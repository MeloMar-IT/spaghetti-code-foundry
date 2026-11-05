import { isProjectBudgetStop, listRunBriefs, loadRun, projectOfVars, spentTodayByProject } from "../engine/state.js";
import type { Scheduler } from "../queue/scheduler.js";

/** How often the server looks for project-capped runs that may go on (a cap ends by the day, not by an event). */
export const PROJECT_BUDGET_SWEEP_MS = 5 * 60_000;

export interface ProjectBudgetSweepDeps {
  scheduler: Pick<Scheduler, "isActive" | "isQueued" | "submit" | "projectDailyBudget">;
  runsDir: string;
  log: (msg: string) => void;
  now?: () => Date;
}

/**
 * Queues a resume of every stopped run that the daily cap of its project stopped, once the cap allows again (#792).
 * It reads the run files, so it finds such runs after a server restart too, and it works without an issue watcher
 * (manual runs, local projects, release builds). The scheduler holds the resume again if the cap is still reached.
 * Returns the ids it queued. A run that cannot be read is skipped; the scheduler answers the rest.
 */
export function resumeProjectStopped(deps: ProjectBudgetSweepDeps): string[] {
  const now = deps.now?.() ?? new Date();
  const queued: string[] = [];
  for (const b of listRunBriefs(deps.runsDir)) {
    if (b.status !== "stopped" || b.archived) continue;
    if (deps.scheduler.isActive(b.runId) || deps.scheduler.isQueued(b.runId)) continue;
    let owner: string | undefined;
    try {
      const run = loadRun(deps.runsDir, b.runId);
      if (!run || run.status !== "stopped" || !isProjectBudgetStop(run.reason)) continue;
      const ref = projectOfVars(run.vars);
      if (!ref) continue;
      owner = run.owner;
      const cap = deps.scheduler.projectDailyBudget(ref, owner);
      if (cap === undefined || spentTodayByProject(deps.runsDir, ref, now) >= cap) continue;
    } catch {
      continue;
    }
    deps.scheduler.submit({ kind: "resume", runId: b.runId }, { source: "project limit", owner });
    queued.push(b.runId);
  }
  return queued;
}

/** A timer that runs resumeProjectStopped now and then every `everyMs`. Errors are logged once in a row; the timer is unref'd. */
export function startProjectBudgetSweep(deps: ProjectBudgetSweepDeps, everyMs = PROJECT_BUDGET_SWEEP_MS): () => void {
  let told = false;
  const tick = () => {
    try {
      const queued = resumeProjectStopped(deps);
      if (queued.length) deps.log(`project limit: ${queued.length} stopped run(s) continue`);
      told = false;
    } catch (e) {
      if (told) return;
      told = true;
      deps.log(`! project limit: ${e instanceof Error ? e.name : "error"}`);
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
