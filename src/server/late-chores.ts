import type { WatcherConfig } from "../config.js";
import type { RunBrief } from "../engine/state.js";
import { nextStep, RELEASE_FLOWS, type ChoreWait, type NextStep } from "../next-step.js";
import { choreWatcherOf } from "../queue/scheduler.js";
import { DEFAULT_FLOWS, minutesNow, watcherAccount, type WatcherStatus } from "../queue/watcher.js";

/** How long after its time a daily schedule run may wait before it is a problem. */
export const CHORE_LATE_MS = 60 * 60_000;
const DAY = 86_400_000;

/**
 * The instant of a local date and time in a time zone. A repeated hour: the first one. A skipped time: the first minute
 * the clock is past it. Throws on a day that is not a real date.
 */
export function slotTime(day: string, at: string, timeZone?: string): number {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) throw new RangeError(`not a date: ${day}`);
  const wall = Date.parse(`${day}T${at}:00Z`);
  const wallAt = (t: number) => { const m = minutesNow(timeZone, new Date(t)); return Date.parse(`${m.day}T00:00:00Z`) + m.minutes * 60_000; };
  const offset = (t: number) => wallAt(t) - t;
  const both = [wall - offset(wall - DAY), wall - offset(wall + DAY)];
  const fit = both.filter((t) => wallAt(t) === wall);
  if (fit.length) return Math.min(...fit);
  for (let t = Math.min(...both); t < Math.max(...both); t += 60_000) if (wallAt(t) >= wall) return t;
  return Math.max(...both);
}

export interface LateChoreInput {
  watchers: (WatcherConfig & { status?: WatcherStatus })[];
  pending: { runId: string; kind: string; source?: string; enqueuedAt: string; choreDay?: string; waitingFor?: string; limit?: string }[];
  active: { runId: string; source?: string; choreDay?: string }[];
  briefs: () => Pick<RunBrief, "runId" | "source" | "startedAt" | "choreDay">[];
  concurrency: number;
  waitsToRestart: boolean;
  dailyBudgetUsed: boolean;
  /** Asked at most once per owner in one call. */
  ownerBudgetUsed: (owner: string) => boolean;
  now: Date;
}

const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

/**
 * The daily schedule runs that have not started an hour after their time, one record each. Pure: the caller passes in
 * everything. A watcher with bad data (time zone, day) gives no record; the others still do.
 */
export function lateChores(i: LateChoreInput): NextStep[] {
  const out: NextStep[] = [];
  const now = i.now.getTime();
  let briefList: ReturnType<LateChoreInput["briefs"]> | undefined;
  const briefs = () => (briefList ??= i.briefs());
  const owners = new Map<string, boolean>();
  const ownerUsed = (owner: string): boolean => {
    let v = owners.get(owner);
    if (v === undefined) { v = i.ownerBudgetUsed(owner); owners.set(owner, v); }
    return v;
  };

  const record = (w: WatcherConfig, wait: ChoreWait, runId?: string, blockingRun?: string): NextStep => {
    const flow = w.flow === "default" ? DEFAULT_FLOWS.schedule : w.flow;
    return nextStep("chore_late", { repo: w.github_repo, ...(runId ? { runId } : {}) }, {
      choreAt: w.at, choreName: flow !== undefined && RELEASE_FLOWS.includes(flow) ? "release" : "schedule run", choreWait: wait, blockingRun,
    });
  };

  const one = (w: WatcherConfig & { status?: WatcherStatus }): NextStep | undefined => {
    const at = w.at!;
    const zone = w.timezone || undefined;

    // Case 1: the run is queued.
    const job = i.pending.find((p) => p.kind === "run" && choreWatcherOf(p.source) === w.id);
    if (job) {
      const day = job.choreDay ?? minutesNow(zone, new Date(job.enqueuedAt)).day;
      if (now - slotTime(day, at, zone) < CHORE_LATE_MS) return undefined;
      if (i.waitsToRestart) return record(w, "restart", job.runId);
      if (i.concurrency < 1) return record(w, "no_runs", job.runId);
      if (job.waitingFor) return record(w, "other_run", job.runId, job.waitingFor);
      if (job.limit === "budget") return record(w, "owner_budget", job.runId);
      const other = i.active.find((a) => { const id = choreWatcherOf(a.source); return id !== undefined && id !== w.id; });
      if (other) return record(w, "other_chore", job.runId, other.runId);
      return record(w, "in_queue", job.runId);
    }

    // Case 2: nothing is queued.
    const status = w.status;
    if (!status?.lastTick) return undefined;
    const today = minutesNow(zone, i.now).day;
    let slotDay = today;
    let slot = slotTime(today, at, zone);
    if (slot > now) {
      slotDay = dayBefore(today);
      slot = slotTime(slotDay, at, zone);
    }
    if (now - slot < CHORE_LATE_MS) return undefined;
    const isToday = slotDay === today;
    if (!isToday && !(status.startedAt && Date.parse(status.startedAt) <= slot)) return undefined;

    const mine = i.active.filter((a) => choreWatcherOf(a.source) === w.id);
    if (mine.some((a) => a.choreDay === slotDay)) return undefined;
    const all = briefs();
    const own = all.filter((b) => choreWatcherOf(b.source) === w.id);
    if (own.some((b) => (b.choreDay ?? minutesNow(zone, new Date(b.startedAt)).day) === slotDay)) return undefined;
    if (mine.some((a) => !a.choreDay && !all.some((b) => b.runId === a.runId))) return undefined;

    if (i.waitsToRestart && isToday) return record(w, "restart");
    if (status.lastError) return record(w, "watcher_error");
    const resume = i.pending.find((p) => p.kind === "resume" && choreWatcherOf(p.source) === w.id);
    const blocker = mine[0] ?? resume;
    if (blocker) return record(w, "other_run", undefined, blocker.runId);
    if (!status.lastOk || Date.parse(status.lastOk) < slot) return record(w, "no_check");
    if (i.dailyBudgetUsed) return record(w, "budget");
    const owner = watcherAccount(w);
    if (owner && ownerUsed(owner)) return record(w, "owner_budget");
    return record(w, "not_queued");
  };

  for (const w of i.watchers) {
    if (!w.enabled || w.source !== "schedule" || !w.at) continue;
    try {
      const r = one(w);
      if (r) out.push(r);
    } catch {
      // a bad time zone or day costs this watcher its record, not the answer of the health check
    }
  }
  return out;
}
