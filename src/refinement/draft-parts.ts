import { randomUUID } from "node:crypto";
import { DRAFT_LIMIT, DRAFT_TITLE_MAX, bad, checkText, isObject, oneLine, type Draft, type DraftChange, type DraftState, type Source } from "./draft.js";
import { SPLIT_MAX, SPLIT_TEXT_MAX, confirmRefusal } from "./draft-split.js";
import { RefinementError } from "./errors.js";
import { cut } from "./talk.js";

// This file may import values from draft.ts and draft-split.ts (draft-split.ts takes only types from draft.ts).

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
