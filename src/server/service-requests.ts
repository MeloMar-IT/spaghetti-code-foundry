import type { IncomingMessage } from "node:http";
import { StoreError } from "../auth/store.js";
import { lookupServiceToken, recordServiceUse, type FoundToken, type ServiceAccount } from "../auth/service-accounts.js";
import { basename } from "node:path";
import { HttpError } from "./http.js";
import { requestAccess } from "./net.js";
import { findRule, serviceAllows, type Rule } from "./permissions.js";
import type { ApiContext } from "./server.js";

/**
 * The request path of a service token (#866). A request with `Authorization: Bearer scf_svc_…` is a service request: only the
 * bearer counts (a cookie is ignored), it works only on this computer, it needs no CSRF token (nothing in a browser sends it
 * by itself), and every such request writes one `service-request` audit line, also a refused one.
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
  /** True once this request has its audit line. */
  written: boolean;
  seg: string[];
}

export const newServiceCall = (token: string, method: string, seg: string[]): ServiceCall => ({ token, method, seg, rule: findRule(method, seg), written: false });

const INTERNAL = "service accounts are not working; see the server log";
const REFUSED_TOKEN = "this service token is not valid";

const targetOf = (call: ServiceCall) => `${call.method.slice(0, 16)} ${call.rule?.path ?? "unknown route"}`;
const detailOf = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 200);

const lost = (ctx: ApiContext, e: unknown) =>
  ctx.diagLog?.(e instanceof StoreError ? `auth: ${basename(e.file)} ${e.kind} (service-request)` : "auth: audit.jsonl not-valid (service-request)");

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
    recordServiceUse(call.found?.account.id, { result: "failed", target: targetOf(call), detail: detailOf(`${status} ${text}`) }, { touch: call.account !== undefined });
  } catch (err) {
    lost(ctx, err);
  }
}

/** A refusal of a service bearer on a path that serves no service call (the files of plugins): audited, then 401. */
export function refuseBearer(ctx: ApiContext, token: string, method: string, target: string): never {
  const call: ServiceCall = { token, method, seg: [], written: false };
  try {
    call.found = lookupServiceToken(token);
  } catch (e) {
    lost(ctx, e);
  }
  try {
    recordServiceUse(call.found?.account.id, { result: "failed", target: `${method.slice(0, 16)} ${target}`, detail: "401 a service token does not work here" });
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
  return f.account;
}

/**
 * An open response (an event stream) of a service request keeps going only while the token is still live, the account active,
 * the connection still on this computer and the route still in the scope. Checked again on every recheck, so a removed
 * route or a revoke ends the stream at once. Any failure to read the account counts as gone.
 */
export function serviceStillAllowed(ctx: ApiContext, req: IncomingMessage, call: ServiceCall): boolean {
  try {
    const found = lookupServiceToken(call.token);
    if (!found || found.state !== "live" || found.account.status !== "active") return false;
    if (!requestAccess(req, ctx.config().server, ctx.opts.port).local) return false;
    return call.rule !== undefined && serviceAllows(found.account, call.rule);
  } catch {
    return false;
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
  const call = newServiceCall(token, method, seg);
  try {
    call.found = lookupServiceToken(token);
  } catch (e) {
    lost(ctx, e);
  }
  auditRefused(ctx, call, new HttpError(403, refusal));
}

/**
 * The request passed the access checks: writes its `ok` line and the time of use before the handler runs. If the line cannot
 * be written the request answers 503 and the handler does nothing (the log is the record of what a service did).
 */
export function serviceOk(ctx: ApiContext, call: ServiceCall): void {
  let live: boolean;
  try {
    live = recordServiceUse(call.account!.id, { result: "ok", target: targetOf(call) }, { touch: true });
  } catch (e) {
    lost(ctx, e);
    throw new HttpError(503, "the audit log is busy; try again in a moment", { "retry-after": "1" });
  }
  call.written = true;
  if (!live) throw new HttpError(401, REFUSED_TOKEN);
}
