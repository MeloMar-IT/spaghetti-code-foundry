import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claudeProviderEnv, type Target } from "../agents/targets.js";
import { ConfigSchema, type Config } from "../config.js";
import { setEvaluationLimits } from "../engine/eval-limits.js";
import { tokenVarNames } from "../engine/isolation.js";
import type { RunSummary } from "../engine/state.js";
import { FlowSchema, type Flow } from "../flow/schema.js";
import { FACTORY_HOME, setFactoryHome } from "../home.js";
import { Scheduler } from "../queue/scheduler.js";
import { evaluateSkillRun, SkillExpectSchema } from "../skills/eval.js";
import type { InstructionsScenario, InstructionsSuite } from "../skills/evaluation-instructions.js";
import type { ToolsScenario } from "../skills/evaluation-suite.js";
import { pinArmSkill } from "./package.js";

// Runs the instructions scenarios of a suite for one arm (the candidate or one baseline) as sandboxed user's runs. The Scheduler, the
// engine and the OS sandbox do the work; this file only builds the flow and the configuration in memory and switches the data folder
// of the whole process to a temporary folder for the time the arm runs. Only a process that runs nothing else may do that.

export const EVAL_DEADLINES = { fixtureSec: 120, checkSec: 300 } as const;
export const EVAL_OWNER = "skill-evaluation";
const BOT = { name: "scf skill evaluation", email: "skill-evaluation@invalid" } as const;

/** Thrown when the evaluation is cancelled (a signal, or an error elsewhere). Everything that was started has been stopped first. */
export class EvaluationInterrupted extends Error {
  constructor() {
    super("the evaluation was interrupted");
    this.name = "EvaluationInterrupted";
  }
}

/** The tools of the work step: always the read tools; the others only as the scenario policy allows. */
export function scenarioTools(p: ToolsScenario["policy"]): string[] {
  return [
    "Read", "Glob", "Grep", "LS",
    ...(p.filesystem === "write" ? ["Edit", "Write", "MultiEdit"] : []),
    ...(p.shell ? ["Bash"] : []),
    ...(p.network ? ["WebFetch", "WebSearch"] : []),
  ];
}

/** The environment the agent step would get for the model key: the process environment plus what the provider sets. */
export function agentEnvFor(target: Target, evalConfig: Pick<Config, "bot">, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...claudeProviderEnv(target, tokenVarNames(evalConfig)) };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The one outbound port of the evaluation, from the base URL the agent would use. `rule` is for the evaluation limit, `host` for the record. */
export function outboundFor(env: NodeJS.ProcessEnv): { rule: string; host: string; port: number } {
  const url = new URL(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  const host = url.hostname.toLowerCase();
  if (LOOPBACK.has(host)) return { rule: `localhost:${port}`, host: `localhost:${port}`, port };
  return { rule: `*:${port}`, host: `${host}:${port}`, port };
}

const SWITCHED = [
  "FACTORY_HOME", "SCF_HOME", "FACTORY_LOCK_DIR", "SCF_LOCK_DIR", "FACTORY_NO_NOTIFY", "FACTORY_NO_FAILURE_MODEL", "SCF_STEP_ENV_PASS", "FACTORY_STEP_ENV_PASS",
] as const;

/**
 * Points the whole process at `dir` as its data folder: the four folder variables, the live `FACTORY_HOME`, no notifications, no failure
 * model, and no server pass list. Returns the function that puts every value back exactly (a variable that was unset is deleted).
 */
export function switchDataFolder(dir: string): () => void {
  const saved = SWITCHED.map((n) => [n, process.env[n]] as const);
  const previous = FACTORY_HOME;
  const locks = join(dir, "locks");
  mkdirSync(locks, { recursive: true });
  process.env.FACTORY_HOME = dir;
  process.env.SCF_HOME = dir;
  process.env.FACTORY_LOCK_DIR = locks;
  process.env.SCF_LOCK_DIR = locks;
  process.env.FACTORY_NO_NOTIFY = "1";
  process.env.FACTORY_NO_FAILURE_MODEL = "1";
  delete process.env.SCF_STEP_ENV_PASS;
  delete process.env.FACTORY_STEP_ENV_PASS;
  setFactoryHome(dir);
  return () => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    setFactoryHome(previous);
  };
}

/**
 * The configuration of the evaluation, built in memory: a fixed commit identity (the only credential-free way an isolated step may commit),
 * no router rules or fallbacks, the sandbox reading only the fixture snapshots, and only the skill of the arm with the scenario's tool policy.
 */
export function evaluationConfig(real: Config, policy: ToolsScenario["policy"], fixtureDirs: string[]): Config {
  return ConfigSchema.parse({
    protected_branches: [],
    concurrency: real.concurrency,
    cost_limits: real.cost_limits,
    ...(real.default_model !== undefined ? { default_model: real.default_model } : {}),
    providers: real.providers,
    // only the variable's name is kept, so that it is still cleared from every isolated step; no token value is read
    bot: { ...BOT, ...(real.bot.gh_token_env ? { gh_token_env: real.bot.gh_token_env } : {}) },
    router: { rules: [], fallback: [] },
    sandbox: { user_runs: "required", user_read: fixtureDirs },
    skills: {
      builtin: false,
      roots: [],
      repository: false,
      releases: { allow_unreleased: true, approved: [] },
      tools: { shell: policy.shell, network: policy.network, filesystem: policy.filesystem, missing: "degrade" },
    },
  });
}

/** The flow of one run: clone the fixture snapshot, let the agent work, then check. Suite text goes in by variables only. */
export function evaluationFlow(skillId: string, scenario: InstructionsScenario, model: string | undefined, deadlines: { fixtureSec: number; checkSec: number } = EVAL_DEADLINES): Flow {
  return FlowSchema.parse({
    name: "skill-evaluation",
    workspace: "empty",
    one_per_repo: false,
    defaults: model ? { model } : {},
    skills: { mode: "explicit", ids: [skillId] },
    steps: [
      { id: "fixture", type: "shell", run: 'git clone -q --no-hardlinks "$FACTORY_VAR_EVAL_FIXTURE" .', timeout_sec: deadlines.fixtureSec },
      { id: "work", type: "claude", prompt: "{{task}}", permission_mode: "dontAsk", allowed_tools: scenarioTools(scenario.policy), timeout_sec: scenario.timeout_sec },
      { id: "check", type: "shell", run: 'sh -c "$FACTORY_VAR_EVAL_CHECK"', timeout_sec: deadlines.checkSec },
    ],
  });
}

export type RunFinding = "agent-failed" | "check-failed" | "skill-not-loaded";

/** 1 only when fixture, work and check succeeded and the skill was loaded. A broken fixture, an access failure or a run that did not end is a `problem`. */
export function scoreRun(s: Pick<RunSummary, "status" | "history" | "reason" | "skillLock" | "skillPlan">, skillId: string): { score: 0 | 1; finding?: RunFinding } | { problem: string } {
  if (s.history.some((h) => h.accessFailed)) return { problem: "a step was refused by an access rule" };
  if (s.history.some((h) => h.id === "fixture" && !h.ok)) return { problem: "the fixture step failed" };
  if (s.status !== "succeeded" && s.status !== "failed") return { problem: `a run ended as ${s.status}` };
  const last = (id: string) => [...s.history].reverse().find((h) => h.id === id);
  const work = last("work");
  const check = last("check");
  if (!work || !work.ok) return { score: 0, finding: "agent-failed" };
  if (!check || !check.ok) return { score: 0, finding: "check-failed" };
  const used = evaluateSkillRun(s, SkillExpectSchema.parse({ selected: [skillId] }));
  if (used.activation.status !== "loaded") return { score: 0, finding: "skill-not-loaded" };
  return s.status === "succeeded" ? { score: 1 } : { score: 0, finding: "agent-failed" };
}

export interface ArmRun {
  scenario: string;
  attempt: number;
  runId: string;
  score: 0 | 1;
  finding?: RunFinding;
}
export interface ArmContext {
  /** The temporary root of the evaluation: the arm folders are made inside it. */
  root: string;
  /** The real data folder; no step may read it. */
  realHome: string;
  realConfig: Config;
  target: Target;
  outbound: { rule: string; host: string; port: number };
  suite: InstructionsSuite;
  /** repo of a scenario → its snapshot folder (fixture.ts). */
  snapshots: ReadonlyMap<string, string>;
  fixtureDirs: string[];
  claudeBin?: string;
  deadlines?: { fixtureSec: number; checkSec: number };
  signal: AbortSignal;
  onRunStarted?: (runId: string) => void;
}
export interface Arm {
  skillId: string;
  key: string;
  /** Writes the arm's skill into the temporary `skills/` folder and returns the digest of what was written. */
  write: (skillsDir: string) => { digest: string } | { problem: string };
}

/**
 * Runs every scenario of the suite `repeat` times with one arm's skill, one scenario after the other, the repeats of a scenario together.
 * The evaluation limit holds the tools of the scenario, so every running job always has the same limit. On abort or error every submitted job is
 * cancelled and awaited before the limit is reset, the environment is restored and the arm folder is removed.
 */
export async function runArm(arm: Arm, ctx: ArmContext): Promise<{ runs: ArmRun[]; packageDigest: string } | { problem: string }> {
  if (ctx.signal.aborted) throw new EvaluationInterrupted();
  const armDir = mkdtempSync(join(ctx.root, "arm-"));
  const submitted: string[] = [];
  const waits: Promise<unknown>[] = [];
  let scheduler: Scheduler | undefined;
  const cancelAll = () => cancelLive(scheduler, submitted);
  ctx.signal.addEventListener("abort", cancelAll);
  const restore = switchDataFolder(armDir);
  try {
    const written = arm.write(join(armDir, "skills"));
    if ("problem" in written) return written;
    pinArmSkill(arm.key, written.digest);
    let current = ctx.realConfig;
    scheduler = new Scheduler({ runsDir: join(armDir, "runs"), config: () => current, claudeBin: ctx.claudeBin });
    const denyRead = [...new Set([ctx.realHome, realpathSync(ctx.realHome)])];
    const model = ctx.realConfig.default_model;
    const runs: ArmRun[] = [];
    for (const scenario of ctx.suite.scenarios) {
      const snapshot = ctx.snapshots.get(scenario.repo);
      if (!snapshot) return { problem: `scenario ${scenario.id} has no fixture snapshot` };
      current = evaluationConfig(ctx.realConfig, scenario.policy, ctx.fixtureDirs);
      setEvaluationLimits({ outbound: [ctx.outbound.rule], denyRead, tools: scenarioTools(scenario.policy) });
      const flow = evaluationFlow(arm.skillId, scenario, model, ctx.deadlines);
      const mine: { id: string; done: Promise<RunSummary | undefined> }[] = [];
      for (let attempt = 1; attempt <= ctx.suite.repeat; attempt++) {
        if (ctx.signal.aborted) throw new EvaluationInterrupted();
        const id = scheduler.submit(
          { kind: "run", flow, task: scenario.task, repo: snapshot, vars: { eval_fixture: snapshot, eval_check: scenario.check } },
          { owner: EVAL_OWNER, source: "skill evaluation" },
        );
        submitted.push(id);
        // a signal that came in while the job was queued: the listener has seen the id too, this covers the one just submitted
        if (ctx.signal.aborted) cancelLive(scheduler, [id]);
        const done = scheduler.wait(id);
        waits.push(done);
        mine.push({ id, done });
        ctx.onRunStarted?.(id);
      }
      const summaries = await Promise.all(mine.map((m) => m.done));
      if (ctx.signal.aborted) throw new EvaluationInterrupted();
      for (const [i, m] of mine.entries()) {
        const s = summaries[i];
        if (!s) return { problem: `scenario ${scenario.id}: run ${m.id} cannot be read` };
        const r = scoreRun(s, arm.skillId);
        if ("problem" in r) return { problem: `scenario ${scenario.id}: ${r.problem}` };
        runs.push({ scenario: scenario.id, attempt: i + 1, runId: m.id, score: r.score, ...(r.finding ? { finding: r.finding } : {}) });
      }
    }
    return { runs, packageDigest: written.digest };
  } finally {
    ctx.signal.removeEventListener("abort", cancelAll);
    cancelLive(scheduler, submitted);
    await Promise.allSettled(waits);
    setEvaluationLimits(undefined);
    restore();
    rmSync(armDir, { recursive: true, force: true });
  }
}

/** Cancels every listed job that is still queued or running. Used when the arm ends or is aborted: nothing may run past it. */
function cancelLive(scheduler: Scheduler | undefined, ids: readonly string[]): void {
  if (!scheduler) return;
  for (const id of ids) {
    try {
      if (scheduler.isActive(id) || scheduler.isQueued(id)) scheduler.cancel(id);
    } catch {
      // a job that is already finished has nothing to cancel
    }
  }
}
