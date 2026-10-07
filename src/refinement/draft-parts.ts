import { randomUUID } from "node:crypto";
import { CRITERIA_MAX, DRAFT_LIMIT, DRAFT_TITLE_MAX, bad, checkText, isObject, oneLine, type Draft, type DraftChange, type DraftState, type Source } from "./draft.js";
import { IMPACT_OVERLAP_AREAS_MAX, areaOverlaps } from "./draft-impact.js";
import { SPLIT_MAX, SPLIT_TEXT_MAX, confirmRefusal } from "./draft-split.js";
import { RefinementError } from "./errors.js";
import { cut } from "./talk.js";

// This file may import values from draft.ts, draft-split.ts and draft-impact.ts (both take only types from draft.ts).

/** A criterion in a message of the plan: its stored text on one line, cut to this many characters. */
export const PLAN_TEXT_MAX = 60;

const NO_TITLE = "each part needs a title";

/**
 * The person confirms a split plan `{ way?, parts, unplaced }`: each part becomes a new draft, appended in plan order, and the original
 * stays as a record with the unplaced criteria and `splitInto`. Every criterion is in exactly one part or in `unplaced`.
 * No architect run starts. Ids from the input are never echoed.
 */
export function confirmSplit(st: DraftState, draftId: string, input: unknown): DraftChange {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  const refusal = confirmRefusal(d);
  if (refusal) throw new RefinementError("bad-state", refusal);
  if (!isObject(input)) throw bad("send the plan as an object");

  let w: NonNullable<Draft["split"]>["ways"][number] | undefined;
  if (input.way !== undefined) {
    const n = input.way;
    w = typeof n === "number" && Number.isInteger(n) && n >= 0 && n < SPLIT_MAX.ways ? d.split?.ways[n] : undefined;
    if (!w) throw bad("no such way; ask for ways to split again");
  }
  const parts = input.parts;
  if (!Array.isArray(parts) || parts.length < SPLIT_MAX.storiesMin || parts.length > SPLIT_MAX.stories || !parts.every(isObject)) throw bad("a split has 2 to 6 parts");
  const unplaced = input.unplaced;
  if (!Array.isArray(unplaced)) throw bad("unplaced must be a list of criterion ids");

  const plan = parts.map((p, i) => {
    if (typeof p.title !== "string") throw bad(NO_TITLE);
    const title = checkText(p.title, "title", DRAFT_TITLE_MAX, true);
    if (!title) throw bad(NO_TITLE);
    let hint: string | undefined;
    if (p.sentence !== undefined) hint = checkText(p.sentence, "sentence", SPLIT_TEXT_MAX, true) || undefined;
    if (!Array.isArray(p.criteria)) throw bad("the criteria of a part must be a list of criterion ids");
    if (!Array.isArray(p.dependsOn)) throw bad("depends on must be a list of part numbers");
    const seen = new Set<unknown>();
    for (const x of p.dependsOn) {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > parts.length) throw bad("no such part");
      if (x === i + 1) throw bad("a part cannot depend on itself");
      if (x > i + 1) throw bad("a part cannot depend on a later part");
      if (seen.has(x)) throw bad("the same part is in depends on twice");
      seen.add(x);
    }
    return { title, hint, criteria: p.criteria as unknown[], dependsOn: p.dependsOn as number[] };
  });

  // Every criterion of the draft is in exactly one part or in `unplaced`.
  const byId = new Map(d.criteria.map((c) => [c.id, c]));
  const shown = (c: { text: string }) => cut(oneLine(c.text), PLAN_TEXT_MAX);
  const placed = new Set<string>();
  for (const id of [...plan.flatMap((p) => p.criteria), ...unplaced]) {
    const c = typeof id === "string" ? byId.get(id) : undefined;
    if (!c) throw bad("a criterion of the plan is not in this draft");
    if (placed.has(c.id)) throw bad(`a criterion is in the plan twice: "${shown(c)}"`);
    placed.add(c.id);
  }
  const left = d.criteria.find((c) => !placed.has(c.id));
  if (left) throw bad(`a criterion is missing from the plan: "${shown(left)}"`);

  if (st.drafts.length + plan.length > DRAFT_LIMIT) throw new RefinementError("limit", `at most ${DRAFT_LIMIT} story drafts`);

  const ids = plan.map(() => randomUUID());
  const unplacedSet = new Set(unplaced as string[]);
  const parted: Draft[] = plan.map((p, i) => {
    const story = w?.stories[i];
    const from: Source = !w ? "typed" : story?.title.trim() === p.title ? "accepted" : "accepted-edited";
    const links: Draft["dependsOn"] = p.dependsOn.map((x) => ({
      id: randomUUID(),
      draft: ids[x - 1]!,
      from: !w ? "typed" : story?.dependsOn.includes(x) ? "accepted" : "accepted-edited",
    }));
    return {
      id: ids[i]!,
      title: { text: p.title, from },
      criteria: (p.criteria as string[]).map((id) => byId.get(id)!),
      ...(d.outOfScope ? { outOfScope: { ...d.outOfScope } } : {}),
      dependsOn: [...(i === 0 ? d.dependsOn.map((x) => ({ ...x, id: randomUUID() })) : []), ...links],
      ...(d.notes ? { notes: { ...d.notes } } : {}),
      part: { of: d.id, ...(p.hint ? { hint: p.hint } : {}) },
    };
  });
  const { split: _split, ...rest } = d;
  const original: Draft = { ...rest, criteria: d.criteria.filter((c) => unplacedSet.has(c.id)), splitInto: ids };
  return { ...st, drafts: [...st.drafts.map((x) => (x === d ? original : x)), ...parted], line: { what: "draft-split", detail: String(plan.length) } };
}

const FAMILY_ONLY = "a criterion can only move between a split draft and its parts";
const NO_CRITERION = "This part has no acceptance criterion.";
const SAME_CODE = "Both parts touch the same code and neither depends on the other.";

/**
 * Moves one criterion (the same object) to the end of another draft of the same split: the original or one of its parts.
 * This is the one change allowed on a split original. A draft that is on GitHub is refused, as source and as target.
 */
export function moveCriterion(st: DraftState, draftId: string, criterionId: string, input: unknown): DraftChange {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  if (!isObject(input) || typeof input.to !== "string") throw bad("send to: the draft to move the criterion to");
  const family = (x: Draft) => (x.splitInto ? x.id : x.part?.of);
  const t = st.drafts.find((x) => x.id === input.to);
  if (!t || t === d || family(d) === undefined || family(t) !== family(d)) throw bad(FAMILY_ONLY);
  const c = d.criteria.find((x) => x.id === criterionId);
  if (!c) throw new RefinementError("not-found", "no such criterion in this draft");
  const held = [d, t].find((x) => x.published);
  if (held?.published) throw new RefinementError("bad-state", `a story draft that is on GitHub as issue #${held.published.issue}; it cannot be changed here`);
  if (t.criteria.length >= CRITERIA_MAX) throw new RefinementError("limit", `at most ${CRITERIA_MAX} acceptance criteria`);
  return {
    ...st,
    drafts: st.drafts.map((x) => (x === d ? { ...d, criteria: d.criteria.filter((y) => y !== c) } : x === t ? { ...t, criteria: [...t.criteria, c] } : x)),
    line: { what: "criterion-moved", detail: oneLine(c.text) },
  };
}

export type PartWarning =
  | { kind: "layer"; part: string; why: string }
  | { kind: "same-code"; parts: [string, string]; areas: string[]; why: string };

/** Warnings about the parts of a split original, worked out from the stored drafts: an empty part, and two unrelated parts on the same code. */
export function partWarnings(d: Draft, drafts: readonly Draft[]): PartWarning[] {
  if (!d.splitInto) return [];
  const ids = new Set(d.splitInto);
  const parts = d.splitInto.map((id) => drafts.find((x) => x.id === id)).filter((x): x is Draft => x !== undefined);
  const out: PartWarning[] = parts.filter((p) => p.criteria.length === 0).map((p) => ({ kind: "layer", part: p.id, why: NO_CRITERION }));
  const byId = new Map(parts.map((p) => [p.id, p]));
  const reaches = (from: Draft, to: Draft): boolean => {
    const seen = new Set<string>();
    const walk = (x: Draft): boolean => {
      for (const l of x.dependsOn) {
        if (l.draft === undefined || !ids.has(l.draft) || seen.has(l.draft)) continue;
        if (l.draft === to.id) return true;
        seen.add(l.draft);
        const n = byId.get(l.draft);
        if (n && walk(n)) return true;
      }
      return false;
    };
    return walk(from);
  };
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]!;
      const b = parts[j]!;
      const other = (b.impact?.areas ?? []).map((x) => x.area);
      const areas = [...new Set((a.impact?.areas ?? []).map((x) => x.area))].filter((x) => other.some((y) => areaOverlaps(x, y))).slice(0, IMPACT_OVERLAP_AREAS_MAX);
      if (areas.length > 0 && !reaches(a, b) && !reaches(b, a)) out.push({ kind: "same-code", parts: [a.id, b.id], areas, why: SAME_CODE });
    }
  }
  return out;
}
