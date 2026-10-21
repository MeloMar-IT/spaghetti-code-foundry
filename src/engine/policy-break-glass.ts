import { lstatSync, renameSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { appendAuditLocked, prepareAuditLocked } from "../auth/audit.js";
import { dataHome, StoreError, withAuthLock } from "../auth/store.js";
import { credentialProblem } from "../skills/credential-scan.js";
import { readPolicyFile } from "./policy-hooks.js";
import { randomTmp, writeTmp } from "./policy-store.js";

/**
 * The break-glass record: a time-limited, audited note that an administrator started on the server machine with
 * `scf policy break-glass`. This module writes, reads, ends and audits it; runs use it through RunPolicy (policy-hooks.ts) and the server watches it.
 */

export const BREAK_GLASS_FILE = "policy-break-glass.json";
export const MAX_BREAK_GLASS_MS = 4 * 60 * 60 * 1000;
export const BREAK_GLASS_REASON_MAX = 200;
const ENDING_FILE = `.${BREAK_GLASS_FILE}.ending`;
const MAX_BREAK_GLASS_BYTES = 4096;
const FUTURE_SKEW_MS = 60_000;
const OS_USER = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface BreakGlass {
  version: 1;
  reason: string;
  startedAt: string;
  expiresAt: string;
  actor: { kind: "cli"; osUser: string };
}
export type BreakGlassEndDetail = "ended" | "expired" | "invalid";
export type BreakGlassState =
  | { state: "missing" }
  | { state: "invalid"; why: string }
  | { state: "expired"; record: BreakGlass }
  | { state: "active"; record: BreakGlass };
export type BreakGlassResult = { ok: true; expiresAt?: string; detail?: BreakGlassEndDetail } | { ok: false; reason: string };

export const breakGlassFile = (home: string = dataHome()): string => join(home, BREAK_GLASS_FILE);

/** The problem with a reason, in fixed words that never quote it; undefined when it is fine. */
export function breakGlassReasonProblem(reason: string | undefined): string | undefined {
  const required = 'a reason is required: add --reason "<text>"';
  if (reason === undefined) return required;
  if (CONTROL.test(reason)) return "the reason must be one line with no control characters";
  const text = reason.trim();
  if (!text) return required;
  if (text.length > BREAK_GLASS_REASON_MAX) return `the reason is longer than ${BREAK_GLASS_REASON_MAX} characters`;
  const cred = credentialProblem(text);
  if (cred) return `the reason looks like it holds a credential (${cred}); leave it out`;
  return undefined;
}

/** `<n>m` or `<n>h` up to 4 hours, in milliseconds; undefined when it is not valid. */
export function breakGlassMs(spec: string | undefined): number | undefined {
  const m = /^([1-9]\d{0,3})([mh])$/.exec(spec ?? "");
  if (!m) return undefined;
  const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
  return ms <= MAX_BREAK_GLASS_MS ? ms : undefined;
}

const RecordSchema = z
  .object({
    version: z.literal(1),
    reason: z.string(),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    actor: z.object({ kind: z.literal("cli"), osUser: z.string().regex(OS_USER) }).strict(),
  })
  .strict();

/** Reads and checks the record. Never throws. */
export function readBreakGlass(home: string = dataHome(), now: Date = new Date()): BreakGlassState {
  const invalid = (why: string): BreakGlassState => ({ state: "invalid", why });
  try {
    const file = breakGlassFile(home);
    try {
      const st = lstatSync(file);
      if (st.isDirectory()) return invalid("a folder");
      if (st.isSymbolicLink()) return invalid("a link");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
      return invalid("could not be read");
    }
    const read = readPolicyFile(file, MAX_BREAK_GLASS_BYTES);
    if ("problem" in read) {
      if (read.problem === "missing") return { state: "missing" };
      if (read.problem === "not-file") return invalid("not a plain file");
      if (read.problem === "too-large") return invalid("larger than 4 KiB");
      return invalid("could not be read");
    }
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch {
      return invalid("not valid JSON");
    }
    const parsed = RecordSchema.safeParse(json);
    if (!parsed.success) return invalid("not valid");
    const record: BreakGlass = parsed.data;
    if (record.reason !== record.reason.trim() || breakGlassReasonProblem(record.reason)) return invalid("not valid");
    const started = Date.parse(record.startedAt);
    const expires = Date.parse(record.expiresAt);
    const t = now.getTime();
    const span = expires - started;
    if (!(span > 0) || span > MAX_BREAK_GLASS_MS || started > t + FUTURE_SKEW_MS || expires > t + MAX_BREAK_GLASS_MS) {
      return invalid("the times are not valid");
    }
    return t >= expires ? { state: "expired", record } : { state: "active", record };
  } catch {
    return invalid("could not be read");
  }
}

const quiet = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // best effort
  }
};

/**
 * Ends the record: moves it aside, writes the end line, and puts it back when the line cannot be written.
 * Only inside withAuthLock. A side file left behind is never read and never put back.
 */
function endLocked(home: string, detail: BreakGlassEndDetail, target: string): BreakGlassResult {
  const file = breakGlassFile(home);
  const side = join(home, ENDING_FILE);
  let log;
  try {
    log = prepareAuditLocked("cli", { action: "policy-break-glass-end", result: "ok", target, detail });
  } catch {
    return { ok: false, reason: "the audit log could not be opened; nothing was ended" };
  }
  try {
    try {
      renameSync(file, side);
    } catch {
      return { ok: false, reason: `${BREAK_GLASS_FILE} could not be removed; nothing was ended` };
    }
    try {
      log.write();
    } catch {
      try {
        renameSync(side, file);
      } catch {
        return {
          ok: false,
          reason: "the audit line could not be written and the break-glass could not be put back; it is no longer active, but its end is not in the audit log",
        };
      }
      return { ok: false, reason: "the audit line could not be written; the break-glass was not ended" };
    }
    quiet(() => rmSync(side, { force: true }));
    return { ok: true, detail };
  } finally {
    quiet(() => log.close());
  }
}

/** Ends the record again only if it is still expired. Only inside withAuthLock. */
function endExpiredLocked(home: string, now: Date): boolean {
  const r = readBreakGlass(home, now);
  if (r.state !== "expired") return false;
  return endLocked(home, "expired", r.record.expiresAt).ok;
}

/** Writes the one `expired` end line and removes the record. Best effort, never throws; true when it wrote the line. */
export function endExpiredBreakGlass(now: Date = new Date()): boolean {
  try {
    return withAuthLock(() => endExpiredLocked(dataHome(), now), 0);
  } catch {
    return false;
  }
}

/**
 * The record, only when it is active. An expired record in the data folder gets its end line here (first reader wins).
 * The lock is not re-entrant: a caller that already holds it gets no expiry line.
 */
export function activeBreakGlass(home: string = dataHome(), now: Date = new Date()): BreakGlass | undefined {
  const r = readBreakGlass(home, now);
  if (r.state === "active") return r.record;
  if (r.state === "expired" && home === dataHome()) endExpiredBreakGlass(now);
  return undefined;
}

export const BREAK_GLASS_WATCH_MS = 60_000;
export const BREAK_GLASS_REMIND_MS = 15 * 60_000;

/** The server's watch on the record in the data folder: call the returned tick at startup and every minute. Never throws. */
export function breakGlassWatch(log: (line: string) => void, now: () => Date = () => new Date()): () => void {
  let shown: { startedAt: string; at: number } | undefined;
  return () => {
    try {
      const t = now();
      const r = readBreakGlass(dataHome(), t);
      if (r.state === "active") {
        if (!shown || shown.startedAt !== r.record.startedAt || t.getTime() - shown.at >= BREAK_GLASS_REMIND_MS) {
          log(`! policy: break-glass active until ${r.record.expiresAt} (${r.record.reason}) — a mandatory policy that cannot be used does not stop privileged steps`);
          shown = { startedAt: r.record.startedAt, at: t.getTime() };
        }
      } else if (r.state === "expired") {
        if (endExpiredBreakGlass(t)) {
          log("policy: break-glass ended (expired)");
          shown = undefined;
        }
      } else if (shown) {
        log("policy: break-glass ended");
        shown = undefined;
      }
    } catch {
      // the watch never stops the server
    }
  };
}

const lockMessage ="another scf command holds the data-folder lock; try again";

function osUser(): string {
  try {
    const name = userInfo().username;
    return OS_USER.test(name) ? name : "unknown";
  } catch {
    return "unknown";
  }
}

/** `scf policy break-glass --reason … --for …`. Never throws. */
export function startBreakGlass(o: { reason?: string; for?: string; now?: () => Date; waitMs?: number }): BreakGlassResult {
  const problem = breakGlassReasonProblem(o.reason);
  if (problem) return { ok: false, reason: problem };
  const ms = breakGlassMs(o.for);
  if (ms === undefined) return { ok: false, reason: "--for is required and must be <n>m or <n>h, from 1 minute up to 4 hours" };
  const reason = o.reason!.trim();
  const t = (o.now ?? (() => new Date()))();
  const startedAt = t.toISOString();
  const expiresAt = new Date(t.getTime() + ms).toISOString();
  const record: BreakGlass = { version: 1, reason, startedAt, expiresAt, actor: { kind: "cli", osUser: osUser() } };
  let committed: BreakGlassResult | undefined;

  const locked = (): BreakGlassResult => {
    const home = dataHome();
    const file = breakGlassFile(home);
    const refuse = (why: string): BreakGlassResult => {
      quiet(() => appendAuditLocked("cli", { action: "policy-break-glass-start", result: "failed", target: expiresAt, detail: reason }));
      return { ok: false, reason: why };
    };
    const cur = readBreakGlass(home, t);
    if (cur.state === "active") return refuse(`a break-glass is already active until ${cur.record.expiresAt}; end it first with scf policy break-glass --end`);
    if (cur.state === "invalid") {
      return refuse(
        cur.why === "a folder"
          ? `${BREAK_GLASS_FILE} is a folder; remove it by hand`
          : "the break-glass file is not valid; end it first with scf policy break-glass --end",
      );
    }
    if (cur.state === "expired" && !endExpiredLocked(home, t)) return refuse("the expired break-glass could not be ended; nothing was started");
    let log;
    try {
      log = prepareAuditLocked("cli", { action: "policy-break-glass-start", result: "ok", target: expiresAt, detail: reason });
    } catch {
      return refuse("the audit log could not be opened; no break-glass was started");
    }
    const tmp = randomTmp(home, BREAK_GLASS_FILE);
    const dropTmp = (): void => quiet(() => rmSync(tmp, { force: true }));
    try {
      try {
        writeTmp(tmp, JSON.stringify(record));
      } catch {
        dropTmp();
        return refuse(`${BREAK_GLASS_FILE} could not be written; no break-glass was started`);
      }
      try {
        log.write();
      } catch {
        dropTmp();
        return { ok: false, reason: "the audit line could not be written; no break-glass was started" };
      }
      try {
        renameSync(tmp, file);
      } catch {
        dropTmp();
        return refuse(`${BREAK_GLASS_FILE} could not be written; no break-glass was started`);
      }
      return { ok: true, expiresAt };
    } finally {
      quiet(() => log.close());
    }
  };

  try {
    return withAuthLock(() => (committed = locked()), o.waitMs);
  } catch (e) {
    if (committed) return committed;
    if (e instanceof StoreError && e.kind === "locked") return { ok: false, reason: lockMessage };
    return { ok: false, reason: "the data folder could not be locked; nothing was started" };
  }
}

/** `scf policy break-glass --end`. Never throws. */
export function endBreakGlass(o: { now?: () => Date; waitMs?: number } = {}): BreakGlassResult {
  const t = (o.now ?? (() => new Date()))();
  let committed: BreakGlassResult | undefined;

  const locked = (): BreakGlassResult => {
    const home = dataHome();
    const none: BreakGlassResult = { ok: false, reason: "no break-glass is active" };
    try {
      lstatSync(breakGlassFile(home));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return none;
      return { ok: false, reason: `${BREAK_GLASS_FILE} could not be checked; nothing was ended` };
    }
    const cur = readBreakGlass(home, t);
    if (cur.state === "missing") return none;
    if (cur.state === "invalid" && cur.why === "a folder") {
      quiet(() => appendAuditLocked("cli", { action: "policy-break-glass-end", result: "failed", target: "unknown", detail: "invalid" }));
      return { ok: false, reason: `${BREAK_GLASS_FILE} is a folder; remove it by hand` };
    }
    if (cur.state === "invalid") return endLocked(home, "invalid", "unknown");
    return endLocked(home, cur.state === "active" ? "ended" : "expired", cur.record.expiresAt);
  };

  try {
    return withAuthLock(() => (committed = locked()), o.waitMs);
  } catch (e) {
    if (committed) return committed;
    if (e instanceof StoreError && e.kind === "locked") return { ok: false, reason: lockMessage };
    return { ok: false, reason: "the data folder could not be locked; nothing was ended" };
  }
}
