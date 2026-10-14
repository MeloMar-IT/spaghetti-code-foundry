import type { LicenceRecord, PreparedLicence } from "./import-licence.js";
import { IMPORT_LIMITS, SkillImportError, type ImportLicenceFile, type ImportRecord, type PreparedImport } from "./import-plan.js";
import { isUtcTime } from "./release.js";

// Lists the licence and notice files of the approved commit in import.json and records when it was fetched. The bytes
// are staged by import-licence.ts (licence.json and licence/); this lists the same files, so the record says what the
// importer saw. Pure: no file system, no process, no clock.

/** The files of licence.json in the form import.json lists them. */
export function importLicenceFiles(record: LicenceRecord): ImportLicenceFile[] {
  return record.files.map((f) => (f.problem !== undefined ? { path: f.path, problem: f.problem } : { path: f.path, sha256: f.sha256!, bytes: f.bytes! }));
}

/** Adds `retrievedAt` and `licenceFiles` to a prepared import and carries the licence evidence to publishImport. */
export function addLicenceEvidence(prep: PreparedImport, licence: PreparedLicence, retrievedAt: string, opts: { limits?: { recordBytes?: number } } = {}): PreparedImport {
  if (!isUtcTime(retrievedAt)) throw new SkillImportError("not-usable", "the source cannot be imported: retrievedAt is not a UTC time");
  const next: ImportRecord = { ...prep.record, retrievedAt, licenceFiles: importLicenceFiles(licence.record) };
  const recordText = JSON.stringify(next, null, 2) + "\n";
  if (Buffer.byteLength(recordText) > (opts.limits?.recordBytes ?? IMPORT_LIMITS.recordBytes)) throw new SkillImportError("too-large", "the import record is too large");
  return { record: next, recordText, files: prep.files, licence };
}
