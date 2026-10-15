import { createHash } from "node:crypto";
import { z } from "zod";
import { credentialProblem } from "./credential-scan.js";
import { byteCmp } from "./import-plan.js";
import type { LicenceStatus } from "./licence.js";
import { canonicalJson } from "./normalize-values.js";
import { isUtcTime } from "./release.js";
import { promotionBlockers, type DecidedReport } from "./scan-exceptions.js";
import { SKILL_DIGEST_RE, SkillIdSchema, SkillVersionSchema } from "./schema.js";
import {
  EVALUATION_DIGEST_HEADER, EVALUATION_DIMENSIONS, EVALUATION_EPSILON, EVALUATION_LIMITS, EVALUATION_MANDATORY, EVALUATION_MIN_MARGIN,
  EVALUATION_MIN_SAMPLES, EVALUATION_MODES, EVALUATION_REASON_CODES, EVALUATION_THRESHOLDS,
  type EvaluationDimension, type EvaluationMode, type EvaluationReasonCode,
} from "./evaluation-rules.js";

// The evaluation record of a candidate skill and the promotion gate over it. Pure: no file system, process,
// clock or network. The time is an input. `scf skills score` stores the records (evaluation-store.ts); `scf skills gate` judges them.

export interface EvaluationRecord {
  schema: 1;
  candidate: { id: string; version: string; digest: string; fingerprint: string; source: string; repositoryKey: string; commit: string };
  suite: { digest: string; scenarios: { id: string; inputs: Record<string, string> }[] };
  runtime: { foundry: string; agent?: string; model?: string };
  /** UTC time (isUtcTime), given by the caller. */
  evaluatedAt: string;
  /** Scores 0..1, one per sample, in the order they were taken. */
  dimensions: Partial<Record<EvaluationDimension, number[]>>;
  findings: { code: string; dimension?: EvaluationDimension; scenario?: string; detail?: string }[];
  evidence: { name: string; digest: string }[];
}

const L = EVALUATION_LIMITS;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,199}$/;
const REPOSITORY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/;
const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const INPUT_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const FINDING_RE = /^[0-9a-f]{16}$/;
const token = z.string().regex(TOKEN_RE, "must be a short token");
const digest = z.string().regex(SKILL_DIGEST_RE, "must be a sha256 digest");
const dimension = z.enum(EVALUATION_DIMENSIONS);
const samples = z.array(z.number().finite().min(0).max(1)).min(1).max(L.samples);

export const EvaluationRecordSchema = z
  .object({
    schema: z.literal(1),
    candidate: z
      .object({
        id: SkillIdSchema,
        version: SkillVersionSchema,
        digest,
        fingerprint: token,
        source: token,
        repositoryKey: z.string().max(L.repositoryKeyChars).regex(REPOSITORY_KEY_RE, "must be like host/owner/name"),
        commit: z.string().regex(COMMIT_RE, "must be a full commit id"),
      })
      .strict(),
    suite: z
      .object({
        digest,
        scenarios: z
          .array(
            z
              .object({
                id: SkillIdSchema,
                inputs: z
                  .record(z.string().regex(INPUT_KEY_RE), z.string().max(L.inputChars))
                  .refine((o) => Object.keys(o).length <= L.inputs, `at most ${L.inputs} inputs`),
              })
              .strict(),
          )
          .max(L.scenarios),
      })
      .strict(),
    runtime: z.object({ foundry: token, agent: token.optional(), model: token.optional() }).strict(),
    evaluatedAt: z.string().refine(isUtcTime, "must be a UTC time like 2026-01-31T12:00:00Z"),
    dimensions: z
      .object({
        selection: samples.optional(),
        instructions: samples.optional(),
        conflicts: samples.optional(),
        context: samples.optional(),
        tools: samples.optional(),
      })
      .strict(),
    findings: z
      .array(
        z
          .object({ code: SkillIdSchema, dimension: dimension.optional(), scenario: SkillIdSchema.optional(), detail: z.string().max(L.detailChars).optional() })
          .strict(),
      )
      .max(L.findings),
    evidence: z.array(z.object({ name: token, digest }).strict()).max(L.evidence),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ids = new Set<string>();
    for (const s of r.suite.scenarios) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["suite", "scenarios"], message: "scenario ids must be unique" });
      ids.add(s.id);
    }
    for (const f of r.findings) {
      if (f.scenario !== undefined && !ids.has(f.scenario)) ctx.addIssue({ code: "custom", path: ["findings"], message: "a finding names a scenario that is not listed" });
    }
    const { agent, model } = r.runtime;
    if ((agent === undefined) !== (model === undefined)) ctx.addIssue({ code: "custom", path: ["runtime"], message: "agent and model come together" });
    if (r.dimensions.instructions && (agent === undefined || model === undefined)) {
      ctx.addIssue({ code: "custom", path: ["runtime"], message: "instructions needs the agent and model that scored it" });
    }
  });

export type EvaluationRecordRead =
  | { record: EvaluationRecord; digest: string }
  | { code: "record-invalid" | "record-credential"; problem: string };

/** A fresh, normalised copy: scenarios, findings and evidence sorted, dimensions in fixed order. Optional keys are left out. */
function normalise(r: EvaluationRecord): EvaluationRecord {
  const dims: Partial<Record<EvaluationDimension, number[]>> = {};
  for (const d of EVALUATION_DIMENSIONS) if (r.dimensions[d]) dims[d] = [...r.dimensions[d]!];
  const findings = r.findings.map((f) => ({
    code: f.code,
    ...(f.dimension !== undefined ? { dimension: f.dimension } : {}),
    ...(f.scenario !== undefined ? { scenario: f.scenario } : {}),
    ...(f.detail !== undefined ? { detail: f.detail } : {}),
  }));
  findings.sort((a, b) => byteCmp(canonicalJson(a), canonicalJson(b)));
  return {
    schema: 1,
    candidate: { ...r.candidate },
    suite: {
      digest: r.suite.digest,
      scenarios: r.suite.scenarios.map((s) => ({ id: s.id, inputs: { ...s.inputs } })).sort((a, b) => byteCmp(a.id, b.id)),
    },
    runtime: { foundry: r.runtime.foundry, ...(r.runtime.agent !== undefined ? { agent: r.runtime.agent } : {}), ...(r.runtime.model !== undefined ? { model: r.runtime.model } : {}) },
    evaluatedAt: r.evaluatedAt,
    dimensions: dims,
    findings,
    evidence: r.evidence.map((e) => ({ name: e.name, digest: e.digest })).sort((a, b) => byteCmp(`${a.name} ${a.digest}`, `${b.name} ${b.digest}`)),
  };
}

/** The text the digest is made of: the header, then one line per element. */
export function evaluationRecordText(record: EvaluationRecord): string {
  const r = normalise(record);
  const c = r.candidate;
  const lines = [
    canonicalJson([c.id, c.version, c.digest, c.fingerprint, c.source, c.repositoryKey, c.commit]),
    r.suite.digest,
    ...r.suite.scenarios.map((s) => canonicalJson({ id: s.id, inputs: s.inputs })),
    canonicalJson([r.runtime.foundry, r.runtime.agent ?? "", r.runtime.model ?? ""]),
    r.evaluatedAt,
    ...EVALUATION_DIMENSIONS.filter((d) => r.dimensions[d]).map((d) => `${d} ${r.dimensions[d]!.join(",")}`),
    ...r.findings.map((f) => canonicalJson(f)),
    ...r.evidence.map((e) => `${e.name} ${e.digest}`),
  ];
  return EVALUATION_DIGEST_HEADER + lines.map((l) => l + "\n").join("");
}

export function evaluationRecordDigest(record: EvaluationRecord): string {
  return "sha256:" + createHash("sha256").update(evaluationRecordText(record)).digest("hex");
}

/** The name of the first credential rule any string or key of the raw value trips; "limit" when it is too big or deep. */
function rawCredential(raw: unknown): string | undefined {
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | undefined => {
    if (++nodes > L.walkNodes || depth > L.walkDepth) return "limit";
    if (typeof v === "string") return credentialProblem(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const p = walk(x, depth + 1);
        if (p) return p;
      }
    } else if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v)) {
        const val = (v as Record<string, unknown>)[k];
        // A key and its string value are scanned together too: the rules look for `name: secret`.
        const pair = typeof val === "string" ? (credentialProblem(`${k}: ${val}`) ?? credentialProblem(`${k}="${val}"`)) : undefined;
        const p = credentialProblem(k) ?? pair ?? walk(val, depth + 1);
        if (p) return p;
      }
    }
    return undefined;
  };
  return walk(raw, 1);
}

/** Checks a raw record and returns a normalised copy with its digest. Messages never hold any part of the text. */
export function parseEvaluationRecord(raw: unknown): EvaluationRecordRead {
  const hit = rawCredential(raw);
  if (hit === "limit") return { code: "record-invalid", problem: "is too large or nested too deep" };
  if (hit) return { code: "record-credential", problem: `holds credential-like text (${hit})` };
  const parsed = EvaluationRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { code: "record-invalid", problem: i ? `${i.path.join(".") || "record"}: ${i.message}` : "is not a valid record" };
  }
  const record = normalise(parsed.data as EvaluationRecord);
  const text = evaluationRecordText(record);
  const again = credentialProblem(text);
  if (again) return { code: "record-credential", problem: `holds credential-like text (${again})` };
  return { record, digest: "sha256:" + createHash("sha256").update(text).digest("hex") };
}

export interface EvaluationPolicy {
  /** Digest of the suite the records must be made with. */
  suite: string;
  /** Extra mandatory dimensions; only `instructions` adds anything. */
  mandatory?: readonly EvaluationDimension[];
  thresholds?: Partial<Record<EvaluationDimension, number>>;
  minSamples?: Partial<Record<EvaluationDimension, number>>;
}
export interface EvaluationSubject {
  record: unknown;
  /** The package digest the caller is about to promote. */
  digest: string;
  safety: DecidedReport;
  licence: LicenceStatus;
}
export type EvaluationGateInput =
  | { mode: "new"; policy: EvaluationPolicy; candidate: EvaluationSubject }
  | { mode: "upgrade"; policy: EvaluationPolicy; candidate: EvaluationSubject; baseline?: { record: unknown; digest: string; id?: string } }
  | { mode: "duplicate"; policy: EvaluationPolicy; candidates: readonly [EvaluationSubject, EvaluationSubject] };

export interface EvaluationReason {
  code: EvaluationReasonCode;
  dimension?: EvaluationDimension;
  /** safety-blocked: the scan finding id. */
  finding?: string;
  licence?: LicenceStatus;
}
export interface EvaluationDimensionResult {
  dimension: EvaluationDimension;
  mandatory: boolean;
  samples: number;
  minSamples: number;
  mean?: number;
  spread?: number;
  threshold: number;
  passed: boolean;
  /** upgrade: the baseline mean and the allowed drop. */
  baseline?: number;
  allowed?: number;
}
export interface EvaluationVerdict {
  /** From the record when it is valid; else only the expected digest. */
  candidate: { id?: string; version?: string; digest: string };
  outcome: "passed" | "failed";
  reasons: EvaluationReason[];
  dimensions: EvaluationDimensionResult[];
}
export interface EvaluationComparison {
  /** `id@version digest` of the better candidate, or "none" (no clear difference). */
  better: string;
  basis: "thresholds" | "scores" | "none";
  dimensions: { dimension: EvaluationDimension; favours: string; difference: number; allowed: number }[];
}
export interface EvaluationGateResult {
  schema: 1;
  mode: EvaluationMode;
  verdicts: EvaluationVerdict[];
  comparison?: EvaluationComparison;
}

export const evaluationKey = (c: { id: string; version: string; digest: string }): string => `${c.id}@${c.version} ${c.digest}`;
const verdictKey = (v: EvaluationVerdict): string => `${v.candidate.id ?? ""}@${v.candidate.version ?? ""} ${v.candidate.digest}`;

const LICENCES: readonly string[] = ["allowed", "review", "rejected", "missing", "ambiguous"];
const dimIndex = (d: EvaluationDimension | undefined): number => (d === undefined ? -1 : EVALUATION_DIMENSIONS.indexOf(d));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

interface EffectivePolicy {
  suite: string;
  mandatory: ReadonlySet<EvaluationDimension>;
  thresholds: Record<EvaluationDimension, number>;
  minSamples: Record<EvaluationDimension, number>;
}

/** Tighten-only: a looser value is ignored. Undefined when the policy is malformed. */
function effectivePolicy(policy: unknown): EffectivePolicy | undefined {
  if (!isObj(policy) || typeof policy.suite !== "string" || !SKILL_DIGEST_RE.test(policy.suite)) return undefined;
  const known = (k: string): k is EvaluationDimension => (EVALUATION_DIMENSIONS as readonly string[]).includes(k);
  const mandatory = new Set<EvaluationDimension>(EVALUATION_MANDATORY);
  if (policy.mandatory !== undefined) {
    if (!Array.isArray(policy.mandatory)) return undefined;
    for (const d of policy.mandatory) {
      if (typeof d !== "string" || !known(d)) return undefined;
      mandatory.add(d);
    }
  }
  const thresholds = { ...EVALUATION_THRESHOLDS };
  const minSamples = { ...EVALUATION_MIN_SAMPLES };
  const apply = (src: unknown, target: Record<EvaluationDimension, number>, ok: (n: number) => boolean): boolean => {
    if (src === undefined) return true;
    if (!isObj(src)) return false;
    for (const k of Object.keys(src)) {
      const n = src[k];
      if (!known(k) || typeof n !== "number" || !Number.isFinite(n) || !ok(n)) return false;
      target[k] = Math.max(target[k], n);
    }
    return true;
  };
  if (!apply(policy.thresholds, thresholds, (n) => n >= 0 && n <= 1)) return undefined;
  if (!apply(policy.minSamples, minSamples, (n) => Number.isInteger(n) && n >= 1 && n <= L.samples)) return undefined;
  return { suite: policy.suite, mandatory, thresholds, minSamples };
}

const sortedAsc = (s: readonly number[]): number[] => [...s].sort((a, b) => a - b);
/** Mean of the sorted samples (sample order cannot change floating-point results) and range. */
function stats(s: readonly number[]): { mean: number; spread: number } {
  const a = sortedAsc(s);
  let sum = 0;
  for (const x of a) sum += x;
  return { mean: sum / a.length, spread: a[a.length - 1]! - a[0]! };
}
/** A threshold of 1 needs every sample to be exactly 1; no tolerance, no averaging. */
function meets(s: readonly number[], threshold: number): boolean {
  if (threshold >= 1) return sortedAsc(s)[0] === 1;
  return stats(s).mean + EVALUATION_EPSILON >= threshold;
}
const allowedDrop = (a: readonly number[], b: readonly number[]): number => Math.max(stats(a).spread, stats(b).spread, EVALUATION_MIN_MARGIN);
/** `a` is lower than `b` by more than the allowed drop. */
const lowerThan = (a: readonly number[], b: readonly number[]): boolean => stats(b).mean - stats(a).mean > allowedDrop(a, b) + EVALUATION_EPSILON;

interface Judged {
  verdict: EvaluationVerdict;
  record?: EvaluationRecord;
  reasons: EvaluationReason[];
}

function judge(subject: EvaluationSubject, ep: EffectivePolicy | undefined): Judged {
  if (!isObj(subject)) throw new TypeError("candidate must be an object");
  const expected = typeof subject.digest === "string" ? subject.digest : "";
  const reasons: EvaluationReason[] = [];
  const verdict: EvaluationVerdict = { candidate: { digest: expected }, outcome: "failed", reasons, dimensions: [] };
  if (!ep) {
    reasons.push({ code: "policy-invalid" });
    return { verdict, reasons };
  }
  const read = parseEvaluationRecord(subject.record);
  if (!("record" in read)) {
    reasons.push({ code: read.code });
    return { verdict, reasons };
  }
  const record = read.record;
  verdict.candidate = { id: record.candidate.id, version: record.candidate.version, digest: expected };
  if (!SKILL_DIGEST_RE.test(expected) || record.candidate.digest !== expected) reasons.push({ code: "digest-mismatch" });
  if (record.suite.digest !== ep.suite) reasons.push({ code: "suite-mismatch" });

  const s: unknown = subject.safety;
  const shaped = isObj(s) && s.schema === 1 && Array.isArray(s.findings) && s.findings.every((d) => isObj(d) && isObj(d.finding));
  if (!shaped || s.skill !== record.candidate.id || s.digest !== expected) reasons.push({ code: "safety-mismatch" });
  else {
    for (const d of promotionBlockers(s as unknown as DecidedReport)) {
      const id: unknown = d.finding.id;
      reasons.push({ code: "safety-blocked", ...(typeof id === "string" && FINDING_RE.test(id) ? { finding: id } : {}) });
    }
  }
  if (subject.licence !== "allowed") {
    reasons.push({ code: "licence-not-allowed", ...(LICENCES.includes(subject.licence as string) ? { licence: subject.licence } : {}) });
  }

  for (const d of EVALUATION_DIMENSIONS) {
    const mandatory = ep.mandatory.has(d);
    const have = record.dimensions[d];
    const threshold = ep.thresholds[d];
    const minSamples = ep.minSamples[d];
    if (!have) {
      if (mandatory) {
        reasons.push({ code: "dimension-missing", dimension: d });
        verdict.dimensions.push({ dimension: d, mandatory, samples: 0, minSamples, threshold, passed: false });
      }
      continue;
    }
    const { mean, spread } = stats(have);
    const enough = have.length >= minSamples;
    const ok = enough && meets(have, threshold);
    if (mandatory && !enough) reasons.push({ code: "too-few-samples", dimension: d });
    else if (mandatory && !ok) reasons.push({ code: "below-threshold", dimension: d });
    verdict.dimensions.push({ dimension: d, mandatory, samples: have.length, minSamples, mean, spread, threshold, passed: ok });
  }
  return { verdict, record, reasons };
}

/** `baseline.id` names the skill the baseline record is of when it is not the candidate's own id (an upgrade by capability). */
function compareBaseline(j: Judged, ep: EffectivePolicy, baseline: { record: unknown; digest: string; id?: string } | undefined): void {
  const { record, reasons, verdict } = j;
  if (!record) return;
  if (!isObj(baseline)) {
    reasons.push({ code: "baseline-missing" });
    return;
  }
  const read = parseEvaluationRecord(baseline.record);
  if (!("record" in read)) {
    reasons.push({ code: "baseline-invalid" });
    return;
  }
  const base = read.record;
  if (baseline.id !== undefined && typeof baseline.id !== "string") {
    reasons.push({ code: "baseline-invalid" });
    return;
  }
  if (base.candidate.id !== (baseline.id ?? record.candidate.id) ||base.candidate.digest !== baseline.digest || base.suite.digest !== ep.suite) {
    reasons.push({ code: "baseline-mismatch" });
    return;
  }
  for (const d of EVALUATION_DIMENSIONS) {
    const b = base.dimensions[d];
    const mandatory = ep.mandatory.has(d);
    if (!b) {
      if (mandatory) reasons.push({ code: "baseline-invalid", dimension: d });
      continue;
    }
    const c = record.dimensions[d];
    const min = ep.minSamples[d];
    if (b.length < min) reasons.push({ code: "too-few-samples", dimension: d });
    if (!c) {
      reasons.push({ code: "dimension-missing", dimension: d });
      continue;
    }
    if (c.length < min) reasons.push({ code: "too-few-samples", dimension: d });
    if (b.length < min || c.length < min) continue;
    const r = verdict.dimensions.find((x) => x.dimension === d);
    if (r) {
      r.baseline = stats(b).mean;
      r.allowed = allowedDrop(b, c);
    }
    if (lowerThan(c, b)) reasons.push({ code: "regression", dimension: d });
  }
}

function finish(j: Judged): EvaluationVerdict {
  const seen = new Set<string>();
  const list = j.reasons.filter((r) => {
    const k = canonicalJson(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  list.sort(
    (a, b) =>
      EVALUATION_REASON_CODES.indexOf(a.code) - EVALUATION_REASON_CODES.indexOf(b.code) ||
      dimIndex(a.dimension) - dimIndex(b.dimension) ||
      byteCmp(a.finding ?? "", b.finding ?? "") ||
      byteCmp(a.licence ?? "", b.licence ?? ""),
  );
  const reasons = list.slice(0, L.reasons);
  return { candidate: j.verdict.candidate, outcome: reasons.length === 0 ? "passed" : "failed", reasons, dimensions: j.verdict.dimensions };
}

const sortVerdicts = (vs: EvaluationVerdict[]): EvaluationVerdict[] =>
  vs.map((v) => ({ v, k: verdictKey(v), j: canonicalJson(v) })).sort((a, b) => byteCmp(a.k, b.k) || byteCmp(a.j, b.j)).map((x) => x.v);

function duplicate(ep: EffectivePolicy | undefined, subjects: readonly [EvaluationSubject, EvaluationSubject]): EvaluationGateResult {
  const a = judge(subjects[0], ep);
  const b = judge(subjects[1], ep);
  let comparison: EvaluationComparison = { better: "none", basis: "none", dimensions: [] };
  let scored = false;
  if (ep && a.record && b.record) {
    const ka = verdictKey(a.verdict);
    const kb = verdictKey(b.verdict);
    if (ka === kb) {
      a.reasons.push({ code: "same-candidate" });
      b.reasons.push({ code: "same-candidate" });
    } else {
      const favours: Record<string, number> = { [ka]: 0, [kb]: 0 };
      const dims: EvaluationComparison["dimensions"] = [];
      for (const d of EVALUATION_DIMENSIONS) {
        const x: number[] | undefined = a.record.dimensions[d];
        const y: number[] | undefined = b.record.dimensions[d];
        if (!x || !y) continue;
        const min = ep.minSamples[d];
        if (x.length < min) a.reasons.push({ code: "too-few-samples", dimension: d });
        if (y.length < min) b.reasons.push({ code: "too-few-samples", dimension: d });
        if (x.length < min || y.length < min) continue;
        const allowed = allowedDrop(x, y);
        const diff: number = stats(x).mean - stats(y).mean;
        if (Math.abs(diff) > allowed + EVALUATION_EPSILON) {
          const key = diff > 0 ? ka : kb;
          favours[key]!++;
          dims.push({ dimension: d, favours: key, difference: Math.abs(diff), allowed });
        }
      }
      if (a.reasons.length === 0 && b.reasons.length === 0) {
        scored = true;
        const fa = favours[ka]!;
        const fb = favours[kb]!;
        const better = fa > 0 && fb === 0 ? ka : fb > 0 && fa === 0 ? kb : "none";
        comparison = { better, basis: better === "none" ? "none" : "scores", dimensions: dims };
        if (better === ka) b.reasons.push({ code: "worse-duplicate" });
        if (better === kb) a.reasons.push({ code: "worse-duplicate" });
      }
    }
  }
  // One candidate passes its own thresholds and the other does not (an unreadable record included): name the one that passes.
  const okA = a.record !== undefined && a.reasons.length === 0;
  const okB = b.record !== undefined && b.reasons.length === 0;
  if (!scored && okA !== okB) comparison = { better: verdictKey(okA ? a.verdict : b.verdict), basis: "thresholds", dimensions: [] };
  return { schema: 1, mode: "duplicate", verdicts: sortVerdicts([finish(a), finish(b)]), comparison };
}

export function evaluationGate(input: EvaluationGateInput): EvaluationGateResult {
  if (!isObj(input) || !(EVALUATION_MODES as readonly string[]).includes(input.mode)) throw new TypeError("unknown evaluation mode");
  const ep = effectivePolicy(input.policy);
  if (input.mode === "duplicate") {
    if (!Array.isArray(input.candidates) || input.candidates.length !== 2) throw new TypeError("duplicate mode needs two candidates");
    return duplicate(ep, input.candidates);
  }
  const j = judge(input.candidate, ep);
  if (input.mode === "upgrade" && ep) compareBaseline(j, ep, input.baseline);
  return { schema: 1, mode: input.mode, verdicts: [finish(j)] };
}

/** The value for CanonicalCandidate.evaluation. With two verdicts, name the candidate; unknown or unnamed is "failed". */
export function evaluationOutcome(result: EvaluationGateResult, candidate?: { id: string; version: string; digest: string }): "passed" | "failed" {
  const vs = candidate ? result.verdicts.filter((v) => verdictKey(v) === evaluationKey(candidate)) : result.verdicts.length === 1 ? result.verdicts : [];
  return vs.length > 0 && vs.every((v) => v.outcome === "passed") ? "passed" : "failed";
}
