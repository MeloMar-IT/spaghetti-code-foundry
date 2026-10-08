import { z } from "zod";
import { DRAFT_LIMIT, type Draft } from "./draft.js";
import { RefinementError } from "./errors.js";
import type { IssueSource, Session } from "./store.js";

/** At most this many dependants are kept in a journal. */
export const JOURNAL_MAX = 1000;
/** The longest text of the write evidence of one dependant: an issue text, as long as GitHub allows. */
export const EVIDENCE_MAX = 65_536;
export const CLOSED = ["not_planned", "other", "open"] as const;
export type Closed = (typeof CLOSED)[number];

const ISSUE = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const NUMBERS = z
  .array(ISSUE)
  .min(1)
  .max(DRAFT_LIMIT)
  .refine((a) => new Set(a).size === a.length, "duplicate");
const EVIDENCE = z.string().max(EVIDENCE_MAX);

export const DependantSchema = z
  .object({
    issue: ISSUE,
    title: z.string().min(1).max(256),
    byHand: z.literal(true).optional(),
    before: EVIDENCE.optional(),
    after: EVIDENCE.optional(),
    rangeBefore: EVIDENCE.optional(),
    rangeAfter: EVIDENCE.optional(),
    outcome: z
      .string()
      .max(40)
      .regex(/^[a-z][a-z-]*$/)
      .optional(),
    done: z.literal(true).optional(),
  })
  .strict();
export const ReplacingSchema = z
  .object({
    parts: NUMBERS,
    cut: z.literal(true).optional(),
    dependants: z
      .array(DependantSchema)
      .max(JOURNAL_MAX)
      .refine((a) => new Set(a.map((d) => d.issue)).size === a.length, "duplicate issue"),
  })
  .strict();
export const ReplacedBySchema = NUMBERS;
export type Dependant = z.infer<typeof DependantSchema>;
export type Replacing = z.infer<typeof ReplacingSchema>;
/** What a fresh scan knows of one dependant. */
export type Found = Pick<Dependant, "issue" | "title" | "byHand" | "before" | "after">;
export type WriteEvidence = { before: string; after: string; rangeBefore: string; rangeAfter: string };
export type ReplaceState = "done" | "due" | "waiting" | undefined;
type Basis = Pick<Session, "source" | "drafts" | "log">;

/**
 * The draft that stands for the issue a session came from, or undefined when none does. Sessions made since the mark exists have it in
 * `source.draft`. An older session is worked out from what it kept (nothing is written): it is the first draft, when it is not a part and
 * no draft was ever removed; else it is not known, and nothing stands for the issue.
 */
export function markOf(s: Basis): string | undefined {
  if (!s.source) return undefined;
  if (s.source.draft !== undefined) return s.source.draft;
  if (s.log.some((l) => l.what === "draft-removed")) return undefined;
  const first = s.drafts[0];
  return first && !first.part ? first.id : undefined;
}

/** The drafts reached through `splitInto`, depth first and in order, down to those that are not split themselves. */
export function partsOf(drafts: readonly Draft[], id: string): Draft[] {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const seen = new Set<string>([id]);
  const out: Draft[] = [];
  const walk = (d: Draft) => {
    for (const pid of d.splitInto ?? []) {
      const p = byId.get(pid);
      if (!p || seen.has(pid)) continue;
      seen.add(pid);
      if (p.splitInto) walk(p);
      else out.push(p);
    }
  };
  const root = byId.get(id);
  if (root?.splitInto) walk(root);
  return out;
}

export function replaceState(s: Basis): ReplaceState {
  if (!s.source) return undefined;
  if (s.source.replacedBy) return "done";
  const mark = markOf(s);
  const d = mark === undefined ? undefined : s.drafts.find((x) => x.id === mark);
  if (!d?.splitInto) return undefined;
  const parts = partsOf(s.drafts, d.id);
  return parts.length > 0 && parts.every((p) => p.published) ? "due" : "waiting";
}

export function replaceStarted(s: Basis): boolean {
  if (s.source?.replacing !== undefined) return true;
  const mark = markOf(s);
  return mark !== undefined && partsOf(s.drafts, mark).some((p) => p.published);
}

/** Merges the journal kept with a fresh scan. Pure; it never returns more than `JOURNAL_MAX` entries (`cut: true` then). */
export function mergeJournal(stored: readonly Dependant[], found: readonly Found[]): { dependants: Dependant[]; cut?: true } {
  const scan = new Map<number, Found>();
  for (const f of found) if (!scan.has(f.issue)) scan.set(f.issue, f);
  const known = new Set<number>();
  const list: Dependant[] = [];
  for (const e of stored) {
    if (known.has(e.issue)) continue;
    known.add(e.issue);
    if (e.rangeAfter !== undefined || e.done) {
      list.push(e);
      continue;
    }
    const f = scan.get(e.issue);
    if (!f) continue;
    const { title: _t, byHand: _h, before: _b, after: _a, ...kept } = e;
    list.push({ ...kept, ...pick(f) });
  }
  const added = [...scan.values()].filter((f) => !known.has(f.issue)).sort((a, b) => a.issue - b.issue);
  for (const f of added) list.push(pick(f));
  return list.length > JOURNAL_MAX ? { dependants: list.slice(0, JOURNAL_MAX), cut: true } : { dependants: list };
}

function pick(f: Found): Pick<Dependant, "issue" | "title" | "byHand" | "before" | "after"> {
  return {
    issue: f.issue,
    title: f.title,
    ...(f.byHand !== undefined ? { byHand: f.byHand } : {}),
    ...(f.before !== undefined ? { before: f.before } : {}),
    ...(f.after !== undefined ? { after: f.after } : {}),
  };
}

const bad = (m: string) => new RefinementError("bad-state", m);

function parsed<T>(schema: z.ZodType<T>, v: unknown, m: string): T {
  const r = schema.safeParse(v);
  if (!r.success) throw bad(m);
  return r.data;
}

export function withJournal(source: IssueSource, input: { parts: number[]; found: readonly Found[]; cut?: boolean }): IssueSource {
  if (source.replacedBy) throw bad("the issue was replaced already");
  const merged = mergeJournal(source.replacing?.dependants ?? [], input.found);
  const cut = input.cut || merged.cut || source.replacing?.cut;
  const replacing = parsed(ReplacingSchema, { parts: input.parts, dependants: merged.dependants, ...(cut ? { cut: true } : {}) }, "the replacement cannot be kept in the session");
  return { ...source, replacing };
}

function entryOf(source: IssueSource, issue: number): { replacing: Replacing; at: number } {
  if (!source.replacing) throw bad("the replacement has not started");
  const at = source.replacing.dependants.findIndex((d) => d.issue === issue);
  if (at < 0) throw new RefinementError("not-found", "no such dependant");
  return { replacing: source.replacing, at };
}

function setEntry(source: IssueSource, replacing: Replacing, at: number, entry: unknown): IssueSource {
  const next = parsed(DependantSchema, entry, "the evidence cannot be kept in the session");
  return { ...source, replacing: { ...replacing, dependants: replacing.dependants.map((d, i) => (i === at ? next : d)) } };
}

/** Stores the write evidence of one dependant. Undefined when the same evidence is there already; conflicting evidence is refused. */
export function withWrite(source: IssueSource, issue: number, ev: WriteEvidence): IssueSource | undefined {
  const { replacing, at } = entryOf(source, issue);
  const e = replacing.dependants[at]!;
  if (e.done) throw bad("this dependant is done already");
  if (e.rangeAfter !== undefined) {
    if (e.before === ev.before && e.after === ev.after && e.rangeBefore === ev.rangeBefore && e.rangeAfter === ev.rangeAfter) return undefined;
    throw bad("this dependant has other write evidence already");
  }
  return setEntry(source, replacing, at, { ...e, ...ev });
}

/** Sets `outcome` and `done` of one dependant. Undefined when it is done with this outcome already; another outcome is refused. */
export function withDone(source: IssueSource, issue: number, outcome: string): IssueSource | undefined {
  const { replacing, at } = entryOf(source, issue);
  const e = replacing.dependants[at]!;
  if (e.done) {
    if (e.outcome === outcome) return undefined;
    throw bad("this dependant is done with another outcome");
  }
  return setEntry(source, replacing, at, { ...e, outcome, done: true });
}

/** Ends the replacement: `replacedBy` from the parts of the journal, `closed`, `closedAt`; the journal goes. Undefined when that is done already. */
export function withReplaced(source: IssueSource, end: { closed: Closed; closedAt?: string }): { source: IssueSource; parts: number[] } | undefined {
  const { replacing, replacedBy: was, ...rest } = source;
  if (!replacing) {
    if (was) return undefined;
    throw bad("the replacement has not started");
  }
  const closed = parsed(z.enum(CLOSED), end.closed, "invalid closed value");
  const closedAt = end.closedAt === undefined ? undefined : parsed(z.iso.datetime(), end.closedAt, "invalid closing time");
  const parts = [...replacing.parts];
  return { source: { ...rest, replacedBy: [...parts], closed, ...(closedAt !== undefined ? { closedAt } : {}) }, parts };
}
