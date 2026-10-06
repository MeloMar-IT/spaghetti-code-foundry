import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { auditAction } from "../auth/audit.js";
import { REPO_METHODS, type RepoRecord, RepoError, addRepo, checkNewRepo, checkRepoAuth, getRepo, listAllRepos, listRepos, readRepoSecret, removeGithubRepo, removeRepo, setRepoAuth, setRepoReady, setRepoConnection, setRepoSettings, transferRepo, watchersRemovedDetail } from "../auth/repos.js";
import { readyView } from "../refinement/ready-list.js";
import { githubNameOf, tryParseRepoUrl } from "../auth/repo-url.js";
import { type InstallProblem, type RepoApp, installUrl, repoApp, repoInstallation } from "../github-app.js";
import { type Code, ConnectError, TEST_TIMEOUT_MS, blockedResult, testConnection } from "../repos/connect.js";
import { StoreError } from "../auth/store.js";
import { type User, getUser, listUsers } from "../auth/users.js";
import { KeyError } from "../credentials/keychain.js";
import { KeygenError } from "../credentials/ssh-keygen.js";
import { RepoWatcherError, addRepoWatcher, listRepoWatchers, removeRepoWatcher,updateRepoWatcher, watcherRepoProblem } from "../repos/watchers.js";
import { watcherState } from "../words.js";
import { watchersWithNext } from "./next.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

const INTERNAL = "the repository list is not working; see the server log";
const STATUS = { "bad-name": 400, "bad-url": 400, "bad-auth": 400, duplicate: 409, taken: 409, limit: 400, "not-found": 404, "no-owner": 404, "bad-settings": 400, "bad-owner": 400, blocked: 409, "no-credential": 409, "bad-ready": 400 } as const;

/**
 * Runs repository-list code. Input errors become 4xx; everything else is logged (the file name and the kind, never
 * a path or a value) and answered with a plain 500.
 */
export function guardedRepos<T>(ctx: ApiContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RepoError) throw new HttpError(STATUS[e.code], e.message);
    if (e instanceof HttpError) throw e;
    const log = ctx.diagLog;
    if (e instanceof KeygenError) {
      log?.(`repos: ssh-keygen ${e.code}`);
      throw new HttpError(500, "the SSH key could not be made; see the server log");
    }
    if (e instanceof StoreError) log?.(`repos: ${basename(e.file)} ${e.kind}`);
    else if (e instanceof KeyError) log?.(`repos: keychain ${e.code === "wrong-key" ? "wrong-key" : "failed"}`);
    else log?.(`repos: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

const WATCHER_STATUS = { "bad-watcher": 400, duplicate: 409, "not-found": 404 } as const;

/** Like guardedRepos, for the watcher store: its input errors become 4xx; a broken store gives the fixed 500. */
function guardedWatchers<T>(ctx: ApiContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RepoWatcherError) throw new HttpError(WATCHER_STATUS[e.code], e.message);
    return guardedRepos(ctx, () => {
      throw e;
    });
  }
}

/** GET /api/watchers: the watchers that run or are listed from config.yaml, and the stored ones that cannot run (with their `problem`, in the disabled, paused or error state, without a status). */
export function watcherRows(ctx: ApiContext) {
  const blocked = ctx.blockedWatchers().map((b) => ({ ...b, state: watcherState(!b.enabled ? "disabled" : b.paused ? "paused" : "error") }));
  return [...watchersWithNext(ctx), ...blocked];
}

/**
 * Removes a repository through `remove` (which also removes its watchers), writes the audit lines and always brings the
 * running watchers in line, also when the removal failed half way.
 */
function removeAndTell(ctx: ApiContext, by: string, remove: () => ReturnType<typeof removeRepo>): void {
  try {
    const r = guardedRepos(ctx, remove);
    if (r.removed) {
      auditAction(ctx.diagLog, by, "repo-remove", r.removed.id, r.removed.url);
      if (r.watchers?.length) auditAction(ctx.diagLog, by, "repo-change", r.removed.id, watchersRemovedDetail(r.watchers));
    }
    oldKeys(ctx, r.oldKeysLeft, "the repository was removed");
  } finally {
    ctx.watchers.sync();
  }
}

/** A value of the body: missing or null is "not given"; anything else goes to the store, which checks it. */
const given = (body: Record<string, unknown>, key: string): unknown => (body[key] === null ? undefined : body[key]);

/** After a wipe: an old key that is still in the Keychain is reported, like the credentials API does. */
function oldKeys(ctx: ApiContext, left: number, done: string): void {
  if (!left) return;
  ctx.diagLog?.(`repos: ${left} old key(s) still in the Keychain; run scf credential rotate-key`);
  throw new HttpError(500, `${done}, but an old key is still in the Keychain, so older copies of the data could be read; try again, or run scf credential rotate-key`);
}

const APP_NOT_SET_UP = "the GitHub App is not set up on this server; ask the administrator, or choose another method";

/** The app, or a 400 when the administrator has not set it up. */
function needApp(ctx: ApiContext): RepoApp {
  const app = repoApp(ctx.config());
  if (!app) throw new HttpError(400, APP_NOT_SET_UP);
  return app;
}

/**
 * Finds the installation of the app on a GitHub repository. Answers 409 when the app is not installed there. Nothing of the
 * app (key, tokens, GitHub's text) is logged or answered; the log holds a fixed word.
 */
async function lookupInstallation(ctx: ApiContext, app: RepoApp, github: string | undefined): Promise<string> {
  const found = github ? await repoInstallation(app, github) : ({ ok: false, problem: "failed" } as const);
  if (found.ok) return found.installationId;
  if (found.problem === "not-installed") throw new HttpError(409, "the GitHub App is not installed on this repository; install it with the link on the page, then save again");
  ctx.diagLog?.(`repos: github-app ${found.problem}`);
  if (found.problem === "app-broken") throw new HttpError(500, "the GitHub App of this server is not working; ask the administrator");
  throw new HttpError(502, "GitHub could not be asked about the app; try again later");
}

const BLOCKED: Record<InstallProblem, Code> = { "not-installed": "app-not-installed", "app-broken": "app-broken", "rate-limit": "rate-limit", unreachable: "unreachable", failed: "failed" };

/** A record as its owner sees it: with `github` ("owner/name") when it is a GitHub repository. */
const shown = <T extends { url: string }>(r: T): T & { github?: string } => {
  const github = githubNameOf(r.url);
  return github === undefined ? r : { ...r, github };
};

/** The public keys of deploy-key records; `send` keeps them readable (a public key is not a secret). */
const publicKeys = (repos: Pick<RepoRecord, "publicKey">[]) => repos.flatMap((r) => (r.publicKey ? [r.publicKey] : []));

/** A record for the admin page: with its settings (`{}` when none) and the owner's name, e-mail, role and status (null when the account is gone). */
function adminRow(rec: RepoRecord, users?: Map<string, User>) {
  const u = users ? users.get(rec.owner) : getUser(rec.owner);
  const problem = watcherRepoProblem(rec, u ?? undefined);
  const { definitionOfReady, ...rest } = rec;
  return { ...rest, settings: rec.settings ?? {}, ready: readyView(definitionOfReady), account: u ? { name: u.name, email: u.email, role: u.role, status: u.status } : null, ...(problem ? { watcherProblem: problem } : {}) };
}

/** The admin calls (the permission table lets only an admin through): all repositories, their settings, and transfer. */
async function adminRepos(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string, by: string): Promise<boolean> {
  if (seg[1] !== "repos") return false;
  if (seg.length === 2 && method === "GET") {
    const rows = guardedRepos(ctx, () => {
      const users = new Map(listUsers().map((u) => [u.id, u]));
      return listAllRepos().map((r) => adminRow(r, users));
    });
    return send(res, 200, rows, publicKeys(rows)), true;
  }
  if (seg.length === 4 && seg[3] === "settings" && method === "PUT") {
    const body = await readJson(req);
    const r = guardedRepos(ctx, () => setRepoSettings(seg[2]!, body));
    if (r.changed.length) auditAction(ctx.diagLog, by, "repo-change", r.repo.id, `settings: ${r.changed.join(", ")}`);
    const row = adminRow(r.repo);
    return send(res, 200, row, publicKeys([row])), true;
  }
  if (seg.length === 4 && seg[3] === "ready" && method === "PUT") {
    const body = await readJson(req);
    const r = guardedRepos(ctx, () => setRepoReady(seg[2]!, body));
    if (r.changed) {
      const detail = r.repo.definitionOfReady ? `definition of ready: ${r.repo.definitionOfReady.length} items` : "definition of ready: back to the default";
      auditAction(ctx.diagLog, by, "repo-change", r.repo.id, detail);
    }
    const row = adminRow(r.repo);
    return send(res, 200, row, publicKeys([row])), true;
  }
  if (seg.length === 4 && seg[3] === "transfer" && method === "POST") {
    const body = await readJson(req);
    const r = guardedRepos(ctx, () => transferRepo(seg[2]!, given(body, "email")));
    if (r.moved) {
      auditAction(ctx.diagLog, by, "repo-transfer", r.repo.id, r.repo.owner);
      ctx.watchers.sync(); // the new owner gets the runs
    }
    oldKeys(ctx, r.oldKeysLeft, "the repository was transferred");
    const row = adminRow(r.repo);
    return send(res, 200, row, publicKeys([row])), true;
  }
  if (seg[3] === "watchers" && seg.length <= 5) return adminWatchers(ctx, req, res, seg, method, by);
  return false;
}

/** The watchers of one repository (admin only): list, add, change (also enable and disable), delete. */
async function adminWatchers(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string, by: string): Promise<boolean> {
  const repoId = seg[2]!;
  const wid = seg[4];
  const known = () => {
    const rec = guardedRepos(ctx, () => getRepo(repoId));
    if (!rec) throw new HttpError(404, "no such repository");
    return rec;
  };
  const rowOf = (id: string, fallback: object) => watcherRows(ctx).find((w) => w.id === id && w.repoId === repoId) ?? fallback;
  const audit = (detail: string) => auditAction(ctx.diagLog, by, "repo-change", repoId, detail);
  if (seg.length === 4 && method === "GET") {
    known();
    guardedWatchers(ctx, listRepoWatchers); // a store that cannot be read is an error here, not an empty list
    return send(res, 200, watcherRows(ctx).filter((w) => w.repoId === repoId)), true;
  }
  if (seg.length === 4 && method === "POST") {
    const body = await readJson(req);
    const rec = known();
    const problem = guardedRepos(ctx, () => watcherRepoProblem(rec, getUser(rec.owner)));
    if (problem) throw new HttpError(400, problem);
    const w = guardedWatchers(ctx, () => addRepoWatcher(repoId, body, { taken: ctx.fileConfig().watchers.map((x) => x.id) }));
    audit(`watcher ${w.id}: added`);
    ctx.watchers.sync();
    return send(res, 201, rowOf(w.id, w)), true;
  }
  if (seg.length === 5 && method === "PUT") {
    const body = await readJson(req);
    known();
    const r = guardedWatchers(ctx, () => updateRepoWatcher(repoId, wid!, body));
    if (r.changed.length) {
      audit(`watcher ${wid}: ${r.changed.join(", ") === "enabled" ? (r.watcher.enabled ? "enabled" : "disabled") : `changed ${r.changed.join(", ")}`}`);
      ctx.watchers.sync();
    }
    return send(res, 200, rowOf(wid!, r.watcher)), true;
  }
  if (seg.length === 5 && method === "DELETE") {
    guardedWatchers(ctx, () => removeRepoWatcher(repoId, wid!));
    audit(`watcher ${wid}: removed`);
    ctx.watchers.sync();
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

/** The repositories whose connection test is running now. A second test of the same one answers 409. */
const testing = new Set<string>();

/** `POST /api/repos/<id>/test`: runs the checks, saves the result as the connection status and answers with it. */
async function testRepo(ctx: ApiContext, user: User, id: string): Promise<{ at: string; ok: boolean; checks: unknown[] }> {
  const rec = guardedRepos(ctx, () => getRepo(id));
  if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
  if (testing.has(rec.id)) throw new HttpError(409, "a test of this repository is running already; wait for it to finish");
  testing.add(rec.id);
  try {
    if (rec.method === "none" && user.role !== "admin") {
      throw new HttpError(409, "this repository has no sign-in yet; choose one with Change authentication");
    }
    const started = Date.now();
    const isApp = rec.method === "github-app";
    let secret: string | undefined;
    let installationId: string | undefined;
    let blocked: ReturnType<typeof blockedResult> | undefined;
    if (isApp) {
      // a short-lived token limited to this repository; it goes to git and gh through the environment only
      const app = repoApp(ctx.config());
      const github = tryParseRepoUrl(rec.url)?.github;
      if (!app || !github) blocked = blockedResult("app-not-set-up", rec.method);
      else {
        const found = await repoInstallation(app, github, { token: true, timeoutMs: Math.min(10_000, TEST_TIMEOUT_MS) });
        if (!found.ok) blocked = blockedResult(BLOCKED[found.problem], rec.method);
        else ({ installationId, token: secret } = found);
      }
    } else if (rec.method !== "none") {
      secret = guardedRepos(ctx, () => readRepoSecret(rec));
    }
    let result;
    try {
      // one limit for the whole test: what the lookup used is not given to the checks again
      result = blocked ?? (await testConnection({ url: rec.url, method: rec.method, username: rec.username, secret }, { timeoutMs: Math.max(1, started + TEST_TIMEOUT_MS - Date.now()) }));
    } catch (e) {
      if (!(e instanceof ConnectError)) throw e;
      ctx.diagLog?.(`repos: test ${e.code}`);
      throw new HttpError(500, "the connection test could not run; see the server log");
    }
    const saved = guardedRepos(ctx, () => setRepoConnection(rec, result, installationId));
    if (saved === "gone") throw new HttpError(404, "no such repository");
    if (saved === "changed") throw new HttpError(409, "the repository was changed while the test ran; test again");
    for (const c of result.checks) if (!c.ok) ctx.diagLog?.(`repos: test ${c.check} ${c.code}`);
    return result;
  } finally {
    testing.delete(rec.id);
  }
}

/** The caller's own repositories: list, add, change how to reach one, remove. A token is only ever accepted, a private key never leaves the server. */
export const repoRoutes: Route = async (ctx, req, res, seg, method, caller) => {
  if (seg[0] === "admin") return adminRepos(ctx, req, res, seg, method, caller.id);
  if (seg[0] !== "repos") return false;
  const user = caller;
  const noServerAccess = (m: unknown) => {
    if (m === "none" && user.role !== "admin") throw new HttpError(403, 'only an admin may choose "none" (the server\'s own access)');
  };
  if (seg.length === 1 && method === "GET") {
    const repos = guardedRepos(ctx, () => listRepos(user.id)).map(shown);
    return send(res, 200, repos, publicKeys(repos)), true;
  }
  if (seg.length === 2 && seg[1] === "methods" && method === "GET") {
    const app = repoApp(ctx.config());
    const methods = REPO_METHODS.filter((m) => (m !== "none" || user.role === "admin") && (m !== "github-app" || app));
    return send(res, 200, { methods, githubApp: app ? { available: true, installUrl: installUrl(app.slug) } : { available: false } }), true;
  }
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    noServerAccess(body.method);
    const input = { url: given(body, "url") ?? given(body, "name"), method: given(body, "method"), username: given(body, "username"), token: given(body, "token") };
    let installationId: string | undefined;
    if (input.method === "github-app") {
      const app = needApp(ctx);
      // every error of the request itself is answered before GitHub is asked
      guardedRepos(ctx, () => checkNewRepo(user.id, input));
      installationId = await lookupInstallation(ctx, app, tryParseRepoUrl(String(input.url))?.github);
    }
    const repo = guardedRepos(ctx, () => addRepo(user.id, input, { installationId }));
    auditAction(ctx.diagLog, user.id, "repo-add", repo.id, repo.url);
    const out = shown(repo);
    return send(res, 201, out, publicKeys([out])), true;
  }
  if (seg.length === 3 && seg[2] === "auth" && method === "PUT") {
    const body = await readJson(req);
    noServerAccess(body.method);
    const change = { method: given(body, "method"), username: given(body, "username"), token: given(body, "token"), url: given(body, "url"), newKey: given(body, "newKey") };
    let installationId: string | undefined;
    if (change.method === "github-app") {
      const app = needApp(ctx);
      guardedRepos(ctx, () => checkRepoAuth(user.id, seg[1]!, change));
      const rec = guardedRepos(ctx, () => getRepo(seg[1]!));
      installationId = await lookupInstallation(ctx, app, rec ? tryParseRepoUrl(rec.url)?.github : undefined);
    }
    const r = guardedRepos(ctx, () => setRepoAuth(user.id, seg[1]!, change, { installationId }));
    if (r.changed) {
      auditAction(ctx.diagLog, user.id, "repo-change", r.repo.id, r.repo.url);
      ctx.watchers.sync(); // the method decides whether a watcher of this repository may run
    }
    oldKeys(ctx, r.oldKeysLeft, "the repository was changed");
    const out = shown(r.repo);
    return send(res, 200, out, publicKeys([out])), true;
  }
  if (seg.length === 3 && seg[2] === "test" && method === "POST") {
    return send(res, 200, await testRepo(ctx, user, seg[1]!)), true;
  }
  if (seg.length === 3 && seg[2] === "ready" && method === "GET") {
    const rec = guardedRepos(ctx, () => getRepo(seg[1]!));
    if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
    return send(res, 200, readyView(rec.definitionOfReady)), true;
  }
  if (seg.length === 2 && method === "DELETE") {
    removeAndTell(ctx, user.id, () => removeRepo(user.id, seg[1]!));
    return send(res, 200, { ok: true }), true;
  }
  if (seg.length === 3 && method === "DELETE") {
    removeAndTell(ctx, user.id, () => removeGithubRepo(user.id, `${seg[1]}/${seg[2]}`));
    return send(res, 200, { ok: true }), true;
  }
  return false;
};
