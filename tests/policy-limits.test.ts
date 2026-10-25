import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { recordStep, type Engine } from "../src/engine/execute.js";
import { ROUND_CHECK_MAX_OUTPUT } from "../src/engine/guards.js";
import { baselineEntry, runPolicy, RunPolicy, type LayeredPack } from "../src/engine/policy-hooks.js";
import { baselineLimits, NO_STEP_LIMITS, scopedPacks, stepLimits } from "../src/engine/policy-limits.js";
import type { StepResult } from "../src/engine/execute.js";
import type { Flow } from "../src/flow/schema.js";
import { parseFlow } from "../src/flow/load.js";
import { BASELINE_VERSION, baselineControls, runBaseline } from "../src/policy/baseline.js";
import type { Facts } from "../src/policy/schema.js";
import { DEFAULT_MAX_OUTPUT } from "../src/steps/shell.js";

const flowOf = (yaml: string): Flow => parseFlow(yaml, "t.yaml");
const CFG = ConfigSchema.parse({});

const FLOW = flowOf(`
name: t
defaults:
  timeout_sec: 60
  max_budget_usd: 2
limits:
  max_cost_usd: 10
steps:
  - { id: a, type: shell, run: "echo a", timeout_sec: 1 }
  - { id: b, type: claude, prompt: hi, max_budget_usd: 5 }
  - { id: c, type: shell, run: "echo c", timeout_sec: 1 }
  - { id: d, type: claude, prompt: hi, timeout_sec: 1 }
  - { id: e, type: parallel, steps: [a, c], timeout_sec: 5 }
  - { id: f, type: approval, message: ok }
`);

describe("stepLimits and baselineLimits", () => {
  it("groups by value in the order of first appearance, claude and shell steps only", () => {
    const l = stepLimits(FLOW, 0, CFG);
    expect(l.timeout).toEqual([
      { limit: 1000, steps: ["a", "c", "d"] },
      { limit: 60000, steps: ["b"] },
    ]);
    expect(l.stepBudget).toEqual([
      { limit: 5, steps: ["b"] },
      { limit: 2, steps: ["d"] },
    ]);
    expect(l.output).toEqual([{ limit: DEFAULT_MAX_OUTPUT, steps: ["a", "c"] }]);
  });

  it("drops the budgets, and keeps the rest, with cost_limits off", () => {
    const cfg = ConfigSchema.parse({ cost_limits: false, daily_budget_usd: 5 });
    const l = baselineLimits(FLOW, cfg);
    expect(l.stepBudget).toEqual([]);
    expect(l.runBudget).toBeUndefined();
    expect(l.dailyBudget).toBeUndefined();
    expect(l.timeout?.length).toBe(2);
    expect(l.output?.length).toBe(1);
  });

  it("adds the run and daily budgets", () => {
    const l = baselineLimits(FLOW, ConfigSchema.parse({ daily_budget_usd: 5 }));
    expect(l.runBudget).toBe(10);
    expect(l.dailyBudget).toBe(5);
  });

  it("does not throw for a missing or partial flow", () => {
    expect(baselineLimits(undefined, CFG)).toEqual(NO_STEP_LIMITS);
    expect(stepLimits({ workspace: "worktree" } as unknown as Flow, 0, CFG)).toEqual(NO_STEP_LIMITS);
  });

  it("gives the long output limit to check_round of refine-round at the root only", () => {
    const f = (name: string) => flowOf(`name: ${name}\nsteps:\n  - { id: check_round, type: shell, run: "echo" }\n  - { id: other, type: shell, run: "echo" }\n`);
    expect(stepLimits(f("refine-round"), 0, CFG).output).toEqual([
      { limit: ROUND_CHECK_MAX_OUTPUT, steps: ["check_round"] },
      { limit: DEFAULT_MAX_OUTPUT, steps: ["other"] },
    ]);
    expect(stepLimits(f("refine-round"), 1, CFG).output).toEqual([{ limit: DEFAULT_MAX_OUTPUT, steps: ["check_round", "other"] }]);
    expect(stepLimits(f("elsewhere"), 0, CFG).output).toEqual([{ limit: DEFAULT_MAX_OUTPUT, steps: ["check_round", "other"] }]);
  });

  it("builds a baseline for every built-in flow", () => {
    const cfg = ConfigSchema.parse({ daily_budget_usd: 10 });
    for (const file of readdirSync("flows").filter((n) => n.endsWith(".yaml"))) {
      const flow = parseFlow(readFileSync(join("flows", file), "utf8"), file);
      const { controls } = baselineControls(cfg, { shippedHotfixFlow: false, limits: baselineLimits(flow, cfg) });
      expect(() => runBaseline(BASELINE_VERSION, controls), file).not.toThrow();
    }
  });
});

describe("scopedPacks", () => {
  const root = baselineEntry(BASELINE_VERSION, { protectedBranches: [], secretScan: true, shippedHotfixFlow: false });
  const scoped = baselineEntry(BASELINE_VERSION, { protectedBranches: [], secretScan: false, shippedHotfixFlow: false });
  const other: LayeredPack = { layer: "optional", id: "x", problem: "policy.unavailable", detail: "d" };
  it("swaps only the baseline entry", () => {
    expect(scopedPacks([root, other], scoped)).toEqual([scoped, other]);
  });
  it("keeps the packs when the root baseline has a problem", () => {
    const bad: LayeredPack = { layer: "mandatory", id: "foundry.baseline", problem: "policy.invalid", detail: "d" };
    const packs = [bad, other];
    expect(scopedPacks(packs, scoped)).toBe(packs);
  });
});

describe("a RunPolicy with scoped baselines", () => {
  const T = "2026-01-31T12:00:00.000Z";
  const outer = flowOf(`name: outer\ndefaults:\n  timeout_sec: 1\nlimits:\n  max_cost_usd: 3\nsteps:\n  - { id: x, type: shell, run: "echo", timeout_sec: 1 }\n  - { id: y, type: shell, run: "echo" }\n`);
  const inner = flowOf(`name: inner\nsteps:\n  - { id: x, type: shell, run: "echo" }\n  - { id: y, type: shell, run: "echo", timeout_sec: 0.1 }\n`);
  const cfg = ConfigSchema.parse({ daily_budget_usd: 50 });
  const build = (rootFlow: Flow = outer) => {
    const lines: string[] = [];
    const limits = baselineLimits(rootFlow, cfg);
    const { controls } = baselineControls(cfg, { shippedHotfixFlow: false, limits });
    const entry = baselineEntry(BASELINE_VERSION, controls);
    const scopedBaseline = (s?: { flow: Flow; depth: number }) => baselineEntry(BASELINE_VERSION, { ...controls, limits: { ...limits, ...(s ? stepLimits(s.flow, s.depth, cfg) : NO_STEP_LIMITS) } });
    const policy = new RunPolicy({ runId: "r", packs: [entry], base: {}, log: (l) => lines.push(l), now: () => T, scopedBaseline });
    return { policy, lines };
  };
  const after = (over: Facts): Facts => ({ step: "x", outputBytes: 0, elapsedMs: 0, stepCostUsd: 0, runCostUsd: 0, dailyCostUsd: 0, ...over });
  const id = (step: string, parent?: string) => ({ id: step, visit: 1, type: "shell" as const, ...(parent ? { parent } : {}) });
  const reason = (r: ReturnType<RunPolicy["at"]>) => r.decisions[0]!.decision.reasonCode;

  it("answers each of the five limits in observe mode, and passes under them", () => {
    const { policy } = build(
      flowOf(`name: o\nlimits:\n  max_cost_usd: 3\nsteps:\n  - { id: x, type: shell, run: "echo", timeout_sec: 1 }\n  - { id: k, type: claude, prompt: p, max_budget_usd: 1 }\n`),
    );
    const cases: [Facts, string][] = [
      [{ outputBytes: DEFAULT_MAX_OUTPUT + 1 }, "output.limit-exceeded"],
      [{ elapsedMs: 1001 }, "timeout.exceeded"],
      [{ step: "k", stepCostUsd: 1.5 }, "budget.step-exceeded"],
      [{ runCostUsd: 3.5 }, "budget.run-exceeded"],
      [{ dailyCostUsd: 50.5 }, "budget.daily-exceeded"],
    ];
    for (const [facts, code] of cases) {
      const r = policy.at("step.after", after(facts), id(String(facts.step ?? "x")));
      expect(reason(r)).toBe(code);
      expect(r.decisions[0]!.decision.mode).toBe("observe");
      expect(r.denied).toBeUndefined();
    }
    expect(reason(policy.at("step.after", after({ outputBytes: DEFAULT_MAX_OUTPUT, elapsedMs: 1000, runCostUsd: 3, dailyCostUsd: 50 }), id("x")))).toBe("policy.no-rule-matched");
  });

  it("judges a sub-flow step by its own flow, whatever the parent has under the same id", () => {
    const { policy } = build();
    policy.subFlow("build", inner, 1);
    // root x has a 1000 ms limit, inner x has none
    expect(reason(policy.at("step.after", after({ elapsedMs: 5000 }), id("x", "build")))).toBe("policy.no-rule-matched");
    expect(reason(policy.at("step.after", after({ elapsedMs: 5000 }), id("x")))).toBe("timeout.exceeded");
    // inner y has 100 ms, root y has none
    expect(reason(policy.at("step.after", after({ step: "y", elapsedMs: 500 }), id("y", "build")))).toBe("timeout.exceeded");
    expect(reason(policy.at("step.after", after({ step: "y", elapsedMs: 500 }), id("y")))).toBe("policy.no-rule-matched"); // root y: 1 s from the defaults
  });

  it("uses the registration of a nested scope, and only run-wide limits for an unregistered one", () => {
    const { policy } = build();
    policy.subFlow("build/inner", inner, 2);
    expect(reason(policy.at("step.after", after({ step: "y", elapsedMs: 500 }), id("y", "build/inner")))).toBe("timeout.exceeded");
    expect(reason(policy.at("step.after", after({ elapsedMs: 5000 }), id("x", "nowhere")))).toBe("policy.no-rule-matched");
    expect(reason(policy.at("step.after", after({ runCostUsd: 4 }), id("x", "nowhere")))).toBe("budget.run-exceeded");
  });

  const big = (n = 600) => flowOf(`name: big\nsteps:\n${Array.from({ length: n }, (_, i) => `  - { id: s${i}, type: shell, run: "echo", timeout_sec: ${i + 1} }`).join("\n")}\n`);

  it("fails closed for the steps of a sub-flow whose baseline cannot be built", () => {
    const { policy, lines } = build();
    policy.subFlow("big", big(), 1);
    policy.subFlow("build", inner, 1);
    expect(lines.filter((l) => l.startsWith("!"))).toHaveLength(1);
    expect(lines[0]).toMatch(/^! policy foundry\.baseline: sub-flow big: .*would have \d+ rules/);
    expect(reason(policy.at("step.after", after({}), id("x", "big")))).toBe("policy.invalid");
    expect(policy.at("agent.write", { isolated: false, sandboxed: false }, id("x", "big")).denied).toBeDefined();
    expect(policy.at("repository.access", { credential: "machine" }, id("x", "big")).denied).toBeDefined();
    for (const step of [id("x"), id("x", "build")]) {
      expect(policy.at("agent.write", { isolated: false, sandboxed: false }, step).denied).toBeUndefined();
      expect(policy.at("repository.access", { credential: "machine" }, step).denied).toBeUndefined();
    }
  });

  it("keeps a root failure for the sub-flow steps", () => {
    const { policy } = build(big());
    policy.subFlow("build", inner, 1);
    expect(policy.at("agent.write", { isolated: false, sandboxed: false }, id("x", "build")).denied).toBeDefined();
    expect(policy.at("agent.write", { isolated: false, sandboxed: false }, id("x")).denied).toBeDefined();
  });

  it("keeps the enforcing rules in a scoped baseline", () => {
    const { policy } = build();
    policy.subFlow("build", inner, 1);
    const root = policy.at("repository.access", { credential: "machine", owner: "user" }, id("x"));
    const sub = policy.at("repository.access", { credential: "machine", owner: "user" }, id("x", "build"));
    expect(reason(sub)).toBe(reason(root));
    expect(reason(sub)).toBe("credential.scope-exceeded");
  });

  it("asks for the daily fact: a daily rule without it is input-incomplete", () => {
    const { policy } = build();
    const { dailyCostUsd: _drop, ...facts } = after({});
    expect(reason(policy.at("step.after", facts, id("x")))).toBe("policy.input-incomplete");
  });
});

describe("runPolicy with a root baseline that is too large", () => {
  it("fails closed and logs it", () => {
    const steps = Array.from({ length: 600 }, (_, i) => `  - { id: s${i}, type: shell, run: "echo", timeout_sec: ${i + 1} }`).join("\n");
    const flowDef = flowOf(`name: big\nsteps:\n${steps}\n`);
    const lines: string[] = [];
    const policy = runPolicy({ runId: "r", vars: {}, flow: "big", flowDef, owner: undefined } as never, ConfigSchema.parse({}), (l) => lines.push(l));
    expect(lines.some((l) => /^! policy foundry\.baseline: .*would have /.test(l))).toBe(true);
    expect(policy.at("agent.write", { isolated: false, sandboxed: false }, { id: "s1", visit: 1, type: "shell" }).denied).toBeDefined();
    expect(policy.at("step.after", { step: "s1" }, { id: "s1", visit: 1, type: "shell" }).decisions[0]!.decision.reasonCode).toBe("policy.invalid");
  });
});

describe("recordStep facts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "record-step-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (step: string, over: { type?: "shell" | "claude" | "approval"; res?: Partial<StepResult>; meter?: { ms?: number; printedBytes?: number }; startedAgo?: number; daily?: () => number; real?: boolean } = {}) => {
    const type = over.type ?? "shell";
    const stepDef = (type === "shell" ? { id: step, type, run: "echo" } : type === "claude" ? { id: step, type, prompt: "p" } : { id: step, type, message: "m" }) as never;
    const facts: Facts[] = [];
    const decisions: string[] = [];
    const real = over.real ? runPolicy({ runId: "r", vars: {}, flow: "t", flowDef: flowOf(`name: t\nsteps:\n  - { id: ${step}, type: shell, run: "echo" }\n`), owner: undefined } as never, ConfigSchema.parse({}), () => {}) : undefined;
    const policy = {
      pushes() {},
      at(b: string, f: Facts, s: unknown) {
        if (b !== "step.after") return { decisions: [] };
        facts.push(f);
        const r = real?.at(b as never, f, s as never);
        if (r) decisions.push(r.decisions[0]!.decision.reasonCode);
        return r ?? { decisions: [] };
      },
    };
    const summary = { runDir: dir, history: [], totalCostUsd: 0, outputs: {}, flow: "t", runId: "r" } as never;
    const engine = { summary, config: CFG, log() {}, save() {}, policy, ...(over.daily ? { dailyCostUsd: over.daily } : {}) } as unknown as Engine;
    const scope = { flow: flowOf(`name: t\nsteps:\n  - { id: ${step}, type: shell, run: "echo" }\n`), ctx: { vars: {}, steps: {}, run: {} }, visits: {}, prefix: "", depth: 0 } as never;
    const res: StepResult = { ok: true, output: "short", ...over.res };
    recordStep(stepDef, scope, engine, res, new Date(Date.now() - (over.startedAgo ?? 0)), join(dir, "l.log"), 1, over.meter);
    return { facts: facts[0]!, decisions };
  };

  it("takes the elapsed time of a process step from the meter, not from the wall clock", () => {
    expect(run("a", { startedAgo: 10_000, meter: { ms: 5 } }).facts.elapsedMs).toBe(5);
    expect(run("a", { startedAgo: 10_000 }).facts.elapsedMs).toBe(0);
    expect(run("a", { type: "approval", startedAgo: 2000 }).facts.elapsedMs).toBeGreaterThanOrEqual(2000);
  });

  it("counts what a shell step printed, also with a short output", () => {
    expect(run("a", { meter: { printedBytes: 300000 } }).facts.outputBytes).toBe(300000);
    expect(run("a").facts.outputBytes).toBe(5);
  });

  it("counts the bytes of the output of a claude step", () => {
    expect(run("a", { type: "claude", meter: { printedBytes: 300000 }, res: { output: "héllo" } }).facts.outputBytes).toBe(6);
  });

  it("records an over-limit output of a rejected call", () => {
    const r = run("a", { real: true, meter: { printedBytes: 300000 }, res: { ok: false, output: "", error: "could not write the log file" } });
    expect(r.decisions).toEqual(["output.limit-exceeded"]);
  });

  it("gives a step cost of 0 when there is none, and the daily cost when it can be read", () => {
    expect(run("a", { res: { costUsd: undefined } }).facts.stepCostUsd).toBe(0);
    expect(run("a", { daily: () => 3 }).facts.dailyCostUsd).toBe(3);
    expect(run("a", { daily: () => { throw new Error("x"); } }).facts.dailyCostUsd).toBeUndefined();
  });
});
