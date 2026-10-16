import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StoreError, dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import { acquireLock, releaseLock } from "../home-migrate.js";
import { readRegular } from "./package.js";
import { SKILL_ID_RE } from "./schema.js";
import type { SourceCadence } from "./sources.js";

// When each skill source was last checked by `scf skills update --due`, and how it ended: <data folder>/skill-update-checks.json
// (schema 1). Pure rules (`isDue`, `nextCheck`) and a small store: read never throws, write is atomic and under a lock.

export const UPDATE_CHECKS_FILE = "skill-update-checks.json";
const LOCK_NAME = "skill-update-checks.lock";
const MAX_BYTES = 65_536;
const MAX_ENTRIES = 1000;
const DAY_MS = 86_400_000;

export const UPDATE_CHECK_OUTCOMES = ["UNCHANGED", "OPEN", "UPDATED", "OK", "PROBLEM"] as const;
export type UpdateCheckOutcome = (typeof UPDATE_CHECK_OUTCOMES)[number];

export const CADENCE_DAYS = { daily: 1, weekly: 7, monthly: 30 } as const;

/** Test hook: how long a write waits for the lock. */
export const updateChecksSettings = { waitMs: 2000 };

export interface UpdateCheck {
  checkedAt: string;
  outcome: UpdateCheckOutcome;
  /** The time of the last outcome that was not PROBLEM. */
  succeededAt?: string;
}

export type UpdateChecksRead = { state: "none" } | { state: "ok"; checks: Record<string, UpdateCheck> } | { state: "unreadable"; reason: string };

const Time = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "not a time");
const CheckSchema = z.object({ checkedAt: Time, outcome: z.enum(UPDATE_CHECK_OUTCOMES), succeededAt: Time.optional() }).strict();
const FileSchema = z
  .object({
    schema: z.literal(1),
    sources: z.record(z.string().regex(SKILL_ID_RE), CheckSchema).refine((r) => Object.keys(r).length <= MAX_ENTRIES, "too many entries"),
  })
  .strict();

/** Due: never checked, last outcome PROBLEM (retry soon), or the cadence has passed (at least 1, 7 or 30 days). `manual` is never due. */
export function isDue(cadence: SourceCadence, last: UpdateCheck | undefined, now: Date): boolean {
  if (cadence === "manual") return false;
  if (last === undefined || last.outcome === "PROBLEM") return true;
  const at = Date.parse(last.checkedAt);
  if (Number.isNaN(at) || at > now.getTime()) return true;
  return now.getTime() - at >= CADENCE_DAYS[cadence] * DAY_MS;
}

/** The record after a check that ended with `outcome` at `at`. */
export function nextCheck(prev: UpdateCheck | undefined, outcome: UpdateCheckOutcome, at: Date): UpdateCheck {
  const checkedAt = at.toISOString();
  const succeededAt = outcome === "PROBLEM" ? prev?.succeededAt : checkedAt;
  return { checkedAt, outcome, ...(succeededAt !== undefined ? { succeededAt } : {}) };
}

export const updateChecksPath = (home: string = dataHome()): string => join(home, UPDATE_CHECKS_FILE);

export function readUpdateChecks(opts: { home?: string } = {}): UpdateChecksRead {
  const path = updateChecksPath(opts.home);
  try {
    lstatSync(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "unreadable", reason: "cannot be read" };
  }
  let bytes: ReturnType<typeof readRegular>;
  try {
    bytes = readRegular(path, MAX_BYTES);
  } catch {
    return { state: "unreadable", reason: "cannot be read" };
  }
  if (bytes === "link") return { state: "unreadable", reason: "is a symbolic link" };
  if (bytes === "other") return { state: "unreadable", reason: "is not a regular file" };
  if (bytes === "large") return { state: "unreadable", reason: `is larger than ${MAX_BYTES} bytes` };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { state: "unreadable", reason: "is not valid JSON" };
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) return { state: "unreadable", reason: "has the wrong format" };
  return { state: "ok", checks: parsed.data.sources };
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(text, "utf8");
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}

function withLock(home: string, fn: () => void): void {
  const waitMs = updateChecksSettings.waitMs;
  const lock = join(home, LOCK_NAME);
  const until = Date.now() + waitMs;
  claimHomeWrite(
    lock,
    () => {
      try {
        mkdirSync(home, { recursive: true, mode: 0o700 });
      } catch (e) {
        throw new StoreError("cannot-write", home, `cannot be created (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      let got: boolean;
      try {
        got = acquireLock(lock, Math.max(0, until - Date.now()));
      } catch (e) {
        throw new StoreError("cannot-write", lock, `cannot be locked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      if (!got) throw new StoreError("locked", lock, "is held by another scf process; try again, or delete this folder if no scf is running");
      try {
        fn();
      } finally {
        releaseLock(lock);
      }
    },
    waitMs,
    (kind, detail) =>
      kind === "busy"
        ? new StoreError("locked", detail, "is held by another scf process; try again in a moment")
        : new StoreError("cannot-write", home, `cannot be changed: the data folder moved to ${detail}; restart scf`),
  );
}

/**
 * Records the end of the check of source `id`. Reads the file again under the lock (an unreadable file counts as empty), sets the
 * entry, drops ids that are not in `keep` and writes atomically. Throws StoreError.
 */
export function recordUpdateCheck(id: string, outcome: UpdateCheckOutcome, at: Date, opts: { home?: string; keep?: ReadonlySet<string> } = {}): void {
  const home = opts.home ?? dataHome();
  withLock(home, () => {
    const read = readUpdateChecks({ home });
    const checks: Record<string, UpdateCheck> = read.state === "ok" ? { ...read.checks } : {};
    checks[id] = nextCheck(checks[id], outcome, at);
    if (opts.keep) for (const k of Object.keys(checks)) if (!opts.keep.has(k)) delete checks[k];
    try {
      writeAtomic(updateChecksPath(home), JSON.stringify({ schema: 1, sources: checks }, null, 2) + "\n");
    } catch (e) {
      throw new StoreError("cannot-write", updateChecksPath(home), `cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  });
}
