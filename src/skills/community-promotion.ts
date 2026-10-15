import { compareWithBuiltins, type BuiltinSkill } from "./compare.js";
import { byteCmp, SkillImportError, type ImportRecord } from "./import-plan.js";
import type { LicenceEvidence } from "./licence.js";
import type { ImportLicenceReview } from "./licence-review.js";
import type { NormalizedSkill } from "./normalize.js";
import { supportStatus } from "./project-technologies.js";
import { promoteImport } from "./promotion.js";
import type { ScanReport } from "./scan.js";
import { applyExceptions, promotionBlockers, type ScanException } from "./scan-exceptions.js";
import type { SkillLibrarySource } from "./sources.js";

// One decision per candidate skill of a community source: promotable only when every check is on record. The checks are the
// existing pure ones (promoteImport, applyExceptions, supportStatus, compareWithBuiltins); this module adds none of its own.
// Pure: no file system, no process, no clock. Nothing is installed or offered. `scf skills` will call it in part 2 of #521.

export const COMMUNITY_PROMOTION_CODES = [
  "source-not-enabled", "source-not-community", "review-missing", "review-stale", "import-not-approved",
  "import-mismatch", "excluded", "licence-review", "licence-rejected", "licence-missing", "licence-ambiguous",
  "scan-missing", "scan-blocked", "version-stale", "version-unchecked",
  "collision-blocking", "canonical-conflict", "fixtures-missing", "fixtures-failed",
] as const;
export type CommunityPromotionCode = (typeof COMMUNITY_PROMOTION_CODES)[number];
export type FixtureResult = "passed" | "failed";

export interface CommunityPromotionInput {
  source: SkillLibrarySource;
  record: ImportRecord;
  skills: readonly NormalizedSkill[];
  /** With licenceReview, this must be licenceReview.evidence (promoteImport refuses a review of other evidence). */
  evidence: LicenceEvidence;
  retrievedAt: string;
  licenceReview?: ImportLicenceReview;
  /** A ScanReport per skill (package) id, read with Object.hasOwn. A report of another digest counts as no report. */
  scans: Readonly<Record<string, ScanReport>>;
  exceptions: readonly ScanException[];
  today: string;
  builtins: readonly BuiltinSkill[];
  overrides?: Readonly<Record<string, string>>;
  highRisk?: readonly string[];
  /** Fixture result per skill id, read with Object.hasOwn. An absent entry or any other value gives fixtures-missing. */
  fixtures: Readonly<Record<string, FixtureResult>>;
}
export interface CommunityPromotionDecision {
  skill: string;
  decision: "promotable" | "refused";
  /** Each once, in the order of COMMUNITY_PROMOTION_CODES. */
  codes: CommunityPromotionCode[];
}

const isReport = (r: unknown, digest: string): r is ScanReport =>
  typeof r === "object" && r !== null && Array.isArray((r as ScanReport).findings) && (r as ScanReport).digest === digest;

export function communityPromotionCheck(input: CommunityPromotionInput): CommunityPromotionDecision[] {
  const { source, record, skills, scans, exceptions, today, fixtures } = input;

  const sourceCodes = new Set<CommunityPromotionCode>();
  if (source.status !== "enabled") sourceCodes.add("source-not-enabled");
  if (source.trust !== "community") sourceCodes.add("source-not-community");
  if (!source.review) sourceCodes.add("review-missing");
  else if (source.review.commit !== source.ref.approved) sourceCodes.add("review-stale");
  if (record.commit !== source.ref.approved) sourceCodes.add("import-not-approved");

  // A candidate of another source cannot be compared (collisionCandidate throws); it is refused alone, not the whole check.
  const foreign = (s: NormalizedSkill) => s.provenance.source !== source.id || s.provenance.repositoryKey !== source.repositoryKey;
  const compared = compareWithBuiltins({
    source, skills: skills.filter((s) => !foreign(s)), builtins: input.builtins,
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.highRisk ? { highRisk: input.highRisk } : {}),
  });
  const capabilities = new Map<string, string[]>();
  for (const c of compared.skills) capabilities.set(c.id, [...(capabilities.get(c.id) ?? []), ...c.capabilities]);

  const count = new Map<string, number>();
  for (const s of skills) count.set(s.package.id, (count.get(s.package.id) ?? 0) + 1);

  const out = skills.map((skill): CommunityPromotionDecision => {
    const id = skill.package.id;
    const codes = new Set<CommunityPromotionCode>(sourceCodes);
    if ((count.get(id) ?? 0) > 1 || foreign(skill)) codes.add("import-mismatch");

    if (sourceCodes.size === 0) {
      try {
        const r = promoteImport({
          source, record, skills: [skill], evidence: input.evidence, retrievedAt: input.retrievedAt,
          ...(input.licenceReview ? { review: input.licenceReview } : {}),
        });
        if (r.promoted.length === 0) {
          const status = r.manifest.refused[0]?.status;
          codes.add(status === "excluded" ? "excluded" : (`licence-${status}` as CommunityPromotionCode));
        }
      } catch (e) {
        if (!(e instanceof SkillImportError)) throw e;
        codes.add("import-mismatch");
      }
    }

    const report = Object.hasOwn(scans, id) ? scans[id] : undefined;
    if (!isReport(report, skill.package.digest)) codes.add("scan-missing");
    else if (promotionBlockers(applyExceptions(id, report, exceptions, today)).length > 0) codes.add("scan-blocked");

    const support = supportStatus(skill.provenance.technologies);
    if (support === "stale") codes.add("version-stale");
    else if (support === "unchecked") codes.add("version-unchecked");

    if (compared.collisions.some((c) => c.blocking && c.members.some((m) => m.id === id))) codes.add("collision-blocking");
    const caps = capabilities.get(id) ?? [];
    if (compared.resolutions.some((r) => r.outcome !== "selected" && caps.includes(r.capability))) codes.add("canonical-conflict");

    const result = Object.hasOwn(fixtures, id) ? fixtures[id] : undefined;
    if (result === "failed") codes.add("fixtures-failed");
    else if (result !== "passed") codes.add("fixtures-missing");

    const list = COMMUNITY_PROMOTION_CODES.filter((c) => codes.has(c));
    return { skill: id, decision: list.length === 0 ? "promotable" : "refused", codes: list };
  });
  const root = new Map(skills.map((s, i) => [out[i]!, s.provenance.root]));
  return out.sort((a, b) => byteCmp(a.skill, b.skill) || byteCmp(root.get(a)!, root.get(b)!));
}

/** `PROMOTABLE <skill>` or `REFUSED <skill>: <code>, <code>`. Ids and codes are slugs, printed as they are. */
export function communityPromotionLines(decisions: readonly CommunityPromotionDecision[]): string[] {
  return decisions.map((d) => (d.decision === "promotable" ? `PROMOTABLE ${d.skill}` : `REFUSED ${d.skill}: ${d.codes.join(", ")}`));
}
