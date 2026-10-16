import { createHash } from "node:crypto";
import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { effectiveLifecycle, lifecycleReasonProblem, type EffectiveLifecycle } from "./lifecycle.js";
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
/** Version 2 locks hold the category of each skill; a lock without any category is still written as version 1. Both are read. */
export const RUN_SKILL_LOCK_VERSION = 2;
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
    source: z.enum(["admin", "builtin", "catalogue"]),
    role: z.enum(SKILL_ROLES),
    selection: z.enum(RESOLVE_REASONS),
    /** The category of the package when it was locked (version 2). */
    category: z.string().min(1).max(64).optional(),
    /** The planner's sentence; absent for mandatory skills and dependencies, or when it was not safe to store. */
    reason: reason.optional(),
    evidence: evidence.optional(),
    requiredBy: z.array(SkillIdSchema).max(RESOLVE_RANGE.maxSkills[1]),
    estimatedTokens: z.number().int().min(0),
  })
  .strict();

export const RunSkillLockSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(RUN_SKILL_LOCK_VERSION)]),
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
  sourceOf: (id: string, version: string) => RunSkillLockEntry["source"];
  /** The category of a locked package; when no skill has one the lock is written as version 1. */
  categoryOf?: (id: string, version: string) => string | undefined;
  planHash: string;
  commit?: string;
  now?: Date;
}): RunSkillLock {
  const items = new Map(i.request.skills.map((s) => [s.id, s]));
  const categories = i.resolution.selected.map((s) => {
    const c = i.categoryOf?.(s.id, s.version);
    return typeof c === "string" && c ? c : undefined;
  });
  return RunSkillLockSchema.parse({
    version: categories.some((c) => c !== undefined) ? RUN_SKILL_LOCK_VERSION : 1,
    runId: i.runId,
    createdAt: (i.now ?? new Date()).toISOString(),
    planHash: i.planHash,
    ...(i.commit && /^[0-9a-f]{40,64}$/.test(i.commit) ? { commit: i.commit } : {}),
    estimatedTokens: i.resolution.estimatedTokens,
    skills: i.resolution.selected.map((s, n) => {
      const item = items.get(s.id);
      const ev = item ? [...new Set(item.evidence.map(projectEvidence))] : [];
      return {
        id: s.id,
        version: s.version,
        digest: s.digest,
        source: i.sourceOf(s.id, s.version),
        role: i.resolution.role,
        selection: s.reason,
        ...(categories[n] ? { category: categories[n] } : {}),
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
  code: "missing" | "changed" | "unpinned" | "unverified" | "unapproved" | "quarantined" | "revoked" | "lifecycle";
  expected: string;
  actual?: string;
  /** `<catalogue>@<version>` of the release that revokes the key. */
  release?: string;
  replacement?: string;
  runId?: string;
};

type LockReg = Pick<SkillRegistry, "byKey" | "problems" | "lifecycle" | "revoked">;

/**
 * Every locked skill must still be there at exactly its version, approved, pinned, with its digest. Never looks at the active default.
 * Then the lifecycle: a revoked version always stops the run, a quarantined one stops it unless this run is allowed.
 * A lifecycle problem of the registry comes first, before every other problem.
 */
export function verifyRunSkillLock(lock: RunSkillLock, reg: LockReg): RunSkillLockProblem[] {
  const out: RunSkillLockProblem[] = [];
  const lifeBad = reg.problems.some((p) => p.kind === "lifecycle");
  // One problem per locked key, all before the others: no skill counts as verified when its lifecycle cannot be checked.
  if (lifeBad) for (const e of lock.skills) out.push({ key: `${e.id}@${e.version}`, code: "lifecycle", expected: e.digest });
  for (const e of lock.skills) {
    const key = `${e.id}@${e.version}`;
    const replacement = reg.lifecycle?.get(key)?.replacement;
    const rel = reg.revoked?.get(key);
    // A key revoked by a release is not in byKey: say so instead of "missing".
    if (rel) {
      out.push({ key, code: "revoked", expected: e.digest, release: rel.by, ...(replacement ? { replacement } : {}) });
      continue;
    }
    try {
      const s = selectSkill(reg, e.id, e.version);
      if (s.digest !== e.digest) {
        out.push({ key, code: "changed", expected: e.digest, actual: s.digest });
        continue;
      }
      if (lifeBad) continue;
      const life = effectiveLifecycle(reg, key);
      if (life?.state === "revoked") out.push({ key, code: "revoked", expected: e.digest, ...(life.replacement ? { replacement: life.replacement } : {}) });
      else if (life?.state === "quarantined" && !life.allowedRuns.some((a) => a.runId === lock.runId)) {
        out.push({ key, code: "quarantined", expected: e.digest, runId: lock.runId, ...(life.replacement ? { replacement: life.replacement } : {}) });
      }
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

/** Locked keys with a non-active lifecycle that does not stop this run. */
function goingOn(lock: RunSkillLock, reg: LockReg): { key: string; life: EffectiveLifecycle }[] {
  const list: { key: string; life: EffectiveLifecycle }[] = [];
  if (reg.problems.some((p) => p.kind === "lifecycle")) return list;
  for (const e of lock.skills) {
    const key = `${e.id}@${e.version}`;
    const life = effectiveLifecycle(reg, key);
    if (!life || life.state === "revoked") continue;
    if (life.state === "quarantined" && !life.allowedRuns.some((a) => a.runId === lock.runId)) continue;
    list.push({ key, life });
  }
  return list;
}

/** Lines for the run log about locked skills that go on although their lifecycle is not active. Validated fields only. */
export function runSkillLockNotes(lock: RunSkillLock, reg: LockReg): string[] {
  return goingOn(lock, reg).map(({ key, life }) => {
    if (life.state === "quarantined") {
      const a = life.allowedRuns.find((x) => x.runId === lock.runId)!;
      return `skill lifecycle: ${key} is quarantined; this run is allowed (#${a.seq} by ${a.by})`;
    }
    return `skill lifecycle: ${key} is ${life.state}${life.replacement ? ` (replaced by ${life.replacement})` : ""}; this run goes on with it`;
  });
}

/** Lines for the run log only, with the reason text of the administrator or the release. Never put these into a stop reason. */
export function runSkillLockReasons(lock: RunSkillLock, reg: LockReg): string[] {
  const out: string[] = [];
  for (const e of lock.skills) {
    const key = `${e.id}@${e.version}`;
    const life = effectiveLifecycle(reg, key);
    if (life) out.push(`skill lifecycle: ${key} ${life.state}: ${lifecycleReasonProblem(life.reason) === undefined ? life.reason : "(reason not shown)"}`);
  }
  return out;
}

export function integrityReason(p: RunSkillLockProblem): string {
  const p0 = "skill integrity: ";
  const repl = p.replacement ? ` (replaced by ${p.replacement})` : "";
  switch (p.code) {
    case "revoked":
      return `${p0}${p.key} is revoked${p.release ? ` by release ${p.release}` : ""}${repl}. A revoked skill is not loaded again: plan the issue again to lock other skills.`;
    case "quarantined":
      return `${p0}${p.key} is quarantined${repl}. An administrator may let this run go on with "scf skills allow-run ${p.runId ?? "<run-id>"} ${p.key} --reason …" and resume it; or plan the issue again.`;
    case "lifecycle":
      return `${p0}${p.key} cannot be verified: the skill lifecycle record cannot be read`;
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
