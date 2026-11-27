import type { RunSummary } from "../engine/state.js";
import { releaseBuildLock } from "./release-trigger.js";

/**
 * The lock key a watcher queued this run with, for the runs the watcher resumes itself after an interruption.
 * Undefined: not a run of this watcher, or an issue run (the check of the issue labels resumes those).
 */
export function interruptedLockKey(watcherId: string, repo: string, run: Pick<RunSummary, "source" | "vars">): string | undefined {
  const prefix = `watcher ${watcherId} `;
  if (!run.source?.startsWith(prefix)) return undefined;
  const vars = run.vars ?? {};
  switch (run.source.slice(prefix.length).split(" ")[0]) {
    case "schedule": return `${repo}#chore:${watcherId}`;
    case "precheck": return `${repo}#precheck:${watcherId}`;
    case "ci": return vars.ci_workflow ? `${repo}#ci:${vars.ci_workflow}` : undefined;
    case "pr": return vars.pr ? `${repo}#${vars.pr}` : undefined;
    case "release-build": return vars.ref ? releaseBuildLock(repo, vars.ref) : undefined;
    default: return undefined;
  }
}
