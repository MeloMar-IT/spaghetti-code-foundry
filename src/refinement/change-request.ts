import { auditAction } from "../auth/audit.js";
import type { RunSummary } from "../engine/state.js";
import { refinementSessionOf } from "../server/user-view.js";
import { askArchitect, type ArchitectDeps, type ArchitectRequest, type ArchitectView } from "./architect.js";
import { CRITERIA_MAX, isObject, type Draft } from "./draft.js";
import { withoutSplits } from "./publish.js";
import { getSession, RefinementError, type ArchitectKind, type Session } from "./store.js";
import { answer, emptyTalk, type Question } from "./talk.js";

/**
 * A change request (#812): the plain, small view of a refinement session of the Simple view. This file maps the session to the
 * five states a person sees, works out the next architect step, and checks the bodies of the answers and of a card edit.
 * Nothing here shows a cost, a model, a run id or a label.
 */
export type ChangeState = "thinking" | "questions" | "cards" | "planned" | "stuck";
export interface ChangeQuestion {
  id: string;
  text: string;
  why: string;
  options: string[];
  recommended: number;
}
export interface ChangeCard {
  id: string;
  title: string;
  understood?: string;
  criteria: string[];
}
export interface ChangeView {
  id: string;
  repo: string;
  text: string;
  state: ChangeState;
  questions?: ChangeQuestion[];
  cards?: ChangeCard[];
  /** For `planned`: whether the cards were sent to be built ("Yes, build this") or kept for later ("Not now"). */
  building?: boolean;
  /** For `stuck`: a fixed sentence. */
  reason?: string;
  created: string;
  updated: string;
}

export const STUCK_FAILED = "The Foundry could not finish this by itself.";
export const STUCK_PAUSED = "The Foundry paused: a usage limit was reached. Try again later.";
/** The architect steps a change request runs by itself. */
export const CHAIN_KINDS: readonly ArchitectKind[] = ["brief", "round", "understand"];
export const TITLE_EMPTY = "give the card a title";

export const isChange = (s: Pick<Session, "changeRequest">): boolean => s.changeRequest !== undefined;

/** The cards of a session: the drafts that can be published (no split original) and have a title. */
export function cardsOf(s: Pick<Session, "drafts">): Draft[] {
  return withoutSplits(s.drafts).filter((d) => d.title !== undefined);
}

const lastRound = (s: Pick<Session, "talk">) => (s.talk ?? emptyTalk()).rounds.at(-1);
const openQuestions = (s: Pick<Session, "talk">): Question[] => lastRound(s)?.questions.filter((q) => !q.answer) ?? [];

/**
 * The step the architect takes next, by itself: brief, then a round in plain words, then `understand` (when the last round has no
 * open question). Undefined when nothing is due. A run that is there (also a failed one) blocks it unless `ignoreArchitect` is set
 * (used to tell what a retry starts).
 */
export function nextStep(s: Session, ignoreArchitect = false): ArchitectRequest | undefined {
  if (!isChange(s) || s.state === "dropped" || s.state === "published") return undefined;
  if (s.architect && !ignoreArchitect) return undefined;
  if (!s.brief) return { kind: "brief" };
  if (!s.talk?.rounds.length) return { kind: "round", words: "simple" };
  if (openQuestions(s).length) return undefined;
  if (!cardsOf(s).length) return { kind: "understand", words: "simple" };
  return undefined;
}

function questionsOf(s: Session): ChangeQuestion[] {
  return openQuestions(s).map((q) => ({ id: q.id, text: q.text, why: q.why, options: q.options.map((o) => o.text), recommended: q.recommended }));
}

const cardOf = (d: Draft): ChangeCard => ({ id: d.id, title: d.title!.text, ...(d.understood ? { understood: d.understood.summary } : {}), criteria: d.criteria.map((c) => c.text) });

/** The plain view of a change request (as settled: call `settleSession` first). The first rule that fits wins. */
export function changeView(s: Session, arch: ArchitectView): ChangeView {
  const cards = cardsOf(s);
  const base = { id: s.id, repo: s.repo, text: s.idea, created: s.created, updated: s.updated };
  const chain = arch.kind !== undefined && CHAIN_KINDS.includes(arch.kind);
  if (cards.length && cards.every((d) => d.published)) return { ...base, state: "planned", cards: cards.map(cardOf), building: s.changeRequest?.build === true };
  if (arch.state === "queued" || arch.state === "running") return { ...base, state: "thinking" };
  if (arch.state === "paused" && chain) return { ...base, state: "stuck", reason: STUCK_PAUSED };
  if (arch.state === "failed" && s.architect?.failed !== undefined && chain && nextStep(s, true)) return { ...base, state: "stuck", reason: STUCK_FAILED };
  if (arch.state === "failed" && s.architect?.failed === undefined) return { ...base, state: "thinking" };
  if (openQuestions(s).length) return { ...base, state: "questions", questions: questionsOf(s) };
  if (cards.length) return { ...base, state: "cards", cards: cards.map(cardOf) };
  if (nextStep(s, true)) return { ...base, state: "stuck", reason: STUCK_FAILED };
  return { ...base, state: "thinking" };
}

/** What a retry starts: the paused run again, or the step that is due. */
export function retryAsk(s: Session, arch: ArchitectView): ArchitectRequest {
  if (arch.state === "paused") {
    if (arch.kind === "brief" || arch.kind === "round" || arch.kind === "understand") return { kind: arch.kind, ...(arch.kind === "brief" ? {} : { words: "simple" }) };
    throw new RefinementError("bad-state", "open it in the Advanced view to go on");
  }
  const step = nextStep(s, true);
  if (!step) throw new RefinementError("bad-state", "there is nothing to try again");
  return step;
}

/**
 * The answers of a round: exactly the open questions of the last round, each once, each with one of `option`, `text` or `unknown`.
 * Each is tried on a copy of the talk, so a bad one is refused before anything is written.
 */
export function parseAnswers(s: Session, input: unknown): { question: string; answer: Record<string, unknown> }[] {
  const bad = (m: string) => new RefinementError("bad-answer", m);
  if (!isObject(input) || Object.keys(input).some((k) => k !== "answers") || !Array.isArray(input.answers)) throw bad("send { answers: [{ question, option | text | unknown }] }");
  const open = new Set(openQuestions(s).map((q) => q.id));
  const seen = new Set<string>();
  const out: { question: string; answer: Record<string, unknown> }[] = [];
  for (const a of input.answers as unknown[]) {
    if (!isObject(a) || typeof a.question !== "string" || Object.keys(a).some((k) => !["question", "option", "text", "unknown"].includes(k))) throw bad("each answer names its question and has an option, a text or unknown");
    if (!open.has(a.question)) throw bad("an answer is for a question that is not open");
    if (seen.has(a.question)) throw bad("a question is answered twice");
    seen.add(a.question);
    const { question, ...rest } = a;
    out.push({ question, answer: rest });
  }
  if (seen.size !== open.size) throw bad("answer every open question");
  let talk = s.talk ?? emptyTalk();
  const at = new Date().toISOString();
  for (const a of out) talk = answer(talk, a.question, a.answer, at).talk;
  return out;
}

/** The body of a card edit as the draft update takes it: `{ title?, criteria? }`. A criterion with the same text as an old one keeps its id. */
export function cardInput(d: Draft, input: unknown): Record<string, unknown> {
  const bad = (m: string) => new RefinementError("bad-draft", m);
  if (!isObject(input) || Object.keys(input).some((k) => k !== "title" && k !== "criteria")) throw bad("send title and/or criteria");
  if (input.title === undefined && input.criteria === undefined) throw bad("send title and/or criteria");
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim()) throw bad(TITLE_EMPTY);
    out.title = input.title;
  }
  if (input.criteria !== undefined) {
    if (!Array.isArray(input.criteria) || input.criteria.length > CRITERIA_MAX) throw bad(`criteria is a list of at most ${CRITERIA_MAX} texts`);
    const used = new Set<string>();
    out.criteria = (input.criteria as unknown[]).map((c) => {
      if (typeof c !== "string") throw bad("each criterion is text");
      const old = d.criteria.find((x) => !used.has(x.id) && x.text === c.trim());
      if (old) used.add(old.id);
      return old ? { id: old.id, text: c } : { text: c };
    });
  }
  return out;
}

/**
 * The scheduler's hook for a finished run of a refinement session: when the session is a change request and its next step is due,
 * the architect is asked for it (as the owner). Never throws. Runs after `settleFinished`, which took the run's end in.
 */
export function advanceChange(deps: ArchitectDeps, run: Pick<RunSummary, "source">): void {
  try {
    const id = refinementSessionOf(run.source);
    const s = id ? getSession(id) : undefined;
    const step = s ? nextStep(s) : undefined;
    if (!s || !step) return;
    const r = askArchitect(deps, { id: s.owner, admin: false }, s.id, step);
    auditAction(deps.log, s.owner, "run-start", r.runId);
  } catch {
    deps.log?.("refinement: a change request could not go on by itself");
  }
}
