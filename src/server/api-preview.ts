import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { localRepoName } from "../auth/local-name.js";
import { githubKey, githubNameOf, tryParseRepoUrl, validGithubName } from "../auth/repo-url.js";
import { NEEDS_TOKEN, getRepo, readRepoSecret, repoAccess, type RepoRecord } from "../auth/repos.js";
import { validBranchName } from "../auth/repo-settings.js";
import { getUser, type User } from "../auth/users.js";
import { APP_PERMISSIONS } from "../engine/repo-broker.js";
import { appTokenAccess } from "../engine/repo-access.js";
import type { RunSummary } from "../engine/state.js";
import { PREVIEW_VERSIONS } from "../preview/config.js";
import { PreviewService, type PreviewJob, type PreviewVersion, type SourceFactory } from "../preview/service.js";
import { needsUser } from "../your-turn.js";
import { guardedRepos } from "./api-repos.js";
import { HttpError, readJson, send } from "./http.js";
import { nextFor } from "./next.js";
import type { ApiContext } from "./server.js";

const services = new WeakMap<ApiContext, PreviewService>();

/** The previews of this server: one service, one runner. */
export function previewsOf(ctx: ApiContext): PreviewService {
  let s = services.get(ctx);
  if (!s) {
    s = new PreviewService({ log: ctx.diagLog });
    services.set(ctx, s);
  }
  return s;
}

const RUN_ID = /^[\w-]{1,128}$/;
const BRANCH_LINE = /^BRANCH: (\S+) \(/m;

/** The branch of the work a run built: the newest successful branch step says it, else the run's own branch. */
export function runBranch(run: Pick<RunSummary, "history" | "branch">): string | undefined {
  const history = run.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (!h.ok || (h.id !== "feature_branch" && h.id !== "hotfix_branch")) continue;
    const m = BRANCH_LINE.exec(h.output ?? "");
    if (m) return m[1];
  }
  return run.branch;
}

/** Is the run a run of this project? */
export function projectRun(rec: Pick<RepoRecord, "id" | "url" | "method">, run: Pick<RunSummary, "vars">): boolean {
  const name = run.vars?.github_repo;
  if (typeof name !== "string") return false;
  if (rec.method === "local") return name === localRepoName(rec);
  if (!validGithubName(name)) return false;
  const key = tryParseRepoUrl(rec.url)?.key;
  return key !== undefined && githubKey(name) === key;
}

/** The sign-in of the record, worked out only when this source is asked for. */
function recordSource(ctx: ApiContext, rec: RepoRecord): SourceFactory {
  return async (signal) => {
    if (rec.method === "local") return { kind: "path", path: rec.url };
    const github = githubNameOf(rec.url);
    if (github !== undefined) {
      const a = repoAccess(rec.owner, github, { unlisted: "refuse" });
      if (a.kind === "token") return { kind: "remote", url: a.url, auth: { method: rec.method, username: a.username, secret: a.token } };
      if (a.kind === "key") return { kind: "remote", url: a.url, auth: { method: "ssh-deploy-key", secret: a.key } };
      if (a.kind === "server") return { kind: "remote", url: rec.url, auth: { method: "none" } };
      if (a.kind === "refused") return { refused: a.reason };
      const t = await appTokenAccess(a, ctx.config(), 20_000, APP_PERMISSIONS.clone);
      if (signal.aborted) return { refused: "cancelled" };
      return t.ok ? { kind: "remote", url: a.url, auth: { method: "github-token", secret: t.token } } : { refused: t.reason };
    }
    if (rec.method === "none") return getUser(rec.owner)?.role === "admin" ? { kind: "remote", url: rec.url, auth: { method: "none" } } : { refused: NEEDS_TOKEN };
    try {
      return { kind: "remote", url: rec.url, auth: { method: rec.method, username: rec.username, secret: readRepoSecret(rec) } };
    } catch {
      return { refused: "the sign-in of this repository cannot be read; set it again under My repositories" };
    }
  };
}

/** The run's own workspace holds the branch before it is pushed. Not usable when it is not a git folder. */
function workspaceSource(run: RunSummary): SourceFactory {
  return async () => {
    const dir = run.workdir ?? join(run.runDir, "workspace");
    return existsSync(join(dir, ".git")) ? { kind: "path", path: dir } : { refused: "the work of this run has no folder" };
  };
}

/** `POST|GET|DELETE /api/repos/<id>/preview`. */
export async function previewRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, repoId: string, method: string, user: User): Promise<boolean> {
  if (method !== "POST" && method !== "GET" && method !== "DELETE") return false;
  const rec = guardedRepos(ctx, () => getRepo(repoId));
  if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
  const previews = previewsOf(ctx);
  if (method === "GET") return send(res, 200, previews.view(rec.id, true)), true;
  if (method === "DELETE") return send(res, 200, await previews.stop(rec.id)), true;
  const body = await readJson(req);
  const version = body.version;
  if (typeof version !== "string" || !(PREVIEW_VERSIONS as readonly string[]).includes(version)) throw new HttpError(400, `version must be one of: ${PREVIEW_VERSIONS.join(", ")}`);
  const runId = body.runId;
  const develop = rec.settings?.developBranch ?? "develop";
  let job: PreviewJob;
  if (version === "develop") {
    if (runId !== undefined) throw new HttpError(400, "runId is only for the version checking");
    job = { repoId: rec.id, version: version as PreviewVersion, branch: develop, sources: [recordSource(ctx, rec)] };
  } else {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new HttpError(400, "runId is needed for the version checking");
    const run = ctx.scheduler.get(runId);
    // another account's run is not named to a user, as in the run routes: only its owner or an admin may preview its work
    const mine = user.role === "admin" || ctx.scheduler.ownerOf(runId) === user.id;
    if (!run || !mine || !projectRun(rec, run)) throw new HttpError(404, "no such run of this project");
    if (!needsUser(nextFor(ctx, undefined, true)(run))) throw new HttpError(409, "this work is not waiting for your check");
    const branch = runBranch(run);
    if (!branch || !validBranchName(branch)) throw new HttpError(409, "this run has no branch to try");
    job = { repoId: rec.id, version: "checking", runId, branch, sources: [workspaceSource(run), recordSource(ctx, rec)] };
  }
  return send(res, 202, previews.start(job)), true;
}
