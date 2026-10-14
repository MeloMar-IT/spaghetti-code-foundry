import { githubNameOf } from "../auth/repo-url.js";
import { getRepo } from "../auth/repos.js";
import type { User } from "../auth/users.js";
import { readForecasts, saveMissingForecasts } from "../epics/forecast-store.js";
import type { Forecast } from "../epics/forecast.js";
import { epicKeyOf, epicView, epicsView, type EpicsViewInput } from "../epics/view.js";
import { medianRunMs } from "../estimate.js";
import type { NextStep } from "../next-step.js";
import { readIssueList } from "../queue/issue-list.js";
import { labelNames } from "../queue/watcher.js";
import { guardedRepos } from "./api-repos.js";
import { boardSources } from "./board.js";
import { HttpError, send } from "./http.js";
import { historyFor, ownRecord } from "./next.js";
import type { ApiContext, Route } from "./server.js";
import { userRecord } from "./user-view.js";

const SAVE_WAIT_MS = 500;

/** What the pure view needs, from the saved files and the watchers' records. No call to GitHub. */
function epicsInput(ctx: ApiContext, user: User, repoId: string, now: Date): EpicsViewInput {
  const rec = guardedRepos(ctx, () => getRepo(repoId));
  if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
  const name = githubNameOf(rec.url)?.toLowerCase();
  const watchers = ctx.config().watchers.filter((w) => w.enabled && w.source === "issues" && name !== undefined && w.github_repo.toLowerCase() === name);
  const first = watchers[0];
  const base: EpicsViewInput = { repo: first?.github_repo ?? name ?? "", watched: !!first, labels: [], doneLabels: [], states: new Map(), now };
  if (!first) return base;

  const names = watchers.map((w) => labelNames(w));
  base.labels = [...new Set([...watchers.map((w) => w.label), ...names.flatMap((n) => [n.working, n.done, n.needsInfo, n.waiting, n.failed])])];
  base.doneLabels = [...new Set([...watchers.flatMap((w) => w.dependency_done_labels), ...names.map((n) => n.done)])];
  const list = readIssueList(first.github_repo);
  if (list) base.list = list;
  const stored = readForecasts(first.github_repo);
  if (stored) base.stored = stored;
  if (!list) return base;

  // The same reconciliation as the board: a newer live run beats a stale watcher snapshot, queued jobs count.
  const admin = user.role === "admin";
  const mine = (id: string) => ctx.scheduler.ownerOf(id) === user.id;
  const picked = new Map<number, { rank: number; next: NextStep }>();
  for (const s of boardSources(ctx, now, !admin).sources) {
    if (s.next.repo.toLowerCase() !== name || s.next.issue === undefined) continue;
    const have = picked.get(s.next.issue);
    const rank = s.rank ?? 1;
    if (!have || rank < have.rank) picked.set(s.next.issue, { rank, next: admin ? s.next : userRecord(ownRecord(s.next, mine)) });
  }
  base.states = new Map([...picked].map(([n, p]) => [n, p.next]));
  const median = medianRunMs(historyFor(ctx), first.github_repo);
  if (median !== undefined) base.medianStoryMs = median;
  return base;
}

/** Saves the forecasts that are not stored for today. A failure is logged; the answer does not depend on it. */
async function saveDue(ctx: ApiContext, repo: string, save: Map<string, Forecast>, now: Date): Promise<void> {
  if (!save.size) return;
  try {
    await saveMissingForecasts(repo, save, now, SAVE_WAIT_MS);
  } catch {
    ctx.diagLog?.("epics: forecast not saved");
  }
}

/** GET repos/:id/epics and repos/:id/epics/:issue — read-only, from the saved issue list and the watchers' records. */
export const epicRoutes: Route = async (ctx, _req, res, seg, method, user) => {
  if (seg[0] !== "repos" || seg[2] !== "epics" || method !== "GET" || (seg.length !== 3 && seg.length !== 4)) return false;
  const now = new Date();
  let input = epicsInput(ctx, user, seg[1]!, now);
  // After a save the answer is made again from what the file holds: it never shows a day that was not saved, and a day
  // that another request saved first is the one shown.
  const settle = async (save: Map<string, Forecast>): Promise<boolean> => {
    if (!save.size) return false;
    await saveDue(ctx, input.repo, save, now);
    const stored = readForecasts(input.repo);
    input = { ...input };
    if (stored) input.stored = stored;
    else delete input.stored;
    return true;
  };
  if (seg.length === 3) {
    const first = epicsView(input);
    return send(res, 200, (await settle(first.save)) ? epicsView(input).answer : first.answer), true;
  }
  const key = epicKeyOf(seg[3]!);
  if (!key) throw new HttpError(400, "not an epic: give its issue number");
  const found = epicView(input, key);
  if (!found) throw new HttpError(404, "no such epic");
  return send(res, 200, (await settle(found.save)) ? epicView(input, key)!.answer : found.answer), true;
};
