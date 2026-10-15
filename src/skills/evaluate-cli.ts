import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { selectCanonicalSkills } from "./canonical.js";
import { canonicalFromRegistered } from "./canonical-facts.js";
import { filesOf, hidden, loadExceptions, plural, stagedImport, type StagedImport } from "./staged-import.js";
import { collisionCandidate, type CollisionCandidate } from "./collisions.js";
import { evaluationGate, parseEvaluationRecord, type EvaluationGateInput, type EvaluationReason, type EvaluationRecord, type EvaluationSubject } from "./evaluation.js";
import { EVALUATION_LIMITS, EVALUATION_REASON_CODES, EVALUATION_SUITE_DEFAULT, type EvaluationDimension, type EvaluationMode } from "./evaluation-rules.js";
import { scoreEvaluation, type ComparedSkill, type EvaluationScore } from "./evaluation-score.js";
import { EvaluationStoreError, findNewestRecordOf, readNewestRecord, writeEvaluationRecord, type StoredRecordRead } from "./evaluation-store.js";
import { instructionsPolicy, type EvaluationAgent } from "./evaluation-instructions.js";
import { readEvaluationSuite, type EvaluationSuiteRead } from "./evaluation-suite.js";
import { byteCmp } from "./import-plan.js";
import { evaluateLicence, type LicenceStatus } from "./licence.js";
import { normalizeImport, type NormalizedSkill } from "./normalize.js";
import { discoverSkills, type DiscoverOptions, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { SKILL_ID_RE } from "./schema.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, type DecidedReport, type ScanException } from "./scan-exceptions.js";
import { shownValue, type SourcesManifest } from "./sources.js";

// `scf skills score` and `scf skills gate`: offline. `score` scores every staged skill with the suite and stores one record each
// (evaluation-store.ts); `gate` reads the newest records and prints PASSED, FAILED or PROBLEM. All decisions come from the pure
// modules (evaluation-score.ts, evaluation.ts); this file reads files, picks the mode and the baseline, and prints. It starts no
// process and calls no model. It writes only below <data folder>/skill-evaluations/.

export interface EvaluateCliOptions {
  cwd: string;
  home?: string;
  today: string;
  now: Date;
  skills?: Config["skills"];
  discover: DiscoverOptions;
  /** The parsed skill-sources.yaml to use instead of reading the file. */
  sources?: SourcesManifest;
}
export type Out = (line: string) => void;

export function evaluateOperandsProblem(sub: "score" | "gate", operands: string[]): string | undefined {
  if (operands.length < 1 || operands.length > 2) return `scf skills ${sub}: expects a source id and at most one suite file`;
  if (!SKILL_ID_RE.test(operands[0]!)) return `scf skills ${sub}: the first operand must be a source id`;
  return undefined;
}

/** Problems of the registry that hide approved skills. `root-missing` and `duplicate` are normal; `integrity` is handled per skill. */
export function registryBlockers(reg: SkillRegistry): string[] {
  const kinds = ["root-unreadable", "root-refused", "invalid-package", "too-many", "lock"];
  return reg.problems
    .filter((p) => p.source !== "repository" && kinds.includes(p.kind))
    .map((p) => `${hidden(p.label)}${p.package ? ` ${hidden(p.package)}` : ""}: ${hidden(p.reason)}`);
}

export interface GateChecks {
  /** The other skills of the same import that share a capability, sorted by id. */
  rivals: NormalizedSkill[];
  upgrade: boolean;
  /** The approved skills an upgrade is compared with; every comparison must pass. Empty when no skill can be compared. */
  baselines: RegisteredSkill[];
  /** A shared capability has no canonical winner to compare with. */
  unresolved: boolean;
  /** The first of `baselines`. */
  baseline?: RegisteredSkill;
  /** Relevant approved skills that are not pinned: the comparison cannot be trusted. */
  unverified: RegisteredSkill[];
}

const capsOf = (s: NormalizedSkill): string[] => s.package.capabilities ?? [];

/** Pure. The mode and the baseline of one candidate against the approved skills. */
export function gateChecks(candidate: NormalizedSkill, peers: readonly NormalizedSkill[], approved: readonly RegisteredSkill[]): GateChecks {
  const id = candidate.package.id;
  const mine = new Set(capsOf(candidate));
  const shares = (caps: readonly string[]) => caps.filter((c) => mine.has(c));
  const rivals = peers
    .filter((p) => p !== candidate && p.package.id !== id && shares(capsOf(p)).length > 0)
    .sort((a, b) => byteCmp(a.package.id, b.package.id));
  const sameArtifact = (a: RegisteredSkill) => a.id === id && a.version === candidate.package.version && a.digest === candidate.package.digest;
  const relevant = approved.filter((a) => a.active && a.trust !== "unapproved" && !sameArtifact(a) && (a.id === id || shares(a.pkg.capabilities ?? []).length > 0));
  const unverified = relevant.filter((a) => a.pin !== "pinned");
  // Every comparison counts: the same-id skill, and the canonical winner of each shared capability. A capability without a
  // winner (a conflict) has nothing to compare with: `unresolved` makes the gate fail it as baseline-missing.
  const baselines: RegisteredSkill[] = [];
  let unresolved = false;
  const add = (a: RegisteredSkill | undefined) => {
    if (a && !baselines.includes(a)) baselines.push(a);
  };
  add(relevant.find((a) => a.id === id));
  for (const cap of [...mine].sort(byteCmp)) {
    const sharing = relevant.filter((a) => (a.pkg.capabilities ?? []).includes(cap));
    if (sharing.length === 0) continue;
    const res = selectCanonicalSkills(sharing.map((a) => canonicalFromRegistered(a)), { exclusive: [cap], highRisk: [] });
    const winner = res.resolutions.find((r) => r.capability === cap)?.winner;
    const found = winner && sharing.find((a) => a.id === winner.id && a.version === winner.version);
    if (found) add(found);
    else unresolved = true;
  }
  return { rivals, upgrade: relevant.length > 0, baselines, unresolved, ...(baselines[0] ? { baseline: baselines[0] } : {}), unverified };
}

const foundryVersion = (): string => {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const v = (JSON.parse(readFileSync(join(dir, "../../package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/.test(v) ? v : "unknown";
  } catch {
    return "unknown";
  }
};

export interface Item {
  skill: NormalizedSkill;
  id: string;
  version: string;
  cand: CollisionCandidate;
  safety: DecidedReport;
  licence: LicenceStatus;
  checks: GateChecks;
}
export interface Prepared {
  staged: StagedImport;
  suite: Extract<EvaluationSuiteRead, { state: "ok" }>;
  approved: RegisteredSkill[];
  items: Item[];
  /** PROBLEM lines printed while preparing; they decide the exit code. */
  problems: number;
}

/** What both commands need. Prints PROBLEM lines; returns undefined when nothing can be judged. */
export function prepareEvaluation(id: string, suiteFile: string | undefined, out: Out, opts: EvaluateCliOptions, tail: string): Prepared | undefined {
  let exceptions: ScanException[] = [];
  let suite: Extract<EvaluationSuiteRead, { state: "ok" }> | undefined;
  const staged = stagedImport(
    id,
    out,
    opts,
    () => {
      const read = readEvaluationSuite(resolve(opts.cwd, suiteFile ?? EVALUATION_SUITE_DEFAULT));
      if (read.state === "none") {
        out("PROBLEM the evaluation suite file does not exist");
        return false;
      }
      if (read.state === "invalid") {
        for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
        return false;
      }
      suite = read;
      const ex = loadExceptions(undefined, out, opts);
      if (ex) exceptions = ex;
      return ex !== undefined;
    },
    "evaluated",
  );
  if (!staged || !suite) return undefined;
  const { source, record, files } = staged;

  const reg = discoverSkills(opts.skills ?? loadConfig().skills, { ...opts.discover, repo: undefined });
  const blockers = registryBlockers(reg);
  if (blockers.length > 0) {
    for (const b of blockers) out(`PROBLEM ${b}`);
    return undefined;
  }
  const approved = reg.skills.filter((s) => s.active && s.trust !== "unapproved");

  const { skills: normalized, report: norm } = normalizeImport({ record: { ...record, rejected: [] }, files });
  let problems = 0;
  for (const entry of record.skills) {
    if (normalized.some((s) => s.provenance.root === entry.root)) continue;
    const label = shownValue(entry.root);
    const reasons = norm.quarantined.filter((q) => q.root === label).flatMap((q) => q.reasons.map(hidden));
    out(`PROBLEM ${label}: not normalized (${reasons.join("; ")}); ${tail}`);
    problems++;
  }
  const evidence = staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] };
  const items: Item[] = [];
  for (const skill of [...normalized].sort((a, b) => byteCmp(a.package.id, b.package.id))) {
    const pkg = skill.package;
    const checks = gateChecks(skill, normalized, approved);
    if (checks.unverified.length > 0) {
      const u = checks.unverified[0]!;
      out(`PROBLEM ${pkg.id}: approved skill ${u.key} cannot be verified (${u.pin}); ${tail}`);
      problems++;
      continue;
    }
    const root = skill.provenance.root;
    const safety = applyExceptions(pkg.id, scanSkill({ root, files: filesOf(root, files) }), exceptions, opts.today);
    const licence = evaluateLicence({ root, declared: pkg.license, allow: source.licence.allow, evidence }).status;
    items.push({ skill, id: pkg.id, version: pkg.version, cand: collisionCandidate(skill, source), safety, licence, checks });
  }
  return { staged, suite, approved, items, problems };
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
const short = (p: Prepared) => `${p.staged.source.repositoryKey}@${p.staged.commit.slice(0, 12)} ${p.staged.record.digest} with suite ${p.suite.digest}`;

export interface ScoredItem {
  item: Item;
  score?: EvaluationScore;
  /** Why the item cannot be scored; `writeScores` prints it where it always was printed. */
  problem?: string;
}
export interface ScoringPlan {
  prepared: Prepared;
  scored: ScoredItem[];
}

/** What an agent run adds to the record of one skill (skill-eval/score.ts). */
export interface RecordExtras {
  dimensions?: Partial<Record<EvaluationDimension, number[]>>;
  runtime?: { agent: string; model: string };
  agent?: EvaluationAgent;
  findings?: EvaluationRecord["findings"];
  evidence?: { name: string; digest: string }[];
}

/** The ComparedSkill list and the baseline of one item, for the offline scorer. */
function comparedFor(p: Prepared, it: Item): { approved: ComparedSkill[]; baseline?: ComparedSkill } {
  const { staged, items } = p;
  const same = it.checks.baselines.find((b) => b.id === it.id);
  const baseline = same ? ({ kind: "registered", skill: same } as ComparedSkill) : undefined;
  const approved: ComparedSkill[] = [
    ...p.approved.map((s): ComparedSkill => ({ kind: "registered", skill: s })),
    ...it.checks.rivals.map((r): ComparedSkill => {
      const rid = r.package.id;
      const other = items.find((x) => x.id === rid);
      return { kind: "imported", candidate: collisionCandidate(r, staged.source), licence: other?.licence ?? "missing", safety: other ? promotionBlockers(other.safety).length === 0 : false };
    }),
  ];
  return { approved, ...(baseline ? { baseline } : {}) };
}

/** The offline part of `scf skills score`: prepares the import and scores every staged skill. Writes nothing. */
export function prepareScoring(id: string, suiteFile: string | undefined, out: Out, opts: EvaluateCliOptions): ScoringPlan | undefined {
  const p = prepareEvaluation(id, suiteFile, out, opts, "no record");
  if (!p) return undefined;
  const { suite } = p;
  const scored: ScoredItem[] = [];
  for (const it of p.items) {
    const { approved, baseline } = comparedFor(p, it);
    try {
      scored.push({ item: it, score: scoreEvaluation({ suite: suite.suite, profiles: suite.profiles, instructionFixtures: suite.instructionFixtures, candidate: it.cand, approved, ...(baseline ? { baseline } : {}), safety: it.safety }) });
    } catch (e) {
      if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
      scored.push({ item: it, problem: `${it.id}: cannot be scored (${hidden(e.message)})` });
    }
  }
  return { prepared: p, scored };
}

const meanOf = (s: readonly number[] | undefined): string => (s && s.length ? (s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : "-");

/** Validates and stores one record per scored skill and prints the lines. Returns 1 when a PROBLEM was printed. */
export function writeScores(plan: ScoringPlan, out: Out, opts: EvaluateCliOptions, extras?: ReadonlyMap<string, RecordExtras>): number {
  const p = plan.prepared;
  const { staged } = p;
  let problems = p.problems;
  let written = 0;
  for (const { item: it, score, problem } of plan.scored) {
    if (problem !== undefined || !score) {
      out(`PROBLEM ${problem ?? it.id}`);
      problems++;
      continue;
    }
    const { skill } = it;
    const extra = extras?.get(it.id);
    const pkg = skill.package;
    let findings = score.findings;
    if (extra?.findings?.length) {
      const all = [...findings.filter((f) => f.code !== "findings-truncated"), ...extra.findings];
      const cap = EVALUATION_LIMITS.findings;
      findings = all.length > cap ? [...all.slice(0, cap - 1), { code: "findings-truncated" }] : all;
    }
    const raw = {
      schema: 1,
      candidate: { id: it.id, version: it.version, digest: pkg.digest, fingerprint: skill.identity.fingerprint, source: staged.source.id, repositoryKey: staged.record.repositoryKey, commit: staged.commit },
      suite: score.suite,
      runtime: { foundry: foundryVersion(), ...(extra?.runtime ?? {}) },
      evaluatedAt: stamp(opts.now),
      dimensions: { ...score.dimensions, ...(extra?.dimensions ?? {}) },
      findings,
      evidence: [{ name: "import", digest: staged.record.digest }, { name: "scan", digest: it.safety.report }, ...(extra?.evidence ?? [])],
      ...(extra?.agent ? { agent: extra.agent } : {}),
    };
    const parsed = parseEvaluationRecord(raw);
    if (!("record" in parsed)) {
      out(`PROBLEM ${it.id}: the record is not valid (${hidden(parsed.problem)}); no record`);
      problems++;
      continue;
    }
    try {
      writeEvaluationRecord(parsed.record, { home: opts.home });
    } catch (e) {
      out(`PROBLEM ${e instanceof EvaluationStoreError ? e.message : "the evaluation folder cannot be written"}; records written before it are kept`);
      return 1;
    }
    written++;
    for (const f of parsed.record.findings) out(`FINDING ${it.id} ${f.code} ${f.scenario ?? "-"}${f.detail !== undefined ? `: ${hidden(f.detail)}` : ""}`);
    const mean = (d: EvaluationDimension) => meanOf(parsed.record.dimensions[d]);
    const ins = parsed.record.dimensions.instructions;
    out(`SCORED ${it.id}@${it.version} ${score.mode}: selection=${mean("selection")} conflicts=${mean("conflicts")} context=${mean("context")} tools=${mean("tools")}${ins ? ` instructions=${meanOf(ins)}` : ""}`);
  }
  out(`EVALUATED ${plural(staged.record.skills.length, "skill")} from ${short(p)}: ${plural(written, "record")} written to skill-evaluations/${staged.source.id}/${staged.commit.slice(0, 12)}`);
  return problems > 0 ? 1 : 0;
}

/** `scf skills score`: scores every staged skill and stores one record each. Returns 1 when a PROBLEM was printed. */
export function scoreImport(id: string, suiteFile: string | undefined, out: Out, opts: EvaluateCliOptions): number {
  const plan = prepareScoring(id, suiteFile, out, opts);
  return plan ? writeScores(plan, out, opts) : 1;
}

type Subject = { record: unknown; problem?: string };
const subjectOf = (r: StoredRecordRead): Subject => (r.state === "ok" ? { record: r.raw } : { record: undefined, problem: r.state === "invalid" ? r.problem : undefined });

export interface JudgedItem {
  item: Item;
  passed: boolean;
  modes: EvaluationMode[];
  codes: string[];
  notes: string[];
  record: StoredRecordRead;
}

/** Judges the newest record of every item: the decision of `scf skills gate`, kept in one place. */
export function judgeItems(p: Prepared, opts: { home?: string }): JudgedItem[] {
  const { staged, suite, items } = p;
  const home = opts.home;
  const policy = instructionsPolicy(suite.suite, suite.digest);
  const subjectFor = (it: Item, r: StoredRecordRead): EvaluationSubject & { problem?: string } => {
    const s = subjectOf(r);
    return { record: s.record, digest: it.skill.package.digest, safety: it.safety, licence: it.licence, ...(s.problem ? { problem: s.problem } : {}) };
  };
  const judged: JudgedItem[] = [];
  for (const it of items) {
    const { checks } = it;
    const record = readNewestRecord(staged.source.id, staged.commit, it.id, { home });
    const me = subjectFor(it, record);
    const modes: EvaluationMode[] = [];
    const reasons: EvaluationReason[] = [];
    const notes: string[] = [];
    let ok = true;
    const take = (input: EvaluationGateInput, mine: (v: { candidate: { digest: string }; outcome: string; reasons: EvaluationReason[] }) => boolean) => {
      const result = evaluationGate(input);
      for (const v of result.verdicts.filter(mine)) {
        if (v.outcome !== "passed") ok = false;
        reasons.push(...v.reasons);
      }
    };
    const own = (v: { candidate: { digest: string } }) => v.candidate.digest === it.skill.package.digest;
    if (checks.upgrade) {
      modes.push("upgrade");
      // One comparison per baseline; the skill passes only when all of them pass. Without a baseline: baseline-missing.
      const list: (RegisteredSkill | undefined)[] = [...checks.baselines, ...(checks.unresolved || checks.baselines.length === 0 ? [undefined] : [])];
      for (const b of list) {
        // No stored record: the gate may still pair a baseline of the candidate's own record, else it gives baseline-missing.
        let baseInput: { record?: unknown; digest: string; id?: string } | undefined;
        if (b) {
          const found = findNewestRecordOf(b.id, b.digest, { home });
          baseInput = { record: found.state === "ok" ? found.raw : found.state === "invalid" ? null : undefined, digest: b.digest, id: b.id };
          if (found.state === "invalid") notes.push(`baseline ${b.key}: ${found.problem}`);
        }
        take({ mode: "upgrade", policy, candidate: me, ...(baseInput ? { baseline: baseInput } : {}) }, own);
      }
    }
    if (checks.rivals.length > 0) {
      modes.push("duplicate");
      for (const r of checks.rivals) {
        const other = items.find((x) => x.id === r.package.id);
        if (!other) {
          // the rival could not be judged (not normalized or unverifiable): this skill cannot be compared with it
          ok = false;
          reasons.push({ code: "record-invalid" });
          continue;
        }
        take({ mode: "duplicate", policy, candidates: [me, subjectFor(other, readNewestRecord(staged.source.id, staged.commit, other.id, { home }))] }, own);
      }
    }
    if (modes.length === 0) {
      modes.push("new");
      take({ mode: "new", policy, candidate: me }, own);
    }
    if (me.problem) notes.push(me.problem);
    else if (me.record === undefined) notes.push(`no record; run "scf skills score ${staged.source.id}"`);
    const codes = [...new Map(reasons.map((r) => [`${r.code}:${r.dimension ?? r.finding ?? r.licence ?? ""}`, r])).values()]
      .sort((a, b) => EVALUATION_REASON_CODES.indexOf(a.code) - EVALUATION_REASON_CODES.indexOf(b.code) || byteCmp(a.dimension ?? "", b.dimension ?? ""))
      .map((r) => (r.dimension ?? r.finding ?? r.licence ? `${r.code}:${r.dimension ?? r.finding ?? r.licence}` : r.code));
    judged.push({ item: it, passed: ok && codes.length === 0, modes, codes, notes, record });
  }
  return judged;
}

/** `scf skills gate`: judges the newest record of every staged skill. Returns 1 when a skill fails or a PROBLEM was printed. */
export function gateImport(id: string, suiteFile: string | undefined, out: Out, opts: EvaluateCliOptions): number {
  const p = prepareEvaluation(id, suiteFile, out, opts, "it cannot be promoted");
  if (!p) return 1;
  const { staged } = p;
  if (staged.source.status !== "enabled") {
    out(`PROBLEM the source ${staged.source.id} is ${staged.source.status}; only an enabled source can be promoted`);
    return 1;
  }
  const problems = p.problems;
  let passed = 0;
  let failed = 0;
  for (const j of judgeItems(p, opts)) {
    const { item: it, modes, codes, notes } = j;
    const head = `${it.id}@${it.version} ${modes.join(",")}`;
    if (j.passed) {
      passed++;
      out(`PASSED ${head}`);
    } else {
      failed++;
      out(`FAILED ${head}: ${codes.join(", ") || "record-invalid"}${notes.length ? ` (${notes.map(hidden).join("; ")})` : ""}`);
    }
  }
  out(`GATED ${plural(staged.record.skills.length, "skill")} from ${short(p)}: ${passed} passed, ${failed} failed`);
  return failed > 0 || problems > 0 ? 1 : 0;
}
