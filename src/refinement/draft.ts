import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RefinementError } from "./errors.js";
import { HAS_CONTROL, chars, cut } from "./talk.js";

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

export const DRAFT_LOG_KINDS = ["draft-added", "draft-removed", "epic-set", "epic-cleared"] as const;
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

const CriterionSchema = z.object({ id: z.uuid(), text: text(CRITERION_MAX), from: z.enum(SOURCES) }).strict();
const IssueNumber = z.number().int().min(1);
const DependsSchema = z
  .object({ id: z.uuid(), issue: IssueNumber.optional(), draft: z.uuid().optional(), from: z.enum(SOURCES) })
  .strict()
  .refine((d) => (d.issue === undefined) !== (d.draft === undefined));

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
  })
  .strict()
  .superRefine((d, ctx) => {
    const dup = (path: (string | number)[]) => ctx.addIssue({ code: "custom", message: "duplicate", path });
    const ids = new Set<string>();
    d.criteria.forEach((c, i) => (ids.has(c.id) ? dup(["criteria", i, "id"]) : ids.add(c.id)));
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
  });
export const EpicSchema = IssueNumber.max(Number.MAX_SAFE_INTEGER);

export type Draft = z.infer<typeof DraftSchema>;
type Field = z.infer<ReturnType<typeof field>>;
type Criterion = z.infer<typeof CriterionSchema>;
type Depends = z.infer<typeof DependsSchema>;

export interface DraftState {
  drafts: Draft[];
  epic: number | undefined;
}
export interface DraftChange extends DraftState {
  line?: { what: DraftLogKind; detail?: string };
}

// ---- checking input --------------------------------------------------------------------------------

const bad = (m: string) => new RefinementError("bad-draft", m);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const TEXT_FIELDS = [
  ["title", "title", DRAFT_TITLE_MAX, true],
  ["who", "who part", PART_MAX, false],
  ["what", "what part", PART_MAX, false],
  ["why", "why part", PART_MAX, false],
  ["outOfScope", "out of scope text", LONG_TEXT_MAX, false],
  ["notes", "notes for the builder", LONG_TEXT_MAX, false],
] as const;
type TextKey = (typeof TEXT_FIELDS)[number][0];

/** The text, trimmed and with \n line ends; "" when it is empty. Throws bad-draft when it is not allowed. */
function checkText(raw: unknown, label: string, max: number, oneLine: boolean): string {
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
    out.push(prev && prev.text === t ? prev : { id: prev?.id ?? randomUUID(), text: t, from: prev ? changed(prev.from) : "typed" });
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
  const drafts = st.drafts.filter((x) => x !== d).map((x) => (x.dependsOn.some((y) => y.draft === draftId) ? { ...x, dependsOn: x.dependsOn.filter((y) => y.draft !== draftId) } : x));
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

// ---- the story as text -----------------------------------------------------------------------------

const oneLine = (t: string): string => t.replace(new RegExp(`\\s*[\\n${LS_PS}]\\s*`, "g"), " ");

/** The draft as Markdown in the project's story format: only the person's text and fixed words. */
export function preview(d: Draft, s: { drafts: Draft[]; epic?: number }): { title: string; body: string } {
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
  ];
  return { title: d.title?.text ?? "", body: blocks.join("\n\n") };
}
