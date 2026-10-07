import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { hideKeyVars, redactText } from "../credentials/redact.js";
import { providerKeyVars } from "../agents/targets.js";
import { TOKEN_MIN } from "../credentials/store.js";
import { FACTORY_HOME } from "../flow/load.js";
import { homeMoved } from "../home.js";
import { sweepSignInDirs } from "../engine/repo-access.js";
import { Scheduler } from "../queue/scheduler.js";
import { steppedAsideFor } from "../queue/watcher.js";
import { WatcherManager } from "../queue/watchers.js";
import { SESSION_RECHECK_MS, authRoutes, passwordRoutes, requireSession, sessionAlive } from "./api-auth.js";
import { adminRoutes } from "./api-admin.js";
import { credentialRoutes } from "./api-credentials.js";
import { monitorRoutes } from "./api-monitor.js";
import { flowRoutes } from "./api-flows.js";
import { runRoutes } from "./api-runs.js";
import { HttpError, send, serveStatic } from "./http.js";
import { areaWait, forgetHistory, nextRoutes, type RestartState } from "./next.js";
import { healthRoutes } from "./health.js";
import type { UpdateView } from "../self-update.js";
import { boardRoutes } from "./board.js";
import { TurnNotifier } from "./notifier.js";
import { ClarityRecorder, clarityRoutes } from "./clarity.js";
import { CSP, HSTS, listenProblem, localUrl, requestAccess } from "./net.js";
import { ACCOUNT_SWEEP_MS, accountActive, accountSweeper } from "./account-work.js";
import { adoptRuns } from "../auth/run-owner.js";
import { hasAdmin, type User } from "../auth/users.js";
import { repoRoutes } from "./api-repos.js";
import { getRepo, listAllRepos } from "../auth/repos.js";
import { StoreError } from "../auth/store.js";
import { effectiveLimits } from "../auth/limits.js";
import { type BlockedWatcher, effectiveRepoWatchers, listRepoWatchers, removeOrphanWatchers, repoWatchersMtime } from "../repos/watchers.js";
import { getUser } from "../auth/users.js";
import { moveConfigWatchers } from "../repos/migrate-watchers.js";
import { isRefinementRun } from "../auth/run-owner.js";
import { settleFinished } from "../refinement/architect.js";
import { REFINEMENT_SWEEP_MS, refinementRoutes, refinementSweeper } from "./api-refinement.js";
import { auditRoutes } from "./api-audit.js";
import { AUDIT_SWEEP_MS, auditSweeper } from "../auth/audit.js";
import { userRoutes } from "./api-users.js";
import { logRing } from "../monitor/monitor.js";
import { authorize, findRule } from "./permissions.js";
import { sinceRoutes } from "./since.js";
import { yourTurnRoutes } from "./your-turn.js";
import { USER_ERROR, movedText } from "./user-view.js";
import { turnActionRoutes } from "./turn-actions.js";
import { READ_ONLY, asParam, viewAsRoutes, viewRunning, viewedUser } from "./view-as.js";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui");
const YAML_BROWSER_DIR = join(dirname(createRequire(import.meta.url).resolve("yaml/package.json")), "browser");

export interface ServerOptions {
  repo: string;
  runsDir: string;
  port: number;
  claudeBin?: string;
  /** Run the watchers (default true). */
  watchers?: boolean;
  log?: (msg: string) => void;
  /** How often an open response re-checks its session, in ms (default 4000). */
  sessionRecheckMs?: number;
  /** How often runs without an owner are given to the first admin, in ms (default 60000). */
  adoptEveryMs?: number;
  /** How often blocked and deleted accounts are checked, in ms (default 2000). */
  accountSweepMs?: number;
  /** How often dropped refinement sessions past their 30 days are removed, in ms (default 600000). */
  refinementSweepMs?: number;
  /** The clock of the sign-in waits and locks, in ms (default Date.now). A test moves it. */
  signInClock?: () => number;
  /** The clock of the "view as user" previews, in ms (default Date.now). A test moves it. */
  viewAsClock?: () => number;
  /** How often old audit lines are removed, in ms (default one day). */
  auditSweepMs?: number;
  /** How often the stored watchers are read again after the file could not be read, in ms (default 30000). */
  watcherRetryMs?: number;
}

export interface ApiContext {
  opts: ServerOptions;
  scheduler: Scheduler;
  watchers: WatcherManager;
  /** The config with the effective watcher list: the ones in config.yaml and the runnable ones of the repository store. */
  config: () => Config;
  /** Only what is in config.yaml (what GET and PUT /api/config show and write). */
  fileConfig: () => Config;
  /** Stored watchers that cannot run now, each with its `problem`. */
  blockedWatchers: () => BlockedWatcher[];
  reloadConfig: () => void;
  /** Set while the server waits to restart (new version, moved data folder). */
  restart?: RestartState;
  /** The self-updater of the running server: which version runs and whether an update waits. */
  selfUpdate?: { view(): UpdateView };
  /** The address the server is bound to (a changed setting applies after a restart). */
  listen: string;
  /**
   * The log without redaction, only for diagnostics the code built itself from fixed words (a file name and a kind),
   * never for exception text. They must stay readable when the credential store is the thing that is broken.
   */
  diagLog?: (msg: string) => void;
}

/** A route handler: returns true when it handled the request. */
export type Route = (ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string, user: User) => Promise<boolean>;

const ROUTES: Route[] = [passwordRoutes, monitorRoutes, credentialRoutes, repoRoutes, refinementRoutes, userRoutes, auditRoutes, adminRoutes, flowRoutes, runRoutes, nextRoutes, yourTurnRoutes, turnActionRoutes, sinceRoutes, boardRoutes, healthRoutes, clarityRoutes, viewAsRoutes];

export async function startServer(given: ServerOptions): Promise<{ url: string; close: () => void; ctx: ApiContext; notifier?: TurnNotifier }> {
  // every free-form server, watcher and notifier log line passes the redaction (fail closed)
  const sink = given.log ?? (() => {});
  const ring = logRing(); // the newest redacted lines, for the monitor
  const log = (msg: string) => {
    const text = redactText(msg);
    ring.push(text);
    sink(text);
  };
  const opts: ServerOptions = { ...given, log };
  // loadConfig(), then the values of the provider key variables are hidden; a key too short to hide is named once
  const shortKeys = new Set<string>();
  const readConfig = (): Config => {
    const c = loadConfig();
    for (const name of hideKeyVars(providerKeyVars(c))) {
      if (shortKeys.has(name)) continue;
      shortKeys.add(name);
      log(`! the key in ${name} is shorter than ${TOKEN_MIN} characters, so it is not hidden in output`);
    }
    return c;
  };
  let config = readConfig();
  // The effective config: config.yaml plus the runnable stored watchers (refreshed in every sync()).
  let effective: Config = config;
  let blocked: BlockedWatcher[] = [];
  let stored: Config["watchers"] = [];
  let failure: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  const rebuild = () => {
    effective = stored.length ? { ...config, watchers: [...config.watchers, ...stored] } : config;
  };
  const listen = config.server.listen;
  // Before anything starts (queue, watchers): a non-local address needs accounts.
  const problem = listenProblem(listen, hasAdmin);
  if (problem) {
    log(problem);
    throw new Error(problem);
  }
  // a deploy key that a crash left in a run folder is removed now, not only when the run is resumed
  const swept = sweepSignInDirs(opts.runsDir);
  if (swept.removed > 0) log(`${swept.removed} leftover sign-in folder(s) of interrupted runs removed`);
  if (swept.failed > 0) log(`! ${swept.failed} leftover sign-in folder(s) could not be removed; delete the folder "sign-in" in those run folders`);
  const scheduler = new Scheduler({
    runsDir: opts.runsDir,
    claudeBin: opts.claudeBin,
    config: () => effective,
    queueFile: join(process.env.FACTORY_HOME ?? FACTORY_HOME, "queue.json"),
    accountActive,
    userLimits: (id) => effectiveLimits(id, log),
    onFinished: (s) => {
      // A new succeeded run is a new sample: the next estimate must see it.
      if (s.status === "succeeded") forgetHistory(ctx);
      // The architect's read for a refinement session: the session takes in the end; no watcher has anything to do with it.
      if (isRefinementRun(s.source)) return void settleFinished({ scheduler, repo: opts.repo, log: sink }, s);
      // When a run ends, the watchers of its repository check at once instead of at the next interval.
      // (A run that only stepped aside for a busy code area freed nothing: no check for that.)
      if (s.vars?.github_repo && !steppedAsideFor(s)) watchers.kickRepo(s.vars.github_repo);
    },
  });
  /**
   * Reads the stored watchers again. Fails closed: when the file cannot be read, no stored watcher runs (a run for an
   * owner that cannot be checked must not start); the log names the file and the kind once, and a timer tries again.
   */
  const refreshStored = () => {
    try {
      const r = effectiveRepoWatchers(listRepoWatchers(), getRepo, getUser, config.watchers.map((w) => w.id));
      stored = r.runnable;
      blocked = r.blocked;
      failure = undefined;
      clearTimeout(retryTimer);
      retryTimer = undefined;
    } catch (e) {
      stored = [];
      blocked = [];
      const what = e instanceof StoreError ? `${basename(e.file)} ${e.kind}` : "unexpected error";
      if (failure !== what) sink(`repo-watchers: ${what}`);
      failure = what;
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          syncStored();
        }, opts.watcherRetryMs ?? 30_000);
        retryTimer.unref();
      }
    }
    rebuild();
  };
  /** Brings the watchers in line with the stores; like the other timers: only the lists during a restart wait or on a server without watchers. */
  const syncStored = () => {
    if (opts.watchers === false || ctx.restart) return void refreshStored();
    watchers.sync();
  };
  const watchers = new WatcherManager({ scheduler, runsDir: opts.runsDir, repo: opts.repo, config: () => effective, areaWait, log, serverLog: ring.lines, restart: () => ctx.restart, startedAt: new Date(), beforeSync: refreshStored });
  const ctx: ApiContext = {
    opts,
    diagLog: sink,
    scheduler,
    watchers,
    config: () => effective,
    fileConfig: () => config,
    blockedWatchers: () => blocked,
    reloadConfig: () => {
      config = readConfig();
      rebuild();
    },
    listen,
  };
  // a stored watcher without a repository is removed before the lists are built
  try {
    for (const w of removeOrphanWatchers(() => listAllRepos().map((r) => r.id))) {
      log(`repo-watchers: removed leftover watcher "${w.id}" (its repository is gone)`);
    }
  } catch (e) {
    log(`! repo-watchers: leftover watchers could not be removed: ${e instanceof StoreError ? `${basename(e.file)} ${e.kind}` : "unexpected error"}`);
  }
  // Existing watchers of config.yaml move to their repositories (the store first, the file second) before they are read.
  if (moveConfigWatchers({ log }).changed) config = readConfig();
  refreshStored();

  // Before the first pump and before adopt(): jobs of blocked accounts never start, and a stop-work request made while
  // the server was down does not reach a run that is adopted later.
  const sweep = accountSweeper(scheduler, log, { changed: syncStored, stamp: repoWatchersMtime });
  sweep();
  const refinementSweep = refinementSweeper(log);
  refinementSweep();
  const auditSweep = auditSweeper(() => ctx.config().audit.retention_days, ctx.diagLog);
  auditSweep();

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    const seg = path.split("/").filter(Boolean).slice(1); // drop "api"
    // The guard comes first: without a session nothing is answered, not even the moved-folder message with its path.
    const as = asParam(req);
    if (as !== undefined && method !== "GET") throw new HttpError(403, READ_ONLY);
    // GET /api/session is the one call that ignores `as`; every other call with `as` passes the view checks below
    const plain = as === undefined || (seg.length === 1 && seg[0] === "session");
    if (plain && (await authRoutes(ctx, req, res, seg, method))) return;
    const caller = await requireSession(ctx, req, method);
    // in a view an unexpected error gets the fixed sentence of a user
    const admin = as === undefined && caller.role === "admin";
    let user = caller;
    let where = seg.join("/");
    try {
      if (as !== undefined) user = viewedUser(ctx, req, caller, as);
      // The table decides first: a call without a rule is 404, and a user only gets what the table gives.
      const rule = findRule(method, seg);
      if (!rule) throw new HttpError(404, "not found");
      where = rule.path;
      authorize(ctx, user, rule, seg);
      const moved = method === "GET" ? undefined : homeMoved();
      if (moved) throw new HttpError(503, movedText(moved, admin));
      for (const route of ROUTES) {
        if (await route(ctx, req, res, seg, method, user)) return watchSession(req, res, as);
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      // An unexpected error can hold a folder, a setting or a command: a user gets a fixed sentence, the log the message.
      if (admin || e instanceof HttpError) throw e;
      log(`api ${method} ${where}: ${(e as Error).message}`);
      throw new HttpError(500, USER_ERROR);
    }
  }

  /** A response that stays open (the run log stream) is closed when its session ends. */
  function watchSession(req: IncomingMessage, res: ServerResponse, as?: string) {
    if (res.writableEnded || res.destroyed) return;
    const timer = setInterval(() => {
      if (!sessionAlive(ctx, req) || (as !== undefined && !viewRunning(ctx, req, as))) res.destroy();
    }, opts.sessionRecheckMs ?? SESSION_RECHECK_MS);
    timer.unref();
    res.on("close", () => clearInterval(timer));
  }

  const server = createServer((req, res) => {
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    // Only answer to our own host and origin: blocks DNS rebinding and cross-site requests,
    // since this server can execute code on the machine.
    const acc = requestAccess(req, config.server, opts.port);
    if (acc.https) res.setHeader("strict-transport-security", HSTS);
    if (acc.refusal) return void res.writeHead(403).end(acc.refusal);
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return void res.writeHead(400).end("bad request");
    }
    if (path.startsWith("/api/")) {
      api(req, res, path).catch((e: Error) => {
        const status = e instanceof HttpError ? e.status : 400;
        if (!res.headersSent) {
          if (e instanceof HttpError) for (const [k, v] of Object.entries(e.headers ?? {})) res.setHeader(k, v);
          send(res, status, { error: e.message });
        }
        else res.end();
      });
      return;
    }
    if (path.startsWith("/vendor/yaml/")) return serveStatic(res, YAML_BROWSER_DIR, path.slice("/vendor/yaml/".length));
    serveStatic(res, UI_DIR, path === "/" ? "index.html" : path === "/user" || path === "/user/" ? "user/index.html" : path.slice(1));
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, listen, () => ok());
  });
  // Runs of older versions have no owner. The first admin takes them: now, and again later, since the admin may be
  // made with `scf user create --admin` while we run, and runs that were live are skipped until they end.
  const adopt = () => {
    try {
      adoptRuns(opts.runsDir, log);
    } catch (e) {
      log(`! could not give runs to the first admin: ${(e as Error).message}`);
    }
  };
  adopt();
  const adoptTimer = setInterval(adopt, opts.adoptEveryMs ?? 60_000);
  adoptTimer.unref();
  const sweepTimer = setInterval(sweep, opts.accountSweepMs ?? ACCOUNT_SWEEP_MS);
  sweepTimer.unref();
  const refinementTimer = setInterval(refinementSweep, opts.refinementSweepMs ?? REFINEMENT_SWEEP_MS);
  refinementTimer.unref();
  const auditTimer = setInterval(auditSweep, opts.auditSweepMs ?? AUDIT_SWEEP_MS);
  auditTimer.unref();
  if (opts.watchers !== false) watchers.sync();
  let notifier: TurnNotifier | undefined;
  if (process.env.FACTORY_NO_NOTIFY !== "1") {
    notifier = new TurnNotifier(ctx, { baseUrl: localUrl(listen, opts.port), log });
    notifier.start();
  }
  const clarity = new ClarityRecorder(ctx, { log });
  clarity.start();
  return {
    url: localUrl(listen, opts.port),
    ctx,
    notifier,
    close: () => {
      clarity.stop();
      clearInterval(adoptTimer);
      clearInterval(sweepTimer);
      clearInterval(refinementTimer);
      clearInterval(auditTimer);
      clearTimeout(retryTimer);
      notifier?.stop();
      watchers.stopAll();
      server.close();
    },
  };
}
