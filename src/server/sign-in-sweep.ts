import { aiSignIn, recheckAiSignIn, signInRetry } from "../auth/ai-sign-in.js";
import type { WatcherConfig } from "../config.js";
import { listRunBriefs, loadRun, type RunSummary } from "../engine/state.js";
import { isSignInStop } from "../errors.js";
import { trackingWatcher } from "../next-step.js";
import type { Scheduler } from "../queue/scheduler.js";
import { hiddenRuns } from "../release/superseded.js";
import { runOrigin } from "../your-turn.js";

/** How often the server looks for runs that stopped for the AI sign-in and may go on. */
export const SIGN_IN_SWEEP_MS = 60_000;

export interface SignInSweepDeps {
  scheduler: Pick<Scheduler, "isActive" | "isQueued" | "submit">;
  runsDir: string;
  watchers: () => WatcherConfig[];
  ready?: (run: RunSummary) => boolean;
  log: (msg: string) => void;
  /** Asks Claude Code again, while only its answer says that the sign-in is missing (a new `/login` then counts). */
  reprobe?: () => Promise<void>;
  /** Looks for a token, on every tick and whether or not a run waits. Default: recheckAiSignIn. */
  recheck?: () => unknown;
}

/**
 * Queues a resume of each run that stopped for the AI sign-in and that no issues watcher handles: runs started by hand and
 * runs of other watchers. Returns the ids it queued. A run that cannot be read or queued is skipped.
 */
export function resumeSignInStopped(deps: SignInSweepDeps): string[] {
  const ready = deps.ready ?? signInRetry;
  const briefs = listRunBriefs(deps.runsDir);
  let hidden: ReadonlySet<string> | undefined;
  const queued: string[] = [];
  for (const b of briefs) {
    if (b.status !== "stopped" || b.archived) continue;
    if (deps.scheduler.isActive(b.runId) || deps.scheduler.isQueued(b.runId)) continue;
    try {
      const run = loadRun(deps.runsDir, b.runId);
      if (!run || run.status !== "stopped" || run.parkedAt || !isSignInStop(run.reason)) continue;
      const origin = runOrigin(run.source);
      // an eval is over, and a refinement session asks its architect again itself
      if (origin === "eval" || origin === "refinement") continue;
      if (origin !== "hand" && trackingWatcher(deps.watchers(), run)) continue;
      if ((hidden ??= hiddenRuns(briefs)).has(b.runId) || !ready(run)) continue;
      deps.scheduler.submit({ kind: "resume", runId: b.runId }, { source: run.source, owner: run.owner });
      queued.push(b.runId);
    } catch {
      continue;
    }
  }
  return queued;
}

/** A timer that runs resumeSignInStopped now and then every `everyMs`. Errors are logged once in a row; the timer is unref'd. */
export function startSignInSweep(deps: SignInSweepDeps, everyMs = SIGN_IN_SWEEP_MS): () => void {
  let told = false;
  const tick = () => {
    try {
      // a token set by another process clears the state here, whether or not a run is waiting
      (deps.recheck ?? recheckAiSignIn)();
      // its answer counts from the next look on
      if (aiSignIn().why === "probe") void deps.reprobe?.().catch(() => {});
      const queued = resumeSignInStopped(deps);
      if (queued.length) deps.log(`AI sign-in: ${queued.length} stopped run(s) continue`);
      told = false;
    } catch (e) {
      if (told) return;
      told = true;
      deps.log(`! AI sign-in: ${e instanceof Error ? e.name : "error"}`);
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
