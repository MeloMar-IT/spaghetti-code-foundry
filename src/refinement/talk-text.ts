import type { Talk, Question } from "./talk.js";

/** The talk goes into a run as its task, and the shell steps get it in FACTORY_TASK: it is capped in bytes. */
export const TALK_MAX_BYTES = 90_000;

/** The first line of the text, by what is asked. */
export const TALK_FIRST_LINE = {
  round: "This is the talk of a refinement session. What is asked: a round of questions.",
  question: "This is the talk of a refinement session. What is asked: an answer to a question of the person.",
} as const;
export type TalkKind = keyof typeof TALK_FIRST_LINE;

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
