import { createHash } from "node:crypto";
import { collectLicenceEvidence, type LicenceEvidence, type LicenceEvidenceFile } from "./licence.js";
import { LICENCE_LIMITS } from "./licence-rules.js";
import { byteCmp, IMPORT_LIMITS, importRecordText, parseImportRecord, SkillImportError, type ImportEvidenceEntry, type ImportRecord, type PreparedImport, type SourceTree, type TreeEntry } from "./import-plan.js";
import { hasUnsafeChar, shownValue } from "./sources.js";

// Licence evidence of an import: collecting it, adding it to a prepared import and proving staged bytes against the
// record. Pure: no file system, no process. Skill digests and the import digest never include it.

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const UNREADABLE = "cannot be read";

/**
 * collectLicenceEvidence for an import: a licence or notice file whose read fails with a recoverable error is kept as a
 * problem ("cannot be read") instead of failing the import. Listing errors and all other errors pass through.
 */
export function collectImportEvidence(
  origin: { repositoryKey: string; commit: string },
  roots: readonly string[],
  tree: SourceTree,
  opts: { recoverable?: (e: unknown) => boolean } = {},
): LicenceEvidence {
  const failed = new Set<string>();
  const recoverable = (e: unknown) => opts.recoverable?.(e) === true;
  const read = (entries: readonly TreeEntry[]): Uint8Array[] => {
    try {
      return tree.read(entries);
    } catch (e) {
      if (!recoverable(e)) throw e;
    }
    return entries.map((entry) => {
      try {
        const got = tree.read([entry]);
        return Array.isArray(got) && got.length === 1 ? got[0]! : (undefined as unknown as Uint8Array);
      } catch (e) {
        if (!recoverable(e)) throw e;
        failed.add(entry.path);
        return undefined as unknown as Uint8Array;
      }
    });
  };
  const evidence = collectLicenceEvidence(origin, roots, { list: (p) => tree.list(p), read });
  for (const f of evidence.files) {
    if (!failed.has(f.path)) continue;
    f.problem = UNREADABLE;
    delete f.content;
  }
  return evidence;
}

/** Adds the evidence to a prepared import: record.evidence, a new recordText, and the blobs by sha256. Skill and import digests do not change. */
export function attachLicenceEvidence(prep: PreparedImport, evidence: LicenceEvidence, opts: { limits?: { recordBytes?: number } } = {}): PreparedImport {
  const { record } = prep;
  if (evidence.repositoryKey !== record.repositoryKey || evidence.commit !== record.commit) {
    throw new SkillImportError("not-usable", "the licence evidence is for another repository or commit");
  }
  if (evidence.files.length > LICENCE_LIMITS.files) throw new SkillImportError("too-many-entries", `the source holds more than ${LICENCE_LIMITS.files} licence or notice files`);
  const files = [...evidence.files].sort((a, b) => byteCmp(a.path, b.path));
  for (let i = 1; i < files.length; i++) if (files[i - 1]!.path === files[i]!.path) throw new SkillImportError("not-usable", "a licence or notice file is listed twice");
  if (files.reduce((n, f) => n + (f.content?.byteLength ?? 0), 0) > LICENCE_LIMITS.totalBytes) {
    throw new SkillImportError("too-large", `the licence and notice files hold more than ${LICENCE_LIMITS.totalBytes} bytes`);
  }
  const blobs = new Map<string, Uint8Array>();
  const entries: ImportEvidenceEntry[] = files.map((f: LicenceEvidenceFile) => {
    if (f.content !== undefined && f.content.byteLength <= LICENCE_LIMITS.fileBytes) {
      const hash = sha(f.content);
      blobs.set(hash, f.content);
      return { path: f.path, kind: f.kind, sha256: hash, bytes: f.content.byteLength };
    }
    let problem = f.problem ?? UNREADABLE;
    if (f.content !== undefined) problem = `is larger than ${LICENCE_LIMITS.fileBytes} bytes`;
    if (problem.length < 1 || problem.length > IMPORT_LIMITS.reasonChars || hasUnsafeChar(problem)) problem = UNREADABLE;
    return { path: f.path, kind: f.kind, problem };
  });
  const next: ImportRecord = { ...record, evidence: entries };
  const recordText = importRecordText(next);
  if (Buffer.byteLength(recordText) > (opts.limits?.recordBytes ?? IMPORT_LIMITS.recordBytes)) throw new SkillImportError("too-large", "the import record is too large");
  if ("problem" in parseImportRecord(recordText)) throw new SkillImportError("not-usable", "the import record is not usable");
  return { record: next, recordText, files: prep.files, evidence: blobs };
}

/** Proves the blobs are exactly what record.evidence lists (both ways, size and sha256) and builds the LicenceEvidence. */
export function stagedLicenceEvidence(record: ImportRecord, blobs: ReadonlyMap<string, Uint8Array>): { evidence: LicenceEvidence } | { problem: string } {
  if (record.evidence === undefined) return { problem: "import.json lists no licence evidence" };
  const listed = new Set<string>();
  const out: LicenceEvidenceFile[] = [];
  for (const e of record.evidence) {
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ".";
    if (e.sha256 === undefined) {
      out.push({ path: e.path, dir, kind: e.kind, problem: e.problem ?? UNREADABLE });
      continue;
    }
    const name = shownValue("evidence/" + e.sha256);
    const b = blobs.get(e.sha256);
    if (b === undefined) return { problem: `${name} is missing` };
    if (b.byteLength !== e.bytes || sha(b) !== e.sha256) return { problem: `${name} changed` };
    listed.add(e.sha256);
    out.push({ path: e.path, dir, kind: e.kind, content: b });
  }
  for (const k of blobs.keys()) if (!listed.has(k)) return { problem: `${shownValue("evidence/" + k)} is not part of the import` };
  return { evidence: { repositoryKey: record.repositoryKey, commit: record.commit, files: out } };
}
