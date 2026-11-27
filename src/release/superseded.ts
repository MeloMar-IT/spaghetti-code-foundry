import { listRunIds, loadRun, runsArchiveDir, type RunBrief, type RunSummary } from "../engine/state.js";
import { RELEASE_FLOWS } from "../next-step.js";
import type { Scheduler } from "../queue/scheduler.js";

/** The `archivedBy` of a run the server archived by itself because a later release of its repository succeeded. Not an account id. */
export const SUPERSEDED_BY = "foundry:superseded-release";

export type ReleaseBrief = Pick<RunBrief, "runId" | "flow" | "status" | "startedAt" | "githubRepo" | "archived" | "choreWatcher">;
export type DoneRun = Pick<RunSummary, "runId" | "flow" | "status" | "startedAt" | "finishedAt" | "vars">;
type Archiver = Pick<Scheduler, "briefs" | "setArchived">;
type Log = (m: string) => void;

const keyOf = (flow: string, repo: string) => `${flow}|${repo.toLowerCase()}`;

/** Failed or stopped release runs that started before a succeeded run of the same flow and repository. */
export function supersededReleases(briefs: ReleaseBrief[]): ReleaseBrief[] {
  const newest = new Map<string, number>();
  const rel = briefs.filter((b) => RELEASE_FLOWS.includes(b.flow) && !!b.githubRepo);
  for (const b of rel) {
    const t = Date.parse(b.startedAt);
    if (b.status !== "succeeded" || Number.isNaN(t)) continue;
    const k = keyOf(b.flow, b.githubRepo!);
    if (t > (newest.get(k) ?? -Infinity)) newest.set(k, t);
  }
  return rel.filter((b) => {
    if (b.archived || (b.status !== "failed" && b.status !== "stopped")) return false;
    const t = Date.parse(b.startedAt);
    const win = newest.get(keyOf(b.flow, b.githubRepo!));
    return !Number.isNaN(t) && win !== undefined && t < win;
  });
}

/**
 * Did a later run of this release run's flow, repository and watcher succeed? The run's own status does not matter.
 * A run with no watcher (started by hand or by the CLI) is compared with every run of its flow and repository.
 */
export function releasedLater(run: DoneRun, briefs: ReleaseBrief[]): boolean {
  const watcher = run.vars?.chore_watcher;
  const self: ReleaseBrief = { runId: run.runId, flow: run.flow, status: "failed", startedAt: run.startedAt, githubRepo: run.vars?.github_repo, choreWatcher: watcher };
  const others = briefs.filter((b) => b.runId !== run.runId && (watcher === undefined || b.choreWatcher === watcher));
  return supersededReleases([...others, self]).some((b) => b.runId === run.runId);
}

/** The runs Your turn does not list: archived runs of any flow and superseded release runs. */
export function hiddenRuns(briefs: ReleaseBrief[]): Set<string> {
  const out = new Set(briefs.filter((b) => b.archived).map((b) => b.runId));
  for (const b of supersededReleases(briefs)) out.add(b.runId);
  return out;
}

const archive = (scheduler: Archiver, list: ReleaseBrief[], log?: Log): string[] => {
  const ids: string[] = [];
  for (const b of list) {
    try {
      if (scheduler.setArchived(b.runId, true, SUPERSEDED_BY) !== "done") continue;
      ids.push(b.runId);
      log?.(`release run ${b.runId} of ${b.githubRepo} archived: a later ${b.flow} run succeeded`);
    } catch {
      // one run that cannot be marked must not stop the others
    }
  }
  return ids;
};

/** Succeeded release runs that housekeeping moved to runs-archive. They are not in the run index, but they still show that a later release succeeded. Reads run.json files: call it at start-up only. Never throws. */
export function retainedSuccesses(runsDir: string): ReleaseBrief[] {
  try {
    return listRunIds(runsArchiveDir(runsDir)).flatMap((id) => {
      try {
        const s = loadRun(runsDir, id);
        if (!s || s.status !== "succeeded" || !RELEASE_FLOWS.includes(s.flow) || !s.vars?.github_repo) return [];
        return [{ runId: s.runId, flow: s.flow, status: s.status, startedAt: s.startedAt, githubRepo: s.vars.github_repo, ...(typeof s.vars.chore_watcher === "string" ? { choreWatcher: s.vars.chore_watcher } : {}) }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** The release runs that a scope covers: one flow and repository, and with `watcher` only the runs of that watcher. */
export interface ReleaseScope {
  flow: string;
  repo: string;
  /** Only the runs this watcher started (`vars.chore_watcher`). Absent: every run of the flow and repository. */
  watcher?: string;
}

/** The scope of a finished release run: its watcher, if it has one. */
const scopeOf = (done: DoneRun, repo: string): ReleaseScope => ({ flow: done.flow, repo, ...(typeof done.vars?.chore_watcher === "string" ? { watcher: done.vars.chore_watcher } : {}) });

interface Reconcile {
  log?: Log;
  done?: DoneRun;
  only?: ReleaseScope;
  /** Succeeded runs kept in runs-archive (see `retainedSuccesses`), read when the sweep starts. */
  retained?: () => ReleaseBrief[];
}

/** The superseded runs to archive now. `done` is a run that just ended and may not be in the index yet. Never throws. */
function candidates(scheduler: Archiver, o: Reconcile): ReleaseBrief[] {
  try {
    let briefs: ReleaseBrief[] = scheduler.briefs();
    if (o.retained) {
      const known = new Set(briefs.map((b) => b.runId));
      briefs = [...briefs, ...o.retained().filter((r) => !known.has(r.runId))];
    }
    if (o.done) {
      const d = o.done;
      briefs = [...briefs.filter((b) => b.runId !== d.runId), { runId: d.runId, flow: d.flow, status: d.status, startedAt: d.startedAt, githubRepo: d.vars?.github_repo, choreWatcher: d.vars?.chore_watcher }];
    }
    const only = o.only;
    // another watcher's release does not replace this one's runs: its runs are left out before the comparison
    if (only?.watcher !== undefined) briefs = briefs.filter((b) => b.choreWatcher === only.watcher);
    return supersededReleases(briefs).filter((b) => !only || (b.flow === only.flow && b.githubRepo!.toLowerCase() === only.repo.toLowerCase()));
  } catch {
    return [];
  }
}

/** Archives superseded release runs (of one flow and repository with `only`). Returns the archived ids. Never throws. */
export function reconcileSupersededReleases(scheduler: Archiver, o: Reconcile = {}): string[] {
  return archive(scheduler, candidates(scheduler, o), o.log);
}

/** Like `reconcileSupersededReleases`, in batches with a pause between them, so a big backlog does not hold up the server. */
export async function reconcileSupersededInBatches(scheduler: Archiver, o: Reconcile & { batch?: number } = {}): Promise<string[]> {
  await new Promise<void>((r) => setImmediate(r)); // start-up work does not run inside the caller's tick
  const list = candidates(scheduler, o);
  const size = Math.max(1, o.batch ?? 20);
  const ids: string[] = [];
  for (let i = 0; i < list.length; i += size) {
    ids.push(...archive(scheduler, list.slice(i, i + size), o.log));
    if (i + size < list.length) await new Promise<void>((r) => setImmediate(r));
  }
  return ids;
}

/** A release run succeeded: archives the older failed or stopped runs of its flow and repository. */
export function archiveSupersededReleases(scheduler: Archiver, done: DoneRun, log?: Log): string[] {
  const repo = done.vars?.github_repo;
  if (done.status !== "succeeded" || !RELEASE_FLOWS.includes(done.flow) || !repo) return [];
  return reconcileSupersededReleases(scheduler, { log, done, only: scopeOf(done, repo) });
}

/** A run has fully settled (it has left the active list). */
export function releaseSettled(scheduler: Archiver, done: DoneRun, log?: Log): string[] {
  const repo = done.vars?.github_repo;
  if (!RELEASE_FLOWS.includes(done.flow) || !repo) return [];
  if (done.status === "succeeded") return archiveSupersededReleases(scheduler, done, log);
  if (done.status === "failed" || done.status === "stopped") return reconcileSupersededReleases(scheduler, { log, done, only: scopeOf(done, repo) });
  return [];
}
