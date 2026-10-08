import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataHome, replaceFileLocked, withAuthLock } from "../auth/store.js";
import { readRegular } from "./package.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE, SKILL_VERSION_RE } from "./schema.js";

export const SKILL_LOCK_FILE = "skills.lock.json";
/** The most a lock file may hold, for reading and writing. */
export const MAX_SKILL_LOCK_BYTES = 1024 * 1024;

export interface SkillPin {
  digest: string;
  pinnedAt: string;
}
export type SkillLockRead = { ok: true; pins: Record<string, SkillPin> } | { ok: false; reason: string };

export type SkillLockErrorCode = "bad-input" | "unreadable" | "too-large";
/** A problem with the lock or with what the caller asked for. The message never holds a path. */
export class SkillLockError extends Error {
  constructor(
    public code: SkillLockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillLockError";
  }
}

export const skillLockPath = (home = dataHome()) => join(home, SKILL_LOCK_FILE);

/** `id@version` split into its parts, or undefined when it is not a valid skill key. */
export function parseSkillKey(key: string): { id: string; version: string } | undefined {
  const at = key.indexOf("@");
  if (at < 0) return undefined;
  const id = key.slice(0, at);
  const version = key.slice(at + 1);
  return SKILL_ID_RE.test(id) && SKILL_VERSION_RE.test(version) ? { id, version } : undefined;
}

const KeySchema = z.string().refine((k) => parseSkillKey(k) !== undefined, "not a skill key");
const LockSchema = z
  .object({
    version: z.literal(1),
    pins: z.record(KeySchema, z.object({ digest: z.string().regex(SKILL_DIGEST_RE), pinnedAt: z.string().max(64) }).strict()),
  })
  .strict();

/** Reads the lock. A missing file is an empty lock; anything else wrong is `ok: false` with a reason that has no path. */
export function readSkillLock(home = dataHome(), maxBytes = MAX_SKILL_LOCK_BYTES): SkillLockRead {
  const file = skillLockPath(home);
  try {
    lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, pins: {} };
    return { ok: false, reason: `cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const bytes = readRegular(file, maxBytes);
  if (typeof bytes === "string") {
    return { ok: false, reason: bytes === "large" ? `is larger than ${maxBytes} bytes` : bytes === "link" ? "is a symbolic link" : "is not a readable regular file" };
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
  const r = LockSchema.safeParse(data);
  // Never repeat anything from the file (a key can hold a path or a newline).
  if (!r.success) return { ok: false, reason: "has the wrong format" };
  return { ok: true, pins: r.data.pins };
}

export interface AddPinsOptions {
  /** Overwrite a pin that has another digest. */
  replace?: boolean;
  now?: Date;
  waitMs?: number;
  maxBytes?: number;
}
export interface AddPinsOutcome {
  added: string[];
  unchanged: string[];
  kept: string[];
  replaced: string[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function serialize(pins: Record<string, SkillPin>): string {
  const sorted = Object.fromEntries(Object.keys(pins).sort(cmp).map((k) => [k, pins[k]!]));
  return JSON.stringify({ version: 1, pins: sorted }, null, 2) + "\n";
}

function readLocked(): Record<string, SkillPin> {
  const r = readSkillLock();
  if (!r.ok) throw new SkillLockError("unreadable", `the skill lock ${r.reason}`);
  return r.pins;
}

function write(pins: Record<string, SkillPin>, maxBytes: number): void {
  const bytes = Buffer.from(serialize(pins));
  if (bytes.length > maxBytes) throw new SkillLockError("too-large", `the skill lock would be larger than ${maxBytes} bytes`);
  replaceFileLocked(skillLockPath(), (w) => w(bytes));
}

/**
 * Adds pins under the data-folder lock. A pin with the same digest is left as it is (no rewrite, same `pinnedAt`);
 * one with another digest is kept unless `replace` is set. The input is checked before the lock and the read.
 */
export function addSkillPins(pins: readonly { key: string; digest: string }[], opts: AddPinsOptions = {}): AddPinsOutcome {
  const out: AddPinsOutcome = { added: [], unchanged: [], kept: [], replaced: [] };
  const seen = new Set<string>();
  for (const p of pins) {
    if (!parseSkillKey(p.key)) throw new SkillLockError("bad-input", "not a skill key (expected id@version)");
    if (!SKILL_DIGEST_RE.test(p.digest)) throw new SkillLockError("bad-input", "not a skill digest (expected sha256: and 64 hex digits)");
    if (seen.has(p.key)) throw new SkillLockError("bad-input", `${p.key} is given twice`);
    seen.add(p.key);
  }
  if (!pins.length) return out;
  const pinnedAt = (opts.now ?? new Date()).toISOString();
  return withAuthLock(() => {
    const have = readLocked();
    const next = { ...have };
    for (const { key, digest } of pins) {
      const old = have[key];
      if (!old) {
        next[key] = { digest, pinnedAt };
        out.added.push(key);
      } else if (old.digest === digest) out.unchanged.push(key);
      else if (opts.replace) {
        next[key] = { digest, pinnedAt };
        out.replaced.push(key);
      } else out.kept.push(key);
    }
    if (out.added.length || out.replaced.length) write(next, opts.maxBytes ?? MAX_SKILL_LOCK_BYTES);
    return out;
  }, opts.waitMs);
}

/** Removes a pin. True when there was one. */
export function removeSkillPin(key: string, opts: { waitMs?: number; maxBytes?: number } = {}): boolean {
  if (!parseSkillKey(key)) throw new SkillLockError("bad-input", "not a skill key (expected id@version)");
  return withAuthLock(() => {
    const have = readLocked();
    if (!have[key]) return false;
    const { [key]: _gone, ...rest } = have;
    write(rest, opts.maxBytes ?? MAX_SKILL_LOCK_BYTES);
    return true;
  }, opts.waitMs);
}
