import { SUGGEST_FIELDS, oneLine, type Draft, type SuggestField, type SuggestRefs } from "./draft.js";
import { cut, type Talk, type Question } from "./talk.js";

/** The talk goes into a run as its task, and the shell steps get it in FACTORY_TASK: it is capped in bytes. */
export const TALK_MAX_BYTES = 90_000;

/** The first line of the text, by what is asked. */
export const TALK_FIRST_LINE = {
  round: "This is the talk of a refinement session. What is asked: a round of questions.",
  question: "This is the talk of a refinement session. What is asked: an answer to a question of the person.",
  suggest: "This is the talk of a refinement session. What is asked: a suggestion for one field of a story draft.",
} as const;
export type TalkKind = "round" | "question";

export const QUESTION_HEADING = "## The question of the person";
const charCount = (s: string): number => [...s].length;
/** The heading names the length of the question in characters, so the question can be told from any text inside it. */
const questionHeading = (question: string): string => `${QUESTION_HEADING} (${charCount(question)} characters)`;

export interface TalkInput {
  kind: TalkKind;
  idea: string;
  brief?: string;
  talk: Talk;
  /** The entries the person rejected: their lists and texts. */
  rejected?: { list: string; text: string }[];
  /** Only for kind `question`. */
  question?: string;
}

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;

/** The start of `s` of at most `max` bytes, cut on a whole character (an emoji is never split). */
export function cutBytes(s: string, max: number): string {
  if (max <= 0) return "";
  if (byteLength(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

const LIST_TITLE = { rule: "Rules", example: "Examples", open: "Open questions" } as const;

function answerOf(q: Question): string {
  const a = q.answer;
  if (!a) return "(no answer yet)";
  if (a.option !== undefined) return `option ${a.option}: ${q.options[a.option - 1]?.text ?? ""}`;
  if (a.text !== undefined) return `my own answer: ${a.text}`;
  return "I don't know yet";
}

function roundPart(talk: Talk, index: number): string {
  const r = talk.rounds[index]!;
  const last = index === talk.rounds.length - 1;
  const lines = [`### Round ${index + 1}`];
  r.questions.forEach((q, i) => {
    lines.push(`Question ${i + 1} (${q.view}): ${q.text}`, `Why it matters: ${q.why}`);
    q.options.forEach((o, j) => lines.push(`Option ${j + 1}${q.recommended === j + 1 ? " (recommended)" : ""}: ${o.text} — ${o.tradeoff}`));
    lines.push(`${last && q.answer ? "New answer" : "Answer"}: ${answerOf(q)}`);
  });
  if (r.done) lines.push(`Done: ${r.done}`);
  return lines.join("\n");
}

const list = (items: string[]) => (items.length ? items.map((t) => `- ${t}`).join("\n") : "(none)");

function mapPart(talk: Talk): string {
  return [
    "## The map of the story so far",
    `### ${LIST_TITLE.rule}\n${list(talk.map.rules.map((e) => e.text))}`,
    `### ${LIST_TITLE.example}\n${list(talk.map.examples.map((e) => e.text))}`,
    `### ${LIST_TITLE.open}\n${list(talk.map.open.map((e) => e.text))}`,
  ].join("\n");
}

/**
 * The talk so far as the task of an architect run. Pure. Over TALK_MAX_BYTES, the oldest rounds go first (the last round,
 * with the new answers, stays), then the brief is cut, then the end; the text says what was left out.
 */
export function talkText(input: TalkInput): string {
  const { talk } = input;
  const brief = input.brief ?? "";
  const rejected = input.rejected ?? [];
  const head = `${TALK_FIRST_LINE[input.kind]}\n\n## The idea\n${input.idea}`;
  const tail = input.kind === "question" ? `\n\n${questionHeading(input.question ?? "")}\n${input.question ?? ""}` : "";
  const rounds = talk.rounds.map((_, i) => roundPart(talk, i));
  const rejectedPart = `## The entries the person rejected\n${list(rejected.map((r) => `${r.list}: ${r.text}`))}`;
  const map = mapPart(talk);

  const build = (skip: number, briefText: string, briefCut: boolean): string => {
    const notes: string[] = [];
    if (skip) notes.push(`The oldest ${skip === 1 ? "round" : `${skip} rounds`} of the talk ${skip === 1 ? "was" : "were"} left out.`);
    if (briefCut) notes.push("The context brief was cut: only its first part is here.");
    const parts = [
      head,
      `## The context brief\n${briefText || "(none)"}`,
      map,
      `## The rounds so far\n${rounds.slice(skip).join("\n\n") || "(none)"}`,
      rejectedPart,
      ...(notes.length ? [`## Left out\n${notes.join("\n")}`] : []),
    ];
    return parts.join("\n\n") + tail;
  };

  const fits = (t: string) => byteLength(t) <= TALK_MAX_BYTES;
  const whole = build(0, brief, false);
  if (fits(whole)) return whole;
  // The oldest rounds first; the last one stays.
  const maxSkip = Math.max(0, rounds.length - 1);
  for (let skip = 1; skip <= maxSkip; skip++) {
    const t = build(skip, brief, false);
    if (fits(t)) return t;
  }
  // Then the brief.
  const without = build(maxSkip, "", true);
  const room = TALK_MAX_BYTES - byteLength(without) + byteLength("(none)");
  if (room > 0 && brief) {
    const t = build(maxSkip, cutBytes(brief, room), true);
    if (fits(t)) return t;
  }
  // Last, the end of what is left: the question of the person stays whole. One notice names everything that is missing.
  const left = [
    ...(maxSkip ? [`The oldest ${maxSkip === 1 ? "round" : `${maxSkip} rounds`} of the talk ${maxSkip === 1 ? "was" : "were"} left out.`] : []),
    ...(brief ? ["The context brief was left out."] : []),
    "The end of the talk was cut: it did not fit.",
  ];
  const note = `\n\n## Left out\n${left.join("\n")}`;
  const body = build(maxSkip, "", false);
  const keep = TALK_MAX_BYTES - byteLength(tail) - byteLength(note);
  return cutBytes(body, keep) + note + tail;
}

/** The question of the person read back from a text made by `talkText` for kind `question`; undefined for any other text. */
export function questionOf(text: string): string | undefined {
  const first = text.split("\n", 1)[0];
  if (first !== TALK_FIRST_LINE.question) return undefined;
  // The heading says how long the question is: it is the last N characters, and the heading must stand right before it.
  const end = /\n\n## The question of the person \((\d+) characters\)\n/g;
  for (const m of text.matchAll(end)) {
    const question = text.slice(m.index + m[0].length);
    if (charCount(question) === Number(m[1])) return question;
  }
  return undefined;
}

// ---- the task of a suggestion run ------------------------------------------------------------------

/** The rejected suggestions in the task take at most this many bytes. */
export const SUGGEST_REJECTED_BYTES = 20_000;
const REJECTED_LINE_MAX = 500;

export interface SuggestInput {
  idea: string;
  brief?: string;
  talk: Talk;
  /** The draft the suggestion is for, the field, and all drafts of the session (in their order). */
  draft: Draft;
  field: SuggestField;
  drafts: Draft[];
  /** The suggestions rejected earlier in this session; `own` is true for the draft and field that are asked for now. */
  rejected: { field: string; text: string; reason?: string; own: boolean }[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEAD_DRAFT = new RegExp(`^Draft: (${UUID}); field: (\\w+)$`);
const HEAD_IDS = new RegExp(`^Ids:((?: [RED]\\d+=${UUID})*)$`);

/** The draft, the field and the ids behind the numbers, read back from the three head lines of a suggestion task. */
export function suggestOf(task: string): { draft: string; field: SuggestField; refs: SuggestRefs } | undefined {
  const [first, second, third] = task.split("\n", 3);
  if (first !== TALK_FIRST_LINE.suggest) return undefined;
  const d = HEAD_DRAFT.exec(second ?? "");
  const ids = HEAD_IDS.exec(third ?? "");
  if (!d || !ids || !(SUGGEST_FIELDS as readonly string[]).includes(d[2]!)) return undefined;
  const refs: SuggestRefs = {};
  for (const pair of ids[1]!.trim().split(" ").filter(Boolean)) {
    const [key, id] = pair.split("=");
    refs[key!] = id!;
  }
  return { draft: d[1]!, field: d[2] as SuggestField, refs };
}

function draftPart(d: Draft, drafts: Draft[]): string {
  const part = (label: string, f?: { text: string }) => `${label}: ${f ? oneLine(f.text) : "(empty)"}`;
  const deps = d.dependsOn.map((x) => (x.issue !== undefined ? `#${x.issue}` : `draft ${drafts.find((o) => o.id === x.draft)?.title?.text ?? "(no title)"}`));
  return [
    "## The draft as it is now",
    part("Title", d.title),
    part("Who", d.who),
    part("What", d.what),
    part("Why", d.why),
    "### Acceptance criteria",
    list(d.criteria.map((c) => oneLine(c.text))),
    "### Out of scope",
    d.outOfScope?.text ?? "(empty)",
    "### Depends on",
    list(deps),
    "### Notes for the builder",
    d.notes?.text ?? "(empty)",
  ].join("\n");
}

/** One line: no line breaks, cut at REJECTED_LINE_MAX characters. */
const flat = (t: string): string => cut(oneLine(t), REJECTED_LINE_MAX);

/**
 * The task of a suggestion run. Pure. Three head lines (what is asked; the draft and the field; the ids behind the numbers R1, E1,
 * D1 of the text), then the idea, the brief, the map, the draft, the other drafts and the rejected suggestions. Over TALK_MAX_BYTES,
 * the brief is cut first, then entries of the map and other drafts, last the end of the draft; a notice says what is missing. The
 * ids line names only entries that are in the text.
 */
export function suggestText(input: SuggestInput): string {
  const { talk, draft } = input;
  const brief = input.brief ?? "";
  const others = input.drafts.flatMap((d, i) => (d.id === draft.id ? [] : [{ n: i + 1, d }]));
  const rejected: string[] = [];
  let used = 0;
  // This draft and field first, the newest first in each group (the input is oldest first).
  const ranked = [...input.rejected.filter((x) => x.own).reverse(), ...input.rejected.filter((x) => !x.own).reverse()];
  const NOTE_RESERVE = 100;
  for (const r of ranked) {
    const line = `${r.field}: ${flat(r.text)}${r.reason ? ` — reason: ${flat(r.reason)}` : ""}`;
    if (used + byteLength(line) + 3 > SUGGEST_REJECTED_BYTES - NOTE_RESERVE) break;
    rejected.push(line);
    used += byteLength(line) + 3;
  }
  if (rejected.length < ranked.length) rejected.push(`(${ranked.length - rejected.length} older rejected suggestions left out)`);
  const rules = talk.map.rules.map((e, i) => ({ key: `R${i + 1}`, text: oneLine(e.text), id: e.id }));
  const examples = talk.map.examples.map((e, i) => ({ key: `E${i + 1}`, text: oneLine(e.text), id: e.id }));
  const open = talk.map.open.map((e) => oneLine(e.text));
  const full = { rules: rules.length, examples: examples.length, open: open.length, others: others.length };

  const build = (n: typeof full, briefText: string, briefCut: boolean, draftText: string, draftCut: boolean): string => {
    const r = rules.slice(0, n.rules);
    const e = examples.slice(0, n.examples);
    const o = others.slice(0, n.others);
    const ids = [...r, ...e].map((x) => `${x.key}=${x.id}`).concat(o.map((x) => `D${x.n}=${x.d.id}`));
    const left: string[] = [];
    if (briefCut) left.push(brief && !briefText ? "The context brief was left out." : "The context brief was cut: only its first part is here.");
    const missing = [
      [full.rules - n.rules, "rules"],
      [full.examples - n.examples, "examples"],
      [full.open - n.open, "open questions"],
      [full.others - n.others, "other drafts"],
    ].filter(([k]) => (k as number) > 0);
    if (missing.length) left.push(`These were left out because they did not fit: ${missing.map(([k, w]) => `${k} ${w}`).join(", ")}.`);
    if (draftCut) left.push("The draft was cut: the end did not fit.");
    const parts = [
      `${TALK_FIRST_LINE.suggest}\nDraft: ${draft.id}; field: ${input.field}\nIds:${ids.map((x) => ` ${x}`).join("")}`,
      `## The idea\n${input.idea}`,
      `## The context brief\n${briefText || "(none)"}`,
      [
        "## The map of the story so far",
        `### ${LIST_TITLE.rule}\n${list(r.map((x) => `${x.key}: ${x.text}`))}`,
        `### ${LIST_TITLE.example}\n${list(e.map((x) => `${x.key}: ${x.text}`))}`,
        `### ${LIST_TITLE.open}\n${list(open.slice(0, n.open))}`,
      ].join("\n"),
      draftText,
      `## The other drafts of this session\n${list(o.map((x) => `D${x.n}: ${oneLine(x.d.title?.text ?? "(no title)")}`))}`,
      `## The suggestions the person rejected\n${list(rejected)}`,
      ...(left.length ? [`## Left out\n${left.join("\n")}`] : []),
    ];
    return parts.join("\n\n");
  };

  const fits = (t: string) => byteLength(t) <= TALK_MAX_BYTES;
  const drafted = draftPart(draft, input.drafts);
  const n = { ...full };
  const whole = build(n, brief, false, drafted, false);
  if (fits(whole)) return whole;
  // The brief first.
  if (brief) {
    const probe = build(n, "x", true, drafted, false);
    const room = TALK_MAX_BYTES - byteLength(probe) + 1;
    if (room > 0) {
      const t = build(n, cutBytes(brief, room), true, drafted, false);
      if (fits(t)) return t;
    }
  }
  // Then other drafts and the map, from the end, a whole line at a time.
  let text = build(n, "", brief !== "", drafted, false);
  for (const key of ["others", "open", "examples", "rules"] as const) {
    while (!fits(text) && n[key] > 0) {
      n[key]--;
      text = build(n, "", brief !== "", drafted, false);
    }
  }
  if (fits(text)) return text;
  // Last, the end of the draft.
  const bare = build(n, "", brief !== "", "", true);
  return build(n, "", brief !== "", cutBytes(drafted, Math.max(0, TALK_MAX_BYTES - byteLength(bare))), true);
}
