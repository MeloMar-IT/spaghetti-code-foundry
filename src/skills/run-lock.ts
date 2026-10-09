import { createHash } from "node:crypto";
import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRegular } from "./package.js";
import { SkillSelectError, selectSkill, type SkillRegistry } from "./registry.js";
import { SkillRequestItemSchema, type SkillRequest } from "./request.js";
import { RESOLVE_RANGE, RESOLVE_REASONS } from "./resolve-rules.js";
import type { SkillResolution } from "./resolve.js";
import { SKILL_DIGEST_RE, SKILL_ROLES, SkillIdSchema, SkillVersionSchema } from "./schema.js";

// The skill lock of a run: the exact skills (id, version, digest) the run's plan was resolved to, kept in the run
// folder so a resumed run uses the same approved bytes. Pure apart from the read and the write of one file.
// It holds no credentials, no host paths and no issue text: free text is projected to a safe form (see safeText).

export const RUN_SKILL_LOCK_FILE = "skill-lock.json";
export const RUN_SKILL_LOCK_VERSION = 1;
export const MAX_RUN_SKILL_LOCK_BYTES = 256 * 1024;

/** A path (Unix, home, Windows, UNC, URL) or a secret-looking text. Such text never goes into the lock. */
const HOST_PATH = /(^|[\s"'(=:,;[])(\/|~|\\\\|[A-Za-z]:[\\/])\S|\\\w|:\/\//;
const SECRET = /(gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|AIza)[\w-]{6,}|-----BEGIN|bearer\s+\S|(token|secret|passw(or)?d|api[_-]?key|authorization|credential)s?\s*[:=]|[A-Za-z0-9+/_=-]{32,}/i;

/** True when a text may be stored: no host path, no secret. Fail closed: a doubtful text is not safe. */
export function safeText(t: string): boolean {
  return !HOST_PATH.test(t) && !SECRET.test(t);
}

const ISSUE_REF = /^issue:(#?\d{1,9}|omitted)$/;
/** Evidence as stored: `issue:` only as a number (the text of an issue is never kept); the other kinds when they are safe. */
export function safeEvidence(e: string): boolean {
  if (e.startsWith("issue:")) return ISSUE_REF.test(e);
  return safeText(e);
}
export function projectEvidence(e: string): string {
  if (safeEvidence(e)) return e;
  return e.startsWith("catalogue:") ? "catalogue:omitted" : e.startsWith("path:") ? "path:omitted" : "issue:omitted";
}

const reason = SkillRequestItemSchema.shape.reason.refine(safeText, "is not safe to store");
const evidence = z.array(SkillRequestItemSchema.shape.evidence.element.refine(safeEvidence, "is not safe to store")).min(1).max(5);
const digest = z.string().regex(SKILL_DIGEST_RE);

export const RunSkillLockEntrySchema = z
  .object({
    id: SkillIdSchema,
    version: SkillVersionSchema,
    digest,
    /** The kind only, never a label or a path. */
    source: z.enum(["admin", "builtin"]),
    role: z.enum(SKILL_ROLES),
    selection: z.enum(RESOLVE_REASONS),
    /** The planner's sentence; absent for mandatory skills and dependencies, or when it was not safe to store. */
    reason: reason.optional(),
    evidence: evidence.optional(),
    requiredBy: z.array(SkillIdSchema).max(RESOLVE_RANGE.maxSkills[1]),
    estimatedTokens: z.number().int().min(0),
  })
  .strict();

export const RunSkillLockSchema = z
  .object({
    version: z.literal(RUN_SKILL_LOCK_VERSION),
    runId: z.string().regex(/^[\w-]+$/),
    createdAt: z.string().max(64),
    planHash: digest,
    /** The commit of the workspace when the lock was made; absent when it could not be read. */
    commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    estimatedTokens: z.number().int().min(0),
    /** Load order. */
    skills: z.array(RunSkillLockEntrySchema).max(RESOLVE_RANGE.maxSkills[1]),
  })
  .strict();
export type RunSkillLock = z.infer<typeof RunSkillLockSchema>;
export type RunSkillLockEntry = z.infer<typeof RunSkillLockEntrySchema>;

/** What run.json keeps. */
export interface RunSkillLockSummary {
  version: 1;
  lockDigest: string;
  planHash: string;
  createdAt: string;
  estimatedTokens: number;
  commit?: string;
  skills: { id: string; version: string; digest: string; selection: "mandatory" | "requested" | "dependency" }[];
}

export const sha256Of = (bytes: string | Uint8Array): string => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export const planHashOf = (gateOutput: string): string => sha256Of(gateOutput);

export function buildRunSkillLock(i: {
  runId: string;
  resolution: SkillResolution;
  request: SkillRequest;
  sourceOf: (id: string, version: string) => "admin" | "builtin";
  planHash: string;
  commit?: string;
  now?: Date;
}): RunSkillLock {
  const items = new Map(i.request.skills.map((s) => [s.id, s]));
  return RunSkillLockSchema.parse({
    version: RUN_SKILL_LOCK_VERSION,
    runId: i.runId,
    createdAt: (i.now ?? new Date()).toISOString(),
    planHash: i.planHash,
    ...(i.commit && /^[0-9a-f]{40,64}$/.test(i.commit) ? { commit: i.commit } : {}),
    estimatedTokens: i.resolution.estimatedTokens,
    skills: i.resolution.selected.map((s) => {
      const item = items.get(s.id);
      const ev = item ? [...new Set(item.evidence.map(projectEvidence))] : [];
      return {
        id: s.id,
        version: s.version,
        digest: s.digest,
        source: i.sourceOf(s.id, s.version),
        role: i.resolution.role,
        selection: s.reason,
        ...(item && safeText(item.reason) ? { reason: item.reason } : {}),
        ...(ev.length ? { evidence: ev } : {}),
        requiredBy: s.requiredBy,
        estimatedTokens: s.estimatedTokens,
      };
    }),
  });
}

export const serializeRunSkillLock = (lock: RunSkillLock): string => JSON.stringify(lock, null, 2) + "\n";

/** Atomic (tmp + rename), mode 0600. Throws over the byte limit or on a write error. */
export function writeRunSkillLock(runDir: string, lock: RunSkillLock): { lockDigest: string } {
  const text = serializeRunSkillLock(lock);
  if (Buffer.byteLength(text) > MAX_RUN_SKILL_LOCK_BYTES) throw new Error("the skill lock is too large");
  const file = join(runDir, RUN_SKILL_LOCK_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { lockDigest: sha256Of(text) };
}

export type RunSkillLockRead = { ok: true; lock: RunSkillLock; lockDigest: string } | { ok: false; reason: "missing" | "unreadable" | "invalid" };

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readRunSkillLock(runDir: string): RunSkillLockRead {
  const file = join(runDir, RUN_SKILL_LOCK_FILE);
  const bytes = readRegular(file, MAX_RUN_SKILL_LOCK_BYTES);
  if (typeof bytes === "string") {
    // "other" covers a missing file as well as a directory or a device
    return { ok: false, reason: bytes === "other" && !lexists(file) ? "missing" : "unreadable" };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = RunSkillLockSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return { ok: true, lock: parsed.data, lockDigest: sha256Of(bytes) };
}

export function runSkillLockSummary(lock: RunSkillLock, lockDigest: string): RunSkillLockSummary {
  return {
    version: 1,
    lockDigest,
    planHash: lock.planHash,
    createdAt: lock.createdAt,
    estimatedTokens: lock.estimatedTokens,
    ...(lock.commit ? { commit: lock.commit } : {}),
    skills: lock.skills.map((s) => ({ id: s.id, version: s.version, digest: s.digest, selection: s.selection })),
  };
}

export type RunSkillLockProblem = {
  key: string;
  code: "missing" | "changed" | "unpinned" | "unverified" | "unapproved";
  expected: string;
  actual?: string;
};

/** Every locked skill must still be there at exactly its version, approved, pinned, with its digest. Never looks at the active default. */
export function verifyRunSkillLock(lock: RunSkillLock, reg: Pick<SkillRegistry, "byKey" | "problems">): RunSkillLockProblem[] {
  const out: RunSkillLockProblem[] = [];
  for (const e of lock.skills) {
    const key = `${e.id}@${e.version}`;
    try {
      const s = selectSkill(reg, e.id, e.version);
      if (s.digest !== e.digest) out.push({ key, code: "changed", expected: e.digest, actual: s.digest });
    } catch (err) {
      const code = err instanceof SkillSelectError ? err.code : "unknown";
      const actual = reg.byKey.get(key)?.digest;
      out.push({
        key,
        code: code === "unknown" ? "missing" : code === "mismatch" ? "changed" : code === "unpinned" ? "unpinned" : code === "unapproved" ? "unapproved" : "unverified",
        expected: e.digest,
        ...(actual ? { actual } : {}),
      });
    }
  }
  return out;
}

export function integrityReason(p: RunSkillLockProblem): string {
  const p0 = "skill integrity: ";
  switch (p.code) {
    case "changed":
      return `${p0}${p.key} changed since this run locked it (locked ${p.expected}, now ${p.actual ?? "unknown"})`;
    case "missing":
      return `${p0}${p.key} is missing; this run locked it (${p.expected})`;
    case "unpinned":
      return `${p0}${p.key} is no longer pinned`;
    case "unapproved":
      return `${p0}${p.key} now comes from the repository and is not approved`;
    default:
      return `${p0}${p.key} cannot be verified: the skill lock of the installation cannot be read`;
  }
}
