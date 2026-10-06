import { basename, join } from "node:path";
import { z } from "zod";
import { StoreError, authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "./store.js";
import { UserError, getUser } from "./users.js";

export const limitsPath = () => join(dataHome(), "limits.json");

/** The limits of one account, or the defaults for all. A missing field means "no limit". */
const LimitsSchema = z
  .object({
    maxConcurrent: z.int().min(1).optional(),
    maxRunsPerDay: z.int().min(1).optional(),
    dailyBudgetUsd: z.number().positive().optional(),
  })
  .strict();

const FileSchema = z.object({ version: z.literal(1), defaults: LimitsSchema, users: z.record(z.uuid(), LimitsSchema) }).strict();

export type Limits = z.infer<typeof LimitsSchema>;
export type LimitField = keyof Limits;
/** A change: a number sets the field, null clears it, a missing field stays. */
export type LimitsPatch = { [K in LimitField]?: Limits[K] | null };
type LimitsFile = z.infer<typeof FileSchema>;

export const LIMIT_FIELDS: readonly LimitField[] = ["maxConcurrent", "maxRunsPerDay", "dailyBudgetUsd"];

const EMPTY: LimitsFile = { version: 1, defaults: {}, users: {} };
const read = (): LimitsFile => readJsonFile(limitsPath(), FileSchema, EMPTY);

/** Checks a request body: only the three known fields, each a number in range or null. Returns it as a patch. */
export function checkLimitsPatch(body: unknown): LimitsPatch {
  const bad = (m: string) => new UserError("bad-limits", m);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("the limits must be an object");
  const patch: LimitsPatch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(key)) throw bad(`unknown limit: ${key}`);
    if (value === undefined) continue;
    if (value !== null && !LimitsSchema.shape[key as LimitField].safeParse(value).success) {
      throw bad(key === "dailyBudgetUsd" ? "dailyBudgetUsd must be a number above 0, or null" : `${key} must be a whole number of 1 or more, or null`);
    }
    (patch as Record<string, unknown>)[key] = value;
  }
  return patch;
}

/** `current` with the patch applied, and the fields whose value changed. */
function apply(current: Limits, patch: LimitsPatch): { next: Limits; changed: LimitField[] } {
  const next: Limits = { ...current };
  const changed: LimitField[] = [];
  for (const k of LIMIT_FIELDS) {
    const v = patch[k];
    if (v === undefined || v === current[k] || (v === null && current[k] === undefined)) continue;
    if (v === null) delete next[k];
    else next[k] = v;
    changed.push(k);
  }
  return { next, changed };
}

/** The default limits and the overrides per account. Throws StoreError when the file cannot be used. */
export function getLimits(): { defaults: Limits; users: Record<string, Limits> } {
  const { defaults, users } = read();
  return { defaults, users };
}

/** The limits that apply to an account, and which of its fields are its own. */
export function resolveLimits(userId: string): { effective: Limits; overridden: LimitField[] } {
  const { defaults, users } = getLimits();
  const own = users[userId] ?? {};
  return { effective: { ...defaults, ...own }, overridden: LIMIT_FIELDS.filter((k) => own[k] !== undefined) };
}

let lastFailure: string | undefined;

/**
 * The limits that apply to an account: its own fields win over the defaults. Never throws: a file that cannot be used means
 * no limits, and a failure is reported once to `log` (file and kind only) until it changes or goes away.
 */
export function effectiveLimits(userId: string, log?: (msg: string) => void): Limits {
  try {
    const r = resolveLimits(userId).effective;
    lastFailure = undefined;
    return r;
  } catch (e) {
    const msg = e instanceof StoreError ? `limits: ${basename(e.file)} ${e.kind}` : "limits: unexpected error";
    const key = `${dataHome()}|${msg}`;
    if (key !== lastFailure) {
      lastFailure = key;
      try {
        log?.(msg);
      } catch {
        // the log must not make this throw
      }
    }
    return {};
  }
}

export interface LimitsChange {
  limits: { defaults: Limits; users: Record<string, Limits> };
  /** The fields that changed, in a fixed order; empty when nothing was written. */
  changed: LimitField[];
}

const save = (file: LimitsFile) => writeJsonFile(limitsPath(), file);

/** Changes the defaults for all accounts (see LimitsPatch). Nothing is written when nothing changes. The caller writes the audit line. */
export function setDefaultLimits(patch: LimitsPatch, _opts: { by: string }): LimitsChange {
  const checked = checkLimitsPatch(patch); // a caller's types are not trusted: NaN would be written as null
  return withAuthLock(() => {
    const file = read();
    const { next, changed } = apply(file.defaults, checked);
    if (!changed.length) return { limits: { defaults: file.defaults, users: file.users }, changed };
    const out = { ...file, defaults: next };
    save(out);
    return { limits: { defaults: out.defaults, users: out.users }, changed };
  });
}

/** Changes the override of one account; `null` instead of a patch clears all of its fields. An empty override is dropped. */
export function setUserLimits(id: string, patch: LimitsPatch | null, _opts: { by: string }): LimitsChange {
  const checked = patch === null ? { maxConcurrent: null, maxRunsPerDay: null, dailyBudgetUsd: null } : checkLimitsPatch(patch);
  return withAuthLock(() => {
    if (!getUser(id)) throw new UserError("not-found", "no such account");
    const file = read();
    const { next, changed } = apply(file.users[id] ?? {}, checked);
    if (!changed.length) return { limits: { defaults: file.defaults, users: file.users }, changed };
    const users = { ...file.users };
    if (Object.keys(next).length) users[id] = next;
    else delete users[id];
    save({ ...file, users });
    return { limits: { defaults: file.defaults, users }, changed };
  });
}

/** Removes the override of an account (only inside withAuthLock). Returns true when there was one; writes nothing otherwise. */
export function removeLimitsLocked(id: string): boolean {
  if (!authLockHeld()) throw new Error("removeLimitsLocked must run inside withAuthLock");
  const file = read();
  if (!(id in file.users)) return false;
  const users = { ...file.users };
  delete users[id];
  save({ ...file, users });
  return true;
}
