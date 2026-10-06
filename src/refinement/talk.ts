import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RefinementError } from "./errors.js";

// ---- limits (characters are counted as code points: an emoji is one) -------------------------------

export const ROUND_QUESTIONS_MAX = 5;
export const ROUND_PROPOSALS_MAX = 20;
export const QUESTION_MAX = 500;
export const OPTION_MAX = 300;
export const ENTRY_MAX = 500;
export const DONE_MAX = 500;
/** An own answer to a question. */
export const ANSWER_TEXT_MAX = 2000;
/** The architect's answer to an own question. */
export const REPLY_MAX = 8000;
/** The longest own question that is stored (a storage bound; the input limit of the ask call is at most this). */
export const ASK_MAX = 10_000;
/** The longest own question the owner can ask the architect, in characters. */
export const ASK_INPUT_MAX = 2000;
/** The longest `detail` of a log line of the talk. */
export const DETAIL_MAX = 2000;
export const LIST_LIMIT = 100;
export const WAITING_LIMIT = 50;
export const ASKED_LIMIT = 50;
/** The most log lines a round writes: one per question, and one for proposals that did not fit. */
export const ROUND_LOG_LINES = ROUND_QUESTIONS_MAX + 1;
/** The log lines an own question writes: the question and the answer. */
export const ASKED_LOG_LINES = 2;

export const LISTS = ["rule", "example", "open"] as const;
export type ListKind = (typeof LISTS)[number];
export const MAP_KEY = { rule: "rules", example: "examples", open: "open" } as const;
export const VIEWS = ["need", "build", "test"] as const;

export const TALK_LOG_KINDS = ["question", "answered", "open-added", "entry-accepted", "entry-rejected", "entry-changed", "entry-removed", "asked", "architect-answered", "proposals-left-out", "round-done"] as const;
export const isTalkKind = (what: string): boolean => (TALK_LOG_KINDS as readonly string[]).includes(what);

const CONTROL_IN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const HAS_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const RUN_ID_FORM = /^[\w-]+$/;

export const chars = (s: string): number => [...s].length;
export const cut = (s: string, max: number): string => (chars(s) > max ? [...s].slice(0, max).join("") : s);
const clean = (v: unknown): string => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(CONTROL_IN_TEXT, "").trim();

// ---- stored shape ----------------------------------------------------------------------------------

const RUN_ID = z.string().regex(RUN_ID_FORM).max(100);
const AnswerSchema = z
  .object({ at: z.iso.datetime(), option: z.number().int().min(1).max(4).optional(), text: z.string().min(1).max(ANSWER_TEXT_MAX).optional(), unknown: z.literal(true).optional() })
  .strict()
  .refine((a) => [a.option, a.text, a.unknown].filter((v) => v !== undefined).length === 1);
const QuestionSchema = z
  .object({
    id: z.uuid(),
    view: z.enum(VIEWS),
    text: z.string().min(1).max(QUESTION_MAX),
    why: z.string().min(1).max(QUESTION_MAX),
    options: z
      .array(z.object({ text: z.string().min(1).max(OPTION_MAX), tradeoff: z.string().min(1).max(OPTION_MAX) }).strict())
      .min(2)
      .max(4),
    recommended: z.number().int().min(1).max(4),
    answer: AnswerSchema.optional(),
  })
  .strict()
  .refine((q) => q.recommended <= q.options.length && (q.answer?.option === undefined || q.answer.option <= q.options.length));
const RoundSchema = z.object({ runId: RUN_ID, at: z.iso.datetime(), questions: z.array(QuestionSchema).max(ROUND_QUESTIONS_MAX), done: z.string().max(DONE_MAX).optional() }).strict();
const ProposalSchema = z.object({ id: z.uuid(), list: z.enum(LISTS), text: z.string().min(1).max(ENTRY_MAX) }).strict();
const EntrySchema = z.object({ id: z.uuid(), text: z.string().min(1).max(ENTRY_MAX), at: z.iso.datetime() }).strict();
const EntryList = z.array(EntrySchema).max(LIST_LIMIT);
const AskedSchema = z.object({ runId: RUN_ID, at: z.iso.datetime(), question: z.string().min(1).max(ASK_MAX), answer: z.string().min(1).max(REPLY_MAX) }).strict();

export const TalkSchema = z
  .object({
    rounds: z.array(RoundSchema),
    proposals: z.array(ProposalSchema).max(WAITING_LIMIT),
    map: z.object({ rules: EntryList, examples: EntryList, open: EntryList }).strict(),
    asked: z.array(AskedSchema).max(ASKED_LIMIT),
  })
  .strict();

export type Talk = z.infer<typeof TalkSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Entry = z.infer<typeof EntrySchema>;

export const emptyTalk = (): Talk => ({ rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] });

export interface TalkLine {
  what: (typeof TALK_LOG_KINDS)[number];
  detail: string;
  list?: ListKind;
}
export interface TalkChange {
  talk: Talk;
  lines: TalkLine[];
}

const line = (what: TalkLine["what"], text: string, list?: ListKind): TalkLine => ({ what, detail: cut(text, DETAIL_MAX), ...(list ? { list } : {}) });

// ---- a round ---------------------------------------------------------------------------------------

export interface RoundInput {
  questions?: unknown;
  proposals?: unknown;
  done?: unknown;
}

const badRound = (m: string) => new RefinementError("bad-round", m);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const roundText = (v: unknown, max: number, what: string): string => {
  const t = cut(clean(v), max);
  if (!t) throw badRound(`${what} has no text`);
  return t;
};
const listOf = (v: unknown, name: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRound(`${name} is not a list`);
  return v;
};
const checkRunId = (runId: unknown) => {
  if (typeof runId !== "string" || !RUN_ID_FORM.test(runId) || runId.length > 100) throw badRound("the run id is not valid");
};
const stored = (talk: Talk, runId: string) => talk.rounds.some((r) => r.runId === runId) || talk.asked.some((a) => a.runId === runId);

function checkQuestion(q: unknown, n: number): Question {
  if (!isObject(q)) throw badRound(`question ${n} is not an object`);
  if (!(VIEWS as readonly unknown[]).includes(q.view)) throw badRound(`question ${n} has no view of need, build or test`);
  const text = roundText(q.text, QUESTION_MAX, `question ${n}`);
  const why = roundText(q.why, QUESTION_MAX, `the reason of question ${n}`);
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) throw badRound(`question ${n} does not have 2 to 4 options`);
  const options = q.options.map((o: unknown, i: number) => {
    const r = isObject(o) ? o : {};
    return { text: roundText(r.text, OPTION_MAX, `option ${i + 1} of question ${n}`), tradeoff: roundText(r.tradeoff, OPTION_MAX, `the trade-off of option ${i + 1} of question ${n}`) };
  });
  const rec = q.recommended;
  if (typeof rec !== "number" || !Number.isInteger(rec) || rec < 1 || rec > options.length) throw badRound(`question ${n} does not recommend one of its options`);
  return { id: randomUUID(), view: q.view as Question["view"], text, why, options, recommended: rec };
}

/** The talk with a round and its waiting proposals, or undefined when the run's round is stored already. */
export function addRound(talk: Talk, runId: string, input: unknown, at: string): TalkChange | undefined {
  if (!isObject(input)) throw badRound("the round is not an object");
  checkRunId(runId);
  const qs = listOf(input.questions, "questions");
  const ps = listOf(input.proposals, "proposals");
  if (qs.length > ROUND_QUESTIONS_MAX) throw badRound(`a round has at most ${ROUND_QUESTIONS_MAX} questions`);
  if (ps.length > ROUND_PROPOSALS_MAX) throw badRound(`a round has at most ${ROUND_PROPOSALS_MAX} proposals`);
  const questions = qs.map((q, i) => checkQuestion(q, i + 1));
  const proposals = ps.map((p, i) => {
    if (!isObject(p)) throw badRound(`proposal ${i + 1} is not an object`);
    if (!(LISTS as readonly unknown[]).includes(p.list)) throw badRound(`proposal ${i + 1} has no list of rule, example or open`);
    return { id: randomUUID(), list: p.list as ListKind, text: roundText(p.text, ENTRY_MAX, `proposal ${i + 1}`) };
  });
  if (input.done !== undefined && typeof input.done !== "string") throw badRound("done is not text");
  const done = cut(clean(input.done), DONE_MAX);
  if (!questions.length && !done) throw badRound("there are no questions and no done");
  if (stored(talk, runId)) return undefined;
  const kept = proposals.slice(0, Math.max(0, WAITING_LIMIT - talk.proposals.length));
  const lines = questions.map((q) => line("question", q.text));
  if (kept.length < proposals.length) lines.push(line("proposals-left-out", String(proposals.length - kept.length)));
  return {
    talk: { ...talk, rounds: [...talk.rounds, { runId, at, questions, ...(done ? { done } : {}) }], proposals: [...talk.proposals, ...kept] },
    lines,
  };
}

/** The talk with an own question and the architect's answer, or undefined when the run is stored already. */
export function addAsked(talk: Talk, runId: string, input: { question: string; answer: string }, at: string): TalkChange | undefined {
  checkRunId(runId);
  const question = typeof input?.question === "string" ? input.question : "";
  if (!question.trim()) throw badRound("the question is empty");
  if (chars(question) > ASK_MAX) throw badRound(`the question can have at most ${ASK_MAX} characters`);
  const answer = cut(typeof input.answer === "string" ? input.answer.trim() : "", REPLY_MAX);
  if (!answer) throw badRound("the answer is empty");
  if (stored(talk, runId)) return undefined;
  if (talk.asked.length >= ASKED_LIMIT) throw new RefinementError("limit", `at most ${ASKED_LIMIT} own questions are kept`);
  return { talk: { ...talk, asked: [...talk.asked, { runId, at, question, answer }] }, lines: [line("asked", question), line("architect-answered", answer)] };
}

// ---- the owner's calls -----------------------------------------------------------------------------

function ownText(input: unknown, max: number, code: "bad-answer" | "bad-text", what: string): string {
  const bad = (m: string) => new RefinementError(code, m);
  if (typeof input !== "string") throw bad(`the ${what} must be text`);
  const t = input.replace(/\r\n/g, "\n").trim();
  if (!t) throw bad(`write the ${what}`);
  if (chars(t) > max) throw bad(`the ${what} can have at most ${max} characters`);
  if (HAS_CONTROL.test(t)) throw bad(`the ${what} has characters that are not allowed`);
  return t;
}

/** An own question for the architect, checked: text of 1 to ASK_INPUT_MAX characters, no control characters. */
export const ownQuestion = (input: unknown): string => ownText(input, ASK_INPUT_MAX, "bad-text", "question");

const LIST_NAME = { rule: "rules", example: "examples", open: "open questions" } as const;
const full = (kind: ListKind) => new RefinementError("limit", `the ${LIST_NAME[kind]} are full: at most ${LIST_LIMIT} entries; remove one first`);
const withEntry = (talk: Talk, kind: ListKind, e: Entry): Talk => ({ ...talk, map: { ...talk.map, [MAP_KEY[kind]]: [...talk.map[MAP_KEY[kind]], e] } });
const BAD_ANSWER = 'answer with an option, your own text, or "I don\'t know yet"';

/** My answer to a question: an option, my own text, or "I don't know yet" (which adds the question to the open questions). */
export function answer(talk: Talk, questionId: string, input: unknown, at: string): TalkChange {
  const q = talk.rounds.flatMap((r) => r.questions).find((x) => x.id === questionId);
  if (!q) throw new RefinementError("not-found", "no such question");
  if (q.answer) throw new RefinementError("bad-state", "that question is answered already");
  if (!isObject(input)) throw new RefinementError("bad-answer", BAD_ANSWER);
  const keys = ["option", "text", "unknown"].filter((k) => input[k] !== undefined);
  if (keys.length !== 1) throw new RefinementError("bad-answer", BAD_ANSWER);
  let a: NonNullable<Question["answer"]>;
  let detail: string;
  if (keys[0] === "option") {
    const n = input.option;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > q.options.length) throw new RefinementError("bad-answer", `choose an option from 1 to ${q.options.length}`);
    a = { at, option: n };
    detail = q.options[n - 1]!.text;
  } else if (keys[0] === "text") {
    const t = ownText(input.text, ANSWER_TEXT_MAX, "bad-answer", "answer");
    a = { at, text: t };
    detail = t;
  } else {
    if (input.unknown !== true) throw new RefinementError("bad-answer", BAD_ANSWER);
    if (talk.map.open.length >= LIST_LIMIT) throw full("open");
    a = { at, unknown: true };
    detail = "I don't know yet";
  }
  const rounds = talk.rounds.map((r) => ({ ...r, questions: r.questions.map((x) => (x.id === questionId ? { ...x, answer: a } : x)) }));
  let next: Talk = { ...talk, rounds };
  const lines = [line("answered", detail)];
  if (a.unknown) {
    next = withEntry(next, "open", { id: randomUUID(), text: q.text, at });
    lines.push(line("open-added", q.text, "open"));
  }
  return { talk: next, lines };
}

export function accept(talk: Talk, proposalId: string, at: string): TalkChange {
  const p = talk.proposals.find((x) => x.id === proposalId);
  if (!p) throw new RefinementError("not-found", "no such proposal");
  if (talk.map[MAP_KEY[p.list]].length >= LIST_LIMIT) throw full(p.list);
  const next = withEntry({ ...talk, proposals: talk.proposals.filter((x) => x !== p) }, p.list, { id: p.id, text: p.text, at });
  return { talk: next, lines: [line("entry-accepted", p.text, p.list)] };
}

export function reject(talk: Talk, proposalId: string): TalkChange {
  const p = talk.proposals.find((x) => x.id === proposalId);
  if (!p) throw new RefinementError("not-found", "no such proposal");
  return { talk: { ...talk, proposals: talk.proposals.filter((x) => x !== p) }, lines: [line("entry-rejected", p.text, p.list)] };
}

const findEntry = (talk: Talk, id: string): { kind: ListKind; entry: Entry } => {
  for (const kind of LISTS) {
    const entry = talk.map[MAP_KEY[kind]].find((e) => e.id === id);
    if (entry) return { kind, entry };
  }
  throw new RefinementError("not-found", "no such entry");
};

/** Undefined when the text is the same. */
export function changeText(talk: Talk, entryId: string, input: unknown): TalkChange | undefined {
  const { kind, entry } = findEntry(talk, entryId);
  const text = ownText(input, ENTRY_MAX, "bad-text", "entry");
  if (text === entry.text) return undefined;
  const key = MAP_KEY[kind];
  return { talk: { ...talk, map: { ...talk.map, [key]: talk.map[key].map((e) => (e === entry ? { ...e, text } : e)) } }, lines: [line("entry-changed", text, kind)] };
}

export function remove(talk: Talk, entryId: string): TalkChange {
  const { kind, entry } = findEntry(talk, entryId);
  const key = MAP_KEY[kind];
  return { talk: { ...talk, map: { ...talk.map, [key]: talk.map[key].filter((e) => e !== entry) } }, lines: [line("entry-removed", entry.text, kind)] };
}
