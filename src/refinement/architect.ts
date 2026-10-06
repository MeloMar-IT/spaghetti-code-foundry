import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KEY_MISSING, KEY_UNREADABLE, NEEDS_TOKEN, NO_RUN_OWNER, TOKEN_MISSING, TOKEN_UNREADABLE, ownsRepo } from "../auth/repos.js";
import { REFINEMENT_SOURCE } from "../auth/run-owner.js";
import { StoreError } from "../auth/store.js";
import { SIGN_IN_SENTENCES, TOKEN_REFUSED_REASON } from "../engine/guards.js";
import { saveRun, type RunSummary } from "../engine/state.js";
import { flowDir, parseFlow } from "../flow/load.js";
import { z } from "zod";
import { REFINE_BRIEF_FLOW, REFINE_ROUND_FLOW } from "../flow/usage.js";
import type { Scheduler } from "../queue/scheduler.js";
import { refinementSessionOf, userError } from "../server/user-view.js";
import { SUGGESTIONS_MAX, SUGGEST_FIELDS, type SuggestField } from "./draft.js";
import {
  END_BAD_FORM,
  END_NO_DRAFT,
  END_NO_REVIEW_DRAFT,
  LOG_LIMIT,
  RefinementError,
  architectLogRoom,
  endArchitectRun,
  getSession,
  listSessions,
  noteArchitectResumed,
  setArchitectRun,
  type Actor,
  type ArchitectAsk,
  type ArchitectEnd,
  type ArchitectKind,
  type Session,
} from "./store.js";
import { ASKED_LIMIT, DONE_MAX, ENTRY_MAX, LISTS, OPTION_MAX, QUESTION_MAX, REPLY_MAX, ROUND_PROPOSALS_MAX, ROUND_QUESTIONS_MAX, VIEWS, chars, emptyTalk, ownQuestion } from "./talk.js";
import { TALK_FIRST_LINE, questionOf, reviewOf, reviewText, suggestOf, suggestText, talkText } from "./talk-text.js";

/** A suggestion for one field is mostly wording from the brief and the map: its run has a lower cost limit than a round. */
export const SUGGEST_MAX_COST_USD = 1;

/** What the architect code needs of the scheduler (a test passes a stub). */
export type ArchitectScheduler = Pick<Scheduler, "submit" | "cancel" | "get" | "isActive" | "isQueued" | "queue" | "briefs">;

/** The sessions whose run records were looked through once since this scheduler started. */
const scanned = new WeakMap<object, Set<string>>();

export interface ArchitectDeps {
  scheduler: ArchitectScheduler;
  /** The server's default folder: the folder the run is made for (the flow works in an empty workspace). */
  repo: string;
  /** For problems the code built itself from fixed words. */
  log?: (msg: string) => void;
}

export type ArchitectState = "idle" | "queued" | "running" | "paused" | "failed";
export interface ArchitectView {
  state: ArchitectState;
  /** What the run is for: the context brief, a round of questions, or the answer to a question of the owner. Not there when idle. */
  kind?: ArchitectKind;
  /** For kind `suggest`: the draft and the field the suggestion is for. For kind `review`: the draft. */
  draft?: string;
  field?: SuggestField;
  runId?: string;
  /** What the architect is doing now: the description of the current step. */
  doing?: string;
  /** Why it failed or is paused, in plain words. */
  reason?: string;
}

export const GETTING_READY = "Getting ready";
const upper = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const sourceOf = (id: string) => REFINEMENT_SOURCE + id;

const TOKEN_SENTENCES = [NEEDS_TOKEN, TOKEN_MISSING, TOKEN_UNREADABLE, NO_RUN_OWNER, TOKEN_REFUSED_REASON, KEY_MISSING, KEY_UNREADABLE, ...SIGN_IN_SENTENCES];

/** A fixed sentence for why a read failed: no folder, cost, model or command. */
export function architectReason(run: Pick<RunSummary, "status" | "reason">): string {
  const raw = (run.reason ?? "").trim();
  if (run.status === "cancelled" || /^cancelled/.test(raw)) return "It was cancelled";
  if (/^interrupted/.test(raw)) return "The server stopped while the architect was reading";
  let text = raw;
  let step: string | undefined;
  const m = /^step "([\w./-]+)" failed(?::\s*|$)/.exec(text);
  if (m) {
    step = m[1];
    text = text.slice(m[0].length).trim();
  }
  if (TOKEN_SENTENCES.includes(text)) return upper(text);
  if (/^"[^"]*" is not one of your repositories$/.test(text)) return "The repository is not in My repositories any more";
  if (step === "brief" && /^output did not match pass_if/.test(text)) return "The brief did not have its five parts";
  if (step === "check_brief") return "The brief did not say that the backlog is larger than what was read";
  if (step === "check_round") return END_BAD_FORM;
  if (step === "round") return "The architect could not finish its answer";
  if (step === "clone") return "The repository could not be cloned";
  if (step === "list_issues") return "The open issues could not be read";
  if (/^run budget of /.test(raw)) return "The read used up the limit for one read";
  return userError(raw);
}

/** Why a read is paused, in plain words. */
export function pausedReason(run: Pick<RunSummary, "reason" | "history">): string {
  const raw = run.reason ?? "";
  if (/daily budget/.test(raw)) return "The administrator's limit for today was reached; ask again tomorrow";
  if (/^signed out —/.test(raw)) return "The Foundry is signed out of its AI account; ask the administrator, then ask again";
  if (run.history?.at(-1)?.unreachable) return "The AI service could not be reached; ask again later";
  return "The usage limit was reached; ask again later";
}

/** The description of the step the run is at, or "Getting ready" when there is none. */
export function doingOf(run?: Pick<RunSummary, "flowDef" | "state">): string {
  const next = run?.state?.next;
  const step = next ? run?.flowDef?.steps?.find((s) => s.id === next) : undefined;
  return step?.description?.trim() || GETTING_READY;
}

const live = (deps: ArchitectDeps, runId: string) => deps.scheduler.isQueued(runId) || deps.scheduler.isActive(runId);

/** The run, undefined when there is none; throws when it cannot be read. */
const runOf = (deps: ArchitectDeps, runId: string): RunSummary | undefined => deps.scheduler.get(runId);
const statusOf = (deps: ArchitectDeps, runId: string): string | undefined => {
  try {
    return runOf(deps, runId)?.status;
  } catch {
    return undefined;
  }
};

/** What a run is for, by its flow and its `ask` variable. */
export function kindOfRun(run: Pick<RunSummary, "flow" | "vars">): ArchitectKind {
  if (run.flow !== REFINE_ROUND_FLOW) return "brief";
  return run.vars?.ask === "question" ? "question" : run.vars?.ask === "suggest" ? "suggest" : run.vars?.ask === "review" ? "review" : "round";
}

/**
 * The kind of a run the session does not record, and for a question its text read back from the task. Only for orphans: the
 * normal path stores the question with the session. `ask` is undefined when only the queued job is known.
 */
export function askOfJob(flow?: string, ask?: string, task?: string): ArchitectAsk {
  if (flow !== REFINE_ROUND_FLOW) return { kind: "brief" };
  const first = task?.split("\n", 1)[0];
  if (ask === "suggest" || (ask === undefined && first === TALK_FIRST_LINE.suggest)) {
    const s = suggestOf(task ?? "");
    return s ? { kind: "suggest", draft: s.draft, field: s.field } : { kind: "suggest" };
  }
  if (ask === "review" || (ask === undefined && first === TALK_FIRST_LINE.review)) {
    const r = reviewOf(task ?? "");
    return r ? { kind: "review", draft: r.draft } : { kind: "review" };
  }
  if (ask === "question" || (ask === undefined && first === TALK_FIRST_LINE.question)) {
    try {
      return { kind: "question", question: ownQuestion(questionOf(task ?? "")) };
    } catch {
      return { kind: "question" };
    }
  }
  return { kind: "round" };
}

const str = (max: number, min = 1) => z.string().refine((t) => chars(t) >= min && chars(t) <= max);
const RoundOutput = z
  .object({
    questions: z
      .array(
        z
          .object({
            view: z.enum(VIEWS),
            text: str(QUESTION_MAX),
            why: str(QUESTION_MAX),
            options: z.array(z.object({ text: str(OPTION_MAX), tradeoff: str(OPTION_MAX) }).strict()).min(2).max(4),
            recommended: z.number().int().min(1).max(4),
          })
          .strict(),
      )
      .max(ROUND_QUESTIONS_MAX),
    proposals: z.array(z.object({ list: z.enum(LISTS), text: str(ENTRY_MAX) }).strict()).max(ROUND_PROPOSALS_MAX),
    done: str(DONE_MAX, 0),
  })
  .strict();
const AnswerOutput = z.object({ answer: str(REPLY_MAX) }).strict();

/** The checked output of the step `check_round`, read again: never trust the run. */
function roundEnd(run: RunSummary, kind: "round" | "question" | "suggest" | "review"): ArchitectEnd {
  const rec = [...(run.history ?? [])].reverse().find((h) => h.id === "check_round" && h.ok);
  let json: unknown;
  try {
    json = JSON.parse((rec?.output ?? "").trim());
  } catch {
    return { failed: END_BAD_FORM };
  }
  // The store checks the form of the suggestions; the numbers of the map are read back from the head of the task.
  if (kind === "suggest") return { suggested: json, refs: suggestOf(run.task ?? "")?.refs ?? {} };
  // The texts the architect saw are read back from the head of the task: a remark is stale when the draft changed since.
  if (kind === "review") return { reviewed: json, refs: reviewOf(run.task ?? "")?.refs ?? {} };
  if (kind === "round") {
    const r = RoundOutput.safeParse(json);
    return r.success ? { round: r.data } : { failed: END_BAD_FORM };
  }
  const r = AnswerOutput.safeParse(json);
  return r.success ? { answer: r.data.answer } : { failed: END_BAD_FORM };
}

/** What an ended run means for the session: a brief, a round, an answer, a failure, or "paused" (nothing to store). */
function endOf(run: RunSummary): ArchitectEnd | "paused" {
  if (run.status === "stopped") return "paused";
  if (run.status !== "succeeded") return { failed: architectReason(run) };
  const kind = kindOfRun(run);
  if (kind !== "brief") return roundEnd(run, kind);
  const rec = [...(run.history ?? [])].reverse().find((h) => h.id === "brief" && h.ok);
  const text = rec?.output?.trim();
  if (!text) return { failed: "The brief was empty" };
  const clone = [...(run.history ?? [])].reverse().find((h) => h.id === "clone" && h.ok);
  // eslint-disable-next-line no-control-regex
  const branch = (/^branch: (.+)$/m.exec(clone?.output ?? "")?.[1] ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 255);
  const finished = run.finishedAt ? new Date(run.finishedAt) : new Date();
  return { brief: { text, at: (Number.isNaN(finished.getTime()) ? new Date() : finished).toISOString(), ...(branch ? { branch } : {}) } };
}

/** What happened to the run that has no readable end: the session is marked, never left busy. */
function endFor(deps: ArchitectDeps, runId: string): ArchitectEnd | "paused" {
  let run: RunSummary | undefined;
  try {
    run = runOf(deps, runId);
  } catch {
    return { failed: "The run of the architect cannot be read" };
  }
  if (!run) return { failed: "It did not start; it was cancelled or taken out of the queue" };
  return endOf(run);
}

/**
 * A run of this session that the session does not record (the server stopped between queueing it and recording it):
 * a queued or active job, and once per server start also a run that ended since the session last changed. It is recorded.
 */
function adoptOrphan(deps: ArchitectDeps, s: Session): Session {
  if (s.state === "dropped") return s;
  const source = sourceOf(s.id);
  const known = new Set([s.architect?.runId, s.brief?.runId, ...(s.talk?.rounds.map((r) => r.runId) ?? []), ...(s.talk?.asked.map((a) => a.runId) ?? [])]);
  const q = deps.scheduler.queue();
  const job = [...q.pending, ...q.active].find((j) => j.source === source && !known.has(j.runId));
  let found = job?.runId;
  let seen = scanned.get(deps.scheduler);
  if (!seen) scanned.set(deps.scheduler, (seen = new Set()));
  let scan = false;
  if (!found && !seen.has(s.id)) {
    scan = true;
    const since = Date.parse(s.updated);
    found = deps.scheduler
      .briefs()
      .filter((b) => b.source === source && !known.has(b.runId) && Date.parse(b.startedAt) > since)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.runId;
  }
  if (!found) {
    // Nothing to take in: this session is done with the scan.
    if (scan) seen.add(s.id);
    return s;
  }
  let ask: ArchitectAsk = { kind: "brief" };
  const pending = q.pending.find((p) => p.runId === found);
  if (pending) ask = askOfJob(pending.flow, undefined, pending.task);
  else {
    try {
      const run = deps.scheduler.get(found);
      if (run) ask = askOfJob(run.flow, run.vars?.ask ?? "round", run.task);
    } catch {
      // not readable now: recorded as a brief, as before
    }
  }
  // A suggestion or review whose draft (and field) cannot be read from its task could never be stored: it is cancelled and marked.
  const unreadable = (ask.kind === "suggest" && (!ask.draft || !ask.field)) || (ask.kind === "review" && !ask.draft);
  try {
    const adopted = setArchitectRun({ id: s.owner, admin: false }, s.id, found, unreadable ? { kind: "round" } : ask);
    if (scan) seen.add(s.id);
    if (!unreadable) return adopted;
    deps.scheduler.cancel(found);
    return endArchitectRun(s.id, found, { failed: ask.kind === "review" ? END_NO_REVIEW_DRAFT : END_NO_DRAFT }) ?? adopted;
  } catch {
    // Not recorded (the lock was busy, for example): the next read looks again.
    return s;
  }
}

/** Takes the end of the session's read into the session when the run is over. Returns the session as it is then. */
export function settleSession(deps: ArchitectDeps, id: string): Session | undefined {
  let s = getSession(id);
  if (s) s = adoptOrphan(deps, s);
  if (!s?.architect || s.architect.failed !== undefined) return s;
  const runId = s.architect.runId;
  if (live(deps, runId)) return s;
  const end = endFor(deps, runId);
  if (end === "paused") return s;
  return endArchitectRun(id, runId, end) ?? getSession(id);
}

/** The state of the architect for a session (as settled: call settleSession first). Never throws. */
export function architectView(deps: ArchitectDeps, s: Pick<Session, "architect">): ArchitectView {
  const a = s.architect;
  if (!a) return { state: "idle" };
  const runId = a.runId;
  const kind = a.kind ?? "brief";
  const what = kind === "suggest" ? { kind, draft: a.draft, field: a.field } : kind === "review" ? { kind, draft: a.draft } : { kind };
  if (deps.scheduler.isQueued(runId)) return { state: "queued", ...what, runId };
  if (deps.scheduler.isActive(runId)) {
    let run: RunSummary | undefined;
    try {
      run = runOf(deps, runId);
    } catch {
      run = undefined;
    }
    return { state: "running", ...what, runId, doing: doingOf(run) };
  }
  if (a.failed !== undefined) return { state: "failed", ...what, runId, reason: a.failed };
  const end = endFor(deps, runId);
  if (end === "paused") {
    const run = runOf(deps, runId)!;
    return { state: "paused", ...what, runId, reason: pausedReason(run) };
  }
  // Not settled yet (the hook has not run, or the lock was busy): what it would be, not stored.
  return { state: "failed", ...what, runId, reason: "failed" in end ? end.failed : kind === "brief" ? "The brief is being stored" : "The answer is being stored" };
}

const busy = (m: string) => new RefinementError("busy", m);

const DOING: Record<ArchitectKind, string> = { brief: "reading the code", round: "asking its questions", question: "answering your question", suggest: "writing a suggestion", review: "reviewing a draft" };

/** What the owner asks of the architect. `question` is the text of an own question, `field` and `draft` those of a suggestion (checked here). */
export interface ArchitectRequest {
  kind: ArchitectKind;
  question?: unknown;
  draft?: string;
  field?: unknown;
}

/**
 * The owner asks the architect for a session: the read of the code, a round of questions or the answer to an own question.
 * A new run, or the resume of a paused one. At most one run per account is queued, running or paused. Returns the run id and
 * whether it was a resume.
 */
export function askArchitect(deps: ArchitectDeps, actor: Actor, id: string, ask: ArchitectRequest = { kind: "brief" }): { runId: string; resumed: boolean } {
  const kind = ask.kind;
  const found = getSession(id);
  if (!found) throw new RefinementError("not-found", "no such refinement session");
  if (found.owner !== actor.id) throw actor.admin ? new RefinementError("not-owner", "only the owner can ask the architect") : new RefinementError("not-found", "no such refinement session");
  if (found.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be read; restore it first");
  if (!ownsRepo(found.owner, found.repo)) throw new RefinementError("no-repo", "the repository is not in My repositories any more");
  const field = ask.field as SuggestField;
  if (kind === "suggest" && !(SUGGEST_FIELDS as readonly unknown[]).includes(ask.field)) throw new RefinementError("bad-draft", `the field is ${SUGGEST_FIELDS.join(", ")}`);
  let s = settleSession(deps, id);
  if (!s) throw new RefinementError("not-found", "no such refinement session");
  if (s.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be read; restore it first");

  // This session, then the other sessions of the account: queued, running, or paused (not failed).
  if (s.architect && live(deps, s.architect.runId)) throw busy("the architect is reading for this session already");
  for (const listed of listSessions(s.owner)) {
    if (listed.id === s.id) continue;
    const o = settleSession(deps, listed.id) ?? listed;
    if (!o.architect) continue;
    const running = live(deps, o.architect.runId);
    if (running || (o.architect.failed === undefined && statusOf(deps, o.architect.runId) === "stopped")) {
      throw busy(`the architect is ${running ? "reading" : "paused"} for another of your sessions; ${running ? "wait until it is done" : "ask again there, or drop that session"}`);
    }
  }

  const source = sourceOf(s.id);
  const cur = s.architect;
  if (cur && cur.failed === undefined) {
    const paused = statusOf(deps, cur.runId) === "stopped";
    const pausedKind = cur.kind ?? "brief";
    if (paused && (pausedKind === "suggest" || pausedKind === "review") && !s.drafts.some((d) => d.id === cur.draft)) {
      // The draft is gone: the paused suggestion or review could never be stored. The paused run is cancelled, so it does not stay paused for good.
      try {
        const old = runOf(deps, cur.runId);
        if (old) saveRun({ ...old, status: "cancelled", reason: "cancelled by user", waiting: undefined, finishedAt: new Date().toISOString() });
      } catch {
        deps.log?.("refinement: the paused run could not be saved as cancelled");
      }
      endArchitectRun(s.id, cur.runId, { failed: pausedKind === "review" ? END_NO_REVIEW_DRAFT : END_NO_DRAFT });
      s = getSession(id) ?? s;
    } else if (paused && (pausedKind !== kind || (kind === "suggest" && (cur.draft !== ask.draft || cur.field !== field)) || (kind === "review" && cur.draft !== ask.draft))) {
      throw busy(`the architect paused while ${DOING[pausedKind]} for this session; ask that again first`);
    } else if (paused) {
      const run = runOf(deps, cur.runId);
      if (run?.workdir && existsSync(run.workdir)) {
        deps.scheduler.submit({ kind: "resume", runId: cur.runId }, { source, queuedBy: actor.id, lockKey: source });
        noteArchitectResumed(s.id, cur.runId);
        return { runId: cur.runId, resumed: true };
      }
      endArchitectRun(s.id, cur.runId, { failed: "The folder of the read is gone" });
      s = getSession(id) ?? s;
    }
  }

  // A new session has no talk yet.
  const talk = s.talk ?? emptyTalk();
  let question: string | undefined;
  if (kind === "round") {
    if (!s.brief) throw new RefinementError("bad-state", "ask the architect to look at the code first");
    if (talk.rounds.at(-1)?.questions.some((q) => !q.answer)) throw new RefinementError("bad-state", 'answer every question of the last round first; "I don\'t know yet" is an answer');
  } else if (kind === "question") {
    question = ownQuestion(ask.question);
    if (talk.asked.length >= ASKED_LIMIT) throw new RefinementError("limit", `at most ${ASKED_LIMIT} own questions are kept`);
  }
  const draft = kind === "suggest" || kind === "review" ? s.drafts.find((d) => d.id === ask.draft) : undefined;
  if (kind === "review") {
    if (!s.brief) throw new RefinementError("bad-state", "ask the architect to look at the code first");
    if (!draft) throw new RefinementError("not-found", "no such story draft");
    const empty = !draft.title && !draft.who && !draft.what && !draft.why && !draft.outOfScope && !draft.notes && !draft.criteria.length;
    if (empty) throw new RefinementError("bad-state", "write something in the draft first");
  }
  if (kind === "suggest") {
    if (!s.brief) throw new RefinementError("bad-state", "ask the architect to look at the code first");
    if (!draft) throw new RefinementError("not-found", "no such story draft");
    if (field === "criteria" && !talk.map.rules.length && !talk.map.examples.length) {
      throw new RefinementError("bad-state", "there is no rule and no example in the map yet; ask for a round of questions and accept some entries first");
    }
    if ((draft.suggestions ?? []).filter((x) => x.field !== field).length >= SUGGESTIONS_MAX) throw new RefinementError("limit", `at most ${SUGGESTIONS_MAX} suggestions wait for a draft; accept or reject some first`);
  }

  if (s.log.length + architectLogRoom(kind) > LOG_LIMIT - 1) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
  const parsed = parseFlow(readFileSync(join(flowDir("builtin", ""), `${kind === "brief" ? REFINE_BRIEF_FLOW : REFINE_ROUND_FLOW}.yaml`), "utf8"));
  const flow = kind === "suggest" || kind === "review" ? { ...parsed, limits: { ...parsed.limits, max_cost_usd: SUGGEST_MAX_COST_USD } } : parsed;
  let task: string;
  if (kind === "brief") task = s.idea;
  else if (draft && kind === "review") task = reviewText({ idea: s.idea, brief: s.brief?.text, talk, draft });
  else if (draft) {
    const rejectedHere = s.drafts.flatMap((d) => (d.rejected ?? []).map((r) => ({ ...r, own: d.id === draft.id && r.field === field })));
    task = suggestText({ idea: s.idea, brief: s.brief?.text, talk, draft, field, drafts: s.drafts, rejected: rejectedHere });
  } else {
    const rejected = s.log.flatMap((l) => (l.what === "entry-rejected" && l.detail && l.list ? [{ list: l.list, text: l.detail }] : []));
    task = talkText({ kind: kind as "round" | "question", idea: s.idea, brief: s.brief?.text, talk, rejected, question });
  }
  const runId = deps.scheduler.submit(
    { kind: "run", flow, task, repo: resolve(deps.repo), vars: { ...flow.vars, github_repo: s.repo, ...(kind !== "brief" ? { ask: kind } : {}), ...(kind === "suggest" ? { field } : {}) }, frozenVars: true },
    { source, owner: actor.id, queuedBy: actor.id, lockKey: source },
  );
  try {
    setArchitectRun(actor, s.id, runId, { kind, question, ...(draft ? { draft: draft.id, ...(kind === "suggest" ? { field } : {}) } : {}) });
  } catch (e) {
    deps.scheduler.cancel(runId);
    throw e;
  }
  return { runId, resumed: false };
}

/**
 * The session is dropped: cancels its read. An active run is ended by the hook (as "It was cancelled"); a queued job or
 * a paused run, which no process holds, is ended here. Returns true when something was cancelled.
 */
export function stopArchitect(deps: ArchitectDeps, id: string): boolean {
  const a = getSession(id)?.architect;
  if (!a) return false;
  const runId = a.runId;
  if (a.failed !== undefined && !live(deps, runId)) return false;
  deps.scheduler.cancel(runId);
  if (deps.scheduler.isActive(runId)) return true;
  let run: RunSummary | undefined;
  try {
    run = runOf(deps, runId);
  } catch {
    run = undefined;
  }
  if (run && run.status !== "stopped") {
    // It had ended already: the session takes that end.
    settleSession(deps, id);
    return false;
  }
  if (run) {
    try {
      saveRun({ ...run, status: "cancelled", reason: "cancelled by user", waiting: undefined, finishedAt: new Date().toISOString() });
    } catch {
      deps.log?.("refinement: the paused run could not be saved as cancelled");
    }
  }
  endArchitectRun(id, runId, { failed: "It was cancelled" });
  return true;
}

/** The runs of the architect that a session records (also those marked failed), for an account whose sessions go away. */
export function architectRunsOf(owner: string): string[] {
  return listSessions(owner).flatMap((s) => (s.architect ? [s.architect.runId] : []));
}

/** Cancels runs that no session holds any more: queued and running ones are stopped, a paused one is saved as cancelled. Never throws. */
export function cancelReads(deps: ArchitectDeps, runIds: string[]): void {
  for (const runId of runIds) {
    try {
      deps.scheduler.cancel(runId);
      if (deps.scheduler.isActive(runId)) continue;
      const run = runOf(deps, runId);
      if (run?.status === "stopped") saveRun({ ...run, status: "cancelled", reason: "cancelled by user", waiting: undefined, finishedAt: new Date().toISOString() });
    } catch {
      deps.log?.("refinement: a read could not be cancelled");
    }
  }
}

/** The scheduler's hook for a finished run of a refinement session. Never throws. */
export function settleFinished(deps: ArchitectDeps, run: RunSummary): void {
  try {
    const id = refinementSessionOf(run.source);
    if (!id) return;
    const end = endOf(run);
    if (end === "paused") return;
    endArchitectRun(id, run.runId, end);
  } catch (e) {
    deps.log?.(e instanceof StoreError ? `refinement: ${basename(e.file)} ${e.kind}` : `refinement: unexpected ${e instanceof Error ? e.name : "error"}`);
  }
}
