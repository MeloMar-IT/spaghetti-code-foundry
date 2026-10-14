import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { byteCmp, nameClash, SkillImportError, takeName, type Names } from "./import-plan.js";
import type { LicenceEvidence, LicenceEvidenceFile } from "./licence.js";
import { LICENCE_FILE_RE, LICENCE_LIMITS, NOTICE_FILE_RE } from "./licence-rules.js";
import { relativePathProblem, SKILL_LIMITS } from "./schema.js";
import { approvedRefProblem, hasUnsafeChar, shownValue } from "./sources.js";

// The licence evidence kept beside a staged import: licences.json and licences/<upstream path>.
// Pure and read only: this module writes nothing. publishImport writes what `prepareLicences` returns.

export const LICENCE_RECORD_FILE = "licences.json";
export const LICENCE_DIR = "licences";
/** The largest licences.json that is written or read. */
export const LICENCE_RECORD_BYTES = 262144;
const PROBLEM_CHARS = 200;
const SHA_RE = /^[0-9a-f]{64}$/;

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

export class LicenceStoreProblem extends Error {}
const refuse = (what: string): never => {
  throw new LicenceStoreProblem(what);
};

/** The bytes of a regular file, "link" for a link, "other" for anything else. Every other error is thrown. */
export function readPlain(path: string, size: number): Buffer | "link" | "other" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") return "link";
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== size) return "other";
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) return "other";
      off += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

const lastSeg = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const kindOf = (path: string): "licence" | "notice" | undefined => {
  const name = lastSeg(path);
  return LICENCE_FILE_RE.test(name) ? "licence" : NOTICE_FILE_RE.test(name) ? "notice" : undefined;
};

/** Why a path cannot be kept as a file next to the paths already taken, or undefined. Takes the name when it can. */
function storeProblem(taken: Names, path: string): string | undefined {
  if (path.includes(":")) return 'holds a ":"';
  if (path.split("/").some((s) => s.toLowerCase() === ".git")) return "holds a .git folder";
  if (Buffer.byteLength(path) > SKILL_LIMITS.pathChars) return `path is longer than ${SKILL_LIMITS.pathChars} bytes`;
  if (nameClash(taken, path)) return "collides with another path on a case-insensitive disk";
  takeName(taken, path);
  return undefined;
}

/** Pure. The text of licences.json, the bytes to write (key: path below the import folder) and the evidence as a reader returns it. */
export function prepareLicences(evidence: LicenceEvidence): { text: string; entries: Map<string, Uint8Array>; evidence: LicenceEvidence } {
  const sorted = [...evidence.files].sort((a, b) => byteCmp(a.path, b.path));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.path === sorted[i - 1]!.path) throw new SkillImportError("not-usable", "the licence evidence lists a path twice");
  }
  const taken: Names = new Map();
  const entries = new Map<string, Uint8Array>();
  const rec: LicenceRecordFile[] = [];
  const out: LicenceEvidenceFile[] = [];
  for (const f of sorted) {
    const base = { path: f.path, kind: f.kind };
    let problem = f.problem === undefined ? undefined : f.problem.slice(0, PROBLEM_CHARS);
    if (problem === undefined && f.content === undefined) problem = "cannot be read";
    if (problem === undefined && f.content !== undefined) {
      const why = storeProblem(taken, f.path);
      if (why !== undefined) problem = `cannot be kept: ${why}`;
    }
    if (problem !== undefined || f.content === undefined) {
      rec.push({ ...base, problem: problem ?? "cannot be read" });
      out.push({ ...base, dir: dirOf(f.path), problem: problem ?? "cannot be read" });
      continue;
    }
    rec.push({ ...base, bytes: f.content.byteLength, sha256: sha(f.content) });
    entries.set(`${LICENCE_DIR}/${f.path}`, f.content);
    out.push({ ...base, dir: dirOf(f.path), content: f.content });
  }
  const record: LicenceRecord = { schema: 1, repositoryKey: evidence.repositoryKey, commit: evidence.commit, files: rec };
  const text = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(text) > LICENCE_RECORD_BYTES) throw new SkillImportError("too-large", "the licence record is too large");
  entries.set(LICENCE_RECORD_FILE, Buffer.from(text, "utf8"));
  return { text, entries, evidence: { repositoryKey: evidence.repositoryKey, commit: evidence.commit, files: out } };
}

/** Pure. Checks the form of licences.json. Problems are fixed sentences and never repeat a value. */
export function parseLicenceRecord(text: string): { record: LicenceRecord } | { problem: string } {
  const bad = (p: string) => ({ problem: `${LICENCE_RECORD_FILE} ${p}` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("is not an object");
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1) return bad("has an unknown schema");
  if (typeof o.repositoryKey !== "string" || o.repositoryKey === "" || o.repositoryKey.length > 2048 || hasUnsafeChar(o.repositoryKey)) return bad("has a bad repositoryKey");
  if (typeof o.commit !== "string" || approvedRefProblem(o.commit) !== undefined) return bad("has a bad commit");
  if (!Array.isArray(o.files)) return bad("has no file list");
  if (o.files.length > LICENCE_LIMITS.files) return bad("lists too many files");
  const files: LicenceRecordFile[] = [];
  const taken: Names = new Map();
  let total = 0;
  let prev: string | undefined;
  for (const item of o.files as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return bad("has a bad file entry");
    const e = item as Record<string, unknown>;
    const path = e.path;
    if (typeof path !== "string" || relativePathProblem(path) !== undefined || hasUnsafeChar(path)) return bad("has a bad path");
    if (prev !== undefined && byteCmp(prev, path) >= 0) return bad("lists paths out of order or twice");
    prev = path;
    const kind = kindOf(path);
    if (kind === undefined || e.kind !== kind) return bad("has a kind that does not match the file name");
    const hasContent = e.bytes !== undefined || e.sha256 !== undefined;
    if (hasContent === (e.problem !== undefined)) return bad("has an entry that is neither kept nor a problem");
    if (hasContent) {
      if (typeof e.bytes !== "number" || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || e.bytes > LICENCE_LIMITS.fileBytes) return bad("has a bad size");
      if (typeof e.sha256 !== "string" || !SHA_RE.test(e.sha256)) return bad("has a bad hash");
      total += e.bytes;
      if (total > LICENCE_LIMITS.totalBytes) return bad("lists too many bytes");
      if (storeProblem(taken, path) !== undefined) return bad("lists a path that cannot be kept");
      files.push({ path, kind, bytes: e.bytes, sha256: e.sha256 });
    } else {
      if (typeof e.problem !== "string" || e.problem === "" || e.problem.length > PROBLEM_CHARS || hasUnsafeChar(e.problem)) return bad("has a bad problem text");
      files.push({ path, kind, problem: e.problem });
    }
  }
  const record: LicenceRecord = { schema: 1, repositoryKey: o.repositoryKey, commit: o.commit, files };
  if (JSON.stringify(record, null, 2) + "\n" !== text) return bad("is not in the written form");
  return { record };
}

/** Read only. Throws LicenceStoreProblem for content that does not match; file-system errors pass through. */
export function readStagedLicences(
  dir: string,
  origin: { repositoryKey: string; commit: string },
): { state: "absent" } | { state: "ok"; evidence: LicenceEvidence; entries: Map<string, Uint8Array> } {
  const recPath = join(dir, LICENCE_RECORD_FILE);
  let st;
  try {
    st = lstatSync(recPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw e;
  }
  if (st.isSymbolicLink()) return refuse(`${LICENCE_RECORD_FILE} is a link`);
  if (!st.isFile()) return refuse(`${LICENCE_RECORD_FILE} is not a regular file`);
  if (st.size > LICENCE_RECORD_BYTES) return refuse(`${LICENCE_RECORD_FILE} is too large`);
  const raw = readPlain(recPath, st.size);
  if (raw === "link") return refuse(`${LICENCE_RECORD_FILE} is a link`);
  if (raw === "other") return refuse(`${LICENCE_RECORD_FILE} changed while it was read`);
  const text = raw.toString("utf8");
  const parsed = parseLicenceRecord(text);
  if ("problem" in parsed) return refuse(parsed.problem);
  const record = parsed.record;
  if (record.repositoryKey !== origin.repositoryKey || record.commit !== origin.commit) return refuse(`${LICENCE_RECORD_FILE} is for another repository or commit`);

  const want = new Map<string, { bytes: number; sha256: string }>();
  for (const f of record.files) if (f.bytes !== undefined && f.sha256 !== undefined) want.set(f.path, { bytes: f.bytes, sha256: f.sha256 });
  const content = new Map<string, Buffer>();
  if (want.size > 0) {
    const root = join(dir, LICENCE_DIR);
    let rst;
    try {
      rst = lstatSync(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return refuse(`${LICENCE_DIR} is missing`);
      throw e;
    }
    if (rst.isSymbolicLink()) return refuse(`${LICENCE_DIR} is a link`);
    if (!rst.isDirectory()) return refuse(`${LICENCE_DIR} is not a folder`);
    let folders = 0;
    const maxFolders = [...want.keys()].reduce((n, p) => n + p.split("/").length - 1, 0);
    const walk = (path: string, rel: string): void => {
      for (const name of readdirSync(path).sort(byteCmp)) {
        const p = join(path, name);
        const r = rel === "" ? name : `${rel}/${name}`;
        const s = lstatSync(p);
        if (s.isSymbolicLink()) refuse(`${LICENCE_DIR}/${shownValue(r)} is a link`);
        if (s.isDirectory()) {
          if (++folders > maxFolders) refuse(`${LICENCE_DIR} holds more folders than the import can have`);
          walk(p, r);
        } else if (s.isFile()) {
          const w = want.get(r);
          if (w === undefined) refuse(`${LICENCE_DIR}/${shownValue(r)} is not part of the import`);
          if (s.size !== w!.bytes) refuse(`${LICENCE_DIR}/${shownValue(r)} changed`);
          const got = readPlain(p, s.size);
          if (got === "link") return refuse(`${LICENCE_DIR}/${shownValue(r)} is a link`);
          if (got === "other" || sha(got) !== w!.sha256) return refuse(`${LICENCE_DIR}/${shownValue(r)} changed`);
          content.set(r, got);
        } else refuse(`${LICENCE_DIR}/${shownValue(r)} is not a regular file`);
      }
    };
    walk(root, "");
    for (const p of want.keys()) if (!content.has(p)) refuse(`${LICENCE_DIR}/${shownValue(p)} is missing`);
  }
  const entries = new Map<string, Uint8Array>([[LICENCE_RECORD_FILE, raw]]);
  const files: LicenceEvidenceFile[] = record.files.map((f) => {
    const base = { path: f.path, dir: dirOf(f.path), kind: f.kind };
    const c = content.get(f.path);
    if (c === undefined) return { ...base, problem: f.problem ?? "cannot be read" };
    entries.set(`${LICENCE_DIR}/${f.path}`, c);
    return { ...base, content: c };
  });
  return { state: "ok", evidence: { repositoryKey: record.repositoryKey, commit: record.commit, files }, entries };
}
