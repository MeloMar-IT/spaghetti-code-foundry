import { createHash } from "node:crypto";
import { BOT_MARKER } from "../github.js";
import { bad, isObject, oneLine, preview, type Draft } from "./draft.js";
import { chars } from "./talk.js";
import { acceptedLines, notReadyReason } from "./draft-ready.js";
import type { ReadyItem } from "./ready-list.js";

/** What publishing would do with a draft: create it, not offer it, or leave it (it is on GitHub already). */
export type PlanState = "ready" | "not-ready" | "on-github";
/** What an item depends on: an issue number, or another item of the plan (`item` is its number `n`). */
export type PlanDep = { issue: number } | { item: number; title: string };
/** Where a draft will be: an issue that exists, an item of the plan, or nowhere (it is not in the plan). */
export type DepNumber = { issue: number } | { item: number } | undefined;

export interface PlanItem {
  /** The 1-based position in the plan. */
  n: number;
  draft: string;
  title: string;
  /** The full issue text, in the project's story format. */
  body: string;
  state: PlanState;
  /** Why it is not ready (state `not-ready`). */
  reason?: string;
  /** The issue number (state `on-github`). */
  issue?: number;
  dependsOn: PlanDep[];
  /** The labels it would get: the build label, and the review label when the draft asks for it. */
  labels: string[];
}

export interface PlanInput {
  list: readonly ReadyItem[];
  /** Drafts that are on GitHub already: draft id → issue number. */
  onGithub: ReadonlyMap<string, number>;
  /** The display name of the account and the date (YYYY-MM-DD) for the note at the end of each text. */
  by: string;
  date: string;
  buildLabel?: string;
  reviewLabel?: string;
}

type Sess = { drafts: Draft[]; epic?: number };

const titleOf = (d: Draft): string => (d.title ? oneLine(d.title.text) : "…");

/** The drafts a draft depends on (ids of drafts of the same list only). */
const draftDeps = (d: Draft, ids: ReadonlySet<string>): string[] => d.dependsOn.flatMap((x) => (x.draft !== undefined && ids.has(x.draft) ? [x.draft] : []));

/**
 * The order the issues are created in: a draft comes after the drafts it depends on; otherwise the order of the session stays (of the drafts
 * that can be placed, always the first of the session). Drafts that depend on each other in a circle, and the ones waiting on them, come last in session order.
 */
export function publishOrder(drafts: readonly Draft[]): Draft[] {
  const ids = new Set(drafts.map((d) => d.id));
  const placed = new Set<string>();
  const out: Draft[] = [];
  for (;;) {
    const next = drafts.find((d) => !placed.has(d.id) && draftDeps(d, ids).every((x) => placed.has(x)));
    if (!next) break;
    placed.add(next.id);
    out.push(next);
  }
  for (const d of drafts) if (!placed.has(d.id)) out.push(d);
  return out;
}

/** The issue text of a draft: the story, then a note on who refined it and when. `numberOf` says where another draft will be. */
export function issueText(
  d: Draft,
  s: Sess,
  o: { accepted: { text: string; reason: string }[]; by: string; date: string; numberOf: (draftId: string) => DepNumber },
): { title: string; body: string } {
  const dep = (other: Draft): string => {
    const n = o.numberOf(other.id);
    if (n === undefined) return titleOf(other);
    if ("issue" in n) return `#${n.issue}`;
    return `new issue ${n.item}: ${titleOf(other)}`;
  };
  const p = preview(d, s, o.accepted, dep);
  return { title: p.title, body: `${p.body}\n\n---\nRefined in Spaghetti Code Foundry by ${o.by} on ${o.date}.` };
}

/** The drafts that reach themselves over their draft dependencies. */
function inCircle(drafts: readonly Draft[]): Set<string> {
  const ids = new Set(drafts.map((d) => d.id));
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const out = new Set<string>();
  for (const d of drafts) {
    const seen = new Set<string>();
    const todo = draftDeps(d, ids);
    while (todo.length) {
      const id = todo.pop()!;
      if (id === d.id) {
        out.add(d.id);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      todo.push(...draftDeps(byId.get(id)!, ids));
    }
  }
  return out;
}

/**
 * The plan of a session: one item per draft in the order they would be created, and the ids that would be created. Readiness is worked
 * out now with `isReady` and the list given; the stored state of the session is not used. A ready draft that depends on a draft that is
 * neither ready nor on GitHub is not offered.
 */
export function planOf(s: Sess, o: PlanInput): { items: PlanItem[]; willCreate: string[] } {
  const order = publishOrder(s.drafts);
  const ids = new Set(s.drafts.map((d) => d.id));
  const byId = new Map(s.drafts.map((d) => [d.id, d]));
  const position = new Map(order.map((d, i) => [d.id, i + 1]));
  const circle = inCircle(s.drafts);

  const states = new Map<string, { state: PlanState; reason?: string }>();
  const stateOf = (d: Draft): { state: PlanState; reason?: string } => {
    const known = states.get(d.id);
    if (known) return known;
    let r: { state: PlanState; reason?: string };
    const own = notReadyReason(d, o.list);
    if (o.onGithub.has(d.id)) r = { state: "on-github" };
    else if (circle.has(d.id)) r = { state: "not-ready", reason: "it depends on itself through other drafts" };
    else if (own !== undefined) r = { state: "not-ready", reason: own };
    else {
      const blocker = draftDeps(d, ids)
        .map((id) => byId.get(id)!)
        .find((x) => stateOf(x).state === "not-ready");
      r = blocker ? { state: "not-ready", reason: `it depends on "${titleOf(blocker)}", which is not ready` } : { state: "ready" };
    }
    states.set(d.id, r);
    return r;
  };

  const numberOf = (id: string): DepNumber => {
    const issue = o.onGithub.get(id);
    if (issue !== undefined) return { issue };
    const item = position.get(id);
    return item === undefined ? undefined : { item };
  };

  const items = order.map((d, i): PlanItem => {
    const { state, reason } = stateOf(d);
    const { title, body } = issueText(d, s, { accepted: acceptedLines(d, o.list), by: o.by, date: o.date, numberOf });
    const dependsOn = d.dependsOn.flatMap((x): PlanDep[] => {
      if (x.issue !== undefined) return [{ issue: x.issue }];
      const other = byId.get(x.draft!);
      const n = other ? numberOf(other.id) : undefined;
      if (!other || !n) return [];
      return ["issue" in n ? { issue: n.issue } : { item: n.item, title: titleOf(other) }];
    });
    // GitHub labels are not case sensitive: the same label twice is shown once, with its first spelling.
    const wanted = state === "on-github" ? [] : [...(o.buildLabel ? [o.buildLabel] : []), ...(o.reviewLabel && d.addReviewLabel ? [o.reviewLabel] : [])];
    const labels = wanted.filter((l, k) => wanted.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === k);
    const issue = o.onGithub.get(d.id);
    return { n: i + 1, draft: d.id, title, body, state, ...(reason !== undefined ? { reason } : {}), ...(state === "on-github" && issue !== undefined ? { issue } : {}), dependsOn, labels };
  });
  return { items, willCreate: items.filter((x) => x.state === "ready").map((x) => x.draft) };
}

// ---- the hidden marker -----------------------------------------------------------------------------

/** The hash a marker holds: of the session and the draft, so that the ids themselves are not written to GitHub. */
export const refinedHash = (sessionId: string, draftId: string): string => createHash("sha256").update(`refined\n${sessionId}\n${draftId}`).digest("hex");

/** The last line of every issue the Foundry makes from a draft: it tells a retry that the issue exists already. */
export const refinedMarker = (sessionId: string, draftId: string): string => `${BOT_MARKER} refined=${refinedHash(sessionId, draftId)} -->`;

const MARKER_LINE = new RegExp(`^${BOT_MARKER} refined=([0-9a-f]{64}) -->$`);

/** The hash of the marker in an issue text; only when the last non-empty line, trimmed, is exactly a marker. */
export function refinedHashIn(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  const last = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last === undefined ? undefined : MARKER_LINE.exec(last)?.[1];
}

/** Of issues as GitHub lists them: the one made from this draft (the lowest number when more carry the marker), or undefined. */
export function issueWithMarker<T extends { number: number; body?: string | null }>(issues: readonly T[], sessionId: string, draftId: string): T | undefined {
  const hash = refinedHash(sessionId, draftId);
  return issues.filter((i) => Number.isSafeInteger(i.number) && i.number >= 1 && refinedHashIn(i.body) === hash).sort((a, b) => a.number - b.number)[0];
}

/** The link stored for an issue: the one GitHub reported when it is the link of this repository and number; else the link built from them. */
export function issueUrl(repo: string, issue: number, reported: unknown): string {
  const own = `https://github.com/${repo}/issues/${issue}`;
  return typeof reported === "string" && reported.toLowerCase() === own.toLowerCase() ? reported : own;
}

// ---- what the person chose -------------------------------------------------------------------------

export interface PublishChoice {
  labels: string[];
  startBuilding: boolean;
}

const LABELS_MAX = 20;
const LABEL_MAX = 50;
const NO_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The request body `{ drafts: [{ draft, labels?, startBuilding? }] }`, checked, as a choice for each draft named. A missing `drafts` is
 * no choice at all. Duplicate labels (any case) collapse to the first. Throws bad-draft for anything else.
 */
export function parsePublishInput(input: unknown, drafts: readonly Draft[]): Map<string, PublishChoice> {
  const out = new Map<string, PublishChoice>();
  if (!isObject(input)) throw bad("send an object, empty or with the choices for the drafts");
  if (input.drafts === undefined) return out;
  if (!Array.isArray(input.drafts)) throw bad("drafts must be a list");
  for (const e of input.drafts as unknown[]) {
    if (!isObject(e) || typeof e.draft !== "string") throw bad("each entry names a draft");
    if (!drafts.some((d) => d.id === e.draft)) throw bad("no such story draft in this session");
    if (out.has(e.draft)) throw bad("a draft is named twice");
    const labels: string[] = [];
    if (e.labels !== undefined) {
      if (!Array.isArray(e.labels) || e.labels.length > LABELS_MAX) throw bad(`labels must be a list of at most ${LABELS_MAX} names`);
      for (const raw of e.labels as unknown[]) {
        if (typeof raw !== "string") throw bad("a label is text");
        const l = raw.trim();
        if (!l || chars(l) > LABEL_MAX) throw bad(`a label has 1 to ${LABEL_MAX} characters`);
        if (NO_CONTROL.test(l)) throw bad("a label has characters that are not allowed");
        if (!labels.some((x) => x.toLowerCase() === l.toLowerCase())) labels.push(l);
      }
    }
    if (e.startBuilding !== undefined && typeof e.startBuilding !== "boolean") throw bad("startBuilding is true or false");
    out.set(e.draft, { labels, startBuilding: e.startBuilding === true });
  }
  return out;
}

export type LabelRules = { repo: string; repoLabels: readonly string[]; buildLabel?: string; reviewLabel?: string };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const spelled = (o: LabelRules, name: string): string | undefined => o.repoLabels.find((l) => same(l, name));

/**
 * The labels a person chose, in the repository's spelling. Throws bad-draft for a label the repository does not have, for the build or the
 * review label (they are not chosen by hand), and for `startBuilding` when there is no build label or the repository does not have it.
 */
export function chosenLabels(choice: PublishChoice | undefined, o: LabelRules): string[] {
  if (!choice) return [];
  if (choice.startBuilding) {
    if (!o.buildLabel) throw bad("this repository has no enabled watcher for issues, so no label starts a build");
    if (!spelled(o, o.buildLabel)) throw bad(`the build label "${o.buildLabel}" does not exist in ${o.repo}; create it first`);
  }
  return choice.labels.map((l) => {
    if ((o.buildLabel && same(l, o.buildLabel)) || (o.reviewLabel && same(l, o.reviewLabel))) {
      throw bad(`"${l}" is not chosen by hand: use startBuilding for the build label, and the review switch of the draft for the review label`);
    }
    const found = spelled(o, l);
    if (!found) throw bad(`the label "${l}" does not exist in ${o.repo}`);
    return found;
  });
}

/** All labels a draft is created with: the chosen ones, the build label when asked, the review label when the draft asks for it. */
export function labelsFor(choice: PublishChoice | undefined, d: Draft, o: LabelRules): string[] {
  const labels = chosenLabels(choice, o);
  const build = choice?.startBuilding === true && o.buildLabel ? [spelled(o, o.buildLabel)!] : [];
  let review: string[] = [];
  if (d.addReviewLabel) {
    if (!o.reviewLabel) throw bad("a draft asks for the review label, but this repository has none");
    const found = spelled(o, o.reviewLabel);
    if (!found) throw bad(`the review label "${o.reviewLabel}" does not exist in ${o.repo}; create it first`);
    // Where the review label is the build label, the draft needs the person to say that a build may start.
    if (o.buildLabel && same(o.reviewLabel, o.buildLabel) && !choice?.startBuilding) throw bad("the review label is also the build label: set startBuilding for this draft, or switch the review label off");
    review = [found];
  }
  return [...labels, ...build, ...review].filter((l, i, all) => all.findIndex((x) => same(x, l)) === i);
}
