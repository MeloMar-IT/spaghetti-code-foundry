import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StuckRun } from "../self-update.js";
import type { Scheduler } from "../queue/scheduler.js";
import { areaWait } from "./next.js";

/** A run with no change in its folder for this long is stuck. */
export const STUCK_QUIET_MS = 30 * 60_000;
/** `area-wait.json` written within this time: the run still waits for a code area. */
export const AREA_WAIT_FRESH_MS = 90_000;
const WAIT_FILE = "area-wait.json";

const mtimes = (dir: string, skip?: string): number[] => {
  const out: number[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || e.name === skip) continue;
      try {
        out.push(statSync(join(dir, e.name)).mtimeMs);
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // no such folder
  }
  return out;
};

/** Newest mtime (ms) of the plain files directly in runDir (not area-wait.json) and of runDir/logs/*; 0 when none. */
export function lastActivity(runDir: string): number {
  return Math.max(0, ...mtimes(runDir, WAIT_FILE), ...mtimes(join(runDir, "logs")));
}

/** area-wait.json exists and was written within AREA_WAIT_FRESH_MS. */
export function lockWaiting(runDir: string, now: number): boolean {
  try {
    return now - statSync(join(runDir, WAIT_FILE)).mtimeMs <= AREA_WAIT_FRESH_MS;
  } catch {
    return false;
  }
}

const ms = (t: string | undefined): number => {
  const n = t ? Date.parse(t) : NaN;
  return Number.isNaN(n) ? 0 : n;
};

/** The active runs that wait for a code area or have not changed anything for `quietMs`. */
export function stuckRuns(scheduler: Pick<Scheduler, "queue" | "get">, now = Date.now(), quietMs = STUCK_QUIET_MS): { active: number; runs: StuckRun[] } {
  const active = scheduler.queue().active;
  const runs: StuckRun[] = [];
  for (const { runId } of active) {
    let run;
    try {
      run = scheduler.get(runId);
    } catch {
      continue;
    }
    if (!run || run.status !== "running") continue;
    if (areaWait(run) || lockWaiting(run.runDir, now)) {
      runs.push({ runId, why: "area_lock" });
      continue;
    }
    const last = Math.max(lastActivity(run.runDir), ms(run.stepStartedAt), ms(run.startedAt), ...(run.resumeLog ?? []).map((r) => ms(r.at)));
    if (last > 0 && now - last > quietMs) runs.push({ runId, why: "quiet" });
  }
  return { active: active.length, runs };
}
