// The server's heartbeat (#961): a small file that says whether the queue and the watchers move. The watchdog
// (src/ops/watchdog.ts) reads it from outside, because a stuck server cannot say or repair that itself.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownLane, type Scheduler } from "./queue/scheduler.js";
import { parseInterval } from "./queue/watcher.js";
import { writeAtomic } from "./restart-gate.js";

export const HEARTBEAT_FILE = "heartbeat.json";
export const HEARTBEAT_MS = 30_000;

export interface Heartbeat {
  version: 1;
  at: string;
  pid: number;
  supervisorPid?: number;
  startedAt: string;
  pumpAt?: string;
  lastStart?: string;
  /** When a watcher last finished a check. */
  watchAt?: string;
  watchers: number;
  /** The shortest interval of the running watchers. */
  watchEverySec?: number;
  logAt?: string;
  /** Jobs that could start now. */
  ready: number;
  /** The first heartbeat of the current unbroken time with ready work. */
  readySince?: string;
  pending: number;
  active: number;
  draining: boolean;
}

type QueueView = Pick<ReturnType<Scheduler["queue"]>, "pending" | "active" | "concurrency">;

export interface HeartbeatSource {
  pid: number;
  supervisorPid?: number;
  startedAt: string;
  queue: QueueView;
  pumpAt?: string;
  lastStart?: string;
  watchers: { every: string; lastTick?: string }[];
  logAt?: string;
  draining: boolean;
  restartWaits: boolean;
}

/** How many jobs could start now, by the rule of the monitor's `queue-stalled`: a free slot, and nothing holds the job back. */
export function readyJobs(queue: QueueView): number {
  // architect runs and schedule chores use no slot (the scheduler's slotsInUse), so they do not fill the concurrency
  const slotsUsed = queue.active.filter((a) => !ownLane(a.source)).length;
  if (queue.concurrency - slotsUsed <= 0) return 0;
  return queue.pending.filter((p) => !p.waitingFor && !p.limit && !p.capped).length;
}

export function heartbeatOf(s: HeartbeatSource, now: Date, previousReadySince?: string): Heartbeat {
  // while the server drains or waits to restart, nothing starts on purpose
  const ready = s.draining || s.restartWaits ? 0 : readyJobs(s.queue);
  const checks = s.watchers.map((w) => w.lastTick).filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  const intervals = s.watchers.flatMap((w) => {
    try {
      return [parseInterval(w.every) / 1000];
    } catch {
      return [];
    }
  });
  return {
    version: 1,
    at: now.toISOString(),
    pid: s.pid,
    supervisorPid: s.supervisorPid,
    startedAt: s.startedAt,
    pumpAt: s.pumpAt,
    lastStart: s.lastStart,
    watchAt: checks.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1),
    watchers: s.watchers.length,
    watchEverySec: intervals.length ? Math.min(...intervals) : undefined,
    logAt: s.logAt,
    ready,
    readySince: ready > 0 ? (previousReadySince ?? now.toISOString()) : undefined,
    pending: s.queue.pending.length,
    active: s.queue.active.length,
    draining: s.draining || s.restartWaits,
  };
}

export function writeHeartbeat(dir: string, hb: Heartbeat): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, HEARTBEAT_FILE), JSON.stringify(hb, null, 2));
}

/** The heartbeat in `text`; "newer" for one of a later version, undefined for anything that does not look right. */
export function parseHeartbeat(text: string): Heartbeat | "newer" | undefined {
  let h: Record<string, unknown>;
  try {
    h = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!h || typeof h !== "object") return undefined;
  if (typeof h.version === "number" && h.version > 1) return "newer";
  const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
  const pid = (x: unknown) => count(x) && (x as number) > 0;
  const time = (x: unknown) => typeof x === "string" && !Number.isNaN(Date.parse(x));
  const maybe = (x: unknown, ok: (v: unknown) => boolean) => x === undefined || ok(x);
  const fine = h.version === 1 && time(h.at) && time(h.startedAt) && pid(h.pid) && maybe(h.supervisorPid, pid)
    && [h.watchers, h.ready, h.pending, h.active].every(count) && typeof h.draining === "boolean"
    && [h.pumpAt, h.lastStart, h.watchAt, h.logAt, h.readySince].every((x) => maybe(x, time))
    && maybe(h.watchEverySec, (x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  return fine ? (h as unknown as Heartbeat) : undefined;
}

/** The heartbeat file of a data folder: missing and broken are both undefined. */
export function readHeartbeat(dir: string): Heartbeat | "newer" | undefined {
  try {
    return parseHeartbeat(readFileSync(join(dir, HEARTBEAT_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

export interface HeartbeatOptions {
  dir: string;
  source: () => HeartbeatSource;
  /** Runs with every beat (the restart guard is published again). */
  beat?: () => void;
  log: (m: string) => void;
  everyMs?: number;
  now?: () => Date;
}

/** Writes the heartbeat now and then every 30 seconds. Never throws. Returns the stop. */
export function startHeartbeat(o: HeartbeatOptions): () => void {
  let readySince: string | undefined;
  let failing = false;
  const once = () => {
    try {
      o.beat?.();
    } catch {
      // the heartbeat itself must still be written
    }
    try {
      const hb = heartbeatOf(o.source(), (o.now ?? (() => new Date()))(), readySince);
      readySince = hb.readySince;
      writeHeartbeat(o.dir, hb);
      failing = false;
    } catch (e) {
      const first = !failing;
      failing = true;
      if (!first) return;
      try {
        o.log(`! heartbeat: could not be written (${(e as Error).message})`);
      } catch {
        // nothing left to tell it to
      }
    }
  };
  once();
  const timer = setInterval(once, o.everyMs ?? HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
