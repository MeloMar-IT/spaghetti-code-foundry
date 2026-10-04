import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { KEY_MISSING, KEY_UNREADABLE, NEEDS_TOKEN, NO_RUN_OWNER, TOKEN_MISSING, TOKEN_UNREADABLE, ownsRepo } from "../auth/repos.js";
import { REFINEMENT_SOURCE } from "../auth/run-owner.js";
import { StoreError } from "../auth/store.js";
import { SIGN_IN_SENTENCES, TOKEN_REFUSED_REASON } from "../engine/guards.js";
import { saveRun, type RunSummary } from "../engine/state.js";
import { flowDir, parseFlow } from "../flow/load.js";
import { REFINE_BRIEF_FLOW } from "../flow/usage.js";
import type { Scheduler } from "../queue/scheduler.js";
import { refinementSessionOf, userError } from "../server/user-view.js";
import {
  LOG_LIMIT,
  RefinementError,
  endArchitectRun,
  getSession,
  listSessions,
  noteArchitectResumed,
  setArchitectRun,
  type Actor,
  type ArchitectEnd,
  type Session,
} from "./store.js";

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

/** What an ended run means for the session: a brief, a failure, or "paused" (nothing to store). */
function endOf(run: RunSummary): ArchitectEnd | "paused" {
  if (run.status === "stopped") return "paused";
  if (run.status !== "succeeded") return { failed: architectReason(run) };
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
  const known = new Set([s.architect?.runId, s.brief?.runId]);
  const q = deps.scheduler.queue();
  let found = [...q.pending, ...q.active].find((j) => j.source === source && !known.has(j.runId))?.runId;
  let seen = scanned.get(deps.scheduler);
  if (!seen) scanned.set(deps.scheduler, (seen = new Set()));
  if (!found && !seen.has(s.id)) {
    seen.add(s.id);
    const since = Date.parse(s.updated);
    found = deps.scheduler
      .briefs()
      .filter((b) => b.source === source && !known.has(b.runId) && Date.parse(b.startedAt) > since)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.runId;
  }
  if (!found) return s;
  try {
    return setArchitectRun({ id: s.owner, admin: false }, s.id, found);
  } catch {
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
  if (deps.scheduler.isQueued(runId)) return { state: "queued", runId };
  if (deps.scheduler.isActive(runId)) {
    let run: RunSummary | undefined;
    try {
      run = runOf(deps, runId);
    } catch {
      run = undefined;
    }
    return { state: "running", runId, doing: doingOf(run) };
  }
  if (a.failed !== undefined) return { state: "failed", runId, reason: a.failed };
  const end = endFor(deps, runId);
  if (end === "paused") {
    const run = runOf(deps, runId)!;
    return { state: "paused", runId, reason: pausedReason(run) };
  }
  // Not settled yet (the hook has not run, or the lock was busy): what it would be, not stored.
  return { state: "failed", runId, reason: "failed" in end ? end.failed : "The brief is being stored" };
}

const busy = (m: string) => new RefinementError("busy", m);

/**
 * The owner asks the architect to read for a session: a new run, or the resume of a paused one. At most one read per
 * account is queued, running or paused. Returns the run id and whether it was a resume.
 */
export function askArchitect(deps: ArchitectDeps, actor: Actor, id: string): { runId: string; resumed: boolean } {
  const found = getSession(id);
  if (!found) throw new RefinementError("not-found", "no such refinement session");
  if (found.owner !== actor.id) throw actor.admin ? new RefinementError("not-owner", "only the owner can ask the architect") : new RefinementError("not-found", "no such refinement session");
  if (found.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be read; restore it first");
  if (!ownsRepo(found.owner, found.repo)) throw new RefinementError("no-repo", "the repository is not in My repositories any more");
  const s = settleSession(deps, id);
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
  if (s.architect && s.architect.failed === undefined) {
    const paused = statusOf(deps, s.architect.runId) === "stopped";
    if (paused) {
      const run = runOf(deps, s.architect.runId);
      if (run?.workdir && existsSync(run.workdir)) {
        deps.scheduler.submit({ kind: "resume", runId: s.architect.runId }, { source, queuedBy: actor.id, lockKey: source });
        noteArchitectResumed(s.id, s.architect.runId);
        return { runId: s.architect.runId, resumed: true };
      }
      endArchitectRun(s.id, s.architect.runId, { failed: "The folder of the read is gone" });
    }
  }

  if (s.log.length + 2 > LOG_LIMIT - 1) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
  const flow = parseFlow(readFileSync(join(flowDir("builtin", ""), `${REFINE_BRIEF_FLOW}.yaml`), "utf8"));
  const runId = deps.scheduler.submit(
    { kind: "run", flow, task: s.idea, repo: resolve(deps.repo), vars: { ...flow.vars, github_repo: s.repo }, frozenVars: true },
    { source, owner: actor.id, queuedBy: actor.id, lockKey: source },
  );
  try {
    setArchitectRun(actor, s.id, runId);
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
