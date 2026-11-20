import { setTimeout as sleep } from "node:timers/promises";
import { basename } from "node:path";
import { writeAudit, type ActionAuditEvent } from "../auth/audit.js";
import { SERVICE_DROPPED_TEXT, SERVICE_LINE_RESULTS, isPrintable, serviceLineDetail, type ServiceLineResult } from "../auth/audit-client.js";
import { findServiceByToken, type ServiceAccount } from "../auth/service-accounts.js";
import { StoreError } from "../auth/store.js";
import { HttpError, readJson, send } from "./http.js";
import type { Route } from "./server.js";
import { clientLabel, serviceBearer } from "./service-requests.js";

/**
 * A service account writes one audit line of its own (#884): `POST /api/audit/service-line` with what the program decided
 * (`event`, `result`, optional `code` and `detail`). The line has the action `service-line`, the account as `by`, the event as
 * `target`, and in its detail the program's result, code and text, the person it acts for and its client label. The text is the
 * program's claim: the Foundry checks only its shape, its length, that it is printable and that it holds no token. At most 120
 * lines a minute per account; above that the call answers 429 and one `service-line-dropped` line is written per minute.
 * The request itself still gets its own `service-request` line, as every service request does.
 */

export const SERVICE_LINE_LIMIT = 120;
export const SERVICE_LINE_WINDOW_MS = 60_000;
export const SERVICE_LINE_TEXT_MAX = 300;

const WORD_RE = /^[a-z0-9_.-]{1,64}$/;
const TOKEN_RE = /scf_svc_/i;
const KEYS = new Set(["event", "result", "code", "detail"]);

export interface ServiceLineBody {
  event: string;
  result: ServiceLineResult;
  code?: string;
  detail?: string;
}

/** The body of a call, checked. Any problem answers 400 with a fixed sentence that never repeats the sent value. */
export function readServiceLine(body: Record<string, unknown>): ServiceLineBody {
  for (const k of Object.keys(body)) if (!KEYS.has(k)) throw new HttpError(400, "the fields are event, result, code and detail");
  const { event, result, code, detail } = body;
  if (typeof event !== "string" || !WORD_RE.test(event)) {
    throw new HttpError(400, '"event" must be 1 to 64 lower-case letters, digits, "_", "-" or "."');
  }
  if (typeof result !== "string" || !(SERVICE_LINE_RESULTS as readonly string[]).includes(result)) {
    throw new HttpError(400, '"result" must be ok, refused or failed');
  }
  if ("code" in body && (typeof code !== "string" || !WORD_RE.test(code))) {
    throw new HttpError(400, '"code" must be 1 to 64 lower-case letters, digits, "_", "-" or "."');
  }
  if ("detail" in body) {
    if (typeof detail !== "string" || detail.length === 0 || Array.from(detail).length > SERVICE_LINE_TEXT_MAX || !isPrintable(detail)) {
      throw new HttpError(400, `"detail" must be printable text of 1 to ${SERVICE_LINE_TEXT_MAX} characters`);
    }
  }
  if ([event, code, detail].some((v) => typeof v === "string" && TOKEN_RE.test(v))) {
    throw new HttpError(400, "an audit line must not hold a service token");
  }
  return {
    event,
    result: result as ServiceLineResult,
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  };
}

export type Take = { ok: true } | { ok: false; retryAfterS: number; writeDropped: boolean };

interface LimitState {
  times: number[];
  /** When the last dropped line was written. */
  droppedAt?: number;
  /** A dropped line is being written now. */
  pending: boolean;
}

/**
 * The limit of lines per account: a sliding window of accepted lines. Synchronous, so two calls at once cannot both take the
 * last slot, nor both start the dropped line. A dropped line counts as written only once `droppedWritten` is called; after
 * `droppedFailed` the next refused call tries again.
 */
export class LineLimiter {
  private readonly state = new Map<string, LimitState>();
  constructor(
    private readonly limit = SERVICE_LINE_LIMIT,
    private readonly windowMs = SERVICE_LINE_WINDOW_MS,
  ) {}

  take(id: string, now: number): Take {
    this.prune(now);
    let s = this.state.get(id);
    if (!s) {
      s = { times: [], pending: false };
      this.state.set(id, s);
    }
    if (s.times.length < this.limit) {
      s.times.push(now);
      return { ok: true };
    }
    const retryAfterS = Math.min(Math.ceil(this.windowMs / 1000), Math.max(1, Math.ceil((s.times[0]! + this.windowMs - now) / 1000)));
    const writeDropped = !s.pending && (s.droppedAt === undefined || now - s.droppedAt >= this.windowMs);
    if (writeDropped) s.pending = true;
    return { ok: false, retryAfterS, writeDropped };
  }

  droppedWritten(id: string, now: number): void {
    const s = this.state.get(id);
    if (!s) return;
    s.pending = false;
    s.droppedAt = now;
  }

  droppedFailed(id: string): void {
    const s = this.state.get(id);
    if (s) s.pending = false;
  }

  /** The number of accounts it keeps state for (for tests). */
  get size(): number {
    return this.state.size;
  }

  private prune(now: number): void {
    for (const [id, s] of this.state) {
      while (s.times.length > 0 && s.times[0]! <= now - this.windowMs) s.times.shift();
      if (s.times.length === 0 && !s.pending && (s.droppedAt === undefined || now - s.droppedAt >= this.windowMs)) this.state.delete(id);
    }
  }
}

export interface LineDeps {
  limiter: LineLimiter;
  /** How often a line is tried while another process holds the lock, and how long to wait between tries. */
  tries: number;
  delay: (ms: number) => Promise<unknown>;
  now: () => number;
  log?: (msg: string) => void;
}

const RETRY_MS = 25;
const defaultDeps: LineDeps = { limiter: new LineLimiter(), tries: 20, delay: (ms) => sleep(ms), now: () => Date.now() };

/** Writes one line, trying again (without blocking) while the lock is held. Throws the last error. */
async function writeWithRetries(id: string, event: ActionAuditEvent, deps: LineDeps): Promise<void> {
  for (let n = 1; ; n++) {
    try {
      writeAudit(id, event, 0);
      return;
    } catch (e) {
      if (!(e instanceof StoreError && e.kind === "locked") || n >= deps.tries) throw e;
    }
    await deps.delay(RETRY_MS);
  }
}

const lost = (deps: LineDeps, what: string, e: unknown) =>
  deps.log?.(e instanceof StoreError ? `audit: ${basename(e.file)} ${e.kind} (${what})` : `audit: audit.jsonl not-valid (${what})`);

const withTail = (base: string, account: ServiceAccount, client: string | undefined) =>
  [base, account.actsFor !== undefined ? `acts for ${account.actsFor}` : undefined, client !== undefined ? `client ${client}` : undefined].filter(Boolean).join("; ");

/**
 * Writes the line of one checked call, or answers 429 over the limit (and writes the dropped line when one is due). A lock
 * held by another process the whole time answers 503; any other store error answers 500.
 */
export async function writeOwnLine(account: ServiceAccount, body: ServiceLineBody, client: string | undefined, deps: LineDeps = defaultDeps): Promise<void> {
  const take = deps.limiter.take(account.id, deps.now());
  if (!take.ok) {
    if (take.writeDropped) {
      try {
        await writeWithRetries(account.id, { action: "service-line-dropped", result: "failed", target: "POST audit/service-line", detail: withTail(SERVICE_DROPPED_TEXT, account, client) }, deps);
        deps.limiter.droppedWritten(account.id, deps.now());
      } catch (e) {
        deps.limiter.droppedFailed(account.id);
        lost(deps, "service-line-dropped", e);
      }
    }
    throw new HttpError(429, `more than ${SERVICE_LINE_LIMIT} audit lines a minute; try again later`, { "retry-after": String(take.retryAfterS) });
  }
  const detail = serviceLineDetail({
    result: body.result,
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.detail !== undefined ? { text: body.detail } : {}),
    ...(account.actsFor !== undefined ? { actsFor: account.actsFor } : {}),
    ...(client !== undefined ? { client } : {}),
  });
  try {
    await writeWithRetries(account.id, { action: "service-line", result: body.result === "ok" ? "ok" : "failed", target: body.event, detail }, deps);
  } catch (e) {
    lost(deps, "service-line", e);
    if (e instanceof StoreError && e.kind === "locked") throw new HttpError(503, "the audit log is busy; try again in a moment", { "retry-after": "1" });
    throw new HttpError(500, "the audit log is not working; see the server log");
  }
}

export const serviceLineRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (method !== "POST" || seg.length !== 2 || seg[0] !== "audit" || seg[1] !== "service-line") return false;
  if (user.kind !== "service") throw new HttpError(403, "only a service account writes its own audit lines");
  const token = serviceBearer(req);
  let account: ServiceAccount | undefined;
  try {
    account = token === undefined ? undefined : findServiceByToken(token);
  } catch (e) {
    lost({ ...defaultDeps, log: ctx.diagLog }, "service-line", e);
    throw new HttpError(500, "the audit log is not working; see the server log");
  }
  if (!account) throw new HttpError(401, "this service token is not valid");
  const body = readServiceLine(await readJson(req));
  await writeOwnLine(account, body, clientLabel(req), { ...defaultDeps, log: ctx.diagLog });
  send(res, 201, { written: true });
  return true;
};
