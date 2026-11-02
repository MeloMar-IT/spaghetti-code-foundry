import { runLimit } from "../ops/caps.js";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flowFileId } from "../promotion/flow-id.js";
import type { Config } from "../config.js";
import type { ApprovalDecision } from "../engine/execute.js";
import { cancelStoppedRun, cancelWaitingRun, newRunId, resumeRun, runFlow, saveAnswer } from "../engine/runner.js";
import { RESTART_INTERRUPT } from "../engine/running.js";
import { listRunBriefs, listRunBriefsAsync, listRunIds, loadRun, loadRunAsync, readLiveLog, runUpdatedAt, setRunArchived, setRunParked, clearRunParked, spentTodayBy, type RunBrief, type RunSummary } from "../engine/state.js";
import type { Flow } from "../flow/schema.js";
import { redactText } from "../credentials/redact.js";
import { withGhEnv } from "../github.js";
import { isRefinementRun } from "../auth/run-owner.js";

/**
 * A schedule chore of a watcher (the daily release, the daily report): `watcher <id> schedule`. Chores have their own lane:
 * they use no story slot and go before stories, one chore at a time on the whole machine. They run no agent, so they cost
 * nothing; their only load is one test run, which still waits for a test slot.
 */
export const choreWatcherOf = (source?: string): string | undefined => /^watcher (\S+) schedule$/.exec(source ?? "")?.[1];
export const isChoreRun =(source?: string): boolean => typeof source === "string" && /^watcher \S+ schedule$/.test(source);
/** Runs that use no story slot: architect runs of a refinement session and schedule chores. */
const ownLane = (source?: string): boolean => isRefinementRun(source) || isChoreRun(source);
import { runIdsStartedToday } from "./usage.js";
import { MERGE_GUARD, mergeStarted } from "./overrule.js";
import { stepIs } from "../next-step.js";
import type { Actor } from "../evidence/identity.js";
import { actorOf } from "../evidence/record.js";

const MAX_LOG_LINES = 5000;
/** How often the queue looks again while a helper's cap holds new runs back: a cap ends without any event. */
const CAP_RECHECK_MS = 30_000;

export type Job =
  | { kind: "run"; flow: Flow; task: string; repo: string; vars: Record<string, string>; /** `vars` is final: the folder's settings were applied when it was queued. */ frozenVars?: boolean }
  | { kind: "resume"; runId: string; from?: string; decision?: ApprovalDecision };

export interface QueuedJob {
  runId: string;
  job: Job;
  /** Jobs with the same lock key never run at the same time (e.g. one ticket). */
  lockKey?: string;
  /** Who queued it, e.g. "watcher acme/app#7" or "ui". */
  source?: string;
  /** The id of the account that queued it. */
  owner?: string;
  /** The id of the account that queued it (UI). Absent for watchers, the CLI and older versions. */
  queuedBy?: string;
  /** Set for one_per_repo flows: only one active job per repo key. */
  repoLock?: string;
  enqueuedAt: string;
  /** A bug story: it starts before all other jobs when a slot is free. */
  priority?: boolean;
  /** When the story's issue was created: among priority jobs, the oldest goes first. */
  storyAt?: string;
  /** The flow's id under `scf promote`, saved when the job was queued (see flowFileId). Absent: the flow's name, or for older jobs the file found when the run starts. */
  flowId?: string;
  /** A resume that is a retry after a time limit (auto_retry.timeouts): it waits for a helper's cap like a new run, it is not a run of the day, and a cancel ends the run. */
  asNewRun?: boolean;
}

export interface JobMeta { lockKey?: string; source?: string; owner?: string; queuedBy?: string; priority?: boolean; storyAt?: string; asNewRun?: boolean }

/** The time a priority job is ordered by: the issue's creation time, else when it was queued. */
const storyTime = (q: QueuedJob): number => {
  const t = Date.parse(q.storyAt ?? q.enqueuedAt);
  return Number.isNaN(t) ? 0 : t;
};

export type RunEvent = { type: "log"; line: string } | { type: "update"; summary: RunSummary };

interface Active {
  queued: QueuedJob;
  controller: AbortController;
  lines: string[];
  summary?: RunSummary;
  listeners: Set<(e: RunEvent) => void>;
  done: Promise<RunSummary | undefined>;
  /** The account the run counts for in limits. Falls back to the run's owner when it is not set (a run nobody owned). */
  account?: string;
  /** The round-robin group: the owner when the job was queued, "" for jobs without an owner. Never changes. */
  group: string;
  /** Evidence only: who cancelled the run. */
  cancelledBy?: Actor;
  /** Set once the run reached a merge: a stop request is not taken any more. */
  merging?: boolean;
}

/** Which per-user limit holds a job back. */
export type UserLimit = "concurrent" | "per_day" | "budget";

export interface SchedulerOptions {
  runsDir: string;
  config: () => Config;
  claudeBin?: string;
  /** Test hook: the Codex binary agent steps call. */
  codexBin?: string;
  /** Evals only (src/evals.ts, src/skill-eval/run.ts): every run is a local test (#740), never checked against `promotion.enforce`, and not checked for governance (#665). A job cannot ask for it. */
  localTest?: boolean;
  /** Evals only: folders put first on the PATH of every step of the runs. */
  pathPrefix?: string[];
  /** Where pending jobs are saved so they survive restarts. */
  queueFile?: string;
  /** Test hook: milliseconds between two looks at the queue while a helper's cap holds new runs back. */
  capRecheckMs?: number;
  /** False when the account is blocked or gone: the jobs it queued wait. Without it, no job is held. */
  accountActive?: (accountId: string) => boolean;
  /** The limits of an account. Without it, nobody is limited (CLI, evals). Runs already working are never stopped by a lower limit. */
  userLimits?: (accountId: string) => { maxConcurrent?: number; maxRunsPerDay?: number; dailyBudgetUsd?: number };
  /** Spend of an account's runs that started today. Default: read from the run files. */
  spentTodayBy?: (accountId: string) => number;
  /** New runs of an account that started today. Default: counted from the run files. */
  startedToday?: (accountId: string) => number;
  onFinished?: (summary: RunSummary, job: QueuedJob) => void;
  /** Makes a run id (default: newRunId). Tests use it to force a clash. */
  newId?: () => string;
}

const ID_TRIES = 20;

export type ArchiveResult = "done" | "same" | "busy" | "missing";

export interface AccountInfo {
  id: string;
  blocked: boolean;
}
export interface AccountCancelCounts {
  queued: number;
  running: number;
  waiting: number;
}
export interface AccountCancelled extends AccountCancelCounts {
  accountId: string;
  why: "blocked" | "deleted";
}

export { flowFileId };

/** The account that queued a job. Old entries have no `queuedBy`: a UI run was queued by its owner. */
export function queuerOf(q: QueuedJob): string | undefined {
  return q.queuedBy ?? (q.job.kind === "run" && q.source === "ui" ? q.owner : undefined);
}

/**
 * Runs jobs with a global concurrency limit and per-key locks. Pending jobs are
 * persisted; run progress is fanned out to subscribers (UI live logs).
 */
export class Scheduler {
  private pending: QueuedJob[] = [];
  private active = new Map<string, Active>();
  /** Stop requests of active runs: the reason they stop with before their next step. Memory only. */
  private stopRequests = new Map<string, string>();
  private lastStartAt = new Date().toISOString();
  private recent = new Map<string, Active>(); // finished, kept briefly for late subscribers
  /** Viewers of runs that are not running right now; attached when the run starts. */
  private pendingListeners = new Map<string, Set<(e: RunEvent) => void>>();
  /** Why a pending job waits for a user limit (memory only; rebuilt by every pump). */
  private limited = new Map<string, UserLimit>();
  /** When a group last got a slot (a sequence number, so two starts in one millisecond do not tie). Memory only. */
  private lastStartOf = new Map<string, number>();
  private startSeq = 0;
  /** New runs this scheduler started that are still active: they count before and after their run.json exists. */
  private started = new Map<string, { account: string; day: string }>();

  constructor(private o: SchedulerOptions) {
    if (o.queueFile && existsSync(o.queueFile)) {
      try {
        this.pending = JSON.parse(readFileSync(o.queueFile, "utf8")) as QueuedJob[];
      } catch {
        this.pending = [];
      }
    }
    queueMicrotask(() => this.pump());
  }

  /** A run id that no queued, active or saved run uses. */
  private freeId(): string {
    for (let i = 0; i < ID_TRIES; i++) {
      const id = (this.o.newId ?? newRunId)();
      if (!this.isQueued(id) && !this.isActive(id) && !existsSync(join(this.o.runsDir, id))) return id;
    }
    throw new Error("could not make a free run id; try again");
  }

  /** The account that started a run, also while it is still queued. Undefined: no owner, or the run cannot be read. Never throws. */
  ownerOf(runId: string): string | undefined {
    try {
      const owner = this.get(runId)?.owner;
      if (typeof owner === "string") return owner;
    } catch {
      // a run.json that cannot be read has no owner
    }
    const q = [...this.pending, ...[...this.active.values()].map((a) => a.queued)].find((p) => p.runId === runId && p.job.kind === "run");
    return typeof q?.owner === "string" ? q.owner : undefined;
  }

  /** New runs that started today per account, counted as the per-day limit counts them: every run folder plus runs just started in memory. */
  startedTodayByOwner(now = new Date()): Map<string, number> {
    const day = now.toDateString();
    const ids = new Map<string, Set<string>>();
    const add = (owner: string, id: string) => (ids.get(owner) ?? ids.set(owner, new Set()).get(owner)!).add(id);
    for (const b of listRunBriefs(this.o.runsDir)) {
      const t = new Date(b.startedAt);
      if (isRefinementRun(b.source) || Number.isNaN(t.getTime()) || t.toDateString() !== day) continue;
      add(b.owner ?? "", b.runId);
    }
    for (const [id, s] of this.started) if (s.day === day) add(s.account, id);
    return new Map([...ids].map(([o, s]) => [o, s.size]));
  }

  /** Saves an answer with a stopped run and queues its resume, in one synchronous step. The text goes to run.json only. */
  answer(runId: string, text: string, by: string, meta: JobMeta = {}): void {
    if (this.isActive(runId) || this.isQueued(runId)) throw new Error(`run ${runId} is already queued or running`);
    const { undo } = saveAnswer(this.o.runsDir, runId, text, by);
    try {
      this.put({ kind: "resume", runId }, meta);
    } catch (e) {
      // the job is not in the queue file and nothing started: take the answer back
      const i = this.pending.findIndex((p) => p.runId === runId);
      if (i >= 0) this.pending.splice(i, 1);
      undo(); // if this write fails too, the answer stays without a job; a later resume reads it
      throw e;
    }
    try {
      this.pump();
    } catch {
      // The answer and its job are saved: a queue write that fails now does not fail the call. The next queue change writes the file again.
    }
  }

  submit(job: Job, meta: JobMeta = {}): string {
    const runId = this.put(job, meta);
    this.pump();
    return runId;
  }

  /** Checks a job, puts it into the queue and writes the queue file. Starts nothing. */
  private put(job: Job, meta: JobMeta): string {
    const runId = job.kind === "run" ? this.freeId() : job.runId;
    if (job.kind === "resume" && (this.isActive(runId) || this.isQueued(runId))) throw new Error(`run ${runId} is already queued or running`);
    const repoLock = this.repoLockFor(job);
    const { priority, storyAt, ...rest } = meta;
    // the id is looked up here, once, and never taken from the caller: a file edited while the job waits keeps its id
    const flowId = job.kind === "run" && !this.o.localTest ? flowFileId(job.flow, job.repo) : undefined;
    const q: QueuedJob = {
      runId,
      job,
      ...rest,
      ...(repoLock ? { repoLock } : {}),
      ...(flowId ? { flowId } : {}),
      enqueuedAt: new Date().toISOString(),
      ...(priority ? { priority: true, ...(storyAt ? { storyAt } : {}) } : {}),
    };
    this.enqueue(q);
    this.persist();
    return runId;
  }

  /** Priority jobs go in front of the others, the oldest story first; the rest keep the order they were queued in. */
  private enqueue(q: QueuedJob) {
    let i = 0;
    if (q.priority) {
      while (i < this.pending.length && this.pending[i]!.priority && storyTime(this.pending[i]!) <= storyTime(q)) i++;
    } else {
      i = this.pending.filter((p) => p.priority).length;
      while (i < this.pending.length && Date.parse(this.pending[i]!.enqueuedAt) <= Date.parse(q.enqueuedAt)) i++;
    }
    this.pending.splice(i, 0, q);
  }

  /** Moves a queued job into the priority block, or back out of it. False when nothing changed or the job is not queued. */
  setPriority(runId: string, priority: boolean, storyAt?: string): boolean {
    const i = this.pending.findIndex((p) => p.runId === runId);
    if (i < 0) return false;
    const q = this.pending[i]!;
    if (!!q.priority === priority && (!priority || q.storyAt === storyAt)) return false;
    this.pending.splice(i, 1);
    delete q.priority;
    delete q.storyAt;
    if (priority) {
      q.priority = true;
      if (storyAt) q.storyAt = storyAt;
    }
    this.enqueue(q);
    this.persist();
    this.pump();
    return true;
  }

  /** "code:<owner/repo or local path>" for flows with one_per_repo, else undefined. */
  private repoLockFor(job: Job): string | undefined {
    let flow: Flow | undefined, vars: Record<string, string>, repo: string;
    if (job.kind === "run") ({ flow, vars, repo } = job);
    else {
      const s = loadRun(this.o.runsDir, job.runId);
      if (!s) return undefined;
      ({ flowDef: flow, vars, repo } = s);
    }
    if (!flow?.one_per_repo) return undefined;
    const gh = vars?.github_repo;
    return `code:${gh && gh !== "owner/repo" ? gh : resolve(repo)}`;
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  isQueued(runId: string) {
    return this.pending.some((p) => p.runId === runId);
  }

  /** A copy of the job that waits in the queue for this run, or undefined. Read only. */
  queuedJob(runId: string): QueuedJob | undefined {
    const q = this.pending.find((p) => p.runId === runId);
    return q ? structuredClone(q) : undefined;
  }

  isLocked(lockKey: string) {
    return [...this.active.values()].some((a) => a.queued.lockKey === lockKey) || this.pending.some((p) => p.lockKey === lockKey);
  }

  /** `by`: who asked, for the evidence of the run; without it the cancel is the Foundry's own. */
  cancel(runId: string, by?: Actor): boolean {
    const i = this.pending.findIndex((p) => p.runId === runId);
    if (i >= 0) {
      const [job] = this.pending.splice(i, 1);
      this.persist();
      if (job?.asNewRun) this.cancelStopped(runId, by); // a queued retry after a time limit: the cancel ends the run for good
      else if (job?.job.kind === "resume") this.cancelWaiting(runId, by); // a queued approval: the run no longer waits. A queued answer of a stopped run is only dropped: its answer stays and the run still waits for one
      return true;
    }
    const a = this.active.get(runId);
    if (!a) return this.cancelWaiting(runId, by) || this.cancelStopped(runId, by);
    // A run that stopped but is still finishing (its notification runs): the stop is saved, so cancel it like a stopped run.
    if (a.summary?.status === "stopped" && !a.controller.signal.aborted && this.cancelStopped(runId, by)) return true;
    a.cancelledBy ??= by;
    a.controller.abort();
    return true;
  }

  /** Asks an active run to stop before its next step (never during a merge). False when it is not active, is cancelled or ending, merges, or the reason is empty. */
  requestStop(runId: string, reason: string): boolean {
    const a = this.active.get(runId);
    const why = typeof reason === "string" ? reason.trim() : "";
    if (!a || !why || a.merging || a.controller.signal.aborted) return false;
    if (a.summary && (a.summary.status !== "running" || mergeStarted(a.summary, 0))) return false;
    this.stopRequests.set(runId, why);
    return true;
  }

  /** Stops these active runs for a restart (they end as interrupted and the watchers resume them). True when none of them is active within timeoutMs. */
  async interrupt(runIds: string[], timeoutMs = 60_000): Promise<boolean> {
    const list = runIds.map((id) => this.active.get(id)).filter((a): a is Active => a !== undefined);
    if (!list.length) return true;
    for (const a of list) if (!a.controller.signal.aborted) a.controller.abort(RESTART_INTERRUPT);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
      timer.unref();
    });
    const ok = await Promise.race([Promise.allSettled(list.map((a) => a.done)).then(() => true), timeout]);
    clearTimeout(timer);
    return ok && runIds.every((id) => !this.active.has(id));
  }

  /** Sets or removes the archive mark of a finished run. Refuses a run that is queued, active, running or waiting. */
  setArchived(runId: string, archived: boolean, by: string): ArchiveResult {
    if (this.isActive(runId) || this.isQueued(runId)) return "busy";
    let s: RunSummary | undefined;
    try {
      s = this.get(runId);
    } catch {
      return "missing";
    }
    if (!s) return "missing";
    if (!["succeeded", "failed", "cancelled", "stopped"].includes(s.status)) return "busy";
    if ((typeof s.archivedAt === "string") === archived) return "same";
    if (!setRunArchived(join(this.o.runsDir, runId), archived ? new Date().toISOString() : null, by)) {
      // Not written: look again. The file may be gone, or someone else already made the wanted state.
      let now: RunSummary | undefined;
      try {
        now = this.get(runId);
      } catch {
        return "missing";
      }
      if (!now) return "missing";
      if (["succeeded", "failed", "cancelled", "stopped"].includes(now.status) && (typeof now.archivedAt === "string") === archived) return "same";
      return "busy";
    }
    const summary = this.get(runId);
    if (summary) for (const fn of [...(this.recent.get(runId)?.listeners ?? []), ...(this.pendingListeners.get(runId) ?? [])]) fn({ type: "update", summary });
    return "done";
  }

  /** Cancel a run that waits for approval (no process runs for it). */
  private cancelWaiting(runId: string, by?: Actor): boolean {
    const summary = cancelWaitingRun(this.o.runsDir, runId, this.o.config(), by);
    if (!summary) return false;
    this.announce(summary);
    return true;
  }

  /** Cancel a run that stopped (no process runs for it). */
  private cancelStopped(runId: string, by?: Actor): boolean {
    const summary = cancelStoppedRun(this.o.runsDir, runId, this.o.config(), by);
    if (!summary) return false;
    this.announce(summary);
    return true;
  }

  /** Shows a run's new saved state to its viewers, also while the run is still finishing (its notify command runs). */
  private announce(summary: RunSummary) {
    const runId = summary.runId;
    const live = this.active.get(runId);
    if (live) live.summary = structuredClone(summary);
    // Viewers that watched the run while it was active are kept in `recent`; later ones are pending listeners.
    for (const fn of [...(live?.listeners ?? []), ...(this.recent.get(runId)?.listeners ?? []), ...(this.pendingListeners.get(runId) ?? [])]) fn({ type: "update", summary });
  }

  /** Sets the parked mark of a stopped or cancelled run. Refuses a run that is queued or active. */
  setParked(runId: string): boolean {
    if (this.isActive(runId) || this.isQueued(runId)) return false;
    if (!setRunParked(join(this.o.runsDir, runId), new Date().toISOString())) return false;
    const summary = this.get(runId);
    if (summary) for (const fn of [...(this.recent.get(runId)?.listeners ?? []), ...(this.pendingListeners.get(runId) ?? [])]) fn({ type: "update", summary });
    return true;
  }

  /** Takes the parked mark off again (a park that could not be finished on GitHub). Refuses a run that is queued or active. */
  clearParked(runId: string): boolean {
    if (this.isActive(runId) || this.isQueued(runId)) return false;
    return clearRunParked(join(this.o.runsDir, runId));
  }

  /**
   * Cancels the work of one account and returns the counts. Never pumps and never takes the account lock: it may run
   * inside withAuthLock. Queued jobs the account queued are dropped; with `stopWork` also the jobs for runs it owns,
   * its running runs are aborted and its runs that wait for approval are cancelled.
   */
  cancelAccount(accountId: string, opts: { stopWork?: boolean } = {}): AccountCancelCounts {
    const counts: AccountCancelCounts = { queued: 0, running: 0, waiting: 0 };
    const keep = this.pending.filter((q) => !(queuerOf(q) === accountId || (opts.stopWork && this.ownerOf(q.runId) === accountId)));
    counts.queued = this.pending.length - keep.length;
    if (counts.queued) {
      this.pending = keep;
      this.persist();
    }
    if (!opts.stopWork) return counts;
    for (const [runId, a] of this.active) {
      if (this.ownerOf(runId) !== accountId || a.controller.signal.aborted) continue;
      if (a.summary !== undefined && a.summary.status !== "running") continue;
      a.controller.abort();
      counts.running++;
    }
    for (const b of listRunBriefs(this.o.runsDir)) {
      if (b.status !== "waiting" || b.owner !== accountId || !/^[\w-]+$/.test(b.dirName)) continue;
      const live = this.active.get(b.dirName);
      if (live && live.summary?.status !== "waiting") continue; // a resume is running; the active step handled it
      try {
        const s = loadRun(this.o.runsDir, b.dirName);
        if (!s || s.runId !== b.dirName || s.owner !== accountId || s.status !== "waiting") continue;
        if (this.cancelWaiting(b.dirName)) counts.waiting++;
      } catch {
        // a run.json that cannot be read is left alone
      }
    }
    return counts;
  }

  /** Drops the queued jobs of accounts that are blocked or gone. Returns the accounts where something was dropped. */
  enforceAccounts(accounts: AccountInfo[]): AccountCancelled[] {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const out: AccountCancelled[] = [];
    for (const id of new Set(this.pending.map(queuerOf))) {
      if (id === undefined) continue;
      const acc = byId.get(id);
      if (acc && !acc.blocked) continue;
      const c = this.cancelAccount(id);
      if (c.queued) out.push({ accountId: id, why: acc ? "blocked" : "deleted", ...c });
    }
    this.pump();
    return out;
  }

  queue() {
    const concurrency = this.o.config().concurrency;
    // A helper's cap (machine load, usage limits) holds back new runs only; see pump(). A cap of 0 holds the
    // architect runs and schedule chores too.
    const cap = runLimit(concurrency);
    const busy = this.slotsInUse();
    const capFull = busy >= cap && busy < concurrency;
    const zero = cap < 1 && concurrency >= 1;
    return {
      pending: this.pending.map(({ runId, lockKey, repoLock, source, enqueuedAt, job, priority, asNewRun }, i) => {
        const limit = this.limited.get(runId);
        const same = (q: QueuedJob) => (repoLock && q.repoLock === repoLock) || (lockKey && q.lockKey === lockKey);
        // The lock owner: an active job, else an earlier job in the queue that holds the same lock.
        const blocker = [...this.active.values()].find((a) => same(a.queued))?.queued ?? this.pending.slice(0, i).find(same);
        const vars = job.kind === "run" ? job.vars : undefined;
        return {
          runId, lockKey, repoLock, source, enqueuedAt, kind: job.kind, waitingFor: blocker?.runId,
          ...(priority ? { priority: true as const } : {}),
          ...(limit ? { limit } : {}),
          // nothing but a helper's cap keeps this new run waiting: on purpose, not a queue that stands still
          ...(capFull && (job.kind === "run" || asNewRun) && (zero || !ownLane(source)) && !blocker && !limit ? { capped: true as const } : {}),
          ...(!priority && !limit && this.priorityAhead(i) ? { behindPriority: true as const } : {}),
          ...(typeof vars?.chore_day === "string" ? { choreDay: vars.chore_day } : {}),
          githubRepo: vars?.github_repo, issue: vars?.issue,
          flow: job.kind === "run" ? job.flow.name : undefined,
          repo: job.kind === "run" ? job.repo : undefined, task: job.kind === "run" ? job.task : undefined,
        };
      }),
      active: [...this.active.values()].map((a) => {
        const cd = a.queued.job.kind === "run" ? a.queued.job.vars?.chore_day : undefined;
        return { runId: a.queued.runId, lockKey: a.queued.lockKey, repoLock: a.queued.repoLock, source: a.queued.source, ...(typeof cd === "string" ? { choreDay: cd } : {}) };
      }),
      // the configured number; `cap` is there only while a helper's cap lowers it for new runs
      concurrency,
      ...(cap < concurrency ? { cap } : {}),
    };
  }

  /**
   * The slots the running jobs use. An architect run of a refinement session uses none: a person waits for it, it only
   * reads, and the account's own lock lets one of its architect runs work at a time. It starts past the configured number
   * and past a helper's cap, so a busy factory does not keep a person waiting; only a cap of 0 (no new run at all) holds
   * a new one. A schedule chore uses none either (see isChoreRun).
   */
  private slotsInUse(): number {
    let n = 0;
    for (const a of this.active.values()) if (!ownLane(a.queued.source)) n++;
    return n;
  }

  /** Does a priority job in front of job `i` get the next free slot? One that waits for a busy lock does not hold anyone back. */
  private priorityAhead(i: number): boolean {
    const active = [...this.active.values()].map((a) => a.queued);
    return this.pending.slice(0, i).some((p) => p.priority && !this.limited.has(p.runId) && !((p.lockKey && active.some((a) => a.lockKey === p.lockKey)) || (p.repoLock && active.some((a) => a.repoLock === p.repoLock))));
  }

  /** Wait for a run to finish (resolves immediately if it is not queued or running). */
  async wait(runId: string): Promise<RunSummary | undefined> {
    while (this.isQueued(runId)) await new Promise((r) => setTimeout(r, 200));
    return this.active.get(runId)?.done ?? loadRun(this.o.runsDir, runId);
  }

  async idle(): Promise<void> {
    while (this.pending.length || this.active.size) await new Promise((r) => setTimeout(r, 200));
  }

  get(runId: string): RunSummary | undefined {
    return this.active.get(runId)?.summary ?? this.markStale(loadRun(this.o.runsDir, runId));
  }

  /** Like get, but the run.json is read with fs/promises. */
  async getAsync(runId: string): Promise<RunSummary | undefined> {
    const live = this.active.get(runId)?.summary;
    if (live) return live;
    return this.markStale(await loadRunAsync(this.o.runsDir, runId));
  }

  list(limit = 100): RunSummary[] {
    return listRunIds(this.o.runsDir)
      .slice(0, limit)
      .map((id) => {
        try {
          return this.get(id);
        } catch {
          return undefined; // a run.json that cannot be read is left out, as in briefs()
        }
      })
      .filter((s): s is RunSummary => !!s);
  }

  /** A brief of every run, newest first (cheap: files are read again only when they changed). */
  briefs(): RunBrief[] {
    return listRunBriefs(this.o.runsDir).map((b) => this.liveBrief(b));
  }

  /** The same, reading in batches so the server keeps answering (for the monitor). */
  async briefsAsync(): Promise<RunBrief[]> {
    return (await listRunBriefsAsync(this.o.runsDir)).map((b) => this.liveBrief(b));
  }

  private liveBrief(b: RunBrief): RunBrief {
    // A queued or active run is never listed as archived (its resume clears the mark when it starts).
    if (b.archived && (this.active.has(b.runId) || this.isQueued(b.runId))) {
      const { archived: _archived, ...rest } = b;
      b = rest;
    }
    const live = this.active.get(b.runId)?.summary;
    if (live) return { ...b, status: live.status };
    // An interrupted run ended when its run.json was last written: a time that stays the same.
    return b.status === "running" && !this.active.has(b.runId) ? { ...b, status: "failed" as const, finishedAt: b.finishedAt ?? b.updatedAt, interrupted: true } : b;
  }

  /** A "running" run.json with no live process was interrupted (e.g. the server died). */
  private markStale(s: RunSummary | undefined): RunSummary | undefined {
    if (s && s.status === "running" && !this.active.has(s.runId)) return { ...s, status: "failed", reason: "interrupted — resume it to continue", finishedAt: s.finishedAt ?? runUpdatedAt(s.runDir) ?? s.startedAt };
    return s;
  }

  /** Replays the log so far, then streams. Returns an unsubscribe function. */
  subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
    const live = this.active.get(runId) ?? this.recent.get(runId);
    if (live) live.lines.forEach((line) => fn({ type: "log", line }));
    else {
      const s = loadRun(this.o.runsDir, runId);
      if (s) readLiveLog(s.runDir).forEach((line) => fn({ type: "log", line }));
    }
    const summary = this.get(runId);
    if (summary) fn({ type: "update", summary });
    if (live && this.active.has(runId)) {
      live.listeners.add(fn);
      return () => live.listeners.delete(fn);
    }
    // Not running now: stay subscribed, so a later resume (UI, CLI or watcher) streams to this viewer.
    const set = this.pendingListeners.get(runId) ?? new Set();
    set.add(fn);
    this.pendingListeners.set(runId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.pendingListeners.delete(runId);
    };
  }

  private persist() {
    if (!this.o.queueFile) return;
    mkdirSync(dirname(this.o.queueFile), { recursive: true });
    // write beside the file and rename, so a failed write leaves the old queue file whole
    const tmp = `${this.o.queueFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.pending, null, 2));
      renameSync(tmp, this.o.queueFile);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Set while the server waits to restart: queued jobs stay saved and start in the new server. */
  private paused = false;

  /** From now on nothing starts. Active jobs go on; queued and newly submitted jobs wait in the queue file. */
  drain(): void {
    this.paused = true;
    this.stopCapTimer();
  }

  /** Set by close(): the scheduler starts nothing and holds no timer any more. */
  private closed = false;
  private capTimer?: NodeJS.Timeout;

  /** The server shuts down: nothing starts from now on, and no timer is left. Active jobs and the queue file are not touched. */
  close(): void {
    this.closed = true;
    this.stopCapTimer();
  }

  private stopCapTimer(): void {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = undefined;
  }

  /** Ends a drain: queued jobs start again (a cancelled restart). */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pump();
  }

  get draining(): boolean {
    return this.paused;
  }

  private pump() {
    if (this.paused || this.closed) return;
    // Helper processes (load governor, limit forecaster) may lower the number for a while. Their cap holds back new
    // runs only: a run that already started may hold the turn to merge or a file area that the others wait for, so
    // keeping it out of a slot would stop everything. Resumes are bound by the configured number alone. A cap of 0
    // holds every new run, also architect runs and schedule chores; resumes go on.
    const limit = this.o.config().concurrency;
    const capped = runLimit(limit);
    const states = new Map<string, boolean>();
    const held = (q: QueuedJob) => {
      const id = queuerOf(q);
      if (id === undefined || !this.o.accountActive) return false;
      let ok = states.get(id);
      if (ok === undefined) {
        try {
          ok = this.o.accountActive(id);
        } catch {
          ok = false;
        }
        states.set(id, ok);
      }
      return !ok;
    };
    for (const id of [...this.started.keys()]) if (!this.active.has(id)) this.started.delete(id);

    // The account of a job: the owner of a new run, the owner of the run for a resume. No account: not limited.
    const accounts = new Map<string, string | undefined>();
    const accountOf = (q: QueuedJob): string | undefined => {
      if (!accounts.has(q.runId)) accounts.set(q.runId, q.job.kind === "run" ? q.owner : this.ownerOf(q.runId));
      return accounts.get(q.runId);
    };
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1;
    const limits = new Map<string, { maxConcurrent?: number; maxRunsPerDay?: number; dailyBudgetUsd?: number }>();
    const spends = new Map<string, number>();
    const spent = (acc: string): number => {
      let v = spends.get(acc);
      if (v === undefined) {
        try {
          v = this.o.spentTodayBy?.(acc) ?? spentTodayBy(this.o.runsDir, acc);
        } catch {
          v = 0;
        }
        if (!Number.isFinite(v)) v = 0;
        spends.set(acc, v);
      }
      return v;
    };
    const limitsOf = (acc: string) => {
      let l = limits.get(acc);
      if (!l) {
        try {
          l = this.o.userLimits?.(acc) ?? {};
        } catch {
          l = {};
        }
        limits.set(acc, l);
      }
      return l;
    };
    // Architect runs and chores are not counted as new runs of the day.
    const countable = (q: QueuedJob) => q.job.kind === "run" && !ownLane(q.source);
    const activeOf = (acc: string) => [...this.active.values()].filter((a) => (a.account ?? a.summary?.owner) === acc).length;
    const groupActive = (g: string) => [...this.active.values()].filter((a) => a.group === g).length;
    let briefs: RunBrief[] | undefined;
    const startedNow = new Map<string, number>();
    const baselines = new Map<string, number>();
    const todayCount = (acc: string): number => {
      if (this.o.startedToday) {
        // The baseline is read once per account per pump: a counter that reads run files would otherwise include runs started in this pump.
        let base = baselines.get(acc);
        if (base === undefined) {
          try {
            base = this.o.startedToday(acc);
          } catch {
            base = 0;
          }
          if (!Number.isFinite(base)) base = 0;
          baselines.set(acc, base);
        }
        return base + (startedNow.get(acc) ?? 0);
      }
      briefs ??= listRunBriefs(this.o.runsDir);
      const now = new Date();
      const ids = runIdsStartedToday(briefs, acc, now);
      // counted by run id, so a run that is in both the files and `started` counts once
      for (const [id, s] of this.started) if (s.account === acc && s.day === now.toDateString()) ids.add(id);
      return ids.size;
    };
    const limitOf = (q: QueuedJob): UserLimit | undefined => {
      const acc = accountOf(q);
      if (!acc || !this.o.userLimits) return undefined;
      const l = limitsOf(acc);
      if (valid(l.maxConcurrent) && activeOf(acc) >= l.maxConcurrent) return "concurrent";
      if (countable(q) && valid(l.maxRunsPerDay) && todayCount(acc) >= l.maxRunsPerDay) return "per_day";
      const cap = this.userDailyBudget(acc);
      if (cap !== undefined && spent(acc) >= cap) return "budget";
      return undefined;
    };
    const locked = (q: QueuedJob) => {
      const active = [...this.active.values()].map((a) => a.queued);
      return !!((q.lockKey && active.some((a) => a.lockKey === q.lockKey)) || (q.repoLock && active.some((a) => a.repoLock === q.repoLock)));
    };
    const keyOf = (q: QueuedJob): [number, number] => {
      const g = accountOf(q) ?? "";
      return [groupActive(g), this.lastStartOf.get(g) ?? 0];
    };

    // Architect runs first: they take no slot (see slotsInUse), only their lock, the account's state and its limits hold them
    // (and a cap of 0, for a new one).
    for (const q of this.pending.filter((p) => isRefinementRun(p.source))) {
      if (locked(q) || held(q) || limitOf(q) || (capped < 1 && q.job.kind === "run")) continue;
      const account = accountOf(q);
      const group = account ?? "";
      this.pending.splice(this.pending.indexOf(q), 1);
      this.lastStartOf.set(group, ++this.startSeq);
      this.start(q, account, group);
    }

    // Then one schedule chore at a time on the whole machine, in queue order (the order of their scheduled times). A chore
    // takes no story slot and does not wait for stories or a helper's cap; only its lock, the account's state and the
    // account's daily budget hold it. A concurrency of 0 (nothing starts) holds it too, and so does a cap of 0 for a new one.
    if (limit >= 1 && ![...this.active.values()].some((a) => isChoreRun(a.queued.source))) {
      const q = this.pending.find((p) => isChoreRun(p.source) && !(capped < 1 && p.job.kind === "run") && !locked(p) && !held(p) && limitOf(p) !== "budget");
      if (q) {
        const account = accountOf(q);
        this.pending.splice(this.pending.indexOf(q), 1);
        this.lastStartOf.set(account ?? "", ++this.startSeq);
        this.start(q, account, account ?? "");
      }
    }

    while (this.slotsInUse() < limit) {
      const full = this.slotsInUse() >= capped;
      const ready = this.pending.filter((q) => !ownLane(q.source) && !locked(q) && !held(q) && !limitOf(q) && !(full && (q.job.kind === "run" || q.asNewRun)));
      if (!ready.length) break;
      // priority block first, then the group with the fewest active runs, then the oldest last start, then queue order
      const pool = ready.some((q) => q.priority) ? ready.filter((q) => q.priority) : ready;
      let best = pool[0]!;
      let bestKey = keyOf(best);
      for (const q of pool.slice(1)) {
        const key = keyOf(q);
        if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
          best = q;
          bestKey = key;
        }
      }
      const account = accountOf(best);
      const group = account ?? "";
      this.pending.splice(this.pending.indexOf(best), 1);
      this.lastStartOf.set(group, ++this.startSeq);
      this.start(best, account, group);
      if (countable(best)) {
        // A run nobody owned falls to the first admin inside runFlow: it counts for that account but keeps its own group.
        const a = this.active.get(best.runId);
        let acc = account;
        if (!acc) {
          try {
            acc = a?.summary?.owner ?? loadRun(this.o.runsDir, best.runId)?.owner;
          } catch {
            acc = undefined;
          }
          if (acc && a) a.account = acc;
        }
        if (acc) {
          this.started.set(best.runId, { account: acc, day: new Date().toDateString() });
          startedNow.set(acc, (startedNow.get(acc) ?? 0) + 1);
        }
      }
    }
    this.limited = new Map();
    if (this.o.userLimits) {
      for (const q of this.pending) {
        if (held(q)) continue;
        const l = limitOf(q);
        if (l) this.limited.set(q.runId, l);
      }
    }
    // A cap ends without an event: at 0 nothing runs, so no run that ends calls pump(). Look again from time to time
    // while a cap holds jobs back. Armed before persist(), so a failed write cannot lose it.
    if (capped < limit && this.pending.length) {
      if (!this.capTimer) {
        this.capTimer = setTimeout(() => {
          this.capTimer = undefined;
          try {
            this.pump();
          } catch {
            // the next queue change writes the file again
          }
        }, this.o.capRecheckMs ?? CAP_RECHECK_MS);
        this.capTimer.unref();
      }
    } else this.stopCapTimer();
    this.persist();
  }

  /** The daily budget of an account, or undefined: no limits source, cost limits off, no valid value. Never throws. */
  userDailyBudget(accountId: string): number | undefined {
    try {
      if (!this.o.userLimits || !this.o.config().cost_limits) return undefined;
      const cap = this.o.userLimits(accountId)?.dailyBudgetUsd;
      return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : undefined;
    } catch {
      return undefined;
    }
  }

  /** Looks again at what can start, e.g. after a limit changed. */
  recheck(): void {
    this.pump();
  }

  /** When a job last started, or the scheduler was created. */
  lastStart(): string {
    return this.lastStartAt;
  }

  /**
   * A job never inherits the gh identity of the code that called submit(), setPriority(), answer() or pump():
   * it starts in a host scope (a repository's watcher may be the caller).
   */
  private start(q: QueuedJob, account?: string, group = "") {
    withGhEnv(undefined, () => this.startJob(q, account, group));
  }

  private startJob(q: QueuedJob, account: string | undefined, group: string) {
    this.lastStartAt = new Date().toISOString();
    const a: Active = {
      queued: q,
      controller: new AbortController(),
      lines: [],
      listeners: this.pendingListeners.get(q.runId) ?? new Set(),
      done: Promise.resolve(undefined),
      ...(account ? { account } : {}),
      group,
    };
    this.pendingListeners.delete(q.runId);
    this.active.set(q.runId, a);
    const emit = (e: RunEvent) => a.listeners.forEach((l) => l(e));
    const common = {
      runsDir: this.o.runsDir,
      claudeBin: this.o.claudeBin,
      codexBin: this.o.codexBin,
      pathPrefix: this.o.pathPrefix,
      signal: a.controller.signal,
      config: this.o.config(),
      deliverySettings: () => this.o.config().delivery,
      // evals only, from the Scheduler option: never from a job or its meta, and also on resume (#665)
      ...(this.o.localTest ? { evalRun: true } : {}),
      log: (raw: string) => {
        const line = redactText(raw);
        a.lines.push(line);
        if (a.lines.length > MAX_LOG_LINES) a.lines.shift();
        emit({ type: "log", line });
      },
      onUpdate: (summary: RunSummary) => {
        a.summary = structuredClone(summary);
        emit({ type: "update", summary: a.summary });
      },
      // a job without an account falls to the first admin inside runFlow: it stays under the global budget only
      userDailyBudget: this.o.userLimits && account ? (o: string) => this.userDailyBudget(o) : undefined,
      // evidence only: who asked, when it was queued, and who cancelled it
      actor: actorOf(q.source, queuerOf(q)),
      queuedAt: q.enqueuedAt,
      cancelledBy: () => a.cancelledBy,
      // a stop request (an overrule) ends the run before this step, never once a merge started
      stopBefore: (stepId: string) => {
        const why = this.stopRequests.get(q.runId);
        this.stopRequests.delete(q.runId);
        if (stepIs(stepId, MERGE_GUARD) || (a.summary && mergeStarted(a.summary, 0))) {
          a.merging = true;
          return undefined;
        }
        return why;
      },
    };
    const j = q.job;
    const promise =
      j.kind === "run"
        ? runFlow(j.flow, {
            ...common,
            runId: q.runId,
            task: j.task,
            repo: j.repo,
            vars: j.vars,
            frozenVars: j.frozenVars,
            source: q.source,
            owner: q.owner,
            ...(this.o.localTest ? { localTest: true } : { flowId: q.flowId ?? flowFileId(j.flow, j.repo) }),
          })
        : resumeRun({ ...common, runId: j.runId, from: j.from, decision: j.decision });
    a.done = promise
      .then((summary) => {
        this.o.onFinished?.(summary, q);
        return summary;
      })
      .catch((e: Error) => {
        common.log(`✘ could not start: ${e.message}`);
        return loadRun(this.o.runsDir, q.runId);
      })
      .finally(() => {
        this.stopRequests.delete(q.runId);
        this.active.delete(q.runId);
        this.recent.set(q.runId, a);
        setTimeout(() => this.recent.delete(q.runId), 10 * 60_000).unref();
        this.pump();
      });
  }
}
