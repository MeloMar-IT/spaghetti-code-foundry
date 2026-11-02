import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { appendAuditLocked, MONITOR_ACTOR, prepareAuditLocked, type ActionAuditEvent } from "../auth/audit.js";
import { StoreError, withAuthLock } from "../auth/store.js";
import { listUsers, type User } from "../auth/users.js";
import { breakGlassReasonProblem } from "../engine/policy-break-glass.js";
import { randomTmp, writeTmp } from "../engine/policy-store.js";
import { AUTONOMY_LEVELS, isSensitiveLevel, nextLevel, SYSTEM_MONITOR, type AutonomyLevel } from "./autonomy.js";
import {
  AutonomyError,
  autonomyFile,
  levelIn,
  newEntry,
  readAutonomy,
  requestOf,
  serializeAutonomy,
  withRequest,
  type AutonomyEntry,
  type AutonomyKind,
  type AutonomyRequest,
  type AutonomyStore,
} from "./autonomy-store.js";
import type { PromotionGate } from "./gate.js";

/**
 * Promotion and demotion of an autonomy level (#646). A promotion is a request (stored next to the levels, with a token)
 * and an approval by the accountable owner; a demotion is at once. Each step writes one audit line, in the same step as the
 * file: a level never changes without its line. Messages never quote a reason, a path or the input.
 */

export interface ComponentRef { kind: AutonomyKind; id: string }
export interface AutonomyOwner { id: string; source: "config" | "first-admin"; problem?: string }
export interface ApprovedPromotion { from: AutonomyLevel; to: AutonomyLevel; entry: AutonomyEntry; requester: string; approver: string; selfApproved: boolean; owner: AutonomyOwner }

/** A refusal with a status the API answers with. `extra` goes into the answer. */
export class AutonomyRefused extends Error {
  constructor(
    public status: 403 | 409,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AutonomyRefused";
  }
}

const quiet = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // best effort
  }
};
const targetOf = (ref: ComponentRef): string => `${ref.kind}:${ref.id}`;
const arrow = (from: AutonomyLevel, to: AutonomyLevel): string => `${from}→${to}`;

// ---- who may do what -------------------------------------------------------------------------------

/** Admins that can sign in (an account with no password yet is not a second person), oldest first. */
export const activeAdmins = (users: readonly User[]): User[] =>
  users
    .filter((u) => u.role === "admin" && u.status === "active" && u.passwordHash !== undefined)
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

/**
 * The accountable owner: the configured admin when that account is an active admin, else the first active admin (with a
 * `problem` when an owner was configured). Undefined only when no admin can sign in.
 */
export function accountableOwner(configured: string | undefined, users: readonly User[]): AutonomyOwner | undefined {
  const admins = activeAdmins(users);
  if (configured !== undefined && admins.some((u) => u.id === configured)) return { id: configured, source: "config" };
  const first = admins[0];
  if (!first) return undefined;
  return { id: first.id, source: "first-admin", ...(configured !== undefined ? { problem: "the configured owner is not an active admin" } : {}) };
}

export type ApprovalVerdict = { ok: true; selfApproved: boolean; instead: boolean } | { ok: false; code: "not-owner" | "same-person" };

/** Whether an approver (already known to be an active admin) may approve a request. A pure function of the people. */
export function approvalVerdict(o: { approver: string; requester: string; owner: string; to: AutonomyLevel; admins: number }): ApprovalVerdict {
  if (o.approver === o.owner) {
    if (o.requester !== o.owner) return { ok: true, selfApproved: false, instead: false };
    if (!isSensitiveLevel(o.to) || o.admins <= 1) return { ok: true, selfApproved: true, instead: false };
    return { ok: false, code: "same-person" };
  }
  if (o.requester === o.owner) return { ok: true, selfApproved: false, instead: true };
  return { ok: false, code: "not-owner" };
}

// ---- requests --------------------------------------------------------------------------------------

/** The waiting request of a component, only when it still fits: pending, from the current level, to the next one. */
export function liveRequest(store: AutonomyStore, ref: ComponentRef): AutonomyRequest | undefined {
  const req = requestOf(store, ref.kind, ref.id);
  if (!req || req.state !== "pending") return undefined;
  const level = levelIn(store, ref.kind, ref.id);
  return req.from === level && req.to === nextLevel(level) ? req : undefined;
}

/** The reason, trimmed. Throws AutonomyError in fixed words that never quote it. */
export function checkReason(raw: unknown): string {
  if (typeof raw !== "string") throw new AutonomyError('a reason is required: add --reason "<text>"');
  const problem = breakGlassReasonProblem(raw);
  if (problem) throw new AutonomyError(problem);
  return raw.trim();
}

/** The current level when `to` is exactly one above it and no request waits. Throws AutonomyRefused (409). */
export function checkPromotable(store: AutonomyStore, ref: ComponentRef, to: AutonomyLevel): AutonomyLevel {
  const level = levelIn(store, ref.kind, ref.id);
  const next = nextLevel(level);
  if (next === null) throw new AutonomyRefused(409, "this component is at the top level already");
  if (to !== next) throw new AutonomyRefused(409, "a promotion goes up exactly one level");
  if (liveRequest(store, ref)) throw new AutonomyRefused(409, "a request for this component is waiting already");
  return level;
}

/** Whether `by` could approve the waiting request of a component now (a cheap check before the gate runs). */
export function mayApprove(store: AutonomyStore, ref: ComponentRef, to: AutonomyLevel, by: string, configuredOwner?: string): boolean {
  const req = liveRequest(store, ref);
  if (!req || req.to !== to) return false;
  const users = listUsers();
  const admins = activeAdmins(users);
  const owner = accountableOwner(configuredOwner, users);
  if (!owner || !admins.some((u) => u.id === by)) return false;
  return approvalVerdict({ approver: by, requester: req.by, owner: owner.id, to: req.to, admins: admins.length }).ok;
}

// ---- writing ---------------------------------------------------------------------------------------

/**
 * Writes the file and its audit line together (like the break-glass start): the log must open first, the temp file is
 * written, then the line, then the rename. A rename that fails leaves a `failed` line. Only inside withAuthLock.
 */
function commitLocked(by: string, next: AutonomyStore, event: ActionAuditEvent): void {
  const file = autonomyFile();
  const text = serializeAutonomy(next);
  const log = prepareAuditLocked(by, event);
  const tmp = randomTmp(dirname(file), basename(file));
  let written = false;
  try {
    writeTmp(tmp, text);
    try {
      log.write();
    } catch {
      throw new StoreError("cannot-write", file, "was not changed: the audit line could not be written");
    }
    written = true;
    renameSync(tmp, file);
  } catch (e) {
    quiet(() => rmSync(tmp, { force: true }));
    if (written) {
      quiet(() => log.close());
      quiet(() => appendAuditLocked(by, { ...event, result: "failed", detail: `${event.detail?.split(" ")[0] ?? ""} refused: not-saved` }));
      throw new StoreError("cannot-write", file, "could not be written; the level was not changed");
    }
    throw e instanceof StoreError ? e : new StoreError("cannot-write", file, "could not be written; nothing was changed");
  } finally {
    quiet(() => log.close());
  }
}

/** A failed line for a refusal, best effort, inside the lock. */
const refusedLine = (by: string, action: "autonomy-promote" | "autonomy-promote-request" | "autonomy-demote", ref: ComponentRef, detail: string): void =>
  quiet(() => appendAuditLocked(by, { action, result: "failed", target: targetOf(ref), detail }));

/**
 * The actor must still be an active admin when the change is committed. The request was authenticated before its body was
 * read and before a gate ran, so the account may have been blocked or demoted in between. Inside the lock, before any state is read.
 */
function requireActiveAdminLocked(by: string, ref: ComponentRef, action: "autonomy-promote-request" | "autonomy-demote"): void {
  if (activeAdmins(listUsers()).some((u) => u.id === by)) return;
  refusedLine(by, action, ref, "refused: not-admin");
  throw new AutonomyRefused(403, "only an active admin can change an autonomy level");
}

/** Stores a request for the next level. The caller has checked the gate. Throws AutonomyError, AutonomyRefused or StoreError. */
export function requestPromotion(o: { ref: ComponentRef; to: AutonomyLevel; reason: string; by: string; waitMs?: number }): AutonomyRequest {
  const reason = checkReason(o.reason);
  newEntry(o.ref.kind, o.ref.id, o.to, o.by); // checks the kind, the id, the level and the account
  return withAuthLock(() => {
    requireActiveAdminLocked(o.by, o.ref, "autonomy-promote-request");
    const store = readAutonomy();
    const from = checkPromotable(store, o.ref, o.to);
    const req: AutonomyRequest = { token: randomUUID(), from, to: o.to, reason, by: o.by, at: new Date().toISOString(), state: "pending" };
    commitLocked(o.by, withRequest(store, o.ref.kind, o.ref.id, req), {
      action: "autonomy-promote-request",
      result: "ok",
      target: targetOf(o.ref),
      detail: `${arrow(from, o.to)} reason: ${reason}`,
    });
    return req;
  }, o.waitMs ?? 0);
}

/**
 * Carries out a waiting request. Everything is checked again under the lock, in this order, stopping at the first failure:
 * a request, its token, an active admin, the two-person rule, a request that still fits, the gate. `gate` is the result of
 * the gate for the request with this token, read just before the lock; without it a request that is ready answers 409 "try again".
 */
export function approvePromotion(o: {
  ref: ComponentRef;
  to: AutonomyLevel;
  token: string;
  by: string;
  configuredOwner?: () => string | undefined;
  gate?: PromotionGate;
  waitMs?: number;
}): ApprovedPromotion {
  const { ref, by } = o;
  return withAuthLock(() => {
    const store = readAutonomy();
    const req = requestOf(store, ref.kind, ref.id);
    if (!req || req.state !== "pending") throw new AutonomyRefused(409, "no request is waiting for this component; ask for the promotion again");
    if (req.token !== o.token || req.to !== o.to) throw new AutonomyRefused(409, "the request changed; read it again");
    const steps = arrow(req.from, req.to);

    const users = listUsers();
    const admins = activeAdmins(users);
    if (!admins.some((u) => u.id === by)) {
      refusedLine(by, "autonomy-promote", ref, `${steps} refused: not-admin`);
      throw new AutonomyRefused(403, "only an active admin can approve");
    }
    const owner = accountableOwner(o.configuredOwner?.(), users);
    if (!owner) throw new AutonomyRefused(403, "only an active admin can approve");
    const verdict = approvalVerdict({ approver: by, requester: req.by, owner: owner.id, to: req.to, admins: admins.length });
    if (!verdict.ok) {
      refusedLine(by, "autonomy-promote", ref, `${steps} refused: ${verdict.code}`);
      throw new AutonomyRefused(403, verdict.code === "same-person" ? "a second admin must approve a move to this level" : "only the accountable owner can approve");
    }

    const expire = (why: "level-changed" | "gate-failed", extra?: Record<string, unknown>): never => {
      commitLocked(by, withRequest(store, ref.kind, ref.id, { ...req, state: "expired" }), {
        action: "autonomy-promote",
        result: "failed",
        target: targetOf(ref),
        detail: `${steps} expired: ${why}`,
      });
      throw new AutonomyRefused(409, why === "gate-failed" ? "the gate no longer passes; the request has expired" : "the level changed; the request has expired", extra);
    };
    const level = levelIn(store, ref.kind, ref.id);
    if (req.from !== level || req.to !== nextLevel(level)) return expire("level-changed");
    if (!o.gate) throw new AutonomyRefused(409, "the gate was not checked; try again");
    if (!o.gate.passed) return expire("gate-failed", { gate: o.gate });

    const entry = newEntry(ref.kind, ref.id, req.to, by, req.reason);
    const next = withRequest({ ...store, [ref.kind]: { ...store[ref.kind], [ref.id]: entry } }, ref.kind, ref.id, undefined);
    const marks = `${verdict.selfApproved ? " self-approved" : ""}${verdict.instead ? " second-admin" : ""}${owner.problem ? " owner-fallback" : ""}`;
    commitLocked(by, next, { action: "autonomy-promote", result: "ok", target: targetOf(ref), detail: `${steps} requester:${req.by}${marks} reason: ${req.reason}` });
    return { from: req.from, to: req.to, entry, requester: req.by, approver: by, selfApproved: verdict.selfApproved, owner };
  }, o.waitMs ?? 0);
}

/**
 * Lowers a level at once. Any admin, no gate. `by: "monitor"` (#647) is the monitor's automatic demotion: no admin check, the
 * store names `system:monitor` and the audit line `monitor`. Only code in this process can pass it: the API always passes an
 * account id. Throws AutonomyError, AutonomyRefused or StoreError. */
export function demoteLevel(o: { ref: ComponentRef; to: AutonomyLevel; reason: string; by: string; waitMs?: number }): { from: AutonomyLevel; to: AutonomyLevel; entry: AutonomyEntry } {
  const reason = checkReason(o.reason);
  return withAuthLock(() => {
    const monitor = o.by === MONITOR_ACTOR;
    if (!monitor) requireActiveAdminLocked(o.by, o.ref, "autonomy-demote");
    const store = readAutonomy();
    const from = levelIn(store, o.ref.kind, o.ref.id);
    if (AUTONOMY_LEVELS.indexOf(o.to) >= AUTONOMY_LEVELS.indexOf(from)) throw new AutonomyRefused(409, "a demotion goes to a lower level");
    const entry = newEntry(o.ref.kind, o.ref.id, o.to, monitor ? SYSTEM_MONITOR : o.by, reason);
    commitLocked(o.by, { ...store, [o.ref.kind]: { ...store[o.ref.kind], [o.ref.id]: entry } }, {
      action: "autonomy-demote",
      result: "ok",
      target: targetOf(o.ref),
      detail: `${arrow(from, o.to)} reason: ${reason}`,
    });
    return { from, to: o.to, entry };
  }, o.waitMs ?? 0);
}
