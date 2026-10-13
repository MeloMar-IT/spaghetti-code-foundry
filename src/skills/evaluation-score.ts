import { buildSkillCatalogue } from "./catalogue.js";
import { CATALOGUE_DETAIL } from "./catalogue-rules.js";
import { selectCanonicalSkills } from "./canonical.js";
import { canonicalFromCollision, canonicalFromRegistered } from "./canonical-facts.js";
import { classifySkillCollisions, type CollisionCandidate } from "./collisions.js";
import type { EvaluationRecord } from "./evaluation.js";
import { EVALUATION_LIMITS, EVALUATION_OFFLINE, type EvaluationDimension, type EvaluationMode } from "./evaluation-rules.js";
import type { ConflictScenario, ContextScenario, EvaluationSuite, SelectionScenario, ToolsScenario } from "./evaluation-suite.js";
import { evaluationSuiteDigest, suiteScenarios } from "./evaluation-suite.js";
import { relateSkills } from "./identity.js";
import { byteCmp } from "./import-plan.js";
import type { ImportedCandidate } from "./import-evaluation.js";
import type { NormalizedSkill } from "./normalize.js";
import { canonicalJson } from "./normalize-values.js";
import type { RegisteredSkill } from "./registry.js";
import type { RepoProfile } from "./repo-profile.js";
import { skillContextTokens } from "./resolve.js";
import { promotionBlockers, type DecidedReport } from "./scan-exceptions.js";
import { compareSkillVersions, type SkillPackage } from "./schema.js";
import { checkSkillTools, type Capabilities } from "./tool-policy.js";

// Scores a candidate skill against a suite without running it and without a model: selection, conflicts, context size and tool
// boundaries. Pure over input that is already read. The files of the candidate (package.files, extraFiles) are never touched;
// the scan result comes in as a decided report. Nothing calls this yet; a later story stores the record.

export type ComparedSkill = { kind: "registered"; skill: RegisteredSkill } | ({ kind: "imported" } & ImportedCandidate);
export type EvaluationFinding = EvaluationRecord["findings"][number];
export interface EvaluationScoreInput {
  suite: EvaluationSuite;
  /** One profile per `repo` of the selection scenarios. */
  profiles: ReadonlyMap<string, RepoProfile>;
  /** The candidate with the facts of its source record (collisionCandidate). */
  candidate: CollisionCandidate;
  /** The approved skills: the registry and approved imports. */
  approved: readonly ComparedSkill[];
  /** The approved version the candidate is to replace. It may also be in `approved`. */
  baseline?: ComparedSkill;
  /** applyExceptions(candidate id, scanSkill(...), exceptions, today). */
  safety: DecidedReport;
}
export interface EvaluationScore {
  suite: { digest: string; scenarios: { id: string; inputs: Record<string, string> }[] };
  /** One sample for each of the four offline dimensions. */
  dimensions: Partial<Record<EvaluationDimension, number[]>>;
  /** Sorted; at most EVALUATION_LIMITS.findings. */
  findings: EvaluationFinding[];
  mode: EvaluationMode;
  /** upgrade: the approved version the candidate replaces. */
  baseline?: { id: string; version: string; digest: string };
}
export interface DimensionScore { sample: number; findings: EvaluationFinding[] }
/** A candidate whose package holds no files at all. */
export type BareCandidate = CollisionCandidate;

const FAILING = ["version-reuse", "id-conflict", "baseline-not-replaceable", "compared-skill-missing"];
const detailOf = (s: string) => s.slice(0, EVALUATION_LIMITS.detailChars);
const finding = (code: string, dimension: EvaluationDimension, scenario: string, detail?: string): EvaluationFinding => ({
  code, dimension, scenario, ...(detail !== undefined ? { detail: detailOf(detail) } : {}),
});
const share = (pass: number, total: number) => (total === 0 ? 0 : pass / total);

/** A copy of the package without its files, made by leaving `files` out; the folders are never read. */
function barePackage(pkg: SkillPackage): SkillPackage {
  const { files: _files, ...rest } = pkg;
  void _files;
  return { ...rest, files: { references: [], scripts: [], assets: [], evals: [] } };
}
function bareSkill(s: NormalizedSkill): NormalizedSkill {
  const { package: pkg, provenance, identity } = s;
  return { package: barePackage(pkg), provenance, identity, extraFiles: [] };
}
const bareCandidate = (c: CollisionCandidate): BareCandidate => ({ ...c, skill: bareSkill(c.skill) });
function bareCompared(c: ComparedSkill): ComparedSkill {
  if (c.kind === "registered") return c;
  const { kind, candidate, licence, safety } = c;
  return { kind, candidate: bareCandidate(candidate), licence, safety };
}

interface Member { id: string; version: string; digest: string; capabilities: string[]; entry: ComparedSkill }
function memberOf(c: ComparedSkill): Member {
  if (c.kind === "registered") return { id: c.skill.id, version: c.skill.version, digest: c.skill.digest, capabilities: [...(c.skill.pkg.capabilities ?? [])], entry: c };
  const id = c.candidate.skill.identity;
  return { id: id.id, version: id.version, digest: id.digest, capabilities: [...(c.candidate.skill.package.capabilities ?? [])], entry: c };
}
const isApproved = (c: ComparedSkill): boolean => (c.kind === "registered" ? c.skill.trust !== "unapproved" && c.skill.active : c.candidate.approved);

function asRegistered(pkg: SkillPackage, label: string): RegisteredSkill {
  return { key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label, dir: "", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg };
}

/** Every approved skill plus the candidate, one entry per id: the candidate, then a registered skill, then the highest imported version. */
function selectionRegistry(c: BareCandidate, approved: readonly ComparedSkill[]): RegisteredSkill[] {
  const byId = new Map<string, { skill: RegisteredSkill; rank: number }>();
  const offer = (skill: RegisteredSkill, rank: number) => {
    const have = byId.get(skill.id);
    const better =
      !have || rank < have.rank ||
      (rank === have.rank && rank === 2 && (compareSkillVersions(skill.version, have.skill.version) > 0 || (skill.version === have.skill.version && byteCmp(skill.digest, have.skill.digest) < 0)));
    if (better) byId.set(skill.id, { skill, rank });
  };
  offer(asRegistered(c.skill.package, "candidate"), 0);
  for (const a of approved) {
    if (!isApproved(a)) continue;
    if (a.kind === "registered") offer(a.skill, 1);
    else offer(asRegistered(a.candidate.skill.package, "imported"), 2);
  }
  return [...byId.values()].map((x) => x.skill);
}

export function scoreSelection(
  c: BareCandidate, scenarios: readonly SelectionScenario[], profiles: ReadonlyMap<string, RepoProfile>, approved: readonly ComparedSkill[],
): DimensionScore {
  const skills = selectionRegistry(c, approved);
  const id = c.skill.identity.id;
  const findings: EvaluationFinding[] = [];
  let pass = 0;
  for (const s of scenarios) {
    const profile = profiles.get(s.repo);
    if (!profile) throw new TypeError("a fixture of the suite has no profile");
    const cat = buildSkillCatalogue({ skills }, { profile, task: s.task, modules: s.modules });
    const entry = cat.entries.find((e) => e.id === id);
    const offered = entry !== undefined && entry.evidence.length > 0;
    if (offered === (s.expect === "offered")) pass++;
    else findings.push(finding(offered ? "offered-unexpectedly" : "not-offered", "selection", s.id));
  }
  return { sample: share(pass, scenarios.length), findings };
}

type Baseline = { id: string; version: string; digest: string };
/** True when the baseline cannot be replaced by the candidate: it needs the same id, a lower version and other content. */
function baselineProblem(c: BareCandidate, m: Member): boolean {
  const id = c.skill.identity;
  if (m.id !== id.id || compareSkillVersions(m.version, id.version) >= 0 || m.digest === id.digest) return true;
  if (m.entry.kind === "imported") return relateSkills(m.entry.candidate.skill.identity, id) !== "other-version";
  return false;
}

const COLLISION_CODES: Record<string, string> = { "version-reuse": "version-reuse", "id-conflict": "id-conflict", fork: "fork", "capability-overlap": "capability-overlap" };
interface Hit { code: string; other: Member; shared?: string[] }

/** What the candidate collides with among `pool`. Imported members go through the collision classifier; registered ones by a small rule. */
function collisionsWith(c: BareCandidate, pool: readonly Member[]): Hit[] {
  const hits: Hit[] = [];
  const id = c.skill.identity;
  const caps = new Set(c.skill.package.capabilities ?? []);
  for (const m of pool) {
    if (m.entry.kind !== "registered" || m.digest === id.digest) continue;
    if (m.id === id.id) hits.push({ code: m.version === id.version ? "version-reuse" : "id-conflict", other: m });
    else {
      const shared = m.capabilities.filter((x) => caps.has(x)).sort(byteCmp);
      if (shared.length) hits.push({ code: "capability-overlap", other: m, shared });
    }
  }
  const imported = pool.filter((m) => m.entry.kind === "imported");
  if (imported.length) {
    const result = classifySkillCollisions([c, ...imported.map((m) => (m.entry as ImportedCandidate).candidate)]);
    for (const col of result.report.collisions) {
      const code = COLLISION_CODES[col.class];
      if (!code || !col.fingerprints.includes(id.fingerprint)) continue;
      const other = col.members.find((x) => x.fingerprint !== id.fingerprint);
      const m = other && imported.find((i) => (i.entry as ImportedCandidate).candidate.skill.identity.fingerprint === other.fingerprint);
      if (m) hits.push({ code, other: m, ...(col.shared ? { shared: col.shared } : {}) });
    }
  }
  return hits;
}

export function scoreConflicts(
  c: BareCandidate, scenarios: readonly ConflictScenario[], approved: readonly ComparedSkill[], baseline?: ComparedSkill,
): DimensionScore & { mode: EvaluationMode; baseline?: Baseline } {
  const all = approved.filter(isApproved).map(memberOf);
  let pool = all;
  let valid: Member | undefined;
  let badBaseline = false;
  if (baseline) {
    const b = memberOf(baseline);
    if (baselineProblem(c, b)) badBaseline = true;
    else {
      valid = b;
      pool = pool.filter((m) => m.digest !== b.digest);
    }
  }
  const findings: EvaluationFinding[] = [];
  let duplicate = false;
  let winners: Map<string, string | undefined> | undefined;
  const winnerOf = (cap: string): string | undefined => {
    if (!winners) {
      const list = pool.map((m) => (m.entry.kind === "registered" ? canonicalFromRegistered(m.entry.skill) : canonicalFromCollision(m.entry.candidate, { licence: m.entry.licence, safety: m.entry.safety })));
      const caps = [...new Set(pool.flatMap((m) => m.capabilities))].sort(byteCmp);
      const res = selectCanonicalSkills(list, { exclusive: caps, highRisk: [] });
      winners = new Map(res.resolutions.map((r) => [r.capability, r.winner?.id]));
    }
    return winners.get(cap);
  };
  let pass = 0;
  for (const s of scenarios) {
    const mine: EvaluationFinding[] = [];
    let compared = pool;
    if (s.with !== "all") {
      compared = [];
      for (const w of s.with) {
        // Names are resolved against every approved skill; the validated baseline is then left out of the comparison.
        const found = all.filter((m) => m.id === w);
        if (found.length) compared.push(...found.filter((m) => pool.includes(m)));
        else mine.push(finding("compared-skill-missing", "conflicts", s.id, w));
      }
    }
    if (badBaseline) mine.push(finding("baseline-not-replaceable", "conflicts", s.id));
    if (valid) mine.push(finding("upgrade-of", "conflicts", s.id, `${valid.id}@${valid.version}`));
    for (const h of collisionsWith(c, compared)) {
      const at = `${h.other.id}@${h.other.version}`;
      mine.push(finding(h.code, "conflicts", s.id, h.shared ? `${at} shares ${h.shared.join(", ")}` : at));
      if (h.code === "fork") duplicate = true;
      if (h.code === "capability-overlap" && h.shared?.some((cap) => { const w = winnerOf(cap); return w === undefined || w === h.other.id; })) duplicate = true;
    }
    if (!mine.some((f) => FAILING.includes(f.code))) pass++;
    findings.push(...mine);
  }
  const mode: EvaluationMode = valid ? "upgrade" : duplicate ? "duplicate" : "new";
  return { sample: share(pass, scenarios.length), findings, mode, ...(valid ? { baseline: { id: valid.id, version: valid.version, digest: valid.digest } } : {}) };
}

const BUDGET_RE = /^[1-9]\d{0,6}$/;
export function scoreContext(c: BareCandidate, scenarios: readonly ContextScenario[]): DimensionScore {
  const pkg = c.skill.package;
  const tokens = skillContextTokens(pkg);
  const chars = pkg.description.length;
  const budget = (key: string): number | "invalid" | undefined => {
    const v = pkg.metadata?.[key];
    if (v === undefined) return undefined;
    return BUDGET_RE.test(v) ? Number(v) : "invalid";
  };
  const coder = budget("budget-coder-tokens");
  const planner = budget("budget-planner-chars");
  const findings: EvaluationFinding[] = [];
  let pass = 0;
  for (const s of scenarios) {
    const mine: EvaluationFinding[] = [];
    const add = (code: string, detail?: string) => void mine.push(finding(code, "context", s.id, detail));
    if (s.max_instruction_tokens !== undefined && tokens > s.max_instruction_tokens) add("instructions-over-limit", `${tokens} > ${s.max_instruction_tokens}`);
    if (s.max_description_chars !== undefined && chars > s.max_description_chars) add("description-over-limit", `${chars} > ${s.max_description_chars}`);
    if (coder === "invalid") add("budget-invalid", "budget-coder-tokens");
    else if (coder !== undefined && tokens > coder) add("instructions-over-budget", `${tokens} > ${coder}`);
    if (planner === "invalid") add("budget-invalid", "budget-planner-chars");
    else if (planner !== undefined && chars > planner) add("description-over-budget", `${chars} > ${planner}`);
    if (chars > CATALOGUE_DETAIL.full.descriptionChars) add("description-cut", `${chars} > ${CATALOGUE_DETAIL.full.descriptionChars}`);
    if (mine.length === 0) pass++;
    findings.push(...mine);
  }
  return { sample: share(pass, scenarios.length), findings };
}

const ALL_CAPS: Capabilities = { shell: true, network: true, filesystem: "write", sources: { shell: "suite", network: "suite", filesystem: "suite" } };
export function scoreTools(c: BareCandidate, scenarios: readonly ToolsScenario[], safety: DecidedReport): DimensionScore {
  const { id, digest } = { id: c.skill.identity.id, digest: c.skill.package.digest };
  const pkg = c.skill.package;
  const safe: { code: string; detail?: string }[] =
    safety.skill !== id || safety.digest !== digest
      ? [{ code: "safety-mismatch" }]
      : promotionBlockers(safety).map((d) => ({ code: "scan-high-open", detail: d.finding.id }));
  const findings: EvaluationFinding[] = [];
  let pass = 0;
  for (const s of scenarios) {
    const check = checkSkillTools([{ key: id, id, selection: "requested", requiredBy: [], pkg }], ALL_CAPS, { ...s.policy, missing: "stop" }, "flow");
    const mine = [
      ...check.missing.map((m) => finding(m.code, "tools", s.id, m.need)),
      ...safe.map((f) => finding(f.code, "tools", s.id, f.detail)),
    ];
    if (mine.length === 0) pass++;
    findings.push(...mine);
  }
  return { sample: share(pass, scenarios.length), findings };
}

const MAX_FINDINGS = EVALUATION_LIMITS.findings;
/** Pure. Throws TypeError for a profile that is missing; RangeError comes from classifySkillCollisions. */
export function scoreEvaluation(input: EvaluationScoreInput): EvaluationScore {
  const { suite } = input;
  const c = bareCandidate(input.candidate);
  const approved = input.approved.map(bareCompared);
  const baseline = input.baseline ? bareCompared(input.baseline) : undefined;
  const selection = scoreSelection(c, suite.selection, input.profiles, approved);
  const conflicts = scoreConflicts(c, suite.conflicts, approved, baseline);
  const context = scoreContext(c, suite.context);
  const tools = scoreTools(c, suite.tools, input.safety);
  const dimensions: Partial<Record<EvaluationDimension, number[]>> = {};
  const parts: Record<string, DimensionScore> = { selection, conflicts, context, tools };
  for (const d of EVALUATION_OFFLINE) dimensions[d] = [parts[d]!.sample];
  let findings = [selection, conflicts, context, tools].flatMap((p) => p.findings).sort((a, b) => byteCmp(canonicalJson(a), canonicalJson(b)));
  if (findings.length > MAX_FINDINGS) findings = [...findings.slice(0, MAX_FINDINGS - 1), { code: "findings-truncated" }];
  return {
    suite: { digest: evaluationSuiteDigest(suite, input.profiles), scenarios: suiteScenarios(suite) },
    dimensions,
    findings,
    mode: conflicts.mode,
    ...(conflicts.baseline ? { baseline: conflicts.baseline } : {}),
  };
}
