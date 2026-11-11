import { setImmediate as yieldLoop } from "node:timers/promises";
import { getRepo } from "../auth/repos.js";
import { ownerNames } from "../auth/run-owner.js";
import type { User } from "../auth/users.js";
import type { RunBrief } from "../engine/state.js";
import { gitflowOf } from "../monitor/chains.js";
import { safePoints, safeSourcesOf, MAX_SAFE_POINTS, type SafePoint, type SafeSource } from "../safe-points.js";
import { runOrigin } from "../your-turn.js";
import { projectRun } from "./api-preview.js";
import { guardedRepos } from "./api-repos.js";
import { HttpError, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { callerWorkspaces, inWorkspaces } from "./workspace-scope.js";

/** Runs read at most, newest write first. The scan stops earlier as soon as the answer is settled. */
export const MAX_SAFE_RUNS = 1500;
const BATCH = 50;
const CACHE_MAX = 50;

export interface SafePointsAnswer {
  branch: string;
  gitflow: boolean;
  points: SafePoint[];
  /** False when the scan stopped at MAX_SAFE_RUNS before it found MAX_SAFE_POINTS points: older ones may exist. */
  complete: boolean;
}

interface Scan { key: string; sources: SafeSource[]; complete: boolean }
const cache = new Map<string, Scan>();

const keyOf = (briefs: RunBrief[], main: string): string => `${main}|${briefs.map((b) => `${b.runId}:${b.updatedAt}`).join(",")}`;

/** The branch and the points of the sources found so far. */
function view(sources: SafeSource[], o: { watched: boolean; main: string; develop?: string | undefined }, viewer: { id: string; admin: boolean }) {
  const gitflow = o.watched || sources.some((s) => s.role === "develop");
  const newest = sources.filter((s) => s.role === "develop").sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.branch;
  const branch = gitflow ? o.develop ?? newest ?? "develop" : o.main;
  let names: Map<string, string> | undefined;
  return { gitflow, branch, points: safePoints(sources, { branch, viewer, names: () => (names ??= ownerNames()) }) };
}

/** The safe points of one repository, from the run records only. Throws 404 for a repository the caller may not see. */
export async function safePointsFor(ctx: ApiContext, user: User, repoId: string): Promise<SafePointsAnswer> {
  const rec = guardedRepos(ctx, () => getRepo(repoId));
  if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
  const main = rec.settings?.mainBranch ?? "main";
  const develop = rec.settings?.developBranch;
  const viewer = { id: user.id, admin: user.role === "admin" };
  const ws = callerWorkspaces(user);
  const watched = ctx.config().watchers.some((w) => w.enabled && w.source === "issues" && projectRun(rec, { vars: { github_repo: w.github_repo } }) && gitflowOf(w, w.github_repo));
  // A brief has `githubRepo`, a summary has `vars.github_repo`: the same matcher gets the one shape it knows.
  const briefs = ctx.scheduler.briefs().filter((b) =>
    b.status === "succeeded" && !b.localTest && b.githubRepo !== undefined && projectRun(rec, { vars: { github_repo: b.githubRepo } })
    && !["eval", "refinement"].includes(runOrigin(b.source)) && (user.role === "admin" || inWorkspaces(ws, b.workspace)))
    // newest write first: a run's file is written when its step ends, so no unread run holds a point newer than its time
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  const key = `${user.role === "admin" ? "a" : user.id}|${keyOf(briefs, main)}`;
  const hit = cache.get(repoId);
  if (hit && hit.key === key) {
    cache.delete(repoId);
    cache.set(repoId, hit);
    return { ...view(hit.sources, { watched, main, develop }, viewer), complete: hit.complete };
  }
  const sources: SafeSource[] = [];
  const settled = (v: { points: SafePoint[] }, next: RunBrief): boolean =>
    v.points.length >= MAX_SAFE_POINTS && Date.parse(v.points[MAX_SAFE_POINTS - 1]!.at) >= (Date.parse(next.updatedAt) || 0);
  // Runs are read newest write first; a point is never newer than the write of its run, so once the tenth point is at least
  // as new as the next unread run, no run left can change the answer.
  let i = 0;
  for (; i < briefs.length && i < MAX_SAFE_RUNS; i++) {
    if (i > 0 && i % BATCH === 0) {
      if (settled(view(sources, { watched, main, develop }, viewer), briefs[i]!)) break;
      await yieldLoop();
    }
    const run = ctx.scheduler.get(briefs[i]!.runId);
    if (run) sources.push(...safeSourcesOf(run, { mainBranch: main }));
  }
  const next = briefs[i];
  const v = view(sources, { watched, main, develop }, viewer);
  // complete is false only when the cap stopped the scan before the answer was settled: older points may exist
  const complete = next === undefined || settled(v, next);
  cache.set(repoId, { key, sources, complete });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return { ...v, complete };
}

/** GET repos/:id/safe-points — read-only, from the run records. */
export const safePointRoutes: Route = async (ctx, _req, res, seg, method, user) => {
  if (seg[0] !== "repos" || seg[2] !== "safe-points" || method !== "GET" || seg.length !== 3) return false;
  return send(res, 200, await safePointsFor(ctx, user, seg[1]!)), true;
};
