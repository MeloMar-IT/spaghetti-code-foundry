import { byteCmp, type ImportRecord } from "./import-plan.js";
import { licenceReviewProblem, reviewImport } from "./licence-review.js";
import type { LicenceEvidence } from "./licence.js";
import type { OverlapStagedSkill } from "./overlap.js";
import { licenceReviewRequired } from "./promotion.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, type ScanException } from "./scan-exceptions.js";
import type { SkillLibrarySource } from "./sources.js";
import { filesOf } from "./staged-import.js";
import { effectiveSkill, type SelectionLike } from "./suite-checks.js";

// The staged skills of an import as `overlapReport` wants them: normalized, with the licence verdict (the review gate applied)
// and the scan verdict (exceptions applied). Shared by `scf skills overlap` and the change summary of `scf skills update`.

export interface OverlapStagedInput {
  source: SkillLibrarySource;
  record: ImportRecord;
  files: ReadonlyMap<string, Uint8Array>;
  licence?: LicenceEvidence;
}

export interface OverlapStagedResult {
  skills: OverlapStagedSkill[];
  notNormalized: number;
  /** The digest of the licence evidence of the import. */
  licenceDigest: string;
  /** An allowed licence still needs a matching `licence.reviewed`. */
  licenceUnreviewed: boolean;
  /** Per root: the capabilities as the catalogue sees them (profile and reviewed selections applied). */
  capabilities: Map<string, string[]>;
}

/** `PROBLEM catalogue <source> <kind>` for every problem of the registry that is not of the repository, sorted. A catalogue that could not be read in full would show skills as new that are not. */
export function catalogueProblems(reg: { problems: readonly { source: string; kind: string }[] }): string[] {
  return [...new Set(reg.problems.filter((p) => p.source !== "repository").map((p) => `PROBLEM catalogue ${p.source} ${p.kind}`))].sort();
}

export function overlapStagedSkills(
  staged: OverlapStagedInput,
  exceptions: readonly ScanException[],
  today: string,
  selections: readonly SelectionLike[] = [],
): OverlapStagedResult {
  const { source, record, files } = staged;
  const review = reviewImport({
    allow: source.licence.allow,
    prep: { record: { ...record, rejected: [] }, files },
    evidence: staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] },
  });
  // The same gate as promotion: an allowed licence still needs the matching licence.reviewed.
  const unreviewed = licenceReviewRequired(source) && licenceReviewProblem(source.licence.reviewed, review.classification) !== undefined;
  const verdicts = new Map(review.classification.paths.map((p) => [p.root, p.status] as const));
  const normalized = review.normalized.skills;
  const capabilities = new Map<string, string[]>();
  const skills = normalized.map((skill) => {
    const root = skill.provenance.root;
    const status = verdicts.get(root) ?? "missing";
    const blockers = promotionBlockers(applyExceptions(skill.package.id, scanSkill({ root, files: filesOf(root, files) }), exceptions, today));
    capabilities.set(root, [...(effectiveSkill(skill, source, selections).skill?.package.capabilities ?? [])].sort(byteCmp));
    return { skill, licence: status === "allowed" && unreviewed ? ("review" as const) : status, safe: blockers.length === 0 };
  });
  return { skills, notNormalized: record.skills.length - normalized.length, licenceDigest: review.classification.digest, licenceUnreviewed: unreviewed, capabilities };
}
