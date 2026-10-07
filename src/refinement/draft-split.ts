import { z } from "zod";
import type { Draft, DraftChange, DraftState } from "./draft.js";
import { TIME, draftMark, sentences } from "./draft-impact.js";
import { RefinementError } from "./errors.js";
import { HAS_CONTROL, chars } from "./talk.js";

// This file may import from draft.ts only types: draft.ts imports SplitSchema from here as a value.

export const SPLIT_MAX = { ways: 3, storiesMin: 2, stories: 6 } as const;
export const SPLIT_TITLE_MAX = 120;
export const SPLIT_TEXT_MAX = 300;
export const SPLIT_OWN_MAX = 500;
export const SPLIT_MIN_CRITERIA = 2;
export const SPLIT_CUTS = ["step", "interface", "data", "rule", "spike"] as const;
export const END_NO_SPLIT_DRAFT = "The story draft for the split could not be found";

const LINE_BREAK = new RegExp(`[\\n\\r\\v\\f\\u0085${String.fromCharCode(0x2028, 0x2029)}]`);
// The rules of checkSplit in tools/refine-round-check, so a forged or damaged answer cannot store what the tool would refuse.
// A written quantity that TIME misses: "a day", "an hour", "zero days", "no weeks". Copied from tools/refine-round-check.
const TIME_WORDS = /\b(?:an?|zero|no)[\s-]*(?:(?:man|person|working|work|business|calendar|elapsed|full|whole)[\s-]*)?(?:hours?|hrs?|days?|weeks?)\b/i;
const C_NUMBER = /^C[1-9]\d*$/;

const prose = (max: number, sentenceMax?: number) =>
  z
    .string()
    .refine(
      (t) =>
        t.trim().length > 0 &&
        chars(t) <= max &&
        !LINE_BREAK.test(t) &&
        !t.includes("\t") &&
        !HAS_CONTROL.test(t) &&
        !TIME.test(t) &&
        !TIME_WORDS.test(t) &&
        (sentenceMax === undefined || sentences(t) <= sentenceMax),
    );

/** One way as the architect gives it (criteria as C numbers) and as it is stored (criteria as ids). */
function way<C extends z.ZodType<string>>(crit: C) {
  const count = z.number().int().min(1).max(SPLIT_MAX.stories);
  const story = z.object({ title: prose(SPLIT_TITLE_MAX), sentence: prose(SPLIT_TEXT_MAX, 1), criteria: z.array(crit), dependsOn: z.array(z.number().int().min(1)) }).strict();
  const warning = z.union([
    z.object({ kind: z.literal("layer"), story: count, why: prose(SPLIT_TEXT_MAX, 2) }).strict(),
    z.object({ kind: z.literal("same-code"), stories: z.tuple([count, count]), why: prose(SPLIT_TEXT_MAX, 2) }).strict(),
  ]);
  return z
    .object({ cut: z.enum(SPLIT_CUTS), stories: z.array(story).min(SPLIT_MAX.storiesMin).max(SPLIT_MAX.stories), first: prose(SPLIT_TEXT_MAX, 1), unplaced: z.array(crit), warnings: z.array(warning) })
    .strict()
    .refine((w) => {
      const seen = new Set<string>();
      for (const c of [...w.stories.flatMap((s) => s.criteria), ...w.unplaced]) {
        if (seen.has(c)) return false;
        seen.add(c);
      }
      const n = w.stories.length;
      const deps = w.stories.every((s, i) => new Set(s.dependsOn).size === s.dependsOn.length && s.dependsOn.every((d) => d < i + 1));
      const warned = w.warnings.every((v) => (v.kind === "layer" ? v.story <= n : v.stories.every((x) => x <= n) && v.stories[0] !== v.stories[1]));
      return deps && warned;
    });
}
const ways = <W extends z.ZodType<{ cut: string }>>(one: W) =>
  z
    .array(one)
    .min(1)
    .max(SPLIT_MAX.ways)
    .refine((l) => new Set(l.map((w) => w.cut)).size === l.length);

/** Stored: when it was asked, the mark of the draft at that time, and the checked ways. */
export const SplitSchema = z.object({ at: z.iso.datetime(), mark: z.string().regex(/^[0-9a-f]{64}$/), ways: ways(way(z.uuid())) }).strict();
export type Split = z.infer<typeof SplitSchema>;

const AnswerSchema = z.object({ ways: ways(way(z.string().regex(C_NUMBER))) }).strict();

/** Read back from the task: the criterion ids behind C1, C2, … and the mark of the draft when it was asked. */
export interface SplitRefs {
  criteria: Record<string, string>;
  mark: string;
}

const bad = (m: string) => new RefinementError("bad-draft", m);

/** The person's own way, checked: undefined for undefined or an empty text. Throws bad-text. */
export function ownWay(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const fail = (m: string) => new RefinementError("bad-text", m);
  if (typeof input !== "string") throw fail("the own way must be text");
  const t = input.replace(/\r\n/g, "\n").trim();
  if (!t) return undefined;
  if (chars(t) > SPLIT_OWN_MAX) throw fail(`the own way can have at most ${SPLIT_OWN_MAX} characters`);
  if (HAS_CONTROL.test(t)) throw fail("the own way has characters that are not allowed");
  return t;
}

/** Why this draft cannot be split, or undefined. A published draft is refused before this, in `askArchitect`; more reasons (already split) are added here when that state exists. */
export function splitRefusal(d: Pick<Draft, "criteria">): string | undefined {
  if (d.criteria.length < SPLIT_MIN_CRITERIA) return `a draft needs at least ${SPLIT_MIN_CRITERIA} acceptance criteria to be split`;
  return undefined;
}

/**
 * The end of a split run: the checked ways become the `split` of the draft and replace older ones. No field changes. C numbers become
 * criterion ids; each criterion of the task is in exactly one story or in `unplaced`. Throws bad-draft for a wrong form; undefined
 * when the draft is gone or the refs of the task are missing.
 */
export function setSplit(st: DraftState, draftId: string, output: unknown, refs: SplitRefs | undefined, at: string): DraftChange | undefined {
  const d = st.drafts.find((x) => x.id === draftId);
  if (!d || !refs) return undefined;
  const parsed = AnswerSchema.safeParse(output);
  if (!parsed.success) throw bad("the architect's ways have the wrong form");
  const all = Object.keys(refs.criteria);
  const id = (c: string): string => refs.criteria[c] ?? "";
  const stored = parsed.data.ways.map((w) => {
    const used = [...w.stories.flatMap((s) => s.criteria), ...w.unplaced];
    // Each C number is known, and none is left out.
    if (used.some((c) => !Object.hasOwn(refs.criteria, c)) || all.some((c) => !used.includes(c))) throw bad("the architect's ways have the wrong form");
    return { ...w, stories: w.stories.map((s) => ({ ...s, criteria: s.criteria.map(id) })), unplaced: w.unplaced.map(id) };
  });
  const split: Split = { at, mark: refs.mark, ways: stored };
  if (!SplitSchema.safeParse(split).success) throw bad("the architect's ways have the wrong form");
  const next: Draft = { ...d, split };
  return { ...st, drafts: st.drafts.map((y) => (y === d ? next : y)), line: { what: "architect-split", detail: String(stored.length) } };
}

export type SplitView = Omit<Split, "mark"> & { outOfDate?: true };

/** The stored ways for the caller: no mark; `outOfDate` when the draft changed since they were asked. */
export function splitView(d: Draft): SplitView | undefined {
  if (!d.split) return undefined;
  const { mark, ...rest } = d.split;
  return { ...rest, ...(draftMark(d) !== mark ? { outOfDate: true as const } : {}) };
}
