import { z } from "zod";
import { WORKSPACE_ID_RE } from "../workspaces/list.js";

/**
 * The identity provider (#833): the slot for the one plugin that says who is signing in, and the strict check of its answer.
 * It knows nothing about HTTP or files. It imports only zod and workspaces/list.ts, so plugins/load.ts can use it without
 * an import cycle. Nothing the provider says (an error, an answer) is ever passed on as text: only the fixed reasons below.
 */

export const IDENTITY_TIMEOUT_MS = 5_000;
export const MAX_RESOLVING = 8;

/** What the provider sees of a request. A deeply frozen copy; the session cookie is removed. */
export interface IdentityRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly remoteAddress: string;
}
export interface IdentityAnswer {
  id: string;
  name: string;
  roles: ("admin" | "user")[];
  workspace?: string;
}
/** What a plugin gives `api.identityProvider`. `resolve` may be synchronous or return a promise. */
export interface IdentityProvider {
  resolve(request: Readonly<IdentityRequest>, signal: AbortSignal): IdentityAnswer | null | PromiseLike<IdentityAnswer | null>;
}
export type Resolution =
  | { kind: "user"; id: string; name: string; role: "admin" | "user"; workspace?: string }
  | { kind: "none" }
  | { kind: "error" };

export const REASON_THREW = "identityProvider resolve() failed; nobody is signed in";
export const REASON_TIMEOUT = "identityProvider resolve() did not answer within 5 s; nobody is signed in";
export const REASON_BAD = "identityProvider resolve() gave an answer that is not valid; nobody is signed in";
export const REASON_BUSY = "identityProvider resolve() has 8 calls waiting; nobody is signed in";
export const REASON_TAKEN = "identityProvider resolve() named a local account; nobody is signed in";

interface Supplier {
  owner: string;
  plugin: string;
  provider: IdentityProvider;
  report: (reason: string) => void;
}
interface Slot extends Supplier {
  reported: Set<string>;
  pending: number;
}
let slot: Slot | undefined;

/** Takes the one supplier slot. */
export function supplyIdentity(s: Supplier): "ok" | { taken: string } {
  if (slot) return { taken: slot.plugin };
  slot = { ...s, reported: new Set(), pending: 0 };
  return "ok";
}

export function disposeIdentity(owner: string): void {
  if (slot?.owner === owner) slot = undefined;
}

export const hasIdentityProvider = (): boolean => slot !== undefined;

function problem(s: Slot, reason: string): void {
  if (s.reported.has(reason)) return;
  s.reported.add(reason);
  try {
    s.report(reason);
  } catch {
    /* a failing report must not reach the caller */
  }
}

/** Reports a fixed reason once per supplier. A throwing report is swallowed. */
export function reportIdentityProblem(reason: string): void {
  if (slot) problem(slot, reason);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const AnswerSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(100).refine((s) => !CONTROL.test(s)),
    roles: z
      .array(z.enum(["admin", "user"]))
      .min(1)
      .max(2)
      .refine((l) => new Set(l).size === l.length),
    workspace: z.string().regex(WORKSPACE_ID_RE).optional(),
  })
  .strict();

/** null is "nobody"; a valid answer is a user (id lower-cased, name trimmed); anything else is an error. Never throws. */
export function readIdentityAnswer(value: unknown): Resolution {
  if (value === null) return { kind: "none" };
  try {
    const p = AnswerSchema.safeParse(value);
    if (!p.success) return { kind: "error" };
    const a = p.data;
    return {
      kind: "user",
      id: a.id.toLowerCase(),
      name: a.name,
      role: a.roles.includes("admin") ? "admin" : "user",
      ...(a.workspace !== undefined ? { workspace: a.workspace } : {}),
    };
  } catch {
    return { kind: "error" };
  }
}

function deepFreeze<T extends object>(o: T): Readonly<T> {
  return Object.freeze(o);
}

/**
 * Asks the provider who the request is. Never throws or rejects. No supplier gives an error. The deadline starts before the
 * call; a synchronous answer that took longer is refused too. A slot is freed only when the call settles.
 */
export async function resolveIdentity(request: IdentityRequest, o: { timeoutMs?: number } = {}): Promise<Resolution> {
  const s = slot;
  if (!s) return { kind: "error" };
  if (s.pending >= MAX_RESOLVING) {
    problem(s, REASON_BUSY);
    return { kind: "error" };
  }
  const timeoutMs = o.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  const copy: IdentityRequest = deepFreeze({
    method: request.method,
    url: request.url,
    headers: deepFreeze({ ...request.headers }),
    remoteAddress: request.remoteAddress,
  });
  const controller = new AbortController();
  s.pending++;
  let timer: NodeJS.Timeout | undefined;
  const started = performance.now();
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
    timer.unref();
  });
  let call: Promise<unknown>;
  try {
    call = Promise.resolve(s.provider.resolve(copy, controller.signal));
  } catch (e) {
    call = Promise.reject(e);
  }
  // the call keeps counting as pending until it settles, even after the deadline; the handlers also mark a late rejection as handled
  void call.then(
    () => void s.pending--,
    () => void s.pending--,
  );
  try {
    const r = await Promise.race([call.then((v) => ({ v })), limit]);
    if (r === "timeout" || performance.now() - started > timeoutMs) {
      problem(s, REASON_TIMEOUT);
      return { kind: "error" };
    }
    const a = readIdentityAnswer(r.v);
    if (a.kind === "error") problem(s, REASON_BAD);
    return a;
  } catch {
    problem(s, REASON_THREW);
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}
