import type { IncomingMessage, ServerResponse } from "node:http";
import { StoreError } from "../auth/store.js";
import { cleanClient } from "../auth/audit-client.js";
import { actsForProblem, lookupServiceToken, recordServiceUse, writeServiceLine, type FoundToken, type ServiceAccount, type ServiceUse } from "../auth/service-accounts.js";
import { getUser } from "../auth/users.js";
import { basename } from "node:path";
import { HttpError } from "./http.js";
import { requestAccess } from "./net.js";
import { findLocalRepo, listAllRepos, repoIdsOf, type RepoRecord } from "../auth/repos.js";
import { isLocalRepoName } from "../auth/local-name.js";
import { githubNameOf } from "../auth/repo-url.js";
import { closedToServices } from "../auth/repo-settings.js";
import type { User } from "../auth/users.js";
import { getSession, listSessions } from "../refinement/store.js";
import { REPO_FREE } from "./data-classes.js";
import { findRule, ruleKey, serviceAllows, type Rule } from "./permissions.js";
import type { ApiContext } from "./server.js";

/**
 * The request path of a service token (#866). A request with `Authorization: Bearer scf_svc_…` is a service request: only the
 * bearer counts (a cookie is ignored), it works only on this computer, it needs no CSRF token (nothing in a browser sends it
 * by itself), and every such request writes one `service-request` audit line, also a refused one. A read gets its `ok` line
 * before the handler runs. A change (POST, PUT, PATCH, DELETE) passes the same check before the handler, and its one line is
 * written with the status when the response is done (#877). The optional `X-SCF-Client` header adds `client <label>` to the line.
 */

/** The routes that need no session. A service token is refused there: it never gets the answer of a cookie account. */
const PUBLIC_AUTH = new Set(["session", "setup", "set-password"]);

const BEARER_RE = /^Bearer (scf_svc_\S*)$/i;

/** The token of a service bearer header (even a malformed one: it is refused, never read as a cookie request), or undefined for any other header. */
export function serviceBearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return typeof h === "string" ? BEARER_RE.exec(h.trim())?.[1] : undefined;
}

/** One request made with a service token. */
export interface ServiceCall {
  token: string;
  method: string;
  /** The rule of the call, when there is one. */
  rule?: Rule;
  /** The account the token names (in any state), when there is one. */
  found?: FoundToken;
  /** Set once the token is live and the account active. */
  account?: ServiceAccount;
  /** Why the token was refused, for the audit line only. */
  why?: string;
  /** The id the request acts as (the person of `actsFor`, else the account's own id), once the account is known. A stream ends when it changes. */
  actingId?: string;
  /** True once this request has its audit line (or, for a change, once that line is sure to be written). */
  written: boolean;
  seg: string[];
  /** The cleaned `X-SCF-Client` label, when one was sent. */
  client?: string;
}

export const newServiceCall = (token: string, method: string, seg: string[], client?: string): ServiceCall => ({
  token,
  method,
  seg,
  rule: findRule(method, seg),
  written: false,
  ...(client !== undefined ? { client } : {}),
});

/** The client label of a request (`X-SCF-Client`), cleaned; undefined when none is sent or nothing printable is left. Never refused. */
export function clientLabel(req: IncomingMessage): string | undefined {
  const v = req.headers["x-scf-client"];
  return typeof v === "string" ? cleanClient(v) : undefined;
}

/** The methods that change something: their line is written when the response is done, with the status. */
const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const INTERNAL = "service accounts are not working; see the server log";
const REFUSED_TOKEN = "this service token is not valid";

const targetOf = (call: ServiceCall) => `${call.method.slice(0, 16)} ${call.rule?.path ?? "unknown route"}`;
const detailOf = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 200);

const lost = (ctx: ApiContext, e: unknown) =>
  ctx.diagLog?.(e instanceof StoreError ? `auth: ${basename(e.file)} ${e.kind} (service-request)` : "auth: audit.jsonl not-valid (service-request)");

/**
 * The detail of a line: the given text, then the person the account acts for (by id), then the client label, joined by "; ".
 * The label is always last, so `clientOf` reads it back. Undefined when there is nothing.
 */
const detailWith = (base: string | undefined, found: FoundToken | undefined, client: string | undefined): string | undefined => {
  const parts = [base, found?.account.actsFor ? `acts for ${found.account.actsFor}` : undefined, client !== undefined ? `client ${client}` : undefined];
  const d = parts.filter((p): p is string => !!p).join("; ");
  return d || undefined;
};
const withDetail = (base: string | undefined, found: FoundToken | undefined, client: string | undefined) => {
  const detail = detailWith(base, found, client);
  return detail !== undefined ? { detail } : {};
};

/**
 * The user a service request counts as (#876). Without `actsFor` it is the account itself. With it, it is the account with the
 * person's id: every owner and workspace check then decides for the person, while `kind`, `role` (user) and `scope` stay, so the
 * account is never an admin and its scope still limits it. A person who is gone or cannot sign in throws 403 with the reason.
 */
export function resolveActing(account: ServiceAccount): ServiceAccount {
  if (account.actsFor === undefined) return account;
  const problem = actsForProblem(getUser(account.actsFor));
  if (problem !== undefined) throw new HttpError(403, problem);
  return { ...account, id: account.actsFor };
}

/**
 * Writes the `failed` line of a refused request, once. Best effort: it does not wait for a held lock and never throws. A token
 * that names no account is audited with `anonymous` as the actor.
 */
export function auditRefused(ctx: ApiContext, call: ServiceCall, e: unknown): void {
  if (call.written) return;
  call.written = true;
  const status = e instanceof HttpError ? e.status : 500;
  const text = call.why ?? (e instanceof HttpError ? e.message : "error");
  try {
    recordServiceUse(call.found?.account.id, { result: "failed", target: targetOf(call), ...withDetail(detailOf(`${status} ${text}`), call.found, call.client) }, { touch: call.account !== undefined });
  } catch (err) {
    lost(ctx, err);
  }
}

/** A refusal of a service bearer on a path that serves no service call (the files of plugins): audited, then 401. */
export function refuseBearer(ctx: ApiContext, token: string, method: string, target: string, client?: string): never {
  const call: ServiceCall = { token, method, seg: [], written: false };
  try {
    call.found = lookupServiceToken(token);
  } catch (e) {
    lost(ctx, e);
  }
  try {
    recordServiceUse(call.found?.account.id, { result: "failed", target: `${method.slice(0, 16)} ${target}`, ...withDetail("401 a service token does not work here", call.found, client) });
  } catch (e) {
    lost(ctx, e);
  }
  throw new HttpError(401, REFUSED_TOKEN);
}

/**
 * Finds the account of a service request. Order: the public sign-in routes refuse it (403), then only a connection from this
 * computer passes (403, before anything is said about the token), then the token must be live and the account active (401).
 * A refusal throws; the caller audits it with `auditRefused`.
 */
export function serviceCaller(ctx: ApiContext, req: IncomingMessage, call: ServiceCall, as: string | undefined): ServiceAccount {
  try {
    call.found = lookupServiceToken(call.token);
  } catch (e) {
    ctx.diagLog?.(e instanceof StoreError ? `auth: ${basename(e.file)} ${e.kind}` : "auth: unexpected error");
    throw new HttpError(500, INTERNAL);
  }
  if (call.seg.length === 1 && PUBLIC_AUTH.has(call.seg[0]!)) throw new HttpError(403, "a service token cannot be used here");
  if (!requestAccess(req, ctx.config().server, ctx.opts.port).local) throw new HttpError(403, "a service token works only on this computer");
  if (as !== undefined) throw new HttpError(403, "a service account has no display to view");
  const f = call.found;
  if (!f) call.why = "unknown token";
  else if (f.state !== "live") call.why = f.state === "expired" ? "the token expired" : "the token was revoked";
  else if (f.account.status !== "active") call.why = "the account is blocked";
  if (call.why !== undefined || !f) throw new HttpError(401, REFUSED_TOKEN);
  call.account = f.account;
  let acting: ServiceAccount;
  try {
    acting = resolveActing(f.account);
  } catch (e) {
    if (e instanceof HttpError) {
      call.why = e.message;
      throw e;
    }
    ctx.diagLog?.(e instanceof StoreError ? `auth: ${basename(e.file)} ${e.kind}` : "auth: unexpected error");
    throw new HttpError(500, INTERNAL);
  }
  call.actingId = acting.id;
  return acting;
}

/**
 * An open response (an event stream) of a service request keeps going only while the token is still live, the account active,
 * the connection still on this computer and the route still in the scope. Checked again on every recheck, so a removed
 * route or a revoke ends the stream at once. With `actsFor` the person must still be able to sign in, and the stream also ends
 * when the account now acts for someone else or for nobody (#876). Any failure to read the account counts as gone.
 */
export function serviceStillAllowed(ctx: ApiContext, req: IncomingMessage, call: ServiceCall): boolean {
  try {
    const found = lookupServiceToken(call.token);
    if (!found || found.state !== "live" || found.account.status !== "active") return false;
    if (!requestAccess(req, ctx.config().server, ctx.opts.port).local) return false;
    if (call.rule === undefined || !serviceAllows(found.account, call.rule)) return false;
    const acting = resolveActing(found.account);
    if (call.actingId !== undefined && acting.id !== call.actingId) return false;
    // a repository closed since the stream began ends it
    checkServiceRepos(ctx, acting, call.rule, call.seg, new URL(req.url ?? "/", "http://x").searchParams);
    return true;
  } catch {
    return false;
  }
}

const CLOSED_REPO = "this repository is closed to service accounts";
const CLOSED_SOME = "a repository is closed to service accounts";

/** The records closed to service accounts (`services: none`). A read error answers 500 (fail closed). */
function closedRecords(ctx: ApiContext): RepoRecord[] {
  try {
    return listAllRepos().filter((r) => closedToServices(r.settings));
  } catch {
    ctx.diagLog?.("service-request: repos.json cannot-read");
    throw new HttpError(500, INTERNAL);
  }
}

/** True when a repository name (`owner/name` or `local:…`) has a closed record. If several records hold it, any closed one counts. */
function nameClosed(name: string, closed: ReadonlySet<string>): boolean {
  if (isLocalRepoName(name)) {
    const rec = findLocalRepo(name);
    return rec !== undefined && closed.has(rec.id);
  }
  // an address (https or ssh, with or without ".git") or a bare "owner/name": both name the same GitHub repository
  const gh = githubNameOf(name) ?? githubNameOf(`https://github.com/${name}`);
  return gh !== undefined && repoIdsOf(gh).some((id) => closed.has(id));
}

/** The repositories an account has runs, queued jobs or refinement sessions on. */
function ownedRepoNames(ctx: ApiContext, user: User): string[] {
  const names = new Set<string>();
  for (const b of ctx.scheduler.briefs()) if (b.owner === user.id && b.githubRepo) names.add(b.githubRepo);
  for (const n of ctx.scheduler.queuedRepos(user.id)) names.add(n);
  for (const s of listSessions(user.id)) names.add(s.repo);
  return [...names];
}

/** The path names a run or a repository by its id or name (so the named-object check decides it). */
const namesObject = (path: string): boolean => path.startsWith("runs/:id") || path.startsWith("repos/") || path.startsWith("admin/repos/:id");

/**
 * `services: none` (#869): a service account may not read or change anything about a repository closed to service accounts.
 * Called after `authorize()` on every service request and on each recheck of an open stream. No-op for any other caller, and
 * when no repository is closed. Order: (1) objects named by the request, (2) Ask Foundry, (3) admin-only routes that name no
 * run or repository, (4) lists of the account's own work. Refuses with 403; a read error is 500 (fail closed).
 */
export function checkServiceRepos(ctx: ApiContext, user: User, rule: Rule, seg: string[], query: URLSearchParams): void {
  if (user.kind !== "service") return;
  try {
    const records = closedRecords(ctx);
    if (records.length === 0) return;
    const closed = new Set(records.map((r) => r.id));
    const refuse = (): never => {
      throw new HttpError(403, CLOSED_REPO);
    };
    // 1. objects the request names
    const q = query.get("repo");
    if (q && nameClosed(q, closed)) refuse();
    const p = rule.path;
    if (p.startsWith("runs/:id")) {
      const name = ctx.scheduler.repoOf(seg[1] ?? "");
      if (name && nameClosed(name, closed)) refuse();
    } else if (p === "repos/:owner/:name") {
      if (nameClosed(`${seg[1]}/${seg[2]}`, closed)) refuse();
    } else if (p.startsWith("repos/:id")) {
      if (closed.has(seg[1] ?? "")) refuse();
    } else if (p.startsWith("admin/repos/:id")) {
      if (closed.has(seg[2] ?? "")) refuse();
    } else if (p.startsWith("refinement/:id") || p.startsWith("changes/:id")) {
      const s = getSession(seg[1] ?? "");
      if (s && nameClosed(s.repo, closed)) refuse();
    }
    // 2. Ask Foundry stores and fetches repository text
    if (p.startsWith("help/") && ruleKey(rule) !== "GET help/usage") throw new HttpError(403, CLOSED_SOME);
    // 3. an admin-only rule about no named object may span every repository
    if (rule.user === "no" && !namesObject(p) && !REPO_FREE.has(ruleKey(rule))) throw new HttpError(403, CLOSED_SOME);
    // 4. a list of the account's own work
    if (rule.user !== "no" && rule.scope === "list") {
      if (records.some((r) => r.owner === user.id)) throw new HttpError(403, CLOSED_SOME);
      if (ownedRepoNames(ctx, user).some((n) => nameClosed(n, closed))) throw new HttpError(403, CLOSED_SOME);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    ctx.diagLog?.("service-request: closed repositories cannot-check");
    throw new HttpError(500, INTERNAL);
  }
}

/**
 * A service request refused by the network guard (not on this computer, a forbidden host or origin, insecure http): it is
 * audited as the other refusals, and the caller still answers with the guard's own 403 text.
 */
export function auditNetworkRefusal(ctx: ApiContext, req: IncomingMessage, refusal: string): void {
  const token = serviceBearer(req);
  if (token === undefined) return;
  const method = req.method ?? "GET";
  let seg: string[] = [];
  try {
    seg = new URL(req.url ?? "/", "http://x").pathname.split("/").filter(Boolean).slice(1);
  } catch {
    seg = [];
  }
  const call = newServiceCall(token, method, seg, clientLabel(req));
  try {
    call.found = lookupServiceToken(token);
  } catch (e) {
    lost(ctx, e);
  }
  auditRefused(ctx, call, new HttpError(403, refusal));
}

/** The response a change waits for: its status once it is done. */
export type ServiceResponse = Pick<ServerResponse, "once" | "statusCode" | "writableFinished">;

/**
 * The request passed the access checks. Under one lock the token must still be live and the audit log must open, and the
 * time of use is written; else the request answers 503 (or 401) and the handler does nothing (the log is the record of what a
 * service did). A read writes its `ok` line now. A change, given its `res`, writes its one line when the response is done, with
 * the status: `ok` below 400, else `failed` (#877).
 */
export function serviceOk(ctx: ApiContext, call: ServiceCall, res?: ServiceResponse): void {
  const late = res !== undefined && CHANGE_METHODS.has(call.method.toUpperCase());
  const id = call.account!.id;
  const target = targetOf(call);
  let live: boolean;
  try {
    live = recordServiceUse(id, { result: "ok", target, ...withDetail(undefined, call.found, call.client) }, { touch: true, defer: late });
  } catch (e) {
    lost(ctx, e);
    throw new HttpError(503, "the audit log is busy; try again in a moment", { "retry-after": "1" });
  }
  call.written = true;
  if (!live) throw new HttpError(401, REFUSED_TOKEN);
  if (!late) return;
  res.once("close", () => {
    const status = res.statusCode;
    const done = res.writableFinished;
    const base = done ? String(status) : `${status} the connection closed early`;
    writeLate({ id, use: { result: done && status < 400 ? "ok" : "failed", target, ...withDetail(base, call.found, call.client) }, log: ctx.diagLog });
  });
}

// ---- the late line of a change ----------------------------------------------------------------------------------

interface LateLine {
  id: string;
  use: ServiceUse;
  log: ((msg: string) => void) | undefined;
}

/** How often, and how far apart, a late line is tried again while another process holds the lock (about half a second). */
const LATE_TRIES = 20;
const LATE_RETRY_MS = 25;

const pending = new Set<LateLine>();
let exitHooked = false;

const lostLate = (l: LateLine, e: unknown) =>
  l.log?.(e instanceof StoreError ? `auth: ${basename(e.file)} ${e.kind} (service-request late)` : "auth: audit.jsonl not-valid (service-request late)");

function writeLate(l: LateLine): void {
  pending.add(l);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", flushServiceLines);
  }
  attemptLate(l, 0);
}

function attemptLate(l: LateLine, tries: number): void {
  try {
    writeServiceLine(l.id, l.use);
    pending.delete(l);
  } catch (e) {
    if (e instanceof StoreError && e.kind === "locked" && tries < LATE_TRIES) {
      setTimeout(() => {
        if (pending.has(l)) attemptLate(l, tries + 1);
      }, LATE_RETRY_MS).unref();
      return;
    }
    pending.delete(l);
    lostLate(l, e);
  }
}

/**
 * Tries each late line still waiting once more, now (synchronous: it also runs on process exit). A line that still cannot be
 * written goes to the server log. Never throws.
 */
export function flushServiceLines(): void {
  for (const l of [...pending]) {
    pending.delete(l);
    try {
      writeServiceLine(l.id, l.use);
    } catch (e) {
      lostLate(l, e);
    }
  }
}

/** The number of late lines still waiting (for tests). */
export const pendingServiceLines = (): number => pending.size;
