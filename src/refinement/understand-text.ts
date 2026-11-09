import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CRITERION_MAX,
  DRAFT_LIMIT,
  DRAFT_TITLE_MAX,
  DraftsSchema,
  LONG_TEXT_MAX,
  PART_MAX,
  UNDERSTOOD_SUMMARY_MAX,
  bad,
  dropDraft,
  oneLine,
  strictSentenceCount,
  type Draft,
  type DraftChange,
  type DraftState,
} from "./draft.js";
import { RefinementError } from "./errors.js";
import { ABOUT_REFUSED, PICTURES_MAX, PICTURE_ABOUT_MAX } from "./pictures.js";
import { HAS_CONTROL, chars, type Talk } from "./talk.js";
import { LIST_TITLE, TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, cutBytes, list, roundPart } from "./talk-text.js";

/** Every summary of the architect starts with these words. */
export const UNDERSTOOD_PREFIX = "This is what I understood: ";
export const UNDERSTAND_MAX = { drafts: 5, criteria: 10 } as const;

/** The words of a run: empty (as usual) or `simple` (the plain words of the Simple view). Anything else is refused. */
export function wordsOf(input: unknown): "" | "simple" {
  if (input === undefined || input === "") return "";
  if (input === "simple") return "simple";
  throw new RefinementError("bad-text", 'words is "simple" or empty');
}

/**
 * The ids of the drafts a new `understand` run replaces: drafts the architect wrote from the idea that are not on GitHub, not a split
 * original and not a part, that no published draft depends on, and that no published draft has a suggestion for.
 */
export function replacedByUnderstand(drafts: Draft[]): Set<string> {
  const held = new Set<string>();
  for (const d of drafts) {
    if (!d.published) continue;
    for (const x of d.dependsOn) if (x.draft !== undefined) held.add(x.draft);
    for (const x of d.suggestions ?? []) if (x.draft !== undefined) held.add(x.draft);
  }
  return new Set(drafts.filter((d) => d.understood && !d.published && !d.splitInto && !d.part && !held.has(d.id)).map((d) => d.id));
}

export interface UnderstandInput {
  idea: string;
  brief?: string;
  talk: Talk;
  drafts: Draft[];
}

/**
 * The task of an `understand` run. Pure. The idea, the brief, the map, the rounds so far and the drafts that stay (those a new answer
 * does not replace). Over TALK_MAX_BYTES, the oldest rounds go first (the last stays), then the brief is cut, then entries of the map
 * from the end; a notice says what is missing, and a last guard keeps the whole text within the limit.
 */
export function understandText(input: UnderstandInput): string {
  const { talk } = input;
  const brief = input.brief ?? "";
  const replaced = replacedByUnderstand(input.drafts);
  const stay = input.drafts.flatMap((d, i) => (replaced.has(d.id) ? [] : [`D${i + 1}: ${oneLine(d.title?.text ?? "(no title)")}`]));
  const rules = talk.map.rules.map((e) => oneLine(e.text));
  const examples = talk.map.examples.map((e) => oneLine(e.text));
  const open = talk.map.open.map((e) => oneLine(e.text));
  const full = { rules: rules.length, examples: examples.length, open: open.length };
  const rounds = talk.rounds.map((_, i) => roundPart(talk, i));

  const notice = (skip: number, briefText: string, briefCut: boolean, n: typeof full): string[] => {
    const left: string[] = [];
    if (skip) left.push(`The oldest ${skip === 1 ? "round" : `${skip} rounds`} of the talk ${skip === 1 ? "was" : "were"} left out.`);
    if (briefCut) left.push(brief && !briefText ? "The context brief was left out." : "The context brief was cut: only its first part is here.");
    const missing = [
      [full.rules - n.rules, "rules"],
      [full.examples - n.examples, "examples"],
      [full.open - n.open, "open questions"],
    ].filter(([k]) => (k as number) > 0);
    if (missing.length) left.push(`These were left out because they did not fit: ${missing.map(([k, w]) => `${k} ${w}`).join(", ")}.`);
    return left;
  };
  const build = (skip: number, briefText: string, briefCut: boolean, n: typeof full): string => {
    const left = notice(skip, briefText, briefCut, n);
    return [
      `${TALK_FIRST_LINE.understand}\n\n## The idea\n${input.idea}`,
      `## The context brief\n${briefText || "(none)"}`,
      [
        "## The map of the story so far",
        `### ${LIST_TITLE.rule}\n${list(rules.slice(0, n.rules))}`,
        `### ${LIST_TITLE.example}\n${list(examples.slice(0, n.examples))}`,
        `### ${LIST_TITLE.open}\n${list(open.slice(0, n.open))}`,
      ].join("\n"),
      `## The rounds so far\n${rounds.slice(skip).join("\n\n") || "(none)"}`,
      `## The drafts that stay\n${list(stay)}`,
      ...(left.length ? [`## Left out\n${left.join("\n")}`] : []),
    ].join("\n\n");
  };

  const fits = (t: string) => byteLength(t) <= TALK_MAX_BYTES;
  const n = { ...full };
  const whole = build(0, brief, false, n);
  if (fits(whole)) return whole;
  // The oldest rounds first; the last one stays.
  const maxSkip = Math.max(0, rounds.length - 1);
  for (let skip = 1; skip <= maxSkip; skip++) {
    const t = build(skip, brief, false, n);
    if (fits(t)) return t;
  }
  // Then the brief.
  if (brief) {
    const probe = build(maxSkip, "x", true, n);
    const room = TALK_MAX_BYTES - byteLength(probe) + 1;
    if (room > 0) {
      const t = build(maxSkip, cutBytes(brief, room), true, n);
      if (fits(t)) return t;
    }
  }
  // Then entries of the map, from the end, a whole line at a time.
  let text = build(maxSkip, "", brief !== "", n);
  for (const key of ["open", "examples", "rules"] as const) {
    while (!fits(text) && n[key] > 0) {
      // Large maps: drop in steps, then refine, so this stays fast.
      const step = Math.max(1, Math.floor(n[key] / 8));
      n[key] = Math.max(0, n[key] - step);
      text = build(maxSkip, "", brief !== "", n);
    }
  }
  if (fits(text)) return text;
  // The hard guard: cut the end of what is left.
  const note = `\n\n## Left out\n${[...notice(maxSkip, "", brief !== "", n), "The end of the talk was cut: it did not fit."].join("\n")}`;
  return cutBytes(build(maxSkip, "", brief !== "", n), TALK_MAX_BYTES - byteLength(note)) + note;
}

// ---- the answer ------------------------------------------------------------------------------------

const LS_PS = String.fromCharCode(0x2028, 0x2029);
const LINE_BREAK = new RegExp(`[\\n${LS_PS}]`);
const TITLE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const str = (max: number, one = false, min = 1) =>
  z
    .string()
    .transform((t) => t.trim())
    .pipe(z.string().refine((t) => chars(t) >= min && chars(t) <= max && (one ? !LINE_BREAK.test(t) && !TITLE_CONTROL.test(t) : !HAS_CONTROL.test(t))));

/** One sentence about a picture: one plain line, no link, image or HTML syntax. */
const aboutSchema = str(PICTURE_ABOUT_MAX, true).refine((t) => strictSentenceCount(t) === 1 && !ABOUT_REFUSED.test(t));

const AnswerSchema = z
  .object({
    drafts: z
      .array(
        z
          .object({
            title: str(DRAFT_TITLE_MAX, true),
            who: str(PART_MAX),
            what: str(PART_MAX),
            why: str(PART_MAX),
            criteria: z.array(str(CRITERION_MAX)).min(1).max(UNDERSTAND_MAX.criteria),
            outOfScope: str(LONG_TEXT_MAX, false, 0),
            dependsOn: z.array(z.number().int()),
            summary: str(UNDERSTOOD_SUMMARY_MAX, true).refine((t) => t.startsWith(UNDERSTOOD_PREFIX) && strictSentenceCount(t) === 1),
          })
          .strict(),
      )
      .min(1)
      .max(UNDERSTAND_MAX.drafts),
    pictures: z.array(aboutSchema).max(PICTURES_MAX).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    a.drafts.forEach((d, i) => {
      if (new Set(d.dependsOn).size !== d.dependsOn.length || d.dependsOn.some((n) => n < 1 || n > i)) ctx.addIssue({ code: "custom", message: "depends on", path: ["drafts", i, "dependsOn"] });
    });
  });

/**
 * The descriptions of the pictures in an `understand` answer, one per picture. Undefined when the answer has none. A list of another
 * length than `count`, or an entry of the wrong form, throws `bad-draft`.
 */
export function understoodPictures(output: unknown, count: number): string[] | undefined {
  const raw = (output as { pictures?: unknown } | null | undefined)?.pictures;
  if (raw === undefined) {
    // A request with pictures needs a description of each one: an answer without them is refused, and the old drafts stay.
    if (count > 0) throw bad("the architect's picture descriptions are missing");
    return undefined;
  }
  const parsed = z.array(aboutSchema).max(PICTURES_MAX).safeParse(raw);
  if (!parsed.success || parsed.data.length !== count) throw bad("the architect's picture descriptions have the wrong form");
  return parsed.data;
}

/**
 * Stores the drafts the architect wrote from the idea. The drafts of an earlier run that are still replaceable are removed first (and
 * the links to them); the new ones come last, each with `from: "accepted"` on every text, criterion and link. Never changes its input.
 * A wrong form throws `bad-draft`; too many drafts throw `limit`.
 */
export function applyUnderstood(st: DraftState, output: unknown): DraftChange {
  const parsed = AnswerSchema.safeParse(output);
  if (!parsed.success) throw bad("the architect's drafts have the wrong form");
  let cur: DraftState = st;
  for (const id of replacedByUnderstand(st.drafts)) cur = dropDraft(cur, id);
  const made = parsed.data.drafts;
  if (cur.drafts.length + made.length > DRAFT_LIMIT) throw new RefinementError("limit", `at most ${DRAFT_LIMIT} story drafts; remove some first`);
  const ids = made.map(() => randomUUID());
  const from = "accepted" as const;
  const fresh: Draft[] = made.map((d, k) => ({
    id: ids[k]!,
    title: { text: d.title, from },
    who: { text: d.who, from },
    what: { text: d.what, from },
    why: { text: d.why, from },
    criteria: d.criteria.map((text) => ({ id: randomUUID(), text, from })),
    ...(d.outOfScope ? { outOfScope: { text: d.outOfScope, from } } : {}),
    dependsOn: d.dependsOn.map((n) => ({ id: randomUUID(), draft: ids[n - 1]!, from })),
    understood: { summary: d.summary },
  }));
  const drafts = [...cur.drafts, ...fresh];
  if (!DraftsSchema.safeParse(drafts).success) throw bad("the architect's drafts have the wrong form");
  return { drafts, epic: st.epic, line: { what: "architect-understood", detail: String(made.length) } };
}
