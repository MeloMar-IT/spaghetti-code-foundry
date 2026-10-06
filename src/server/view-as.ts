import { basename } from "node:path";
import type { IncomingMessage } from "node:http";
import { isAccountId, writeAudit } from "../auth/audit.js";
import { StoreError } from "../auth/store.js";
import { getUser, type User } from "../auth/users.js";
import { sessionKey, sessionUser } from "./api-auth.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

/** How long a view of a user's display lasts. */
export const VIEW_AS_MS = 30 * 60 * 1000;
export const READ_ONLY = "the preview is read-only";
const NOT_ALLOWED = "not allowed for your role";
const NO_VIEW = "no view is running for this account";
const INTERNAL = "the account list is not working; see the server log";

export interface View {
  userId: string;
  until: number;
}

/** The running views: one per session, in memory only. Keyed by the session id (a hash), never the token. */
export class ViewStore {
  private readonly views = new Map<string, View>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Starts a view for the session (replacing its old one) and drops the expired ones. */
  start(session: string, userId: string): View {
    const t = this.now();
    for (const [k, v] of this.views) if (v.until <= t) this.views.delete(k);
    const view = { userId, until: t + VIEW_AS_MS };
    this.views.set(session, view);
    return view;
  }

  get(session: string): View | undefined {
    const v = this.views.get(session);
    if (!v) return undefined;
    if (v.until <= this.now()) {
      this.views.delete(session);
      return undefined;
    }
    return v;
  }

  end(session: string): boolean {
    return this.views.delete(session);
  }

  get size(): number {
    return this.views.size;
  }
}

const stores = new WeakMap<ApiContext, ViewStore>();
/** The views of this server. A restarted server has a new context, so no views. */
export function viewsOf(ctx: ApiContext): ViewStore {
  let s = stores.get(ctx);
  if (!s) {
    s = new ViewStore(ctx.opts.viewAsClock);
    stores.set(ctx, s);
  }
  return s;
}

/** The `as` of the query: undefined when it is not there, "" when it is given more than once. */
export function asParam(req: IncomingMessage): string | undefined {
  let all: string[];
  try {
    all = new URL(req.url ?? "/", "http://x").searchParams.getAll("as");
  } catch {
    return undefined;
  }
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0] : "";
}

/** Reads an account; a store error is logged with fixed words and answered with a 500. */
function readUser(ctx: ApiContext, id: string): User | undefined {
  try {
    return getUser(id);
  } catch (e) {
    const log = ctx.diagLog;
    if (e instanceof StoreError) log?.(`users: ${basename(e.file)} ${e.kind}`);
    else log?.(`users: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

/**
 * The account a call with `as=` is answered for. The caller must be an admin with a running view of exactly this
 * account for this session, and the account must still exist as a user. Else 403 (and the view ends when the
 * caller or the account no longer fits). The account's blocked status does not matter.
 */
export function viewedUser(ctx: ApiContext, req: IncomingMessage, caller: User, as: string): User {
  const key = sessionKey(ctx, req);
  const views = viewsOf(ctx);
  if (caller.role !== "admin") {
    if (key) views.end(key);
    throw new HttpError(403, NOT_ALLOWED);
  }
  const view = key ? views.get(key) : undefined;
  if (!key || !view || view.userId !== as) throw new HttpError(403, NO_VIEW);
  const target = readUser(ctx, view.userId);
  if (!target || target.role !== "user") {
    views.end(key);
    throw new HttpError(403, NO_VIEW);
  }
  return target;
}

/** The same checks for an open stream, with the caller read fresh from the session. Never throws: any error is "not running". */
export function viewRunning(ctx: ApiContext, req: IncomingMessage, as: string): boolean {
  try {
    viewedUser(ctx, req, sessionUser(ctx, req), as);
    return true;
  } catch {
    return false;
  }
}

/** POST and DELETE /api/admin/view-as: start or end a read-only view of one user's display. */
export const viewAsRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "admin" || seg[1] !== "view-as" || seg.length !== 2) return false;
  const key = sessionKey(ctx, req);
  if (!key) throw new HttpError(401, "sign in first");
  if (method === "DELETE") {
    viewsOf(ctx).end(key);
    return send(res, 200, { ok: true }), true;
  }
  if (method !== "POST") return false;
  const body = await readJson(req);
  const userId = body.userId;
  if (typeof userId !== "string" || !isAccountId(userId)) throw new HttpError(400, '"userId" must be an account id');
  if (userId === user.id) throw new HttpError(400, "you cannot view your own account");
  const target = readUser(ctx, userId);
  if (!target) throw new HttpError(404, "no such account");
  if (target.role === "admin") throw new HttpError(400, "an admin account cannot be viewed");
  try {
    writeAudit(user.id, { action: "view-as", result: "ok", userId: target.id }, 0);
  } catch (e) {
    const kind = e instanceof StoreError ? e.kind : undefined;
    ctx.diagLog?.(e instanceof StoreError ? `audit: ${basename(e.file)} ${e.kind} (view-as)` : "audit: audit.jsonl not-valid (view-as)");
    if (kind === "locked") throw new HttpError(503, "the audit log is busy; try again in a moment");
    throw new HttpError(500, "the view could not start: the audit log cannot be written");
  }
  viewsOf(ctx).start(key, target.id);
  return send(res, 200, { id: target.id, name: target.name }), true;
};
