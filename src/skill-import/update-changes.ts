import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { EVALUATION_SUITE_DEFAULT } from "../skills/evaluation-rules.js";
import { instructionsPolicy } from "../skills/evaluation-instructions.js";
import { readEvaluationSuite } from "../skills/evaluation-suite.js";
import { findNewestRecordOf } from "../skills/evaluation-store.js";
import type { EvaluationPolicy } from "../skills/evaluation.js";
import type { ImportReview } from "../skills/import-review.js";
import type { ImportGates } from "../skills/source-update.js";
import { readStagedImport } from "../skills/import-stage.js";
import type { LicenceEvidence } from "../skills/licence.js";
import { overlapReport, type OverlapReport } from "../skills/overlap.js";
import { catalogueProblems, overlapStagedSkills, type OverlapStagedResult } from "../skills/overlap-staged.js";
import { discoverSkills } from "../skills/registry.js";
import { reviewStaged } from "../skills/review-cli.js";
import type { ImportRecord } from "../skills/import-plan.js";
import { compareImports, evaluationKey, evaluationLookups, recordVerdict, type CanonicalInput, type RecordVerdict, type SourceChange } from "../skills/source-change.js";
import type { SkillLibrarySource } from "../skills/sources.js";
import { loadExceptions, reviewedFiles } from "../skills/staged-import.js";

type SkillSelection = NonNullable<ReturnType<typeof reviewedFiles>>["selections"][number];

// The glue of the change summary of `scf skills update`: stages and reads the old commit, reviews it, and gathers what the pure
// `compareImports` needs. Reads only (the old commit is staged with the checks of `scf skills import`); nothing is promoted.

export interface StagedSide {
  record: ImportRecord;
  files: ReadonlyMap<string, Uint8Array>;
  licence?: LicenceEvidence;
}

export async function changesSince(o: {
  old: SkillLibrarySource;
  oldCommit: string;
  next: { source: SkillLibrarySource; staged: StagedSide; review: ImportReview };
  cwd: string;
  home?: string;
  today: string;
  /** Stages a commit in the quarantine; true when it is staged. */
  stage: (source: SkillLibrarySource, commit: string) => Promise<boolean>;
}): Promise<SourceChange | "not-compared"> {
  const { home, today, cwd } = o;
  let read = readStagedImport(o.old.id, o.oldCommit, { home });
  if (read.state === "none") {
    if (!(await o.stage(o.old, o.oldCommit))) return "not-compared";
    read = readStagedImport(o.old.id, o.oldCommit, { home });
  }
  if (read.state !== "ok" || read.record.repositoryKey !== o.old.repositoryKey) return "not-compared";
  const oldStaged: StagedSide = { record: read.record, files: read.files, licence: read.licence };
  const oldReview = reviewStaged({ source: o.old, commit: o.oldCommit, record: read.record, files: read.files, licence: read.licence }, { home });

  // The same inputs as `scf skills overlap`; a folder that cannot be read in full gives no canonical comparison.
  let unusable = false;
  const note = () => {
    unusable = true;
  };
  const exceptions = loadExceptions(undefined, note, { cwd, today });
  const reviewed = reviewedFiles(note, { cwd, today }, false);
  const selections = reviewed?.selections ?? [];
  const oldSide = overlapStagedSkills({ source: o.old, ...oldStaged }, exceptions ?? [], today, selections);
  const newSide = overlapStagedSkills({ source: o.next.source, ...o.next.staged }, exceptions ?? [], today, selections);

  const canonical = canonicalInput(o, oldSide, newSide, unusable ? undefined : selections);

  const policy = suitePolicy(cwd);
  const evaluations = new Map<string, RecordVerdict>();
  for (const { id, digest } of evaluationLookups(oldReview, o.next.review)) {
    evaluations.set(evaluationKey(id, digest), recordVerdict(findNewestRecordOf(id, digest, { home }), id, digest, policy));
  }

  return compareImports(
    { review: oldReview, files: oldStaged.files, licenceDigest: oldSide.licenceDigest, licenceUnreviewed: oldSide.licenceUnreviewed, capabilities: oldSide.capabilities },
    { review: o.next.review, files: o.next.staged.files, licenceDigest: newSide.licenceDigest, licenceUnreviewed: newSide.licenceUnreviewed, capabilities: newSide.capabilities },
    evaluations,
    canonical,
  );
}

/** The gate policy of the evaluation suite of this folder; undefined when there is no usable suite. */
function suitePolicy(cwd: string): EvaluationPolicy | undefined {
  const suite = readEvaluationSuite(resolve(cwd, EVALUATION_SUITE_DEFAULT));
  return suite.state === "ok" ? instructionsPolicy(suite.suite, suite.digest) : undefined;
}

/**
 * The gates of the new import alone, for a pull request whose old commit could not be compared: a licence review that is
 * missing or stale, and the skills without a passing evaluation record.
 */
export function newImportGates(o: { next: { source: SkillLibrarySource; staged: StagedSide; review: ImportReview }; cwd: string; home?: string }): ImportGates {
  const { licenceUnreviewed } = overlapStagedSkills({ source: o.next.source, ...o.next.staged }, [], "1970-01-01");
  const policy = suitePolicy(o.cwd);
  let evaluationOpen = 0;
  for (const s of o.next.review.categories.flatMap((c) => c.skills)) {
    const passed = s.id !== undefined && recordVerdict(findNewestRecordOf(s.id, s.digest, { home: o.home }), s.id, s.digest, policy).state === "passed";
    if (!passed) evaluationOpen++;
  }
  return { licenceUnreviewed, evaluationOpen };
}

function canonicalInput(
  o: { old: SkillLibrarySource; next: { source: SkillLibrarySource }; home?: string },
  oldSide: OverlapStagedResult,
  newSide: OverlapStagedResult,
  selections: readonly SkillSelection[] | undefined,
): CanonicalInput {
  if (selections === undefined) return { problem: "the scan exceptions or skill selections of this folder are not valid" };
  const skills = loadConfig().skills;
  const reg = discoverSkills(skills, { home: o.home, repo: undefined });
  // The same check as `scf skills overlap`: a catalogue that was not read in full would show skills as new that are not.
  if (catalogueProblems(reg).length > 0) return { problem: "the catalogue skills could not be read in full" };
  const policy = { highRisk: skills.unresolved.high_risk, mandatory: skills.selection.include, tools: skills.tools };
  const build = (source: SkillLibrarySource, side: OverlapStagedResult): OverlapReport => overlapReport({ source, skills: side.skills, selections }, reg.skills, policy);
  let next: OverlapReport;
  try {
    next = build(o.next.source, newSide);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { problem: "too many skills or capabilities to compare" };
  }
  try {
    return { next, old: build(o.old, oldSide) };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { next };
  }
}
