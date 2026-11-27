import { RELEASE_FLOWS } from "../next-step.js";
import type { Scheduler } from "../queue/scheduler.js";
import { reconcileSupersededReleases, type ReleaseBrief, type ReleaseScope } from "../release/superseded.js";

export type DeadRunScheduler = Pick<Scheduler, "markInterrupted" | "staleRunIds" | "briefs" | "setArchived">;

export interface SettleOptions {
  /** The runs to look at. Default: every run that is stored as running and is not active or queued here. */
  ids?: string[];
  /** This process's own pid counts as gone: only at the start of the server. */
  ownPidDead?: boolean;
  log: (m: string) => void;
  /** The monitor's recent activity. */
  act?: (m: string) => void;
  /** Succeeded release runs kept in runs-archive (see `retainedSuccesses`); read only when a release run was interrupted. */
  retained?: () => ReleaseBrief[];
}

/**
 * Saves the runs whose process is gone as interrupted. A release run that a later success has replaced is then archived
 * as superseded, in the same synchronous step, so no watcher can resume it in between. A run that could not be saved
 * stays `running` and is found again by the next call. Returns the ids of the saved runs. Never throws.
 */
export function settleDeadRuns(scheduler: DeadRunScheduler, o: SettleOptions): string[] {
  const done: string[] = [];
  const releases = new Map<string, ReleaseScope>();
  let ids: string[] = [];
  try {
    ids = o.ids ?? scheduler.staleRunIds();
  } catch (e) {
    o.log(`! could not look for runs whose process is gone: ${(e as Error).message}`);
  }
  for (const id of ids) {
    try {
      const run = scheduler.markInterrupted(id, { ownPidDead: o.ownPidDead });
      if (!run) continue;
      done.push(id);
      const repo = run.vars?.github_repo;
      if (repo && RELEASE_FLOWS.includes(run.flow)) {
        const watcher = run.vars?.chore_watcher;
        releases.set(`${run.flow}|${repo.toLowerCase()}|${watcher ?? ""}`, { flow: run.flow, repo, ...(typeof watcher === "string" ? { watcher } : {}) });
      }
      const m = `run ${id} is saved as interrupted: its process is gone`;
      o.log(m);
      o.act?.(m);
    } catch (e) {
      o.log(`! could not save run ${id} as interrupted: ${(e as Error).message}`);
    }
  }
  for (const only of releases.values()) reconcileSupersededReleases(scheduler, { log: o.log, only, retained: o.retained });
  return done;
}
