import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { missingAgentKey } from "../agents/boxed.js";
import { specOf, toTarget, type Target } from "../agents/targets.js";
import { dataHome } from "../auth/store.js";
import { loadConfig, type Config } from "../config.js";
import { sandboxAvailable } from "../engine/os-sandbox.js";
import { EVALUATION_SUITE_DEFAULT, type EvaluationDimension } from "../skills/evaluation-rules.js";
import { scoreEvaluation, type ComparedSkill } from "../skills/evaluation-score.js";
import type { EvaluationAgent, EvaluationAgentBaseline, EvaluationAgentRun } from "../skills/evaluation-instructions.js";
import { prepareScoring, writeScores, type EvaluateCliOptions, type Item, type RecordExtras, type ScoredItem } from "../skills/evaluate-cli.js";
import { hidden, loadExceptions } from "../skills/staged-import.js";
import { applyExceptions, promotionBlockers, type ScanException } from "../skills/scan-exceptions.js";
import { scanSkill } from "../skills/scan.js";
import { registeredCandidate } from "../skills/source-skill-evaluation.js";
import { snapshotFixtures } from "./fixture.js";
import { copyBaselinePackage, packageScanFiles, writeCandidatePackage } from "./package.js";
import {
  agentEnvFor, evaluationConfig, EvaluationInterrupted, outboundFor, runArm, type Arm, type ArmContext, type ArmRun,
} from "./run.js";

// `scf skills score <source-id> [suite] --agent`: the offline score, plus the instructions scenarios run in the OS sandbox with the candidate
// and with every baseline (at most 4), `repeat` times each. The arms run one after another. The record is written only when everything ended.

export interface AgentScoreOptions extends EvaluateCliOptions {
  /** Default: the real configuration, read before anything is switched. */
  config?: Config;
  claudeBin?: string;
  signal?: AbortSignal;
  /** Tests: shorter deadlines. */
  deadlines?: { fixtureSec: number; checkSec: number };
  onRunStarted?: (runId: string) => void;
  /** Tests: the temporary root, once it is made. */
  onTempRoot?: (dir: string) => void;
}
type Out = (line: string) => void;

export const INTERRUPTED = "PROBLEM the evaluation was interrupted";
const MAX_BASELINES = 4;

function blockedReason(it: Item): string | undefined {
  const blockers = promotionBlockers(it.safety).length;
  if (blockers > 0) return `${blockers} promotion blocker${blockers === 1 ? "" : "s"}`;
  if (it.licence !== "allowed") return `licence ${it.licence}`;
  return undefined;
}

/** The refusals that come before anything is made. Returns the target and the outbound rule, or prints a PROBLEM. */
function preflight(plan: NonNullable<ReturnType<typeof prepareScoring>>, config: Config, opts: AgentScoreOptions, out: Out): { target: Target; outbound: ReturnType<typeof outboundFor> } | undefined {
  const refuse = (why: string) => {
    out(`PROBLEM ${why}`);
    return undefined;
  };
  if (!sandboxAvailable()) return refuse("the OS sandbox is not available on this computer; --agent runs only in the sandbox");
  if (process.env.SCF_USER_SANDBOX === "off" || process.env.FACTORY_USER_SANDBOX === "off") return refuse("the sandbox is switched off (SCF_USER_SANDBOX or FACTORY_USER_SANDBOX); --agent runs only in the sandbox");
  const ins = plan.prepared.suite.suite.instructions;
  if (!ins || ins.scenarios.length === 0) return refuse("the suite has no instructions scenarios; there is nothing to run with --agent");
  let target: Target;
  try {
    target = toTarget(specOf(config.default_model, config), config);
  } catch (e) {
    return refuse(`the default model cannot be used (${hidden((e as Error).message)})`);
  }
  if (target.agent !== "claude") return refuse(`the default model runs with ${target.agent}; --agent needs Claude Code`);
  let env: NodeJS.ProcessEnv;
  try {
    env = agentEnvFor(target, evaluationConfig(config, { shell: false, network: false, filesystem: "read" }, []), process.env);
  } catch (e) {
    return refuse(`the default model cannot be used (${hidden((e as Error).message)})`);
  }
  const missing = missingAgentKey(target, env);
  if (missing) return refuse(missing);
  let outbound: ReturnType<typeof outboundFor>;
  try {
    outbound = outboundFor(env);
  } catch {
    return refuse("the base URL of the model is not valid");
  }
  for (const s of plan.scored) {
    if (s.item.checks.baselines.length > MAX_BASELINES) return refuse(`${s.item.id}: ${s.item.checks.baselines.length} baselines; at most ${MAX_BASELINES} can be run`);
  }
  if (opts.signal?.aborted) return refuse("the evaluation was interrupted");
  return { target, outbound };
}

export async function scoreImportWithAgent(id: string, suiteFile: string | undefined, out: Out, opts: AgentScoreOptions): Promise<number> {
  const plan = prepareScoring(id, suiteFile, out, opts);
  if (!plan) return 1;
  const config = opts.config ?? loadConfig();
  const ready = preflight(plan, config, opts, out);
  if (!ready) return 1;
  const { target, outbound } = ready;
  const { prepared } = plan;
  const suite = prepared.suite;
  const ins = suite.suite.instructions!;

  let problems = 0;
  const runnable: ScoredItem[] = [];
  for (const s of plan.scored) {
    if (!s.score) continue; // writeScores prints why
    const why = blockedReason(s.item);
    if (why) out(`SKIPPED ${s.item.id}: ${why}; no agent run`);
    else runnable.push(s);
  }
  const extras = new Map<string, RecordExtras>();
  if (runnable.length > 0) {
    const ctrl = new AbortController();
    const onSignal = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onSignal);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let root: string | undefined;
    try {
      root = realpathSync(mkdtempSync(join(tmpdir(), "scf-skill-eval-")));
      opts.onTempRoot?.(root);
      const suiteDir = dirname(resolve(opts.cwd, suiteFile ?? EVALUATION_SUITE_DEFAULT));
      const snaps = await snapshotFixtures(suiteDir, ins, suite.instructionFixtures, root, ctrl.signal);
      if ("problem" in snaps) {
        out(`PROBLEM ${snaps.problem}`);
        return 1;
      }
      out(`NOTE network: not host-limited; outbound is limited to port ${outbound.port}, not to the model's host`);
      const exceptions = loadExceptions(undefined, () => {}, opts) ?? [];
      const ctx: ArmContext = {
        root,
        realHome: dataHome(),
        realConfig: config,
        target,
        outbound,
        suite: ins,
        snapshots: snaps.repos,
        fixtureDirs: [...new Set(snaps.repos.values())],
        claudeBin: opts.claudeBin,
        deadlines: opts.deadlines,
        signal: ctrl.signal,
        onRunStarted: opts.onRunStarted,
      };
      for (const s of runnable) {
        const result = await runItem(s, prepared, ctx, exceptions, opts, out);
        if ("problem" in result) {
          out(`PROBLEM ${s.item.id}: ${result.problem}; no instructions`);
          problems++;
        } else extras.set(s.item.id, result.extras);
      }
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
  const written = writeScores(plan, out, opts, extras);
  return problems > 0 ? 1 : written;
}

/** Runs the candidate and every baseline of one item. The runs of the candidate and the baselines go to the record only when all arms ended. */
async function runItem(
  s: ScoredItem,
  prepared: NonNullable<ReturnType<typeof prepareScoring>>["prepared"],
  ctx: ArmContext,
  exceptions: readonly ScanException[],
  opts: AgentScoreOptions,
  out: Out,
): Promise<{ extras: RecordExtras } | { problem: string }> {
  const it = s.item;
  const repeat = ctx.suite.repeat;
  const cand = `${it.id}@${it.version}`;
  const suite = prepared.suite;

  // the baselines are scored offline with the same suite, as the candidate was
  const offline: { b: Item["checks"]["baselines"][number]; dimensions: Partial<Record<EvaluationDimension, number[]>> }[] = [];
  for (const b of it.checks.baselines) {
    try {
      const safety = applyExceptions(b.id, scanSkill({ root: b.id, files: packageScanFiles(b.dir) }), exceptions, opts.today);
      // the baseline stays in the inventory: a scenario may name it in `with`; identical digests are not a collision
      const approved = prepared.approved.map((x): ComparedSkill => ({ kind: "registered", skill: x }));
      const sc = scoreEvaluation({ suite: suite.suite, profiles: suite.profiles, instructionFixtures: suite.instructionFixtures, candidate: registeredCandidate(b), approved, safety });
      offline.push({ b, dimensions: sc.dimensions });
    } catch (e) {
      if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
      return { problem: `baseline ${b.key} cannot be scored (${hidden(e.message)})` };
    }
  }

  const show = (arm: "candidate" | "baseline", skill: string, runs: ArmRun[]) => {
    for (const r of runs) out(`RUN ${cand} ${arm} ${skill} ${r.scenario} ${r.attempt}/${repeat} run ${r.runId}: ${r.score}${r.finding ? ` (${r.finding})` : ""}`);
  };

  const mine: Arm = { skillId: it.id, key: cand, write: (dir) => writeCandidatePackage(it.skill, dir) };
  const own = await runArm(mine, ctx);
  if ("problem" in own) return own;
  show("candidate", it.id, own.runs);

  const runs: EvaluationAgentRun[] = own.runs.map((r) => ({ scenario: r.scenario, arm: "candidate", skill: it.id, digest: it.skill.package.digest, attempt: r.attempt, runId: r.runId, score: r.score }));
  const baselines: EvaluationAgentBaseline[] = [];
  for (const { b, dimensions } of offline) {
    const arm: Arm = {
      skillId: b.id,
      key: b.key,
      write: (dir) => {
        const copied = copyBaselinePackage(b, dir);
        return "problem" in copied ? copied : { digest: b.digest };
      },
    };
    const res = await runArm(arm, ctx);
    if ("problem" in res) return res;
    show("baseline", b.id, res.runs);
    for (const r of res.runs) runs.push({ scenario: r.scenario, arm: "baseline", skill: b.id, digest: b.digest, attempt: r.attempt, runId: r.runId, score: r.score });
    baselines.push({ id: b.id, version: b.version, digest: b.digest, dimensions: { ...dimensions, instructions: res.runs.map((r) => r.score) } });
  }

  const findings: NonNullable<RecordExtras["findings"]> = [];
  const failed = new Map<string, number>();
  for (const r of own.runs) if (r.finding) failed.set(`${r.finding} ${r.scenario}`, (failed.get(`${r.finding} ${r.scenario}`) ?? 0) + 1);
  for (const [key, n] of [...failed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [code, scenario] = key.split(" ") as [string, string];
    findings.push({ code, dimension: "instructions", scenario, detail: `${n} of ${repeat} attempts` });
  }
  findings.push({ code: "network-not-host-limited", dimension: "instructions" });

  const agent: EvaluationAgent = { sandbox: "os", network: "not-host-limited", outbound: [ctx.outbound.host], repeat, runs, baselines };
  return {
    extras: {
      dimensions: { instructions: own.runs.map((r) => r.score) },
      runtime: { agent: ctx.target.agent, model: ctx.target.model ?? "default" },
      agent,
      findings,
      evidence: [{ name: "agent-package", digest: own.packageDigest }],
    },
  };
}
