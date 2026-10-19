export const RELEASE_BUILD_FLOW = "release-build";
/** Set on the runs a watcher starts by itself; its value is the watcher id. */
export const RELEASE_BUILD_VAR = "release_build_watcher";

/** A release-build run that a schedule watcher started by itself. */
export function isWatcherReleaseBuild(run: { flow: string; source?: string; vars?: Record<string, string> }): boolean {
  return run.flow === RELEASE_BUILD_FLOW && !!run.vars?.[RELEASE_BUILD_VAR] && run.source?.startsWith("watcher ") === true;
}
/** Set on the same runs: the id of one submission, made before the job is queued, so a later check can tell whether the job was ever accepted. */
export const RELEASE_BUILD_SUBMISSION_VAR = "release_build_submission";
