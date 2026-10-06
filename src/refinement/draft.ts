import { randomUUID } from "node:crypto";
import { z } from "zod";
import { REMARK_FIELDS } from "./draft-check.js";
import { RefinementError } from "./errors.js";
import { ImpactSchema } from "./draft-impact.js";
import { READY_MAX, READY_TEXT_MAX } from "./ready-list.js";
import { HAS_CONTROL, MAP_KEY, chars, cut, type Talk } from "./talk.js";

// ---- limits (characters are counted as code points) ------------------------------------------------

export const DRAFT_LIMIT = 20;
export const DRAFT_TITLE_MAX = 120;
export const PART_MAX = 500;
export const CRITERIA_MAX = 50;
export const CRITERION_MAX = 500;
export const LONG_TEXT_MAX = 5000;
export const DEPENDS_MAX = 20;

export const SOURCES = ["typed", "accepted", "accepted-edited"] as const;
export type Source = (typeof SOURCES)[number];

/** At most this many suggestions wait per draft; for criteria and depends on at most this many come from one run. */
export const SUGGESTIONS_MAX = 20;
export const SUGGEST_LIST_MAX = 10;
/** The newest rejected suggestions a draft keeps (for the next suggestion runs of the session). */
export const REJECTED_MAX = 30;
export const REASON_MAX = 300;

/** The fields of a draft the architect can suggest text for. */
export const SUGGEST_FIELDS = ["title", "who", "what", "why", "criteria", "outOfScope", "dependsOn", "notes"] as const;
export type SuggestField = (typeof SUGGEST_FIELDS)[number];

/** The kinds of a remark of the architect's review. */
export const REMARK_KINDS = ["uncheckable", "vague", "contradiction", "how", "plan"] as const;
export type RemarkKind = (typeof REMARK_KINDS)[number];
/** A review has at most this many remarks; a remark is at most REMARK_MAX characters, on one line, in at most REMARK_SENTENCES sentences. */
export const REVIEW_MAX = 20;
export const REMARK_MAX = 300;
export const REMARK_SENTENCES = 2;

/** How many sentences a text has: a stop, question mark or exclamation mark followed by a space starts the next one. */
export const sentenceCount = (t: string): number => t.split(/(?<=[.!?])\s+/).filter(Boolean).length;
/** The same, as `tools/refine-round-check` counts: closing quotes and brackets may sit between the mark and the space. */
export const strictSentenceCount = (t: string): number => t.split(/(?<=[.!?]["'”’)\]]*)\s+/).filter(Boolean).length;

export const DRAFT_LOG_KINDS = [
  "draft-added",
  "draft-removed",
  "epic-set",
  "epic-cleared",
  "suggestion-asked",
  "architect-suggested",
  "suggestion-accepted",
  "suggestion-rejected",
  "review-asked",
  "architect-reviewed",
  "impact-asked",
  "architect-impact",
  "moved-to-notes",
  "ready-checked",
  "ready-asked",
  "architect-judged",
  "ready-accepted",
  "ready-unaccepted",
] as const;
export type DraftLogKind = (typeof DRAFT_LOG_KINDS)[number];
export const isDraftKind = (what: string): boolean => (DRAFT_LOG_KINDS as readonly string[]).includes(what);

// ---- stored shape ----------------------------------------------------------------------------------

/** The line separator and the paragraph separator (U+2028, U+2029): line breaks that HAS_CONTROL does not have. */
const LS_PS = String.fromCharCode(0x2028, 0x2029);
const LINE_BREAK = new RegExp(`[\\n${LS_PS}]`);
/** Everything that is not allowed in a title: all control characters, also tab and carriage return. */
const TITLE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const text = (max: number, oneLine = false) =>
  z
    .string()
    .min(1)
    .refine((t) => chars(t) <= max)
    .refine((t) => (oneLine ? !LINE_BREAK.test(t) && !TITLE_CONTROL.test(t) : !HAS_CONTROL.test(t)));
const field = (max: number, oneLine = false) => z.object({ text: text(max, oneLine), from: z.enum(SOURCES) }).strict();

/** `tie`: the id of the rule or example of the map that a criterion comes from. */
const CriterionSchema = z.object({ id: z.uuid(), text: text(CRITERION_MAX), from: z.enum(SOURCES), tie: z.uuid().optional() }).strict();
const IssueNumber = z.number().int().min(1);
const DependsSchema = z
  .object({ id: z.uuid(), issue: IssueNumber.optional(), draft: z.uuid().optional(), from: z.enum(SOURCES) })
  .strict()
  .refine((d) => (d.issue === undefined) !== (d.draft === undefined));

const SuggestionSchema = z
  .object({ id: z.uuid(), field: z.enum(SUGGEST_FIELDS), text: text(LONG_TEXT_MAX).optional(), tie: z.uuid().optional(), issue: IssueNumber.optional(), draft: z.uuid().optional() })
  .strict()
  .superRefine((x, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "invalid" });
    if (x.field === "dependsOn") {
      if (x.text !== undefined || x.tie !== undefined || (x.issue === undefined) === (x.draft === undefined)) fail();
    } else if (x.text === undefined || x.issue !== undefined || x.draft !== undefined || (x.field === "criteria") !== (x.tie !== undefined)) fail();
  });
const RejectedSchema = z.object({ field: z.enum(SUGGEST_FIELDS), text: text(LONG_TEXT_MAX), reason: text(REASON_MAX).optional() }).strict();
/** `about`: the text of the field or criterion when the review was asked; the remark is stale when the text is not that any more. */
const RemarkSchema = z
  .object({
    field: z.enum(REMARK_FIELDS),
    item: z.uuid().optional(),
    kind: z.enum(REMARK_KINDS),
    text: text(REMARK_MAX, true).refine((t) => sentenceCount(t) <= REMARK_SENTENCES),
    about: text(LONG_TEXT_MAX),
  })
  .strict()
  .refine((r) => (r.field === "criteria") === (r.item !== undefined));
const ReviewSchema = z.object({ at: z.iso.datetime(), remarks: z.array(RemarkSchema).max(REVIEW_MAX) }).strict();
export const READY_RESULTS = ["met", "not-met", "unsure"] as const;
export const READY_BY = ["code", "architect"] as const;
const READY_ID = z.string().regex(/^[a-z0-9-]{1,40}$/);
/**
 * One result of a readiness check. Of the architect (`by`): `field` is the field of the draft its sentence points at, `item` the
 * criterion (its id) when it is about one, `about` the text of that field or criterion when it was judged. Of code: none of these.
 */
const ReadyResultSchema = z
  .object({
    id: READY_ID,
    text: text(READY_TEXT_MAX, true),
    result: z.enum(READY_RESULTS),
    reason: text(REASON_MAX, true),
    by: z.enum(READY_BY),
    field: z.enum(SUGGEST_FIELDS).optional(),
    item: z.uuid().optional(),
    about: text(LONG_TEXT_MAX).optional(),
  })
  .strict()
  .refine((r) => (r.by === "architect" ? r.field !== undefined && r.about !== undefined : r.field === undefined && r.item === undefined && r.about === undefined))
  .refine((r) => r.item === undefined || r.field === "criteria");
/** The result of a readiness check: for each item of the list as it was then, its text, the result and why. */
const ReadinessSchema = z.object({ at: z.iso.datetime(), items: z.array(ReadyResultSchema).max(READY_MAX) }).strict();
/** Items the person accepted anyway, with the item text they were given for and the reason. */
const AcceptedSchema = z
  .array(z.object({ id: READY_ID, text: text(READY_TEXT_MAX, true), reason: text(REASON_MAX, true), at: z.iso.datetime() }).strict())
  .min(1)
  .max(READY_MAX);
export type Readiness = z.infer<typeof ReadinessSchema>;
export type Accepted = z.infer<typeof AcceptedSchema>[number];
export type Remark = z.infer<typeof RemarkSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type Rejected = z.infer<typeof RejectedSchema>;

const DraftSchema = z
  .object({
    id: z.uuid(),
    title: field(DRAFT_TITLE_MAX, true).optional(),
    who: field(PART_MAX).optional(),
    what: field(PART_MAX).optional(),
    why: field(PART_MAX).optional(),
    criteria: z.array(CriterionSchema).max(CRITERIA_MAX),
    outOfScope: field(LONG_TEXT_MAX).optional(),
    dependsOn: z.array(DependsSchema).max(DEPENDS_MAX),
    notes: field(LONG_TEXT_MAX).optional(),
    suggestions: z.array(SuggestionSchema).max(SUGGESTIONS_MAX).optional(),
    rejected: z.array(RejectedSchema).max(REJECTED_MAX).optional(),
    review: ReviewSchema.optional(),
    impact: ImpactSchema.optional(),
    addReviewLabel: z.literal(true).optional(),
    readiness: ReadinessSchema.optional(),
    acceptedAnyway: AcceptedSchema.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const dup = (path: (string | number)[]) => ctx.addIssue({ code: "custom", message: "duplicate", path });
    const ids = new Set<string>();
    d.criteria.forEach((c, i) => (ids.has(c.id) ? dup(["criteria", i, "id"]) : ids.add(c.id)));
    const accIds = new Set<string>();
    d.acceptedAnyway?.forEach((x, i) => (accIds.has(x.id) ? dup(["acceptedAnyway", i, "id"]) : accIds.add(x.id)));
    const depIds = new Set<string>();
    const targets = new Set<string>();
    d.dependsOn.forEach((x, i) => {
      if (depIds.has(x.id)) dup(["dependsOn", i, "id"]);
      depIds.add(x.id);
      const key = x.issue !== undefined ? `i${x.issue}` : `d${x.draft}`;
      if (targets.has(key)) dup(["dependsOn", i]);
      targets.add(key);
      if (x.draft === d.id) ctx.addIssue({ code: "custom", message: "itself", path: ["dependsOn", i, "draft"] });
    });
  });

export const DraftsSchema = z
  .array(DraftSchema)
  .max(DRAFT_LIMIT)
  .superRefine((drafts, ctx) => {
    const ids = new Set<string>();
    drafts.forEach((d, i) => {
      if (ids.has(d.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: [i, "id"] });
      ids.add(d.id);
    });
    drafts.forEach((d, i) =>
      d.dependsOn.forEach((x, j) => {
        if (x.draft !== undefined && !ids.has(x.draft)) ctx.addIssue({ code: "custom", message: "no such draft", path: [i, "dependsOn", j, "draft"] });
      }),
    );
    drafts.forEach((d, i) =>
      d.suggestions?.forEach((x, j) => {
        if (x.draft !== undefined && !ids.has(x.draft)) ctx.addIssue({ code: "custom", message: "no such draft", path: [i, "suggestions", j, "draft"] });
      }),
    );
  });
export const EpicSchema = IssueNumber.max(Number.MAX_SAFE_INTEGER);

export type Draft = z.infer<typeof DraftSchema>;
export type Field = z.infer<ReturnType<typeof field>>;
export type Criterion = z.infer<typeof CriterionSchema>;
type Depends = z.infer<typeof DependsSchema>;

export interface DraftState {
  drafts: Draft[];
  epic: number | undefined;
}
export interface DraftChange extends DraftState {
  line?: { what: DraftLogKind; detail?: string };
}

// ---- checking input --------------------------------------------------------------------------------

export const bad = (m: string) => new RefinementError("bad-draft", m);
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const TEXT_FIELDS = [
  ["title", "title", DRAFT_TITLE_MAX, true],
  ["who", "who part", PART_MAX, false],
  ["what", "what part", PART_MAX, false],
  ["why", "why part", PART_MAX, false],
  ["outOfScope", "out of scope text", LONG_TEXT_MAX, false],
  ["notes", "notes for the builder", LONG_TEXT_MAX, false],
] as const;
type TextKey = (typeof TEXT_FIELDS)[number][0];

/** The text, trimmed and with \n line ends; "" when it is empty. Throws bad-draft when it is not allowed. */
export function checkText(raw: unknown, label: string, max: number, oneLine: boolean): string {
  if (typeof raw !== "string") throw bad(`the ${label} must be text`);
  const t = raw.replace(/\r\n/g, "\n").trim();
  if (chars(t) > max) throw bad(`the ${label} can have at most ${max} characters`);
  if (oneLine && LINE_BREAK.test(t)) throw bad(`the ${label} must be on one line`);
  if ((oneLine ? TITLE_CONTROL : HAS_CONTROL).test(t)) throw bad(`the ${label} has characters that are not allowed`);
  return t;
}

/** Where a text came from after a person changed it: typed stays typed; anything accepted is now edited. */
const changed = (prev: Source | undefined): Source => (prev === undefined || prev === "typed" ? "typed" : "accepted-edited");

/** The known item of a list for the `id` an item came with; each id may be used once. */
function known<T extends { id: string }>(item: Record<string, unknown>, items: T[], seen: Set<string>, what: string): T | undefined {
  if (item.id === undefined) return undefined;
  const prev = typeof item.id === "string" ? items.find((x) => x.id === item.id) : undefined;
  if (!prev || seen.has(prev.id)) throw bad(`no such ${what} in this draft; load the session again`);
  seen.add(prev.id);
  return prev;
}

function readCriteria(v: unknown, old: Criterion[]): Criterion[] {
  if (!Array.isArray(v)) throw bad("the acceptance criteria must be a list");
  const seen = new Set<string>();
  const out: Criterion[] = [];
  for (const item of v) {
    if (!isObject(item) || typeof item.text !== "string") throw bad("each criterion needs a text");
    const prev = known(item, old, seen, "criterion");
    const t = checkText(item.text, "criterion", CRITERION_MAX, false);
    if (!t) continue;
    out.push(prev && prev.text === t ? prev : { id: prev?.id ?? randomUUID(), text: t, from: prev ? changed(prev.from) : "typed", ...(prev?.tie ? { tie: prev.tie } : {}) });
  }
  if (out.length > CRITERIA_MAX) throw new RefinementError("limit", `at most ${CRITERIA_MAX} acceptance criteria`);
  return out;
}

function readDepends(v: unknown, old: Depends[], self: string, ids: Set<string>): Depends[] {
  if (!Array.isArray(v)) throw bad("depends on must be a list");
  const seen = new Set<string>();
  const targets = new Set<string>();
  const out: Depends[] = [];
  for (const item of v) {
    if (!isObject(item) || (item.issue === undefined) === (item.draft === undefined)) throw bad("a depends-on item is an issue number or another draft of this session");
    const prev = known(item, old, seen, "depends-on item");
    let target: { issue: number } | { draft: string };
    if (item.issue !== undefined) {
      const n = item.issue;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw bad("an issue number is a whole number from 1");
      if (n > Number.MAX_SAFE_INTEGER) throw bad("the issue number is too large");
      target = { issue: n };
    } else {
      if (typeof item.draft !== "string") throw bad("no such draft in this session");
      if (item.draft === self) throw bad("a draft cannot depend on itself");
      if (!ids.has(item.draft)) throw bad("no such draft in this session");
      target = { draft: item.draft };
    }
    const key = "issue" in target ? `i${target.issue}` : `d${target.draft}`;
    if (targets.has(key)) throw bad("the same item is in depends on twice");
    targets.add(key);
    const same = prev !== undefined && prev.issue === (target as { issue?: number }).issue && prev.draft === (target as { draft?: string }).draft;
    out.push(same ? prev : { id: prev?.id ?? randomUUID(), ...target, from: prev ? changed(prev.from) : "typed" });
  }
  if (out.length > DEPENDS_MAX) throw new RefinementError("limit", `at most ${DEPENDS_MAX} depends-on items`);
  return out;
}

// ---- the changes -----------------------------------------------------------------------------------

/** An empty draft: nothing is filled in. */
export function newDraft(st: DraftState): DraftChange {
  if (st.drafts.length >= DRAFT_LIMIT) throw new RefinementError("limit", `at most ${DRAFT_LIMIT} story drafts`);
  return { ...st, drafts: [...st.drafts, { id: randomUUID(), criteria: [], dependsOn: [] }], line: { what: "draft-added" } };
}

/**
 * What the person typed: only the fields in `input` change; a list is sent whole. The source of every text is set here (a
 * `from` in the input is ignored). Undefined when nothing changes.
 */
export function saveTyped(st: DraftState, draftId: string, input: unknown): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  if (!isObject(input)) throw bad("send the fields to save as an object");
  const next: Draft = { ...d };
  const rec = next as unknown as Record<TextKey, Field | undefined>;
  for (const [key, label, max, oneLine] of TEXT_FIELDS) {
    const v = input[key];
    if (v === undefined) continue;
    let raw: unknown = v;
    if (isObject(v)) {
      if (v.text === undefined) throw bad(`the ${label} must be text`);
      raw = v.text;
    }
    const t = raw === null ? "" : checkText(raw, label, max, oneLine);
    const prev = d[key];
    if (!t) delete rec[key];
    else rec[key] = prev && prev.text === t ? prev : { text: t, from: changed(prev?.from) };
  }
  if (input.criteria !== undefined) next.criteria = readCriteria(input.criteria, d.criteria);
  if (input.dependsOn !== undefined) next.dependsOn = readDepends(input.dependsOn, d.dependsOn, d.id, new Set(st.drafts.map((x) => x.id)));
  if (JSON.stringify(next) === JSON.stringify(d)) return undefined;
  return { ...st, drafts: st.drafts.map((x) => (x === d ? next : x)) };
}

/** Removes a draft, and it from the depends-on lists of the others. */
export function dropDraft(st: DraftState, draftId: string): DraftChange {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  const drafts = st.drafts
    .filter((x) => x !== d)
    .map((x) => {
      if (!x.dependsOn.some((y) => y.draft === draftId) && !x.suggestions?.some((y) => y.draft === draftId)) return x;
      return withSuggestions({ ...x, dependsOn: x.dependsOn.filter((y) => y.draft !== draftId) }, (x.suggestions ?? []).filter((y) => y.draft !== draftId));
    });
  return { ...st, drafts, line: { what: "draft-removed", ...(d.title ? { detail: d.title.text } : {}) } };
}

/** Sets or clears the Epic of the session. Undefined when it stays as it is. */
export function changeEpic(st: DraftState, input: unknown): DraftChange | undefined {
  const badEpic = (m = "give the issue number of the Epic, or null for no Epic") => new RefinementError("bad-epic", m);
  if (!isObject(input) || input.issue === undefined) throw badEpic();
  const n = input.issue;
  if (n === null) return st.epic === undefined ? undefined : { ...st, epic: undefined, line: { what: "epic-cleared" } };
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw badEpic();
  if (n > Number.MAX_SAFE_INTEGER) throw badEpic("the issue number is too large");
  return n === st.epic ? undefined : { ...st, epic: n, line: { what: "epic-set", detail: cut(`#${n}`, DRAFT_TITLE_MAX) } };
}

// ---- suggestions of the architect ------------------------------------------------------------------

/** The draft with these waiting suggestions; the key is not there when none wait. */
function withSuggestions(d: Draft, list: Suggestion[]): Draft {
  const { suggestions: _gone, ...rest } = d;
  return list.length ? { ...rest, suggestions: list } : rest;
}

/** The ids behind the numbers (R1, E2, D3) of the task of a suggestion run. */
export type SuggestRefs = Record<string, string>;

/** True when every tie of a criterion or a suggestion names a rule or an example of the map. */
export function tiesOk(drafts: Draft[], talk?: Talk): boolean {
  const known = new Set([...(talk?.map.rules ?? []), ...(talk?.map.examples ?? [])].map((e) => e.id));
  return drafts.every((d) => d.criteria.every((c) => !c.tie || known.has(c.tie)) && (d.suggestions ?? []).every((x) => !x.tie || known.has(x.tie)));
}

/** A rule or example is removed from the map: criteria lose their tie, and waiting suggestions from it go. */
export function untie(drafts: Draft[], entryId: string): Draft[] {
  return drafts.map((d) => {
    if (!d.criteria.some((c) => c.tie === entryId) && !d.suggestions?.some((x) => x.tie === entryId)) return d;
    const criteria = d.criteria.map((c) => {
      const { tie, ...rest } = c;
      return tie === entryId ? rest : c;
    });
    return withSuggestions({ ...d, criteria }, (d.suggestions ?? []).filter((x) => x.tie !== entryId));
  });
}

const FIELD_OF = new Map<string, (typeof TEXT_FIELDS)[number]>(TEXT_FIELDS.map((f) => [f[0], f]));

export const keysAre = (o: Record<string, unknown>, ...keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

/**
 * The end of a suggestion run: the checked answer `{ field, suggestions }` becomes the waiting suggestions of `field` (the
 * waiting ones of that field are replaced; at most SUGGESTIONS_MAX wait per draft). Items that name a rule, an example or a draft
 * that is not there are left out. Throws bad-draft for a wrong form; undefined when the draft is gone.
 */
export function addSuggested(st: DraftState, talk: Talk | undefined, draftId: string, field: SuggestField, output: unknown, refs: SuggestRefs): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d) return undefined;
  if (!isObject(output) || !keysAre(output, "field", "suggestions") || output.field !== field || !Array.isArray(output.suggestions)) throw bad("the suggestions have the wrong form");
  const items: unknown[] = output.suggestions;
  const list = field === "criteria" || field === "dependsOn";
  if (items.length > (list ? SUGGEST_LIST_MAX : 1)) throw bad("too many suggestions");
  const out: Suggestion[] = [];
  const taken = new Set(d.dependsOn.map((x) => (x.issue !== undefined ? `i${x.issue}` : `d${x.draft}`)));
  for (const item of items) {
    if (!isObject(item)) throw bad("a suggestion is not an object");
    if (field === "dependsOn") {
      if (keysAre(item, "issue")) {
        if (typeof item.issue !== "number" || !Number.isInteger(item.issue) || item.issue < 1 || item.issue > Number.MAX_SAFE_INTEGER) throw bad("an issue number is a whole number from 1");
        if (!taken.has(`i${item.issue}`)) out.push({ id: randomUUID(), field, issue: item.issue });
        taken.add(`i${item.issue}`);
      } else if (keysAre(item, "draft") && typeof item.draft === "string" && /^D\d+$/.test(item.draft)) {
        const id = refs[item.draft];
        if (id !== undefined && id !== d.id && st.drafts.some((x) => x.id === id) && !taken.has(`d${id}`)) out.push({ id: randomUUID(), field, draft: id });
        if (id !== undefined) taken.add(`d${id}`);
      } else throw bad("a depends-on suggestion is an issue number or a draft");
    } else if (field === "criteria") {
      if (!keysAre(item, "text", "from") || typeof item.from !== "string" || !/^[RE]\d+$/.test(item.from)) throw bad("a criterion names the rule or example it comes from");
      const t = checkText(item.text, "criterion", CRITERION_MAX, false);
      if (!t) throw bad("a criterion needs a text");
      const id = refs[item.from];
      const entries = talk?.map[item.from.startsWith("R") ? MAP_KEY.rule : MAP_KEY.example] ?? [];
      if (id !== undefined && entries.some((e) => e.id === id)) out.push({ id: randomUUID(), field, text: t, tie: id });
    } else {
      const [, label, max, oneLineOnly] = FIELD_OF.get(field)!;
      if (!keysAre(item, "text")) throw bad("a suggestion has a text and nothing else");
      const t = checkText(item.text, label, max, oneLineOnly);
      if (!t) throw bad("a suggestion needs a text");
      out.push({ id: randomUUID(), field, text: t });
    }
  }
  const others = (d.suggestions ?? []).filter((x) => x.field !== field);
  const next = withSuggestions(d, [...others, ...out.slice(0, SUGGESTIONS_MAX - others.length)]);
  return { ...st, drafts: st.drafts.map((x) => (x === d ? next : x)), line: { what: "architect-suggested", detail: field } };
}

function findSuggestion(st: DraftState, draftId: string, sid: string): { d: Draft; x: Suggestion } {
  const d = st.drafts.find((y) => y.id === draftId);
  if (!d) throw new RefinementError("not-found", "no such story draft");
  const x = d.suggestions?.find((y) => y.id === sid);
  if (!x) throw new RefinementError("not-found", "no such suggestion");
  return { d, x };
}

/** What a suggestion says, for the list of rejected ones. */
function suggestedText(x: Suggestion, st: DraftState): string {
  if (x.text !== undefined) return x.text;
  if (x.issue !== undefined) return `#${x.issue}`;
  const other = st.drafts.find((y) => y.id === x.draft);
  return other?.title ? oneLine(other.title.text) : "another draft";
}

/**
 * The person takes a suggestion into the draft: as it is (`accepted`) or with their own text (`accepted-edited`, text fields and
 * criteria only). A text field is replaced, a list gets one more item; the suggestion is gone after that.
 */
export function acceptSuggestion(st: DraftState, draftId: string, sid: string, input: unknown): DraftChange {
  const { d, x } = findSuggestion(st, draftId, sid);
  if (!isObject(input)) throw bad("send an object, empty or with the text to use");
  const rest = (d.suggestions ?? []).filter((y) => y !== x);
  const line = { what: "suggestion-accepted" as const, detail: x.field };
  const done = (next: Draft): DraftChange => ({ ...st, drafts: st.drafts.map((y) => (y === d ? withSuggestions(next, rest) : y)), line });
  if (x.field === "dependsOn") {
    if (input.text !== undefined) throw bad("a depends-on suggestion cannot be edited; accept or reject it");
    if (d.dependsOn.some((y) => (x.issue !== undefined ? y.issue === x.issue : y.draft === x.draft))) return done(d);
    if (d.dependsOn.length >= DEPENDS_MAX) throw new RefinementError("limit", `at most ${DEPENDS_MAX} depends-on items`);
    if (x.draft !== undefined && !st.drafts.some((y) => y.id === x.draft)) throw new RefinementError("not-found", "no such draft in this session");
    return done({ ...d, dependsOn: [...d.dependsOn, { id: randomUUID(), ...(x.issue !== undefined ? { issue: x.issue } : { draft: x.draft! }), from: "accepted" }] });
  }
  const edited = input.text !== undefined;
  const spec = FIELD_OF.get(x.field);
  const [label, max, oneLineOnly]: [string, number, boolean] = spec ? [spec[1], spec[2], spec[3]] : ["criterion", CRITERION_MAX, false];
  const t = edited ? checkText(input.text, label, max, oneLineOnly) : x.text!;
  if (!t) throw bad(`the ${label} cannot be empty`);
  const from: Source = edited ? "accepted-edited" : "accepted";
  if (x.field === "criteria") {
    if (d.criteria.length >= CRITERIA_MAX) throw new RefinementError("limit", `at most ${CRITERIA_MAX} acceptance criteria`);
    return done({ ...d, criteria: [...d.criteria, { id: randomUUID(), text: t, from, ...(x.tie ? { tie: x.tie } : {}) }] });
  }
  return done({ ...d, [x.field]: { text: t, from } });
}

/** The person turns a suggestion down, with a reason or without. It is kept with the draft (the newest REJECTED_MAX). */
export function rejectSuggestion(st: DraftState, draftId: string, sid: string, input: unknown): DraftChange {
  const { d, x } = findSuggestion(st, draftId, sid);
  const raw = isObject(input) ? input.reason : undefined;
  let reason: string | undefined;
  if (raw !== undefined && raw !== null) {
    const badText = (m: string) => new RefinementError("bad-text", m);
    if (typeof raw !== "string") throw badText("the reason must be text");
    reason = raw.replace(/\r\n/g, "\n").trim();
    if (chars(reason) > REASON_MAX) throw badText(`the reason can have at most ${REASON_MAX} characters`);
    if (HAS_CONTROL.test(reason)) throw badText("the reason has characters that are not allowed");
  }
  const kept: Rejected = { field: x.field, text: suggestedText(x, st), ...(reason ? { reason } : {}) };
  const next: Draft = { ...withSuggestions(d, (d.suggestions ?? []).filter((y) => y !== x)), rejected: [...(d.rejected ?? []), kept].slice(-REJECTED_MAX) };
  return { ...st, drafts: st.drafts.map((y) => (y === d ? next : y)), line: { what: "suggestion-rejected", detail: x.field } };
}

// ---- the story as text -----------------------------------------------------------------------------

export const oneLine = (t: string): string => t.replace(new RegExp(`\\s*[\\n${LS_PS}]\\s*`, "g"), " ");

/** The draft as Markdown in the project's story format: only the person's text and fixed words. */
export function preview(d: Draft, s: { drafts: Draft[]; epic?: number }, accepted: { text: string; reason: string }[] = []): { title: string; body: string } {
  const part = (f: Field | undefined) => (f ? oneLine(f.text) : "…");
  const why = part(d.why);
  const sentence = `As ${part(d.who)}, I want ${part(d.what)}, so that ${why}${/[.!?]$/.test(why) ? "" : "."}`;
  const deps = d.dependsOn.flatMap((x) => {
    if (x.issue !== undefined) return [`- #${x.issue}`];
    const other = s.drafts.find((o) => o.id === x.draft);
    return other ? [`- ${other.title ? oneLine(other.title.text) : "…"} (draft)`] : [];
  });
  const blocks = [
    ...(s.epic !== undefined ? [`**Epic:** #${s.epic}`] : []),
    sentence,
    ["### Acceptance criteria", ...d.criteria.map((c) => `- [ ] ${oneLine(c.text)}`)].join("\n"),
    ...(d.outOfScope ? [`### Out of scope\n${d.outOfScope.text}`] : []),
    ...(d.notes ? [`### Notes for the builder\n${d.notes.text}`] : []),
    `### Depends on\n${deps.length ? deps.join("\n") : "None (can be built on its own)."}`,
    ...(accepted.length ? [["### Accepted anyway", ...accepted.map((a) => `- ${a.text}: ${oneLine(a.reason)}`)].join("\n")] : []),
  ];
  return { title: d.title?.text ?? "", body: blocks.join("\n\n") };
}
