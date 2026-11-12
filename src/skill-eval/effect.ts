import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dataHome } from "../auth/store.js";
import { loadConfig } from "../config.js";
import { buildSkillCatalogue } from "../skills/catalogue.js";
import { effectLines, effectVerdict, parseEffectRecord, type EffectOperands, type EffectRecord, type EffectRun, type EffectScenario } from "../skills/effect.js";
import { EVALUATION_SUITE_DEFAULT, EVALUATION_SUITE_LIMITS } from "../skills/evaluation-rules.js";
import type { InstructionsSuite } from "../skills/evaluation-instructions.js";
import { EvaluationStoreError, writeEffectRecord } from "../skills/evaluation-store.js";
import { readEvaluationSuite } from "../skills/evaluation-suite.js";
import { foundryVersion, prepareScoring, registryBlockers } from "../skills/evaluate-cli.js";
import { discoverSkills, type RegisteredSkill } from "../skills/registry.js";
import { buildRepoProfile, type RepoProfile } from "../skills/repo-profile.js";
import type { SkillPackage } from "../skills/schema.js";
import { hidden } from "../skills/staged-import.js";
import { policyAllows, skillNeeds } from "../skills/tool-policy.js";
import { snapshotFixtures } from "./fixture.js";
import { copyBaselinePackage, loadLocalSkill, writeCandidatePackage } from "./package.js";
import { agentPreflight, blockedReason, INTERRUPTED, type AgentScoreOptions } from "./score.js";
import { EvaluationInterrupted, runArm, type Arm, type ArmContext, type ArmRun } from "./run.js";

// `scf skills effect`: the instructions scenarios of a suite where the skill is offered, run in the OS sandbox with the skill and
// without it (skills off), `repeat` times each on the same model. The verdict comes from skills/effect.ts; one record is stored
// under skill-effects/. Like `score --agent`, this switches the data folder of the whole process while an arm runs: run it only
// from the command line. Both arms always run when anything is offered; nothing is stored unless everything ended.

export interface AgentEffectOptions extends AgentScoreOptions {
  /** Tests: replaces the arm runner. */
  runArm?: typeof runArm;
  /**
   * Only the arm without the skill, each offered scenario once, and no record: a scenario that passes without the skill is too easy
   * to tell the arms apart. Prints `SCREEN <id>: …` lines and `SCREEN: retask` or `SCREEN: ok`.
   */
  screen?: boolean;
}

/** The line a shell step of a flow prints so that the agent runs it started count toward the run's cost (src/engine/execute.ts). */
export const STEP_COST_PREFIX = "FACTORY_STEP_COST_USD:";
const costLine = (usd: number) => `${STEP_COST_PREFIX} ${(Math.round(usd * 1e4) / 1e4).toFixed(4)}`;
type Out = (line: string) => void;

const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

/** The skill as the selection catalogue sees it: always active, approved and pinned (the caller has checked that). */
export function effectEntry(pkg: SkillPackage): RegisteredSkill {
  return { key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: "effect", dir: "", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg };
}

const NEED_WORDS = { shell: "a shell", network: "network access", write: "write access" } as const;
const NEED_KEYS = { shell: "shell: true", network: "network: true", write: "filesystem: write" } as const;

/**
 * Instructions scenarios whose policy denies a tool the skill needs (a skill with scripts/ needs a shell). The session leaves such a skill
 * out, so the scenario can never load it: the "with" runs would be runs without the skill. Each entry is a sentence for a PROBLEM line.
 */
export function scenarioToolGaps(pkg: SkillPackage, ins: InstructionsSuite): { id: string; problem: string }[] {
  const needs = skillNeeds(pkg).filter((n): n is keyof typeof NEED_WORDS => n in NEED_WORDS);
  const scripts = pkg.tool_profile?.shell === true ? " (it has scripts/ or declares a shell)" : "";
  return ins.scenarios.flatMap((s) => {
    const missing = needs.filter((n) => !policyAllows(n, { ...s.policy, missing: "degrade" }));
    if (!missing.length) return [];
    const what = missing.map((n) => NEED_WORDS[n]).join(" and ");
    return [{ id: s.id, problem: `scenario ${s.id}: the skill needs ${what}${missing.includes("shell") ? scripts : ""}, which its policy does not give, so it can never be loaded; set ${missing.map((n) => NEED_KEYS[n]).join(", ")} in its policy` }];
  });
}

/**
 * Every instructions scenario of the suite, with whether the skill is offered for its fixture and task: the selection catalogue gives
 * the skill an entry with evidence. The skill is alone in the catalogue. Throws RangeError when a fixture cannot be profiled.
 */
export function scenarioOffers(skill: RegisteredSkill, suiteDir: string, ins: InstructionsSuite): EffectScenario[] {
  const L = EVALUATION_SUITE_LIMITS;
  const profiles = new Map<string, RepoProfile>();
  return ins.scenarios.map((s) => {
    let profile = profiles.get(s.repo);
    if (!profile) {
      try {
        profile = buildRepoProfile(join(suiteDir, s.repo), { limits: { files: L.fixtureFiles, fileBytes: L.fixtureFileBytes, totalBytes: L.fixtureTotalBytes } });
        profiles.set(s.repo, profile);
      } catch {
        throw new RangeError(`instructions fixture ${hidden(s.repo)} cannot be profiled`);
      }
    }
    let offered = false;
    try {
      const cat = buildSkillCatalogue({ skills: [skill] }, { profile, task: s.task });
      const entry = cat.entries.find((e) => e.id === skill.id);
      offered = entry !== undefined && entry.evidence.length > 0;
    } catch {
      throw new RangeError(`instructions fixture ${hidden(s.repo)} cannot be profiled`);
    }
    return { id: s.id, task: s.task, offered };
  });
}

interface Resolved {
  id: string;
  version: string;
  digest: string;
  entry: RegisteredSkill;
  origin?: { source: string; commit: string };
  write: NonNullable<Arm["write"]>;
  suiteDigest: string;
  ins: InstructionsSuite | undefined;
  instructionFixtures: ReadonlyMap<string, string>;
  suiteDir: string;
}

function resolveStaged(ops: Extract<EffectOperands, { kind: "staged" }>, out: Out, opts: AgentEffectOptions): Resolved | undefined {
  const plan = prepareScoring(ops.source, ops.suiteFile, out, opts);
  if (!plan) return undefined;
  const item = plan.prepared.items.find((i) => i.id === ops.skill);
  if (!item) {
    out(`PROBLEM ${ops.skill} is not a staged skill of ${ops.source}`);
    return undefined;
  }
  const why = blockedReason(item);
  if (why) {
    out(`PROBLEM ${item.id}: ${why}; no agent run`);
    return undefined;
  }
  const suite = plan.prepared.suite;
  const staged = plan.prepared.staged;
  const pkg = item.skill.package;
  return {
    id: item.id,
    version: item.version,
    digest: pkg.digest,
    entry: effectEntry(pkg),
    origin: { source: staged.source.id, commit: staged.commit },
    write: (dir) => writeCandidatePackage(item.skill, dir),
    suiteDigest: suite.digest,
    ins: suite.suite.instructions,
    instructionFixtures: suite.instructionFixtures,
    suiteDir: dirname(resolve(opts.cwd, ops.suiteFile ?? EVALUATION_SUITE_DEFAULT)),
  };
}

/** A skill folder of the working tree: read strictly and scanned as a whole, then `evals/` is dropped for the arm. The record has no source and no commit. */
function resolveLocal(ops: Extract<EffectOperands, { kind: "local" }>, out: Out, opts: AgentEffectOptions): Resolved | undefined {
  const dir = resolve(opts.cwd, ops.dir);
  const loaded = loadLocalSkill(dir);
  for (const n of loaded.notes) out(`NOTE ${n}`);
  for (const p of loaded.problems) out(`PROBLEM ${hidden(p)}`);
  if (loaded.problems.length > 0 || !loaded.skill) return undefined;
  const file = ops.suiteFile ? resolve(opts.cwd, ops.suiteFile) : join(dir, "evals", "suite.yaml");
  const read = readEvaluationSuite(file);
  if (read.state === "none") {
    out("PROBLEM the evaluation suite file does not exist");
    return undefined;
  }
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return undefined;
  }
  const skill = loaded.skill;
  const pkg = skill.package;
  return {
    id: pkg.id,
    version: pkg.version,
    digest: pkg.digest,
    entry: effectEntry(pkg),
    write: (to) => writeCandidatePackage(skill, to),
    suiteDigest: read.digest,
    ins: read.suite.instructions,
    instructionFixtures: read.instructionFixtures,
    suiteDir: dirname(file),
  };
}

function resolveApproved(ops: Extract<EffectOperands, { kind: "approved" }>, out: Out, opts: AgentEffectOptions): Resolved | undefined {
  const file = resolve(opts.cwd, ops.suiteFile ?? EVALUATION_SUITE_DEFAULT);
  const read = readEvaluationSuite(file);
  if (read.state === "none") {
    out("PROBLEM the evaluation suite file does not exist");
    return undefined;
  }
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return undefined;
  }
  const reg = discoverSkills(opts.skills ?? loadConfig().skills, { ...opts.discover, repo: undefined });
  const blockers = registryBlockers(reg);
  if (blockers.length > 0) {
    for (const b of blockers) out(`PROBLEM ${b}`);
    return undefined;
  }
  const key = `${ops.id}@${ops.version}`;
  const b = reg.byKey.get(key);
  if (!b || !b.active || b.trust === "unapproved" || b.pin !== "pinned") {
    out(`PROBLEM ${key} is not an active, approved and pinned skill`);
    return undefined;
  }
  return {
    id: b.id,
    version: b.version,
    digest: b.digest,
    entry: b,
    write: (dir) => {
      const copied = copyBaselinePackage(b, dir);
      return "problem" in copied ? copied : { digest: b.digest };
    },
    suiteDigest: read.digest,
    ins: read.suite.instructions,
    instructionFixtures: read.instructionFixtures,
    suiteDir: dirname(file),
  };
}

const toRun = (r: ArmRun): EffectRun => ({ scenario: r.scenario, attempt: r.attempt, runId: r.runId, pass: r.passed, loaded: r.loaded, tokens: r.tokens, durationMs: r.durationMs });

export async function effectWithAgent(ops: EffectOperands, out: Out, opts: AgentEffectOptions): Promise<number> {
  const skill = ops.kind === "staged" ? resolveStaged(ops, out, opts) : ops.kind === "local" ? resolveLocal(ops, out, opts) : resolveApproved(ops, out, opts);
  if (!skill) return 1;
  const label = `${skill.id}@${skill.version}`;
  const config = opts.config ?? loadConfig();
  const ready = agentPreflight(skill.ins, config, { signal: opts.signal, who: "scf skills effect" }, out);
  if (!ready) return 1;
  const { target, outbound } = ready;
  const ins = skill.ins!; // agentPreflight refuses a suite without scenarios

  let scenarios: EffectScenario[];
  try {
    scenarios = scenarioOffers(skill.entry, skill.suiteDir, ins);
  } catch (e) {
    out(`PROBLEM ${e instanceof RangeError ? e.message : "an instructions fixture cannot be profiled"}`);
    return 1;
  }
  const gaps = scenarioToolGaps(skill.entry.pkg, ins);
  for (const g of gaps) out(`PROBLEM ${g.problem}`);
  const blocked = new Set(gaps.map((g) => g.id));
  // Such a scenario counts as not offered: it is not run, and the record says so.
  scenarios = scenarios.map((s) => (blocked.has(s.id) ? { ...s, offered: false } : s));
  const offeredIds = new Set(scenarios.filter((s) => s.offered).map((s) => s.id));
  const offered: InstructionsSuite = { ...ins, scenarios: ins.scenarios.filter((s) => offeredIds.has(s.id)) };
  const runs: { with: EffectRun[]; without: EffectRun[] } = { with: [], without: [] };

  if (offered.scenarios.length > 0) {
    const ctrl = new AbortController();
    const onSignal = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onSignal);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let root: string | undefined;
    try {
      root = realpathSync(mkdtempSync(join(tmpdir(), "scf-skill-eval-")));
      opts.onTempRoot?.(root);
      const snaps = await snapshotFixtures(skill.suiteDir, offered, skill.instructionFixtures, root, ctrl.signal);
      if ("problem" in snaps) {
        out(`PROBLEM ${snaps.problem}`);
        return 1;
      }
      out(`NOTE network: not host-limited; outbound is limited to port ${outbound.port}, not to the model's host`);
      const ctx: ArmContext = {
        root,
        realHome: dataHome(),
        realConfig: config,
        target,
        outbound,
        suite: offered,
        snapshots: snaps.repos,
        fixtureDirs: [...new Set(snaps.repos.values())],
        claudeBin: opts.claudeBin,
        deadlines: opts.deadlines,
        signal: ctrl.signal,
        onRunStarted: opts.onRunStarted,
      };
      const run = opts.runArm ?? runArm;
      if (opts.screen) {
        const once = await run({ key: "no-skill" }, { ...ctx, suite: { ...offered, repeat: 1 } });
        if ("problem" in once) {
          out(`PROBLEM ${label}: ${once.problem}`);
          return 1;
        }
        let easy = 0;
        for (const s of offered.scenarios) {
          const passed = once.runs.filter((r) => r.scenario === s.id && r.passed).length > 0;
          if (passed) easy++;
          out(`SCREEN ${s.id}: ${passed ? "passes without the skill: too easy, it tests nothing the skill teaches" : "fails without the skill"}`);
        }
        out(costLine(once.runs.reduce((n, r) => n + r.costUsd, 0)));
        out(`SCREEN: ${easy > 0 ? "retask" : "ok"}`);
        return 0;
      }
      const withSkill = await run({ skillId: skill.id, key: label, write: skill.write }, ctx);
      if ("problem" in withSkill) {
        out(`PROBLEM ${label}: ${withSkill.problem}; no record`);
        return 1;
      }
      const without = await run({ key: "no-skill" }, ctx);
      if ("problem" in without) {
        out(`PROBLEM ${label}: ${without.problem}; no record`);
        return 1;
      }
      runs.with = withSkill.runs.map(toRun);
      runs.without = without.runs.map(toRun);
      out(costLine([...withSkill.runs, ...without.runs].reduce((n, r) => n + r.costUsd, 0)));
    } catch (e) {
      if (!(e instanceof EvaluationInterrupted)) out(`PROBLEM ${hidden(e instanceof Error ? e.message : "error")}`);
      out(INTERRUPTED);
      return 1;
    } finally {
      opts.signal?.removeEventListener("abort", onSignal);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }

  if (opts.screen) {
    out(`PROBLEM ${label}: no sample task offers the skill; nothing to screen`);
    return 1;
  }
  const raw: EffectRecord = {
    schema: 1,
    skill: { id: skill.id, version: skill.version, digest: skill.digest, ...(skill.origin ?? {}) },
    suite: { digest: skill.suiteDigest, repeat: ins.repeat },
    runtime: { foundry: foundryVersion(), node: process.version, agent: target.agent, model: target.model ?? "default" },
    ranAt: stamp(opts.now),
    scenarios,
    runs,
    verdict: effectVerdict({ scenarios, with: runs.with, without: runs.without }),
  };
  const parsed = parseEffectRecord(raw);
  if (!("record" in parsed)) {
    out(`PROBLEM the record is not valid (${hidden(parsed.problem)}); no record`);
    return 1;
  }
  let stored: { file: string };
  try {
    stored = writeEffectRecord(parsed.record, { home: opts.home });
  } catch (e) {
    out(`PROBLEM ${e instanceof EvaluationStoreError ? e.message : "the effect folder cannot be written"}`);
    return 1;
  }
  for (const line of effectLines(parsed.record)) out(line);
  out(`STORED ${stored.file}`);
  return 0;
}
