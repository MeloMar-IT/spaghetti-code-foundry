import { createHash } from "node:crypto";
import { IMPORT_LIMITS, nameClash, SkillImportError, takeName, type ImportLicenceFile, type ImportRecord, type Names, type PreparedImport, type SourceTree } from "./import-plan.js";
import { collectLicenceEvidence, type LicenceEvidence, type LicenceEvidenceFile } from "./licence.js";
import { LICENCE_FILE_RE } from "./licence-rules.js";
import { isUtcTime } from "./release.js";
import { SKILL_LIMITS } from "./schema.js";

// Adds the licence and notice files of the approved commit to a prepared import, and rebuilds the evidence from a
// staged import. Pure: no file system, no process, no clock.

const lastSeg = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Lists and reads the licence and notice files for record.paths and adds them to a prepared import. Errors of `tree` and of collectLicenceEvidence pass through. */
export function addLicenceEvidence(prep: PreparedImport, tree: SourceTree, retrievedAt: string, opts: { limits?: { recordBytes?: number } } = {}): PreparedImport {
  if (!isUtcTime(retrievedAt)) throw new SkillImportError("not-usable", "the source cannot be imported: retrievedAt is not a UTC time");
  const { record } = prep;
  const evidence = collectLicenceEvidence({ repositoryKey: record.repositoryKey, commit: record.commit }, record.paths, tree);
  const taken: Names = new Map();
  const licences = new Map<string, Uint8Array>();
  const licenceFiles: ImportLicenceFile[] = [];
  for (const f of evidence.files) {
    if (f.problem !== undefined || f.content === undefined) {
      licenceFiles.push({ path: f.path, problem: f.problem ?? "cannot be read" });
      continue;
    }
    if (f.path.includes(":") || f.path.split("/").some((s) => s.toLowerCase() === ".git") || Buffer.byteLength(f.path) > SKILL_LIMITS.pathChars || nameClash(taken, f.path)) {
      licenceFiles.push({ path: f.path, problem: "path cannot be staged" });
      continue;
    }
    takeName(taken, f.path);
    licences.set(f.path, f.content);
    licenceFiles.push({ path: f.path, sha256: createHash("sha256").update(f.content).digest("hex"), bytes: f.content.byteLength });
  }
  const next: ImportRecord = { ...record, retrievedAt, licenceFiles };
  const recordText = JSON.stringify(next, null, 2) + "\n";
  if (Buffer.byteLength(recordText) > (opts.limits?.recordBytes ?? IMPORT_LIMITS.recordBytes)) throw new SkillImportError("too-large", "the import record is too large");
  return { record: next, recordText, files: prep.files, licences };
}

/** The evidence the importer saw, rebuilt from the record and the staged bytes. A record without licenceFiles gives no files. */
export function stagedLicenceEvidence(record: ImportRecord, licences: ReadonlyMap<string, Uint8Array>): LicenceEvidence {
  const files: LicenceEvidenceFile[] = (record.licenceFiles ?? []).map((e) => {
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : ".";
    const kind = LICENCE_FILE_RE.test(lastSeg(e.path)) ? "licence" : "notice";
    if (e.problem !== undefined) return { path: e.path, dir, kind, problem: e.problem };
    const content = licences.get(e.path);
    return content === undefined ? { path: e.path, dir, kind, problem: "cannot be read" } : { path: e.path, dir, kind, content };
  });
  return { repositoryKey: record.repositoryKey, commit: record.commit, files };
}
