import { createHash } from "node:crypto";
import { z } from "zod";
import { writeAudit, type ActionAuditEvent } from "../auth/audit.js";
import type { User } from "../auth/users.js";
import type { RunSummary } from "../engine/state.js";
import { isRefinementRun } from "../auth/run-owner.js";
import { ACTIONS, LIST_MAX, type ActionDef, type About } from "../help/contract.js";
import { ActionGrants, grantsOf, sameBinding, type Grant, type GrantBinding } from "../help/grants.js";
import { OutcomeSchema, type Outcome, type OutcomeResult, type Seen, SEEN } from "../help/outcome.js";
import type { Impact } from "../help/plan.js";
import { HelpError, addOutcome, getConversation } from "../help/store.js";
import { REFUSAL_WORDS, type Asker, type RefusalCode } from "../help/turn.js";
import type { Scheduler } from "../queue/scheduler.js";
import { gateRun } from "../run-gate.js";
import { cancelRun, checkResume, readRun, startResume } from "./api-runs.js";
import { currentAccount } from "./help-context.js";
import { HttpError } from "./http.js";
import { authorize, findRule } from "./permissions.js";
import type { ApiContext } from "./server.js";

/** How long the server waits for a run to show the result of an action, in ms. */
export const READ_BACK_MS = 5000;

export type ActionRefusalCode = "off" | "paused" | "actions-off" | "not-allowed" | "limit" | "bad-request" | "not-found" | "deleted" | "bad-state" | "token" | "stale" | "not-owner" | "not-applies" | "gate" | "error";

/** A confirmation or preview that was refused. The message is safe to show; nothing was changed. */
export class ActionRefused extends Error {
  constructor(
    public code: ActionRefusalCode,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActionRefused";
  }
}

export interface ActionDeps {
  /** Whether the account may use Ask SCF now (`helpAllowed`); passed in, so this file does not import the routes. */
  allow: (a: Asker) => RefusalCode | undefined;
  grants?: ActionGrants;
  gate?: typeof gateRun;
  readBackMs?: number;
  audit?: (by: string, e: ActionAuditEvent) => void;
  now?: () => Date;
}

const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/**
 * A hash of what an action depends on: the run, the queue, and the identity of the job that waits for the run. A job
 * that was taken out and queued again changes it, also when every other field is the same.
 */
export function stateVersion(scheduler: Scheduler, runId: string): string {
  const run = readRun(scheduler, runId);
  const last = run?.history?.[run.history.length - 1];
  const lastAnswer = run?.answers?.[run.answers.length - 1];
  const q = scheduler.queuedJob(runId);
  return sha({
    status: run?.status ?? null,
    history: run ? run.history.length : null,
    last: last ? { id: last.id, ok: last.ok, visit: last.visit } : null,
    answers: run?.answers?.length ?? 0,
    lastAnswer: lastAnswer?.at ?? null,
    next: run?.state?.next ?? null,
    waiting: run?.waiting?.stepId ?? null,
    resumes: run?.resumes ?? 0,
    finishedAt: run?.finishedAt ?? null,
    queued: scheduler.isQueued(runId),
    active: scheduler.isActive(runId),
    job: q
      ? { enqueuedAt: q.enqueuedAt, kind: q.job.kind, from: q.job.kind === "resume" ? (q.job.from ?? null) : null, decision: q.job.kind === "resume" ? (q.job.decision ?? null) : null, source: q.source ?? null, priority: !!q.priority, queuedBy: q.queuedBy ?? null }
      : null,
  });
}

/** Whether the action would still make sense for the run now. */
export function applies(action: string, run: RunSummary | undefined, scheduler: Scheduler): boolean {
  if (!run) return false;
  const queued = scheduler.isQueued(run.runId);
  const active = scheduler.isActive(run.runId);
  if (action === "resume-run") {
    // A run without its flow is allowed: the runner refuses it while it runs, and that result is read back as start-failed.
    return !isRefinementRun(run.source) && !active && !queued && ["failed", "stopped", "cancelled"].includes(run.status) && !!run.state?.next;
  }
  if (action === "cancel-run") return queued || active || run.status === "waiting" || run.status === "stopped";
  return false;
}

const STATUS_WORDS: Record<string, string> = {
  running: "is running",
  waiting: "waits for approval",
  stopped: "stopped and waits for you",
  failed: "failed",
  cancelled: "was cancelled",
  succeeded: "succeeded",
};
const STEP_ID = /^[\w.-]{1,64}$/;

export interface Preview {
  action: string;
  title: string;
  about: About;
  now: string;
  changes: string;
  impact: string;
  impactLevel: Impact;
  undo: string;
  undoable: boolean;
  who: string;
}

export const WHO = "Only the owner of the run. An administrator too can do this only for their own runs.";

/** What the action would do, in the server's own words. Only the status, the step id and the run id are put in. */
export function previewOf(def: ActionDef, run: RunSummary, scheduler: Scheduler): Preview {
  const queued = scheduler.isQueued(run.runId);
  const active = scheduler.isActive(run.runId);
  const resume = def.id === "resume-run";
  const next = run.state?.next;
  const now = [
    `The run ${run.runId} ${STATUS_WORDS[run.status] ?? "is in a state Ask SCF does not know"}.`,
    queued ? "It is in the queue." : active ? "It is working now." : "",
    resume && typeof next === "string" && STEP_ID.test(next) ? `It would go on at step "${next}".` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const changes = resume
    ? `The run is put in the queue and goes on from step "${typeof next === "string" && STEP_ID.test(next) ? next : "where it stopped"}" when a slot is free.`
    : queued
      ? "The job that waits in the queue is taken out."
      : active
        ? "The run is stopped and marked as cancelled."
        : "The run is marked as cancelled.";
  const undo = resume ? "You can cancel the run on its page." : "Ask SCF cannot undo this. A cancelled run can be resumed on its page later.";
  return { action: def.id, title: def.title, about: { kind: "run", id: run.runId }, now, changes, impact: def.effect, impactLevel: def.impact, undo, undoable: def.undoable, who: WHO };
}

type Was = "pending" | "active" | "other";
interface Words {
  words: (seen: Seen, was?: Was) => string;
  recovery: string;
}
const MISSING: Words = { words: () => "The run is gone. Ask SCF cannot confirm what the action did.", recovery: "Open Runs to see your runs." };
const UNCONFIRMED: Words = { words: () => "Ask SCF could not confirm what happened to the run.", recovery: "Open the run and check its state before you try again." };
const SEE_STATE = "Open the run to see its state.";
const RESUME_LATER = "Open the run. You can resume it there if you still want the work.";

/** What a person reads for every outcome, in the server's fixed words. */
export const OUTCOME_WORDS: Record<"resume-run" | "cancel-run", Partial<Record<OutcomeResult, Words>>> = {
  "resume-run": {
    done: { words: () => "The run was resumed. The server read it back: it goes on from where it stopped.", recovery: "Open the run to follow it. You can cancel it there." },
    queued: { words: () => "The resume waits in the queue. The run starts when a slot is free.", recovery: "Open the run to follow it. You can cancel the waiting job there." },
    "start-failed": { words: () => "The run could not be started again. It is still as it was.", recovery: "Open the run: its log says why." },
    missing: MISSING,
    unconfirmed: UNCONFIRMED,
  },
  "cancel-run": {
    dequeued: { words: (seen) => `The job that waited in the queue was taken out. The run is now ${seen}.`, recovery: SEE_STATE },
    stopped: { words: () => "The run was stopped and is marked as cancelled.", recovery: RESUME_LATER },
    stopping: { words: () => "The run is being stopped. It had not ended yet when Ask SCF looked.", recovery: "Open the run to see when it ends." },
    "not-done": { words: (seen, was) => (was === "active" ? `The run ended on its own as ${seen} before the stop took effect.` : `The run was not cancelled. It is ${seen}.`), recovery: SEE_STATE },
    done: { words: () => "The run is marked as cancelled. The server read it back.", recovery: RESUME_LATER },
    missing: MISSING,
    unconfirmed: UNCONFIRMED,
  },
};

// ---- the checks ------------------------------------------------------------------------------------

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const targetOf = (id: string | undefined) => (id !== undefined && ID_SHAPE.test(id) ? `conversation ${id}` : "conversation");

const asAsker = (user: User): Asker => ({ id: user.id, role: user.role === "admin" ? "admin" : "user" });

/** The settings and the account, checked now. Returns the account as it is now. */
function checkSwitches(ctx: ApiContext, asker: Asker, deps: ActionDeps): User {
  const help = ctx.config().help;
  if (!help.enabled) throw new ActionRefused("off", 503, REFUSAL_WORDS.off);
  if (help.paused === true) throw new ActionRefused("paused", 503, REFUSAL_WORDS.paused);
  if (!help.actions) throw new ActionRefused("actions-off", 503, "Ask SCF may not carry out actions on this Foundry. An administrator can switch this on.");
  const now = currentAccount(asker);
  if (!now) throw new ActionRefused("not-allowed", 403, REFUSAL_WORDS["not-allowed"]);
  let no: RefusalCode | undefined;
  try {
    no = deps.allow(asker);
  } catch {
    no = "not-allowed";
  }
  if (no === "limit") throw new ActionRefused("limit", 429, REFUSAL_WORDS.limit);
  if (no) throw new ActionRefused("not-allowed", 403, REFUSAL_WORDS["not-allowed"]);
  return now;
}

/** A store error as a refusal with a fixed code. */
function refusalOf(e: HelpError): ActionRefused {
  if (e.code === "not-found") return new ActionRefused("not-found", 404, e.message);
  if (e.code === "deleted") return new ActionRefused("deleted", 410, e.message);
  return new ActionRefused("bad-state", 409, e.message);
}

/** The proposed action at `index` of a finished reply of the owner. A deleted conversation is refused (the store gives its empty record). */
function replyAction(owner: string, conversation: string, message: string, index: number) {
  let c;
  try {
    c = getConversation(owner, conversation);
  } catch (e) {
    if (e instanceof HelpError) throw refusalOf(e);
    throw e;
  }
  if (c.state === "deleted") throw new ActionRefused("deleted", 410, "this conversation was deleted");
  const m = c.messages.find((x) => x.id === message && x.role === "assistant" && x.status === "done");
  const action = m?.reply?.actions[index];
  if (!action) throw new ActionRefused("not-found", 404, "no such action in this answer");
  return action;
}

/** The permission of the same button on the run's page, and that the run is the account's own (an admin too). */
function mayAct(ctx: ApiContext, fresh: User, verb: "resume" | "cancel", runId: string): void {
  const seg = ["runs", runId, verb];
  const rule = findRule("POST", seg);
  try {
    if (!rule) throw new Error("no rule");
    authorize(ctx, fresh, rule, seg);
  } catch {
    throw new ActionRefused("not-owner", 404, "run not found");
  }
  if (ctx.scheduler.ownerOf(runId) !== fresh.id) throw new ActionRefused("not-owner", 404, "run not found");
}

const verbOf = (action: string): "resume" | "cancel" => (action === "resume-run" ? "resume" : "cancel");
const defOf = (id: string): ActionDef => {
  const def = ACTIONS.find((a) => a.id === id);
  if (!def) throw new ActionRefused("not-found", 404, "no such action in this answer");
  return def;
};

const INDEX = z.number().int().min(0).max(LIST_MAX.actions - 1);
const PrepareBody = z.object({ message: z.uuid(), index: INDEX }).strict();
const ConfirmBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), message: z.uuid(), index: INDEX }).strict();
const CancelBody = z.object({ token: z.string().min(1).max(200) });
const bad = () => new ActionRefused("bad-request", 400, "send the answer, the number of the action and its token");

// ---- preview and drop ------------------------------------------------------------------------------

/** Describes an action in the server's words and gives a token that works once. Nothing changes except an in-memory grant. */
export function prepareAction(ctx: ApiContext, user: User, conversation: string, body: unknown, deps: ActionDeps): { token: string; expiresAt: string; preview: Preview } {
  const grants = deps.grants ?? grantsOf(ctx);
  const fresh = checkSwitches(ctx, asAsker(user), deps);
  const parsed = PrepareBody.safeParse(body);
  if (!parsed.success) throw bad();
  const { message, index } = parsed.data;
  const proposed = replyAction(user.id, conversation, message, index);
  const def = defOf(proposed.id);
  const runId = proposed.about.id;
  mayAct(ctx, fresh, verbOf(def.id), runId);
  const run = readRun(ctx.scheduler, runId);
  if (!run || !applies(def.id, run, ctx.scheduler)) throw new ActionRefused("not-applies", 409, "this action does not fit the run any more; ask again");
  const preview = previewOf(def, run, ctx.scheduler);
  const version = stateVersion(ctx.scheduler, runId);
  const { token, expiresAt } = grants.issue({ owner: user.id, conversation, message, index, action: def.id, about: { ...proposed.about }, version });
  return { token, expiresAt: new Date(expiresAt).toISOString(), preview };
}

/** Drops the token of a preview. Needs no switch and no store read. */
export function cancelAction(ctx: ApiContext, user: User, conversation: string, body: unknown, deps: ActionDeps): { cancelled: boolean } {
  const parsed = CancelBody.safeParse(body);
  if (!parsed.success) throw new ActionRefused("bad-request", 400, "send the token");
  return { cancelled: (deps.grants ?? grantsOf(ctx)).cancel(parsed.data.token, user.id, conversation) };
}

// ---- the read-back ---------------------------------------------------------------------------------

/**
 * Watches a run for the read-back. The subscription and the timer are released by `close`, which the caller calls in
 * a `finally`. Events that `subscribe` replays are ignored (`armed` is set after it returns).
 */
function watchRun(s: Scheduler, runId: string, ms: number, ready: (r: RunSummary) => boolean) {
  let armed = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const unsubscribe = s.subscribe(runId, (e) => {
    if (armed && e.type === "update" && ready(e.summary)) wake?.();
  });
  armed = true;
  return {
    /** Resolves when the run shows what was waited for, `wait` resolves, or the time is over. A rejection of `wait` is thrown. */
    until(withWait: boolean): Promise<{ waited: boolean }> {
      return new Promise((resolve, reject) => {
        let done = false;
        const end = (waited: boolean) => {
          if (!done) {
            done = true;
            resolve({ waited });
          }
        };
        wake = () => end(false);
        timer = setTimeout(() => end(false), ms);
        timer.unref();
        if (withWait) {
          s.wait(runId).then(
            () => end(true),
            (e) => {
              if (!done) {
                done = true;
                reject(e);
              }
            },
          );
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    },
  };
}

/** The run as it is now: `ok` is false when it cannot be read, `run` is undefined when it is gone. */
function readNow(s: Scheduler, runId: string): { ok: boolean; run?: RunSummary } {
  try {
    return { ok: true, run: s.get(runId) };
  } catch {
    return { ok: false };
  }
}

const seenOf = (r: { ok: boolean; run?: RunSummary }): Seen => (!r.ok ? "unknown" : !r.run ? "missing" : (SEEN as readonly string[]).includes(r.run.status) ? (r.run.status as Seen) : "unknown");

// ---- confirm ---------------------------------------------------------------------------------------

/**
 * Carries out a previewed action. Everything up to the gate may be refused (and is audited once); from `take` to the
 * executor there is no `await`, so two confirms cannot both pass. After the executor, nothing is refused: the
 * answer is the outcome, read back from the run.
 */
export async function confirmAction(ctx: ApiContext, user: User, conversation: string, readBody: () => Promise<unknown>, deps: ActionDeps): Promise<{ outcome: Outcome; stored: boolean }> {
  const grants = deps.grants ?? grantsOf(ctx);
  const auditLine = (result: "ok" | "failed", detail: string): boolean => {
    const e: ActionAuditEvent = { action: "help-action", result, target: targetOf(conversation), detail };
    try {
      (deps.audit ?? ((by, ev) => writeAudit(by, ev, 0)))(user.id, e);
      return true;
    } catch {
      ctx.diagLog?.("help: audit.jsonl not written (help-action)");
      return false;
    }
  };
  let known: { action: string; runId: string } | undefined;
  let fresh: User;
  let grant: Grant;
  try {
    checkSwitches(ctx, asAsker(user), deps);
    let raw: unknown;
    try {
      raw = await readBody();
    } catch (e) {
      if (e instanceof HttpError) throw new ActionRefused("bad-request", e.status, e.message);
      throw e;
    }
    const parsed = ConfirmBody.safeParse(raw);
    if (!parsed.success) throw bad();
    const { token, message, index } = parsed.data;
    const bind: GrantBinding = { owner: user.id, conversation, message, index };
    const peeked = grants.peek(token);
    if (!peeked) throw new ActionRefused("token", 409, "this confirmation does not work: it was used, has expired or was dropped; ask for a new preview");
    if (!sameBinding(peeked, bind)) {
      grants.take(token, bind); // burns it
      throw new ActionRefused("token", 409, "this confirmation does not fit this action; ask for a new preview");
    }
    known = { action: peeked.action, runId: peeked.about.id };
    const runId = peeked.about.id;
    if (peeked.action === "resume-run") {
      try {
        await checkResume(ctx, user, runId, "resume", {}, deps.gate ?? gateRun);
      } catch (e) {
        if (e instanceof HttpError) throw new ActionRefused(e.status === 404 ? "not-found" : "gate", e.status, e.message);
        throw e;
      }
    }
    // ---- from here to the executor there is no await ----
    const taken = grants.take(token, bind);
    if (!taken.ok) throw new ActionRefused("token", 409, "this confirmation does not work: it was used, has expired or was dropped; ask for a new preview");
    grant = taken.grant;
    const proposed = replyAction(user.id, conversation, message, index);
    if (proposed.id !== grant.action || proposed.about.id !== grant.about.id || proposed.about.kind !== grant.about.kind) throw new ActionRefused("token", 409, "this confirmation does not fit this action; ask for a new preview");
    if (stateVersion(ctx.scheduler, runId) !== grant.version) throw new ActionRefused("stale", 409, "The run changed since the preview. Ask for a new preview.");
    fresh = checkSwitches(ctx, asAsker(user), deps);
    mayAct(ctx, fresh, verbOf(grant.action), runId);
    if (!applies(grant.action, readRun(ctx.scheduler, runId), ctx.scheduler)) throw new ActionRefused("not-applies", 409, "this action does not fit the run any more; ask again");
  } catch (e) {
    const refused = e instanceof ActionRefused ? e : e instanceof HelpError ? refusalOf(e) : undefined;
    auditLine("failed", `${known ? `${known.action}; run ${known.runId}; ` : ""}refused: ${refused?.code ?? "error"}`);
    throw refused ?? e;
  }

  const def = defOf(grant.action);
  const runId = grant.about.id;
  const s = ctx.scheduler;
  const ms = deps.readBackMs ?? READ_BACK_MS;
  const facts: { waited: boolean; returned?: boolean; was: Was; before: number } = {
    waited: false,
    was: s.isQueued(runId) ? "pending" : s.isActive(runId) ? "active" : "other",
    before: readRun(s, runId)?.resumes ?? 0,
  };
  // One error boundary: whatever the executor and the read-back throw, the token is used up and the result follows the state.
  try {
    if (def.id === "resume-run") {
      const w = watchRun(s, runId, ms, (r) => (r.resumes ?? 0) > facts.before);
      try {
        const run = s.get(runId)!;
        startResume(ctx, fresh, runId, run, "resume", { source: "ui help resume" });
        if (!s.isQueued(runId) && (readRun(s, runId)?.resumes ?? 0) <= facts.before) facts.waited = (await w.until(true)).waited;
      } finally {
        w.close();
      }
    } else {
      const w = watchRun(s, runId, ms, () => false);
      try {
        facts.returned = cancelRun(ctx, fresh, runId);
        if (facts.was === "active") facts.waited = (await w.until(true)).waited;
      } finally {
        w.close();
      }
    }
  } catch {
    ctx.diagLog?.(`help: action ${def.id} did not end cleanly`);
  }

  const now = readNow(s, runId);
  const result = decide(def.id, facts, now, s, runId);
  const seen = seenOf(now);
  const table = OUTCOME_WORDS[def.id as "resume-run" | "cancel-run"];
  const w = table[result] ?? UNCONFIRMED;
  const outcome: Outcome = OutcomeSchema.parse({ action: def.id, about: { ...grant.about }, result, words: w.words(seen, facts.was), recovery: w.recovery, seen, at: (deps.now ?? (() => new Date()))().toISOString() });
  let stored = true;
  try {
    addOutcome(user.id, conversation, grant.message, outcome);
  } catch {
    stored = false;
    ctx.diagLog?.("help: an outcome could not be stored");
  }
  if (!auditLine("ok", `${def.id}; run ${runId}; ${result}`)) stored = false;
  return { outcome, stored };
}

/** The result, decided from the fresh state only. */
function decide(action: string, f: { waited: boolean; returned?: boolean; was: Was; before: number }, now: { ok: boolean; run?: RunSummary }, s: Scheduler, runId: string): OutcomeResult {
  if (!now.ok) return "unconfirmed";
  if (action === "resume-run") {
    if (!now.run) return "missing";
    if ((now.run.resumes ?? 0) > f.before) return "done";
    if (s.isQueued(runId)) return "queued";
    return f.waited ? "start-failed" : "unconfirmed";
  }
  if (f.was === "pending") {
    if (f.returned === true && !s.isQueued(runId)) return "dequeued";
    return s.isQueued(runId) ? "not-done" : "unconfirmed";
  }
  if (!now.run) return "missing";
  if (f.was === "active") {
    // cancelled comes first: a stopped run that is still finishing is saved as cancelled while it is active
    if (now.run.status === "cancelled") return "stopped";
    return s.isActive(runId) ? "stopping" : "not-done";
  }
  return now.run.status === "cancelled" ? "done" : "not-done";
}
