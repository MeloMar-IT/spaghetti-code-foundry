import { LONG_TEXT_MAX, REMARK_KINDS, REMARK_MAX, REMARK_SENTENCES, REVIEW_MAX, bad, checkText, isObject, keysAre, oneLine, sentenceCount, type Draft, type DraftChange, type DraftState, type Remark, type RemarkKind } from "./draft.js";
import { REMARK_FIELDS, draftRemarks, type RemarkField } from "./draft-check.js";
import { RefinementError } from "./errors.js";
import { chars } from "./talk.js";

/**
 * What a review run was about, read back from the head of its task: the text of each field (key `title`, `who`, …) and of each
 * criterion (key `C1`, with the criterion's id) as the architect saw it. A text that changes after that makes its remark stale.
 */
export type ReviewRefs = Record<string, { id?: string; text: string }>;

type TextOnly = Exclude<RemarkField, "criteria">;
const FIELD_SET: readonly string[] = REMARK_FIELDS;
const KIND_SET: readonly string[] = REMARK_KINDS;

/**
 * The end of a review run: the checked answer `{ remarks }` becomes the review of the draft and replaces the old one. No field
 * changes. A remark about a text that was not in the task is left out. Throws bad-draft for a wrong form; undefined when the draft is gone.
 */
export function setReview(st: DraftState, draftId: string, output: unknown, refs: ReviewRefs, at: string): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) return undefined;
  if (!isObject(output) || !keysAre(output, "remarks") || !Array.isArray(output.remarks)) throw bad("the remarks have the wrong form");
  const items: unknown[] = output.remarks;
  if (items.length > REVIEW_MAX) throw bad("too many remarks");
  const remarks: Remark[] = [];
  for (const x of items) {
    if (!isObject(x) || typeof x.field !== "string" || !FIELD_SET.includes(x.field)) throw bad("a remark names a field of the draft");
    const field = x.field as RemarkField;
    const criteria = field === "criteria";
    if (!keysAre(x, "field", "kind", "text", ...(criteria ? ["item"] : []))) throw bad("a remark has a field, a kind and a text");
    if (typeof x.kind !== "string" || !KIND_SET.includes(x.kind)) throw bad("a remark has a kind");
    if (x.kind === "uncheckable" && !criteria) throw bad("only a criterion can be uncheckable");
    if (criteria && (typeof x.item !== "string" || !/^C\d+$/.test(x.item))) throw bad("a remark about a criterion names it");
    const text = checkText(x.text, "remark", REMARK_MAX, true);
    if (!text) throw bad("a remark needs a text");
    if (sentenceCount(text) > REMARK_SENTENCES) throw bad(`a remark has at most ${REMARK_SENTENCES} sentences`);
    const ref = refs[criteria ? (x.item as string) : field];
    if (!ref || (criteria && ref.id === undefined) || chars(ref.text) > LONG_TEXT_MAX) continue;
    remarks.push({ field, ...(criteria ? { item: ref.id } : {}), kind: x.kind as RemarkKind, text, about: ref.text });
  }
  const next: Draft = { ...d, review: { at, remarks } };
  return { ...st, drafts: st.drafts.map((y) => (y === d ? next : y)), line: { what: "architect-reviewed", detail: String(remarks.length) } };
}

/** The text a remark is about as it is now; undefined when the field is empty or the criterion is gone. */
const currentText = (d: Draft, field: RemarkField, item?: string): string | undefined => (field === "criteria" ? d.criteria.find((c) => c.id === item)?.text : d[field as TextOnly]?.text);

/** The stored review for the view: no `about`; `stale` when the text is not the one that was reviewed (changed, moved or gone). */
export function reviewView(d: Draft): { at: string; remarks: { field: RemarkField; item?: string; kind: RemarkKind; text: string; stale?: true }[] } | undefined {
  if (!d.review) return undefined;
  const remarks = d.review.remarks.map((r) => ({
    field: r.field,
    ...(r.item !== undefined ? { item: r.item } : {}),
    kind: r.kind,
    text: r.text,
    ...(currentText(d, r.field, r.item) !== r.about ? { stale: true as const } : {}),
  }));
  return { at: d.review.at, remarks };
}

const ONLY_REMARKED = "only a text with a remark that it says how to build can be moved to the notes";

/**
 * The person moves the text of a field (or one criterion) to the notes for the builder, as a line "Wish: <text>". Only a text with
 * a `plan` remark of the code checks, or a `plan` or `how` remark of the review that is about this very text, can be moved. The review stays
 * as it is: its remarks about the moved text are stale then.
 */
export function moveToNotes(st: DraftState, draftId: string, input: unknown): DraftChange {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  if (!isObject(input) || typeof input.field !== "string" || !FIELD_SET.includes(input.field)) throw bad(`the field is ${REMARK_FIELDS.join(", ")}`);
  const field = input.field as RemarkField;
  const criteria = field === "criteria";
  if (criteria ? typeof input.item !== "string" : input.item !== undefined) throw bad(criteria ? "name the criterion to move" : "only a criterion has an item");
  const item = criteria ? (input.item as string) : undefined;
  const crit = criteria ? d.criteria.find((c) => c.id === item) : undefined;
  const source = criteria ? crit : d[field as TextOnly];
  if (!source) throw new RefinementError("not-found", criteria ? "no such criterion in this draft" : "that field of the draft is empty");
  const allowed =
    draftRemarks(d).some((r) => r.kind === "plan" && r.field === field && r.item === item) ||
    (d.review?.remarks ?? []).some((r) => (r.kind === "plan" || r.kind === "how") && r.field === field && r.item === item && r.about === source.text);
  if (!allowed) throw new RefinementError("bad-state", ONLY_REMARKED);
  const line = `Wish: ${oneLine(source.text)}`;
  const notes = d.notes?.text ? `${d.notes.text}\n${line}` : line;
  if (chars(notes) > LONG_TEXT_MAX) throw new RefinementError("limit", "the notes for the builder have no room for this text; shorten them first");
  const typed = source.from === "typed" && (d.notes === undefined || d.notes.from === "typed");
  const next: Draft = { ...d, notes: { text: notes, from: typed ? "typed" : "accepted-edited" } };
  if (criteria) next.criteria = d.criteria.filter((c) => c !== crit);
  else delete (next as Partial<Record<RemarkField, unknown>>)[field];
  return { ...st, drafts: st.drafts.map((y) => (y === d ? next : y)), line: { what: "moved-to-notes", detail: field } };
}
