import { createHash } from "node:crypto";
import { byteCmp, type ImportRecord } from "./import-plan.js";
import { canonicalLicenceEvidence } from "./import-licence.js";
import { evaluateLicence, type LicenceEvidence, type LicenceStatus } from "./licence.js";
import { normalizeImport } from "./normalize.js";

// The review of the licence evidence of one import. The digest covers every licence and notice file that can apply to a
// staged skill (path, kind, content hash or problem) and the decision for every staged skill folder, not only the
// attribution of the promoted skills: a new licence file in a folder above a skill changes it. Pure: no file system, no
// process, no clock. promoteImport accepts only a review that reviewImport made.

export const LICENCE_REVIEW_HEADER = "scf-licence-review-v1\n";

export interface LicenceRoot {
  root: string;
  declared?: string;
}
export interface LicenceClass {
  root: string;
  status: LicenceStatus;
  reasons: string[];
  licences: string[];
  declared?: string;
  governedBy?: string;
}
export interface LicenceEvidenceDigestFile {
  path: string;
  kind: "licence" | "notice";
  sha256?: string;
  problem?: string;
}
export interface LicenceClassification {
  repositoryKey: string;
  commit: string;
  /** Sorted by root. */
  paths: LicenceClass[];
  /** Every evidence file that can apply to a root, sorted by path. */
  files: LicenceEvidenceDigestFile[];
  digest: string;
}
export interface ImportLicenceReview {
  record: ImportRecord;
  allow: readonly string[];
  /** The evidence in the form an import stores it; use this one for promotion. */
  evidence: LicenceEvidence;
  /** The normalization of the whole import. */
  normalized: ReturnType<typeof normalizeImport>;
  classification: LicenceClassification;
}

const inside = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function licenceReviewDigest(files: readonly LicenceEvidenceDigestFile[], paths: readonly LicenceClass[]): string {
  const h = createHash("sha256");
  h.update(LICENCE_REVIEW_HEADER);
  for (const f of files) h.update("F " + JSON.stringify([f.path, f.kind, f.sha256 ?? null, f.problem ?? null]) + "\n");
  for (const p of paths) h.update("S " + JSON.stringify([p.root, p.status, p.licences, p.declared ?? null, p.governedBy ?? null]) + "\n");
  return "sha256:" + h.digest("hex");
}

/** Classifies every root once. The result does not depend on the order of the roots or of the evidence files. */
export function classifyLicences(input: { allow: readonly string[]; evidence: LicenceEvidence; roots: readonly LicenceRoot[] }): LicenceClassification {
  const { allow, evidence, roots } = input;
  const paths: LicenceClass[] = roots.map((r) => {
    const v = evaluateLicence({ root: r.root, ...(r.declared === undefined ? {} : { declared: r.declared }), allow, evidence });
    return {
      root: r.root,
      status: v.status,
      reasons: v.reasons,
      licences: v.licences,
      ...(v.declared === undefined ? {} : { declared: v.declared }),
      ...(v.governedBy === undefined ? {} : { governedBy: v.governedBy }),
    };
  });
  paths.sort((a, b) => byteCmp(a.root, b.root));
  const files: LicenceEvidenceDigestFile[] = evidence.files
    .filter((f) => roots.some((r) => inside(r.root, f.dir) || inside(f.dir, r.root)))
    .map((f) =>
      f.problem === undefined && f.content !== undefined
        ? { path: f.path, kind: f.kind, sha256: sha(f.content) }
        : { path: f.path, kind: f.kind, problem: f.problem ?? "cannot be read" },
    )
    .sort((a, b) => byteCmp(a.path, b.path));
  return { repositoryKey: evidence.repositoryKey, commit: evidence.commit, paths, files, digest: licenceReviewDigest(files, paths) };
}

/** Hash of every evidence file (not only the applicable ones) with its content. Linear in the evidence; no licence decision is made. */
function evidenceFingerprint(e: LicenceEvidence): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([e.repositoryKey, e.commit, e.files.length]) + "\n");
  for (const f of e.files) h.update(JSON.stringify([f.path, f.dir, f.kind, f.problem ?? null, f.content === undefined ? null : sha(f.content)]) + "\n");
  return h.digest("hex");
}

// The review object is frozen, but the evidence it holds (and its buffers) cannot be: the fingerprint taken when the
// review was made tells whether they were changed afterwards.
const made = new WeakMap<object, string>();

/** False when the evidence of the review was changed after reviewImport made it. */
export function reviewEvidenceIntact(review: ImportLicenceReview): boolean {
  return made.get(review) === evidenceFingerprint(review.evidence);
}

/**
 * Builds the review of a whole import: puts the evidence in the form an import stores, normalizes every skill (the
 * `license:` text of each comes from here) and classifies every staged root once. Errors of the evidence pass through.
 */
export function reviewImport(input: { allow: readonly string[]; prep: { record: ImportRecord; files: ReadonlyMap<string, Uint8Array> }; evidence: LicenceEvidence }): ImportLicenceReview {
  const evidence = canonicalLicenceEvidence(input.evidence);
  const normalized = normalizeImport(input.prep);
  const declared = new Map(normalized.skills.map((s) => [s.provenance.root, s.package.license]));
  const roots: LicenceRoot[] = input.prep.record.skills.map((e) => {
    const d = declared.get(e.root);
    return d === undefined ? { root: e.root } : { root: e.root, declared: d };
  });
  const classification = classifyLicences({ allow: input.allow, evidence, roots });
  const review: ImportLicenceReview = Object.freeze({
    record: input.prep.record,
    allow: Object.freeze([...input.allow]),
    evidence,
    normalized,
    classification: Object.freeze({ ...classification, paths: Object.freeze(classification.paths) as LicenceClass[], files: Object.freeze(classification.files) as LicenceEvidenceDigestFile[] }),
  });
  made.set(review, evidenceFingerprint(evidence));
  return review;
}

export function isImportLicenceReview(x: unknown): x is ImportLicenceReview {
  return typeof x === "object" && x !== null && made.has(x);
}

export function licenceReviewProblem(reviewed: string | undefined, c: LicenceClassification): "missing" | "changed" | undefined {
  if (reviewed === undefined) return "missing";
  return reviewed === c.digest ? undefined : "changed";
}
