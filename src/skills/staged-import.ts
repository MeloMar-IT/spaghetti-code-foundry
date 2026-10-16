import { resolve } from "node:path";
import { credentialProblem } from "./credential-scan.js";
import type { ImportRecord } from "./import-plan.js";
import { readStagedImport } from "./import-stage.js";
import { readScanExceptions, SCAN_EXCEPTIONS_FILE, type ScanException } from "./scan-exceptions.js";
import { readSkillSelections, SELECTIONS_FILE, type SkillSelection } from "./selections.js";
import { readSources, shownValue, SOURCES_FILE, type SkillLibrarySource, type SourcesManifest } from "./sources.js";
import { EVALUATIONS_FILE, readSuiteRecords, type EffectDecision } from "./suite-records.js";
import type { SuiteRecord } from "./suite-rules.js";

// Reads a staged import for the offline skill commands (scan, assess, promote check, review). Read-only.

/** Free text from a record is printed only when it holds no credential. */
export const hidden = (s: string): string => (credentialProblem(s) ? "(hidden)" : s);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type StagedOk = Extract<ReturnType<typeof readStagedImport>, { state: "ok" }>;
export interface StagedImport { source: SkillLibrarySource; commit: string; record: ImportRecord; files: Map<string, Uint8Array>; licence: StagedOk["licence"] }

/**
 * Finds the source, checks its approved commit, reads the staged import and proves it matches import.json. Prints a PROBLEM and
 * returns undefined when it cannot. `between` runs after the source is found and before the staged import is read; false stops
 * (it has printed its own PROBLEM).
 */
export function stagedImport(id: string, out: (line: string) => void, opts: { cwd: string; home?: string; today?: string; fixed?: boolean; sources?: SourcesManifest }, between?: () => boolean, done = "scanned"): StagedImport | undefined {
  const problem = (text: string): undefined => {
    out(`PROBLEM ${text}`);
    return undefined;
  };
  // `opts.sources`: a caller that already read and checked the file (publish) gets that same manifest, not a second read.
  let manifest = opts.sources;
  if (!manifest) {
    const sources = readSources(resolve(opts.cwd, SOURCES_FILE), undefined, opts.today);
    if (sources.state === "none") return problem("the skill source file does not exist");
    if (sources.state === "invalid") {
      for (const p of sources.problems) out(`PROBLEM ${p.where}: ${p.message}`);
      return undefined;
    }
    manifest = sources.manifest;
  }
  const source = manifest.sources.find((s) => s.id === id);
  if (!source) return problem(`unknown source ${shownValue(id)}`);
  const commit = source.ref.approved;
  if (!commit) return problem(`source ${source.id} has no approved commit (ref.approved)`);
  if (between && !between()) return undefined;

  const staged = readStagedImport(source.id, commit, { home: opts.home });
  if (staged.state === "none") return problem(`no staged import of ${source.id} at ${commit.slice(0, 12)}; run "scf skills import ${source.id}" first`);
  // `fixed`: the reason can hold upstream file names, so only a fixed text is printed.
  if (staged.state === "invalid") return problem(`the staged import does not match import.json${opts.fixed ? "" : `: ${staged.problem}`}; nothing was ${done}`);
  if (staged.record.repositoryKey !== source.repositoryKey) return problem(`the staged import is from another repository; nothing was ${done}`);
  return { source, commit, record: staged.record, files: staged.files, licence: staged.licence };
}

export { filesOf } from "./scan-staged.js";

/** The reviewed files `promote check` and `overlap` read; prints a PROBLEM and returns undefined when one cannot be used. A missing file is empty. */
export function reviewedFiles(out: (line: string) => void, opts: { cwd: string; today: string }, records: boolean): { selections: SkillSelection[]; records: SuiteRecord[]; decisions: EffectDecision[] } | undefined {
  const fail = (file: string, problems: { where: string; message: string }[]) => {
    for (const p of problems) out(`PROBLEM ${file} ${p.where}: ${p.message}`);
    return undefined;
  };
  const sel = readSkillSelections(resolve(opts.cwd, SELECTIONS_FILE), opts.today);
  if (sel.state === "invalid") return fail(SELECTIONS_FILE, sel.problems);
  let recs: SuiteRecord[] = [];
  let decisions: EffectDecision[] = [];
  if (records) {
    const r = readSuiteRecords(resolve(opts.cwd, EVALUATIONS_FILE), opts.today);
    if (r.state === "invalid") return fail(EVALUATIONS_FILE, r.problems);
    if (r.state === "ok") {
      recs = r.manifest.evaluations;
      decisions = r.manifest.effect_decisions;
    }
  }
  return { selections: sel.state === "ok" ? sel.manifest.selections : [], records: recs, decisions };
}

/** The exception file for `scan`, `promote check`, `score` and `gate`; prints a PROBLEM and returns undefined when it cannot be used. */
export function loadExceptions(file: string | undefined, out: (line: string) => void, opts: { cwd: string; today: string }): ScanException[] | undefined {
  const read = readScanExceptions(resolve(opts.cwd, file ?? SCAN_EXCEPTIONS_FILE), opts.today);
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return undefined;
  }
  if (read.state === "none" && file !== undefined) {
    out("PROBLEM the exception file does not exist");
    return undefined;
  }
  return read.state === "ok" ? read.manifest.exceptions : [];
}
