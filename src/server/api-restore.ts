import type { IncomingMessage } from "node:http";
import { auditAction } from "../auth/audit.js";
import { isLocalRepoName, localRepoName } from "../auth/local-name.js";
import { getRepo } from "../auth/repos.js";
import { githubNameOf } from "../auth/repo-url.js";
import type { User } from "../auth/users.js";
import { PublishGrants, fingerprint, publishGrantsOf, type PublishBinding, type PublishReason } from "../repos/publish-grants.js";
import { readRed, redFile } from "../red-base.js";
import { issueUrl } from "../refinement/publish.js";
import { RefinementError } from "../refinement/store.js";
import { RESTORE_NOT_UNDONE, RESTORE_OTHERS, restoreIssue, restoreMarker, takenBack } from "../restore.js";
import { storeFor } from "../stories/store.js";
import { buildLabelOf } from "../refinement/build-limits.js";
import { guardedRepos } from "./api-repos.js";
import { safePointsFor } from "./api-safe-points.js";
import { GH_TIMEOUT_MS, whatHappened } from "./api-refinement-import.js";
import { HttpError, readJson, send } from "./http.js";
import { asOwnedProject, stillOwnsProject } from "./repo-sign-in.js";
import type { ApiContext, Route } from "./server.js";

const COMMIT = /^[0-9a-f]{40}$/i;

/** The sentences of a refusal. Each says that nothing was opened. */
export const RESTORE_WORDS = {
  needed: "Nothing was opened: look at what is taken back first, then confirm with Yes, open the change",
  used: "Nothing was opened: the confirmation is used up or has expired, or this restore is being opened; look at it again",
  mismatch: "Nothing was opened: the confirmation was made for another request; look at it again",
  changed: "Nothing was opened: the safe points changed since you looked; look at what is taken back again",
  notPoint: "Nothing was opened: that version is not one of the safe points any more",
  noLabel: "Nothing was opened: this project has no enabled watcher for issues, so no label starts a build",
} as const;

/** Restores being opened now, by project and commit: a second confirm at the same time is refused. */
const busy = new Set<string>();

/** Whether a watcher that builds issues runs for this project: a local project needs its own enabled `issues` watcher. */
function hasWatcher(ctx: ApiContext, rec: { id: string }, name: string): boolean {
  if (isLocalRepoName(name)) return ctx.config().watchers.some((w) => w.enabled && w.source === "issues" && w.repoId === rec.id);
  return buildLabelOf(name, ctx.config().watchers) !== undefined;
}

/** The failing tests of the project's base branch while it is red; none otherwise. */
function failingOf(ctx: ApiContext, name: string, branch: string): string[] {
  try {
    const s = readRed(redFile(ctx.opts.runsDir), name, branch);
    return s && s.held && !s.cleared ? s.failing : [];
  } catch {
    return [];
  }
}

function parse(body: Record<string, unknown>): { commit: string; dryRun: true } | { commit: string; dryRun: false; confirm: string } {
  if (Object.keys(body).some((k) => k !== "commit" && k !== "dryRun" && k !== "confirm")) throw new HttpError(400, "the body takes commit, dryRun and confirm only");
  if (typeof body.commit !== "string" || !COMMIT.test(body.commit)) throw new HttpError(400, "commit must be a full commit id (40 hex characters)");
  const commit = body.commit.toLowerCase();
  if (body.dryRun === true && body.confirm === undefined) return { commit, dryRun: true };
  if (body.dryRun === undefined && typeof body.confirm === "string") return { commit, dryRun: false, confirm: body.confirm };
  throw new HttpError(400, "send either { commit, dryRun: true } or { commit, confirm }");
}

const refusal = (reason: PublishReason): HttpError => new HttpError(409, RESTORE_WORDS[reason]);

/** Opens the story. A local project finishes a story that was saved and not committed, instead of saving a second one. */
async function open(ctx: ApiContext, owner: string, name: string, story: { title: string; body: string; labels: string[] }, marker: string) {
  const timeout = ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
  const local = isLocalRepoName(name);
  const store = storeFor(name);
  const guard = local ? () => stillOwnsProject(owner, name) : undefined;
  const finish = async (n: number) => {
    await store.commitCreated?.(n, timeout, guard);
    return { issue: n, url: issueUrl(name, n, undefined) };
  };
  const saved = async () => (await store.listNewest(timeout)).find((i) => i.state !== "closed" && typeof i.body === "string" && i.body.includes(marker));
  try {
    if (local) {
      const earlier = await saved();
      if (earlier) return await finish(earlier.number);
    }
    const made = await store.create(story, timeout, guard);
    return { issue: made.number, url: issueUrl(name, made.number, made.html_url) };
  } catch (e) {
    if (e instanceof RefinementError) throw e;
    if (local) {
      // The story may be saved while its commit failed: finish that one.
      try {
        const found = await saved();
        if (found) return await finish(found.number);
      } catch (e2) {
        if (e2 instanceof RefinementError) throw e2;
      }
      throw new HttpError(502, `The story could not be saved: ${whatHappened(e)}. Check the story list before you try again.`);
    }
    throw new HttpError(502, `GitHub did not answer as expected: ${whatHappened(e)}. The change may exist: check the issue list before you try again.`);
  }
}

async function restore(ctx: ApiContext, req: IncomingMessage, user: User, id: string) {
  const rec = guardedRepos(ctx, () => getRepo(id));
  if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
  const input = parse(await readJson(req));
  const name = rec.method === "local" ? localRepoName(rec) : githubNameOf(rec.url);
  if (!name || !hasWatcher(ctx, rec, name)) throw new HttpError(409, RESTORE_WORDS.noLabel);
  const label = buildLabelOf(name, ctx.config().watchers, rec.owner);
  if (!label) throw new HttpError(409, RESTORE_WORDS.noLabel);

  const answer = await safePointsFor(ctx, user, id);
  const point = answer.points.find((p) => p.commit.toLowerCase() === input.commit);
  const taken = takenBack(answer.points, input.commit);
  if (!point || !taken) throw new HttpError(409, RESTORE_WORDS.notPoint);

  const grants: PublishGrants = publishGrantsOf(ctx);
  const bind: PublishBinding = { owner: user.id, repoId: rec.id, kind: "restore", request: input.commit };
  const what = fingerprint({ branch: answer.branch, commit: input.commit, newest: answer.points[0]?.commit, taken: taken.changes.map((c) => [c.issue, c.title]), more: taken.more });

  if (input.dryRun) {
    return {
      commit: point.commit, short: point.short, branch: point.branch, at: point.at,
      takenBack: taken.changes.map((c) => c.title), more: taken.more, others: RESTORE_OTHERS, notUndone: RESTORE_NOT_UNDONE,
      confirm: grants.issue(bind, what),
    };
  }

  const key = `${rec.id}:${input.commit}`;
  if (busy.has(key)) throw new HttpError(409, RESTORE_WORDS.used);
  busy.add(key);
  try {
    const t = grants.take(input.confirm, bind);
    if (!t.ok) throw refusal(t.reason);
    if (t.grant.what !== what) throw new HttpError(409, RESTORE_WORDS.changed);
    const failing = failingOf(ctx, name, answer.branch);
    const story = restoreIssue(point, taken, failing);
    const made = await asOwnedProject(ctx, rec.owner, name, async () => {
      if (!isLocalRepoName(name)) {
        let labels: string[];
        try {
          labels = await storeFor(name).labels(ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS);
        } catch (e) {
          throw new HttpError(502, `could not read the labels on GitHub: ${whatHappened(e)}; nothing was opened`);
        }
        const found = labels.find((l) => l.toLowerCase() === label.toLowerCase());
        if (!found) throw new HttpError(409, `Nothing was opened: the build label "${label}" does not exist in ${name}; create it first`);
        return open(ctx, rec.owner, name, { ...story, labels: [found] }, restoreMarker(point.commit));
      }
      return open(ctx, rec.owner, name, { ...story, labels: [label] }, restoreMarker(point.commit));
    });
    auditAction(ctx.diagLog, user.id, "safe-point-restore", rec.id, `${point.short} on ${point.branch}: change #${made.issue}`);
    return { issue: made.issue, ...(made.url ? { url: made.url } : {}) };
  } catch (e) {
    if (e instanceof RefinementError) throw new HttpError(409, e.message);
    throw e;
  } finally {
    busy.delete(key);
  }
}

/** POST repos/:id/safe-points/restore — a preview (dryRun), then one normal change that takes the branch back to a safe point. */
export const restoreRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "repos" || seg[2] !== "safe-points" || seg[3] !== "restore" || seg.length !== 4 || method !== "POST") return false;
  return send(res, 200, await restore(ctx, req, user, seg[1]!)), true;
};
