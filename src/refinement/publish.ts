import { oneLine, preview, type Draft } from "./draft.js";
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
