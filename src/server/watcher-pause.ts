import { auditAction } from "../auth/audit.js";
import { getRepo } from "../auth/repos.js";
import { listRepoWatchers, updateRepoWatcher } from "../repos/watchers.js";
import { type WatcherState, watcherState } from "../words.js";
import { guardedRepos, guardedWatchers, watcherRows } from "./api-repos.js";
import { HttpError } from "./http.js";
import type { ApiContext } from "./server.js";

export interface WatcherSwitch { id: string; repoId: string; github_repo: string; enabled: boolean; state: WatcherState }

/** Pause (enabled false) or resume (true) one stored watcher by id; audits a real change and syncs the running watchers. */
export function setWatcherEnabled(ctx: ApiContext, id: string, enabled: boolean, by: string): WatcherSwitch {
  if (ctx.fileConfig().watchers.some((w) => w.id === id)) throw new HttpError(409, `watcher "${id}" is kept in config.yaml; change it in the settings`);
  const w = guardedWatchers(ctx, listRepoWatchers).find((x) => x.id === id);
  if (!w) throw new HttpError(404, "no such watcher");
  const rec = guardedRepos(ctx, () => getRepo(w.repoId));
  if (!rec) throw new HttpError(409, "the repository of this watcher is not connected any more; delete the watcher");
  const r = guardedWatchers(ctx, () => updateRepoWatcher(w.repoId, id, { enabled }, { local: rec.method === "local" }));
  if (r.changed.length) {
    auditAction(ctx.diagLog, by, "repo-change", w.repoId, `watcher ${id}: ${enabled ? "resumed" : "paused"}`);
    ctx.watchers.sync();
  }
  const row = watcherRows(ctx).find((x) => x.id === id && x.repoId === w.repoId);
  return { id, repoId: w.repoId, github_repo: row?.github_repo ?? "", enabled: r.watcher.enabled !== false, state: row?.state ?? watcherState(enabled ? "active" : "disabled") };
}
