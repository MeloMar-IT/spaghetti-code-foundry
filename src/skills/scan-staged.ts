import type { ImportRecord } from "./import-plan.js";
import { importExclusions, type ImportExclusion } from "./import-exclusions.js";
import { normalizeImport, type NormalizationReport, type NormalizedSkill } from "./normalize.js";
import { scanSkill, type ScanReport } from "./scan.js";
import { applyExceptions, promotionBlockers, type DecidedFinding, type DecidedReport, type ScanException } from "./scan-exceptions.js";
import { shownValue } from "./sources.js";

// The per-skill scan of a staged import, shared by `scf skills scan` and `scf skills profiles evaluate`. Pure: reads nothing.

/** The files of one skill, with paths relative to its root. */
export function filesOf(root: string, files: ReadonlyMap<string, Uint8Array>): { path: string; content: Uint8Array }[] {
  const mine: { path: string; content: Uint8Array }[] = [];
  for (const [path, content] of files) {
    if (root === "." || path === root || path.startsWith(root + "/")) mine.push({ path: root === "." ? path : path.slice(root.length + 1), content });
  }
  return mine;
}

export interface StagedSkillScan {
  /** The staged entry, with its full upstream root. */
  entry: ImportRecord["skills"][number];
  report: ScanReport;
  /** Absent: the skill did not normalize. */
  skill?: NormalizedSkill;
  /** Present when the skill normalized. */
  decided?: DecidedReport;
  /** promotionBlockers(decided); empty when not normalized. */
  blockers: DecidedFinding[];
  /** importExclusions(skill); empty when not normalized. */
  exclusions: ImportExclusion[];
  /** The raw reasons it did not normalize (print them through `hidden`); empty when normalized. */
  quarantine: string[];
}

/**
 * Normalizes and scans every skill of a staged import and decides its findings with the exceptions. The recorded `rejected`
 * text is left out, so the result holds only what normalization decided itself.
 */
export function scanStaged(
  staged: { record: ImportRecord; files: ReadonlyMap<string, Uint8Array> },
  exceptions: readonly ScanException[],
  today: string,
): { normalized: NormalizedSkill[]; report: NormalizationReport; skills: StagedSkillScan[] } {
  const { record, files } = staged;
  const { skills: normalized, report } = normalizeImport({ record: { ...record, rejected: [] }, files });
  const skills = record.skills.map((entry): StagedSkillScan => {
    const scan = scanSkill({ root: entry.root, files: filesOf(entry.root, files) });
    const skill = normalized.find((s) => s.provenance.root === entry.root);
    if (!skill) {
      const label = shownValue(entry.root);
      const quarantine = report.quarantined.filter((q) => q.root === label).flatMap((q) => q.reasons);
      return { entry, report: scan, blockers: [], exclusions: [], quarantine };
    }
    const decided = applyExceptions(skill.package.id, scan, exceptions, today);
    return { entry, report: scan, skill, decided, blockers: promotionBlockers(decided), exclusions: importExclusions(skill), quarantine: [] };
  });
  return { normalized, report, skills };
}
