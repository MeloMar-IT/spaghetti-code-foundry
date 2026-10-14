import { createHash } from "node:crypto";
import { byteCmp, IMPORT_LIMITS, nameClash, SkillImportError, takeName, type Names } from "./import-plan.js";
import type { LicenceEvidence, LicenceEvidenceFile } from "./licence.js";
import { LICENCE_FILE_RE, LICENCE_LIMITS, NOTICE_FILE_RE } from "./licence-rules.js";
import { relativePathProblem, SKILL_LIMITS } from "./schema.js";
import { approvedRefProblem, hasUnsafeChar } from "./sources.js";

// The record of the licence and notice files kept next to a staged import (licence.json). Pure: no file system.
// It binds itself to import.json by repeating repositoryKey and commit; import.json itself is not changed.

export const LICENCE_RECORD_FILE = "licence.json";
export const LICENCE_DIR = "licence";
export const LICENCE_RECORD_BYTES = 262144;

export interface LicenceRecordFile {
  path: string;
  kind: "licence" | "notice";
  bytes?: number;
  sha256?: string;
  problem?: string;
}
export interface LicenceRecord {
  schema: 1;
  repositoryKey: string;
  commit: string;
  files: LicenceRecordFile[];
}
export interface PreparedLicence {
  record: LicenceRecord;
  recordText: string;
  files: Map<string, Uint8Array>;
}

const lastSeg = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const kindOf = (path: string): "licence" | "notice" | undefined => {
  const name = lastSeg(path);
  return LICENCE_FILE_RE.test(name) ? "licence" : NOTICE_FILE_RE.test(name) ? "notice" : undefined;
};
const isPlainPath = (p: string) => relativePathProblem(p) === undefined && !hasUnsafeChar(p);
/** A plain path that still cannot be stored: a ":" , a ".git" folder or file, or too long. */
const cannotStore = (p: string) => p.includes(":") || p.split("/").some((s) => s.toLowerCase() === ".git") || Buffer.byteLength(p) > SKILL_LIMITS.pathChars;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const serialise = (record: LicenceRecord) => JSON.stringify(record, null, 2) + "\n";

/** Builds the record and the bytes to write. Throws SkillImportError for evidence that is not usable at all. */
export function prepareLicenceEvidence(evidence: LicenceEvidence): PreparedLicence {
  const { repositoryKey, commit } = evidence;
  if (typeof repositoryKey !== "string" || repositoryKey.length < 1 || repositoryKey.length > 2048 || hasUnsafeChar(repositoryKey) || typeof commit !== "string" || approvedRefProblem(commit)) {
    throw new SkillImportError("not-usable", "the licence evidence is not usable: bad repository or commit");
  }
  if (evidence.files.length > LICENCE_LIMITS.files) throw new SkillImportError("too-many-entries", `the source holds more than ${LICENCE_LIMITS.files} licence or notice files`);
  for (const f of evidence.files) {
    if (typeof f.path !== "string" || !isPlainPath(f.path)) throw new SkillImportError("not-usable", "a licence file has a path that is not a plain relative path");
  }
  const sorted = [...evidence.files].sort((a, b) => byteCmp(a.path, b.path));
  const counts = new Map<string, number>();
  for (const f of sorted) counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
  const taken: Names = new Map();
  const files: LicenceRecordFile[] = [];
  const stored = new Map<string, Uint8Array>();
  let total = 0;
  const seen = new Set<string>();
  for (const f of sorted) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const kind = f.kind;
    const bad = (problem: string) => files.push({ path: f.path, kind, problem });
    if ((counts.get(f.path) ?? 0) > 1) bad("is listed twice");
    else if (f.problem !== undefined || f.content === undefined) {
      const text = f.problem ?? "cannot be read";
      bad(hasUnsafeChar(text) || text === "" ? "cannot be read" : text.slice(0, IMPORT_LIMITS.reasonChars));
    } else if (cannotStore(f.path)) bad("path cannot be stored");
    else if (f.content.byteLength > LICENCE_LIMITS.fileBytes) bad(`is larger than ${LICENCE_LIMITS.fileBytes} bytes`);
    else if (nameClash(taken, f.path) !== undefined) bad("collides with another path on a case-insensitive disk");
    else {
      takeName(taken, f.path);
      total += f.content.byteLength;
      files.push({ path: f.path, kind, bytes: f.content.byteLength, sha256: sha(f.content) });
      stored.set(f.path, f.content);
    }
  }
  if (total > LICENCE_LIMITS.totalBytes) throw new SkillImportError("too-large", `the licence and notice files hold more than ${LICENCE_LIMITS.totalBytes} bytes`);
  const record: LicenceRecord = { schema: 1, repositoryKey, commit, files };
  const recordText = serialise(record);
  if (Buffer.byteLength(recordText) > LICENCE_RECORD_BYTES) throw new SkillImportError("too-large", "the record of the licence files is too large");
  return { record, recordText, files: stored };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks the form of the text of licence.json. Problems are fixed sentences and never repeat a value. */
export function parseLicenceRecord(text: string): { record: LicenceRecord } | { problem: string } {
  const bad = (what: string) => ({ problem: `licence.json: ${what}` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "licence.json is not valid JSON" };
  }
  if (!isRec(raw)) return bad("is not an object");
  if (raw.schema !== 1) return bad("schema is not 1");
  if (!isStr(raw.repositoryKey) || raw.repositoryKey.length < 1 || raw.repositoryKey.length > 2048 || hasUnsafeChar(raw.repositoryKey)) return bad("repositoryKey is not usable");
  if (!isStr(raw.commit) || approvedRefProblem(raw.commit)) return bad("commit is not a full commit id");
  if (!Array.isArray(raw.files) || raw.files.length > LICENCE_LIMITS.files) return bad("files is not a list of at most 200 files");
  const files: LicenceRecordFile[] = [];
  const taken: Names = new Map();
  let total = 0;
  let last: string | undefined;
  for (const [i, e] of raw.files.entries()) {
    if (!isRec(e)) return bad(`files[${i}] is not an object`);
    const path = e.path;
    if (!isStr(path) || path === "." || !isPlainPath(path)) return bad(`files[${i}].path is not usable`);
    if (last !== undefined && byteCmp(last, path) >= 0) return bad(`files[${i}].path is not in order or is used twice`);
    last = path;
    const kind = kindOf(path);
    if (kind === undefined || e.kind !== kind) return bad(`files[${i}].kind does not match the file name`);
    const hasSha = e.sha256 !== undefined;
    const hasProblem = e.problem !== undefined;
    if (hasSha === hasProblem) return bad(`files[${i}] must hold either a size and digest or a problem`);
    if (hasSha) {
      const n = e.bytes;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > LICENCE_LIMITS.fileBytes) return bad(`files[${i}].bytes is not a size`);
      if (!isStr(e.sha256) || !/^[0-9a-f]{64}$/.test(e.sha256)) return bad(`files[${i}].sha256 is not a digest`);
      if (cannotStore(path)) return bad(`files[${i}].path cannot be stored`);
      if (nameClash(taken, path) !== undefined) return bad(`files[${i}].path collides with another path`);
      takeName(taken, path);
      total += n;
      files.push({ path, kind, bytes: n, sha256: e.sha256 });
    } else {
      if (e.bytes !== undefined) return bad(`files[${i}] must not hold a size with a problem`);
      if (!isStr(e.problem) || e.problem.length < 1 || e.problem.length > IMPORT_LIMITS.reasonChars || hasUnsafeChar(e.problem)) return bad(`files[${i}].problem is not usable`);
      files.push({ path, kind, problem: e.problem });
    }
  }
  if (total > LICENCE_LIMITS.totalBytes) return bad("files hold more bytes than the limit");
  const record: LicenceRecord = { schema: 1, repositoryKey: raw.repositoryKey, commit: raw.commit, files };
  if (serialise(record) !== text) return bad("is not in the form scf writes");
  return { record };
}

/** Rebuilds the evidence from the record and the stored bytes (by upstream path). */
export function evidenceFromRecord(record: LicenceRecord, files: ReadonlyMap<string, Uint8Array>): LicenceEvidence {
  const out: LicenceEvidenceFile[] = record.files.map((f) => {
    const base = { path: f.path, dir: dirOf(f.path), kind: f.kind };
    if (f.problem !== undefined) return { ...base, problem: f.problem };
    const content = files.get(f.path);
    return content === undefined ? { ...base, problem: "cannot be read" } : { ...base, content };
  });
  return { repositoryKey: record.repositoryKey, commit: record.commit, files: out };
}
