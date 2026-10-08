import { createHash } from "node:crypto";
import { BOT_MARKER } from "../github.js";
import { cleanBody, splitSections } from "./issue-import.js";
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
  /** The issue this item replaces the title and text of (the draft that stands for the issue the session came from, not on GitHub yet). */
  updates?: number;
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
  /** The issue the session came from, and the draft that stands for it (none: nothing stands for it). */
  source?: { issue: number; draft?: string };
}

type Sess = { drafts: Draft[]; epic?: number };

const titleOf = (d: Draft): string => (d.title ? oneLine(d.title.text) : "…");

/** The drafts a draft depends on (ids of drafts of the same list only). */
const draftDeps = (d: Draft, ids: ReadonlySet<string>): string[] => d.dependsOn.flatMap((x) => (x.draft !== undefined && ids.has(x.draft) ? [x.draft] : []));

/** A split original that still holds criteria: they are in no part, so no issue will carry them. */
export interface LeftBehind {
  draft: string;
  title: string;
  criteria: number;
}

/**
 * The drafts that can become issues: a draft with `splitInto` is left out, and a draft that depends on it depends on each of its parts
 * instead (in the order of `splitInto`), never on itself and none twice. Only for the plan and the publish call; never stored.
 */
export function withoutSplits(drafts: readonly Draft[]): Draft[] {
  const parts = new Map(drafts.flatMap((d) => (d.splitInto ? [[d.id, d.splitInto] as const] : [])));
  if (!parts.size) return [...drafts];
  const ids = new Set(drafts.map((d) => d.id));
  return drafts
    .filter((d) => !d.splitInto)
    .map((d) => {
      if (!d.dependsOn.some((x) => x.draft !== undefined && parts.has(x.draft))) return d;
      const taken = new Set<string>();
      const next: Draft["dependsOn"] = [];
      for (const x of d.dependsOn) {
        if (x.draft === undefined) {
          next.push(x);
          continue;
        }
        const targets = parts.get(x.draft);
        const candidates = targets ? targets.map((p) => ({ ...x, draft: p })) : [x];
        for (const c of candidates) {
          const target = c.draft;
          if (target === undefined || target === d.id || !ids.has(target) || taken.has(target)) continue;
          taken.add(target);
          next.push(c);
        }
      }
      return { ...d, dependsOn: next };
    });
}

/** The split originals that still hold criteria, in session order. */
export function leftBehind(drafts: readonly Draft[]): LeftBehind[] {
  return drafts.flatMap((d) => (d.splitInto && d.criteria.length ? [{ draft: d.id, title: titleOf(d), criteria: d.criteria.length }] : []));
}

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
 * The plan of a session: one item per draft that is not split, in the order they would be created, and the ids that would be created.
 * Readiness is worked out now with `isReady` and the list given; the stored state of the session is not used. A ready draft that depends
 * on a draft that is neither ready nor on GitHub is not offered. `leftBehind` names split originals that still hold criteria.
 */
export function planOf(s: Sess, o: PlanInput): { items: PlanItem[]; willCreate: string[]; willUpdate: string[]; notChanged?: number; leftBehind: LeftBehind[] } {
  const left = leftBehind(s.drafts);
  s = { ...s, drafts: withoutSplits(s.drafts) };
  const order = publishOrder(s.drafts);
  const ids = new Set(s.drafts.map((d) => d.id));
  const byId = new Map(s.drafts.map((d) => [d.id, d]));
  const position = new Map(order.map((d, i) => [d.id, i + 1]));
  const circle = inCircle(s.drafts);
  // The draft that stands for the source issue, while it is there (not split) and not on GitHub yet.
  const markedId = o.source?.draft !== undefined && byId.has(o.source.draft) ? o.source.draft : undefined;
  const updating = o.source && markedId !== undefined && !o.onGithub.has(markedId) ? { id: markedId, issue: o.source.issue } : undefined;
  const notChanged = o.source && markedId === undefined ? o.source.issue : undefined;

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
      const unpublished = updating?.id === d.id ? draftDeps(d, ids).map((id) => byId.get(id)!).find((x) => !o.onGithub.has(x.id)) : undefined;
      if (blocker) r = { state: "not-ready", reason: `it depends on "${titleOf(blocker)}", which is not ready` };
      // The issue is changed first; what it depends on must exist by then.
      else if (unpublished) r = { state: "not-ready", reason: `it replaces issue #${updating!.issue} and depends on "${titleOf(unpublished)}", which is not on GitHub yet: publish that first` };
      else r = { state: "ready" };
    }
    states.set(d.id, r);
    return r;
  };

  const numberOf = (id: string): DepNumber => {
    const issue = o.onGithub.get(id);
    if (issue !== undefined) return { issue };
    if (updating?.id === id) return { issue: updating.issue };
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
    return { n: i + 1, draft: d.id, title, body, state, ...(reason !== undefined ? { reason } : {}), ...(state === "on-github" && issue !== undefined ? { issue } : {}), ...(updating?.id === d.id ? { updates: updating.issue } : {}), dependsOn, labels };
  });
  const ready = items.filter((x) => x.state === "ready");
  return {
    items,
    willCreate: ready.filter((x) => x.updates === undefined).map((x) => x.draft),
    willUpdate: ready.filter((x) => x.updates !== undefined).map((x) => x.draft),
    ...(notChanged !== undefined ? { notChanged } : {}),
    leftBehind: left,
  };
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

/** The last line of the comment the Foundry adds to an issue it replaced the text of: it tells a retry that the comment exists already. */
export const updateMarker = (sessionId: string, draftId: string): string =>
  `${BOT_MARKER} refined-update=${createHash("sha256").update(`refined-update\n${sessionId}\n${draftId}`).digest("hex")} -->`;

/** Whether the last non-empty line of a comment, trimmed, is exactly this marker (a comment that only quotes it is not ours). */
export function endsWithMarker(body: unknown, marker: string): boolean {
  if (typeof body !== "string") return false;
  const last = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last === marker;
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

// ---- the comment on an issue that was updated -------------------------------------------------------

/** The comment must fit GitHub's limit of 65,536 characters; the old text is never cut, so a longer one is refused before anything is written. */
export const UPDATE_COMMENT_MAX = 65_000;

/** Of two issue texts: the sections that differ, as `Name`, `Name (new)` or `Name (removed)`. The text before the first heading is "Story". */
export function changedSections(oldBody: string, newBody: string): string[] {
  const keyed = (text: string) => {
    const { before, sections } = splitSections(cleanBody(text));
    const map = new Map<string, { name: string; text: string }>();
    map.set("story", { name: "Story", text: before.join("\n").trim() });
    for (const sec of sections) {
      const key = sec.heading.toLowerCase();
      const joined = sec.lines.join("\n").trim();
      const known = map.get(key);
      map.set(key, known ? { name: known.name, text: `${known.text}\n${joined}`.trim() } : { name: sec.heading, text: joined });
    }
    return map;
  };
  const was = keyed(oldBody);
  const now = keyed(newBody);
  const out: string[] = [];
  for (const [key, n] of now) {
    const o = was.get(key);
    if (!o) out.push(`${n.name} (new)`);
    else if (o.text !== n.text) out.push(n.name);
  }
  for (const [key, o] of was) if (!now.has(key)) out.push(`${o.name} (removed)`);
  return out;
}

/** Backticks: at least 3, and more than the longest run in any of the texts. */
const fenceFor = (...texts: string[]): string => {
  const longest = Math.max(0, ...texts.flatMap((t) => (t.match(/`+/g) ?? []).map((r) => r.length)));
  return "`".repeat(Math.max(3, longest + 1));
};

/** The comment that says who replaced the title and text of an issue and what changed, with the old title and text folded. The last line is the marker. */
export function updateComment(o: { by: string; date: string; oldTitle: string; oldBody: string; newTitle: string; newBody: string; marker: string }): string {
  const changed = changedSections(o.oldBody, o.newBody);
  const fence = fenceFor(o.oldTitle, o.oldBody);
  return [
    `**Refined in Spaghetti Code Foundry by ${o.by} on ${o.date}.** The title and text of this issue were replaced.`,
    "",
    `- Title: ${o.oldTitle === o.newTitle ? "not changed" : "changed"}`,
    `- Sections changed: ${changed.length ? changed.join(", ") : "none"}`,
    "",
    "<details>",
    "<summary>The title and text before</summary>",
    "",
    "**Title**",
    `${fence}text`,
    o.oldTitle,
    fence,
    "",
    "**Text**",
    `${fence}text`,
    o.oldBody,
    fence,
    "",
    "</details>",
    "",
    o.marker,
  ].join("\n");
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
