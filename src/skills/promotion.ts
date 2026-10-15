import { createHash } from "node:crypto";
import { byteCmp, SkillImportError, type ImportRecord } from "./import-plan.js";
import { connectorFor } from "./connectors.js";
import { exclusionReasons, importExclusions } from "./import-exclusions.js";
import { evaluateLicence, type LicenceEvidence, type LicenceFileRecord, type LicenceStatus } from "./licence.js";
import { isImportLicenceReview, licenceReviewProblem, reviewEvidenceIntact, type ImportLicenceReview } from "./licence-review.js";
import type { NormalizedSkill } from "./normalize.js";
import { isUtcTime } from "./release.js";
import type { SkillFile } from "./schema.js";
import { shownValue, type SkillLibrarySource, type SourceTrustTier } from "./sources.js";

// Decides, per skill of a normalized import, whether it may be promoted: its licence must be accepted by the policy of
// licence.ts, and it must not need a live integration, use the network or ship plugin configuration (import-exclusions.ts;
// such a skill is refused with status "excluded"). For a source that needs a licence review (licenceReviewRequired) an otherwise allowed skill is refused with status "review" until `licence.reviewed` equals the digest of the review (licence-review.ts). Builds the manifest of licence and provenance for the promoted packages. Pure: no file system, no process,
// no clock. evaluateSource (source-evaluation.ts) calls it to report; the story that writes approved artifacts must call it and keep `attribution`.

export interface PackageProvenance {
  id: string;
  version: string;
  digest: string;
  source: string;
  repository: string;
  repositoryKey: string;
  /** The immutable revision. */
  commit: string;
  /** Upstream skill root. */
  path: string;
  /** Upstream name. */
  name: string;
  retrievedAt: string;
  licences: string[];
  declared?: string;
  licenceFiles: LicenceFileRecord[];
  attribution: { path: string; sha256: string; bytes: number }[];
  authorNotice: string[];
  /** The trust tier of the source. Always set by promoteImport; absent in manifests written before #537. */
  trust?: SourceTrustTier;
  /** Who reviewed the source, when and at which commit. Set only when the source has a review; never holds its `licence`. */
  review?: { by: string; on: string; commit: string };
}
export interface PromotionManifest {
  schema: 1;
  source: string;
  repository: string;
  repositoryKey: string;
  commit: string;
  retrievedAt: string;
  /** Sorted by id. */
  packages: PackageProvenance[];
  /** Sorted by root. */
  refused: { root: string; status: Exclude<LicenceStatus, "allowed"> | "excluded"; reasons: string[] }[];
}
export interface PromotedPackage {
  skill: NormalizedSkill;
  provenance: PackageProvenance;
  /** Licence and notice files byte for byte, by upstream path. They must be kept with the package. */
  attribution: SkillFile[];
}
export interface PromotionResult {
  manifest: PromotionManifest;
  manifestText: string;
  promoted: PromotedPackage[];
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const inside = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");

/** A source needs a matching licence.reviewed when its repository has a connector that says so, or when it sets one. */
export function licenceReviewRequired(source: SkillLibrarySource): boolean {
  return source.licence.reviewed !== undefined || connectorFor(source.repositoryKey)?.licenceReview === "required";
}

const GATE_TEXT = {
  missing: "licence review: the licence evidence of the source is not reviewed; run scf skills promote check and set licence.reviewed",
  changed: "licence review: the licence evidence changed since it was reviewed; run scf skills promote check and update licence.reviewed",
};

/**
 * Throws `not-usable` when the input does not belong together: a disabled source, a record or evidence of another
 * source or commit, a skill that is not in the record (root, name and digest) or not below an approved path, or a
 * `retrievedAt` that is not a UTC time, or (when a review is required) a missing review or one that was not made by
 * reviewImport for this import, evidence, allow list and skills. A skill with bad licence evidence is refused, not thrown.
 */
export function promoteImport(input: {
  source: SkillLibrarySource;
  record: ImportRecord;
  skills: readonly NormalizedSkill[];
  evidence: LicenceEvidence;
  retrievedAt: string;
  review?: ImportLicenceReview;
}): PromotionResult {
  const { source, record, skills, evidence, retrievedAt, review } = input;
  const refusal = (what: string) => new SkillImportError("not-usable", `the import cannot be promoted: ${what}`);
  if (source.status !== "enabled") throw refusal("the source is not enabled");
  if (record.source !== source.id || record.repositoryKey !== source.repositoryKey) throw refusal("the import record is of another source");
  if (record.commit !== source.ref.approved) throw refusal("the import record is not of the approved commit");
  if (evidence.repositoryKey !== record.repositoryKey || evidence.commit !== record.commit) throw refusal("the licence evidence is of another repository or commit");
  if (typeof retrievedAt !== "string" || !isUtcTime(retrievedAt)) throw refusal("retrievedAt is not a UTC time");

  const seen = new Set<string>();
  for (const s of skills) {
    const p = s.provenance;
    if (p.source !== source.id || p.repositoryKey !== source.repositoryKey || p.commit !== record.commit) throw refusal("a skill is of another source or commit");
    if (!source.paths.some((path) => inside(path, p.root))) throw refusal("a skill is not below an approved path");
    const entry = record.skills.find((r) => r.root === p.root);
    if (!entry || entry.name !== p.name || entry.digest !== s.package.digest) throw refusal("a skill does not match the import record");
    if (seen.has(p.root)) throw refusal("a skill is listed twice");
    seen.add(p.root);
  }

  let gate: "missing" | "changed" | undefined;
  if (licenceReviewRequired(source)) {
    if (!isImportLicenceReview(review)) throw refusal("the licence review was not given");
    const rr = review.record;
    if (rr.source !== record.source || rr.repositoryKey !== record.repositoryKey || rr.commit !== record.commit || rr.digest !== record.digest) throw refusal("the licence review is of another import");
    if (review.evidence !== evidence) throw refusal("the licence review is of other licence evidence");
    if (!reviewEvidenceIntact(review)) throw refusal("the licence evidence changed after the review was made");
    const allow = source.licence.allow;
    if (review.allow.length !== allow.length || review.allow.some((x, i) => x !== allow[i])) throw refusal("the licence review used another licence.allow");
    for (const s of skills) {
      const r = review.normalized.skills.find((x) => x.provenance.root === s.provenance.root);
      if (!r || r.package.digest !== s.package.digest || r.package.license !== s.package.license) throw refusal("the licence review does not match a skill");
    }
    gate = licenceReviewProblem(source.licence.reviewed, review.classification);
  }

  const promoted: PromotedPackage[] = [];
  const refused: PromotionManifest["refused"] = [];
  for (const skill of skills) {
    const p = skill.provenance;
    const excluded = importExclusions(skill);
    if (excluded.length > 0) {
      refused.push({ root: shownValue(p.root), status: "excluded", reasons: exclusionReasons(excluded) });
      continue;
    }
    const verdict = evaluateLicence({ root: p.root, ...(skill.package.license === undefined ? {} : { declared: skill.package.license }), allow: source.licence.allow, evidence });
    if (verdict.status !== "allowed") {
      refused.push({ root: shownValue(p.root), status: verdict.status, reasons: verdict.reasons });
      continue;
    }
    if (gate !== undefined) {
      refused.push({ root: shownValue(p.root), status: "review", reasons: [GATE_TEXT[gate]] });
      continue;
    }
    const attribution: SkillFile[] = verdict.attribution.map((a) => ({ path: a.path, size: a.content.byteLength, content: a.content }));
    const provenance: PackageProvenance = {
      id: skill.package.id,
      version: skill.package.version,
      digest: skill.package.digest,
      source: p.source,
      repository: p.repository,
      repositoryKey: p.repositoryKey,
      commit: p.commit,
      path: p.root,
      name: p.name,
      retrievedAt,
      licences: verdict.licences,
      ...(verdict.declared === undefined ? {} : { declared: verdict.declared }),
      licenceFiles: verdict.licenceFiles,
      attribution: attribution.map((a) => ({ path: a.path, sha256: sha(a.content), bytes: a.size })),
      authorNotice: verdict.authorNotice,
      trust: source.trust,
      ...(source.review ? { review: { by: source.review.by, on: source.review.on, commit: source.review.commit } } : {}),
    };
    promoted.push({ skill, provenance, attribution });
  }
  promoted.sort((a, b) => byteCmp(a.provenance.id, b.provenance.id));
  refused.sort((a, b) => byteCmp(a.root, b.root));
  const manifest: PromotionManifest = {
    schema: 1,
    source: source.id,
    repository: source.repository,
    repositoryKey: source.repositoryKey,
    commit: record.commit,
    retrievedAt,
    packages: promoted.map((x) => x.provenance),
    refused,
  };
  return { manifest, manifestText: JSON.stringify(manifest, null, 2) + "\n", promoted };
}

/** `<path> is missing` or `<path> changed` for the first attribution file that is not kept byte for byte, else undefined. */
export function attributionProblem(p: PackageProvenance, files: readonly { path: string; content: Uint8Array }[]): string | undefined {
  for (const a of p.attribution) {
    const f = files.find((x) => x.path === a.path);
    if (!f) return `${shownValue(a.path)} is missing`;
    if (f.content.byteLength !== a.bytes || sha(f.content) !== a.sha256) return `${shownValue(a.path)} changed`;
  }
  return undefined;
}
