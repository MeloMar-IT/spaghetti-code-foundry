import {
  SCOPE_MAX, createServiceAccount, listServiceAccounts, revokeServiceToken, rotateServiceToken, tokenExpires, tokenState, updateServiceAccount, type ServiceAccount,
} from "../auth/service-accounts.js";
import { failUsers } from "./api-users.js";
import { HttpError, readJson, send } from "./http.js";
import { GRANTABLE_CLASSES } from "./data-classes.js";
import { RULES, grantableRules, neverGranted, ruleKey } from "./permissions.js";
import type { ApiContext, Route } from "./server.js";

const KEYS = new Set(RULES.map(ruleKey));
const shown = (k: string) => (k.length > 80 ? `${k.slice(0, 80)}…` : k);

/**
 * The scope of a service account as the API takes it: a list of at most 200 distinct entries, each a rule key (`GET runs`) in the table
 * and not one that can never be granted, or a data class (`class:summary`, #869; never `class:secret`). An admin-only rule is in the list by its own key too. Throws 400 that names the key.
 */
export function checkServiceScope(input: unknown): string[] {
  if (!Array.isArray(input)) throw new HttpError(400, '"scope" must be a list of rule keys such as "GET runs"');
  if (input.length > SCOPE_MAX) throw new HttpError(400, `"scope" can hold at most ${SCOPE_MAX} routes`);
  const seen = new Set<string>();
  for (const k of input) {
    if (typeof k !== "string") throw new HttpError(400, '"scope" must be a list of rule keys such as "GET runs"');
    if (seen.has(k)) throw new HttpError(400, `"${shown(k)}" is in the scope twice`);
    seen.add(k);
    if (k.startsWith("class:")) {
      const name = k.slice("class:".length);
      if (name === "secret") throw new HttpError(400, `"${k}" can never be granted to a service account`);
      if (!(GRANTABLE_CLASSES as readonly string[]).includes(name)) throw new HttpError(400, `"${shown(k)}" is not a data class; use one of ${GRANTABLE_CLASSES.join(", ")}`);
      continue;
    }
    if (!KEYS.has(k)) throw new HttpError(400, `"${shown(k)}" is not a route in the permission table`);
    const rule = RULES.find((r) => ruleKey(r) === k)!;
    if (neverGranted(rule.path)) throw new HttpError(400, `"${k}" can never be granted to a service account`);
  }
  return [...input];
}

/** The service account as the API shows it, never the token or its hash. */
function view(ctx: ApiContext, u: ServiceAccount, runs: Map<string, number>) {
  const state = tokenState(u);
  const expires = tokenExpires(u);
  return {
    id: u.id, name: u.name, status: u.status, scope: u.scope, created: u.created,
    lastUse: u.token?.used ?? null,
    token: state,
    expires: state === "revoked" || expires === undefined ? null : new Date(expires).toISOString(),
    runs: runs.get(u.id) ?? 0,
  };
}

function runCounts(ctx: ApiContext): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    for (const b of ctx.scheduler.briefs()) if (b.owner) counts.set(b.owner, (counts.get(b.owner) ?? 0) + 1);
  } catch {
    ctx.diagLog?.("users: runs cannot-read");
    throw new HttpError(500, "the account list is not working; see the server log");
  }
  return counts;
}

const guarded = <T,>(ctx: ApiContext, fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    return failUsers(ctx, e);
  }
};

/** /api/service-accounts: accounts for programs, for admins (the permission table decides who gets here). The token is in the answer of create and rotate only. */
export const serviceAccountRoutes: Route = async (ctx, req, res, seg, method, caller) => {
  if (seg[0] !== "service-accounts") return false;
  const by = caller.id;
  if (seg.length === 1 && method === "GET") {
    const runs = runCounts(ctx);
    return send(res, 200, { accounts: guarded(ctx, () => listServiceAccounts()).map((u) => view(ctx, u, runs)), grantable: grantableRules(), classes: GRANTABLE_CLASSES }), true;
  }
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    if (typeof body.name !== "string") throw new HttpError(400, '"name" must be a string');
    const scope = checkServiceScope(body.scope);
    const r = guarded(ctx, () => createServiceAccount({ name: body.name as string, scope }, { by }));
    return send(res, 201, { account: view(ctx, r.account, new Map()), token: r.token }), true;
  }
  const id = seg[1];
  if (id === undefined) return false;
  if (seg.length === 2 && method === "PUT") {
    const body = await readJson(req);
    if (body.name !== undefined && typeof body.name !== "string") throw new HttpError(400, '"name" must be a string');
    const scope = body.scope === undefined ? undefined : checkServiceScope(body.scope);
    const u = guarded(ctx, () => updateServiceAccount(id, { name: body.name as string | undefined, scope }, { by }));
    return send(res, 200, { account: view(ctx, u, runCounts(ctx)) }), true;
  }
  if (seg.length === 3 && seg[2] === "rotate" && method === "POST") {
    const r = guarded(ctx, () => rotateServiceToken(id, { by }));
    return send(res, 200, { account: view(ctx, r.account, runCounts(ctx)), token: r.token }), true;
  }
  if (seg.length === 3 && seg[2] === "revoke" && method === "POST") {
    const u = guarded(ctx, () => revokeServiceToken(id, { by }));
    return send(res, 200, { account: view(ctx, u, runCounts(ctx)) }), true;
  }
  return false;
};
