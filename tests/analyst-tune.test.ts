import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advise } from "../src/analyst/advise.js";
import { runAnalyst } from "../src/analyst/cli.js";
import { collect } from "../src/analyst/collect.js";
import { loadOverrides, saveOverrides, stepOverride, type Overrides } from "../src/analyst/overrides.js";
import { loadTuning, parseTo, resetTuning, saveTuning, tune, type Tuning } from "../src/analyst/tune.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const SONNET = "claude:anthropic:claude-sonnet-5-5";
const HAIKU = "claude:anthropic:claude-haiku-5-5";
const NONE = { checkedAt: "", figures: [] };

type Shape = Partial<StepRecord> & { id: string };
let clock = 0;

/** A run of the flow `f` whose steps all started `daysAgo` before NOW. */
function run(steps: Shape[], daysAgo = 2, flow = "f"): RunSummary {
  const at = new Date(NOW.getTime() - daysAgo * DAY + clock++ * 1000).toISOString();
  const history = steps.map((s) => ({ type: "claude", visit: 1, ok: true, output: "", startedAt: at, durationMs: 60_000, logFile: "", agent: SONNET, tokens: { input: 1000, output: 100 }, ...s }));
  return { runId: `r${clock}`, flow, flowDef: { steps: [] }, history } as unknown as RunSummary;
}
const many = (n: number, make: (i: number) => RunSummary) => Array.from({ length: n }, (_, i) => make(i));
const steady = (step = "docs", flow = "f") => many(30, () => run([{ id: step }], 2, flow));
const round = (runs: RunSummary[], tuning: Tuning, overrides: Overrides = {}, now = NOW) => tune({ tuning, overrides, advice: advise(collect(runs, now), NONE), runs, now });
const ON: Tuning = { auto: true, trials: [] };

describe("self-tuning", () => {
  it("changes nothing while it is switched off", () => {
    const r = round(steady(), { auto: false, trials: [] });
    expect([r.events, r.overrides, r.tuning.trials]).toEqual([[], {}, []]);
  });

  it("starts one trial per flow, the biggest token user first, and writes the override", () => {
    const runs = [...steady("docs"), ...many(30, () => run([{ id: "fix_develop", tokens: { input: 9000, output: 100 } }])), ...steady("docs", "g")];
    const r = round(runs, ON);
    expect(r.overrides).toEqual({ f: { fix_develop: { model: "claude-haiku-5-5" } }, g: { docs: { model: "claude-haiku-5-5" } } });
    expect(r.tuning.trials.map((t) => [t.flow, t.step, t.status, t.direction])).toEqual([["f", "fix_develop", "running", "lower"], ["g", "docs", "running", "lower"]]);
    expect(r.events[0]).toContain("Trying: f / fix_develop on claude-haiku-5-5 (was claude-sonnet-5-5)");
    // the next check starts nothing new in a flow with a running trial
    expect(round(runs, r.tuning, r.overrides).events).toEqual([]);
  });

  const started = () => round(steady(), ON, {}, new Date(NOW.getTime() - DAY));
  const after = (make: (i: number) => RunSummary, n = 25) => [...steady(), ...many(n, (i) => ({ ...make(i) }))];
  const onHaiku = (extra: Partial<StepRecord> = {}, then: Shape[] = []) => run([{ id: "docs", agent: HAIKU, ...extra }, ...then], 0.5);

  it("keeps a lower level that works as well as before", () => {
    const s = started();
    const r = round(after(() => onHaiku()), s.tuning, s.overrides);
    expect(r.tuning.trials[0]).toMatchObject({ status: "kept", result: { visits: 25, ok: 1 } });
    expect(r.overrides).toEqual({ f: { docs: { model: "claude-haiku-5-5" } } });
    expect(r.events[0]).toMatch(/^Kept: f \/ docs on claude-haiku-5-5 — after 25 visits it works as well as before/);
  });

  it("puts a lower level back when the step fails more or is repaired more, and does not try it again soon", () => {
    const s = started();
    const failing = round(after((i) => onHaiku({ ok: i >= 3 })), s.tuning, s.overrides);
    expect(failing.tuning.trials[0]!.status).toBe("reverted");
    expect(failing.overrides).toEqual({});
    expect(failing.events[0]).toContain("Put back: f / docs on claude-haiku-5-5 — after 25 visits it worked 88% of the time, before 100%");
    const repaired = round(after((i) => onHaiku({}, i < 6 ? [{ id: "fix_tests", agent: HAIKU }] : [])), s.tuning, s.overrides);
    expect(repaired.tuning.trials[0]!.why).toContain("repaired");
    // ten days later the old runs still advise Haiku, but the reverted change is blocked
    const later = new Date(NOW.getTime() + 10 * DAY);
    const again = round(many(30, () => run([{ id: "docs" }], -9)), failing.tuning, failing.overrides, later);
    expect(again.events).toEqual([]);
  });

  it("stops a trial early when it is far worse, and waits while there are too few visits", () => {
    const s = started();
    const few = round(after(() => onHaiku(), 5), s.tuning, s.overrides);
    expect(few.tuning.trials[0]!.status).toBe("running");
    const bad = round(after((i) => onHaiku({ ok: i >= 4 }), 8), s.tuning, s.overrides);
    expect(bad.tuning.trials[0]).toMatchObject({ status: "reverted" });
    expect(bad.tuning.trials[0]!.why).toContain("stopped early after 8 visits");
  });

  it("does not count visits stopped by a usage limit, and gives up a trial nobody visits", () => {
    const s = started();
    const limited = round(after((i) => onHaiku(i < 5 ? { ok: false, limited: true } : {})), s.tuning, s.overrides);
    expect(limited.tuning.trials[0]).toMatchObject({ status: "kept", result: { visits: 20, ok: 1 } });
    const idle = round(steady(), s.tuning, s.overrides, new Date(NOW.getTime() + 8 * DAY));
    expect(idle.tuning.trials[0]!.why).toContain("too few to judge");
    expect(idle.overrides).toEqual({});
  });

  it("keeps a higher level only when it works better, and puts back the override that was there before", () => {
    const failing = many(30, (i) => run([{ id: "implement", ok: i >= 8 }]));
    const s = round(failing, ON, { f: { implement: { effort: "high" } } }, new Date(NOW.getTime() - DAY));
    expect(s.overrides.f!.implement).toEqual({ effort: "high", model: "claude-opus-5-5" });
    const opus = (ok: (i: number) => boolean) => [...failing, ...many(25, (i) => run([{ id: "implement", agent: "claude:anthropic:claude-opus-5-5", ok: ok(i) }], 0.5))];
    expect(round(opus(() => true), s.tuning, s.overrides).tuning.trials[0]!.status).toBe("kept");
    const same = round(opus((i) => i >= 7), s.tuning, s.overrides);
    expect(same.tuning.trials[0]!.why).toContain("did not work better");
    expect(same.overrides).toEqual({ f: { implement: { effort: "high" } } });
  });

  it("judges a review by how often it still leads to a change", () => {
    const t: Tuning = { auto: true, trials: [{ flow: "f", step: "review_1", direction: "lower", reviewer: true, from: { model: "claude-sonnet-5-5", effort: "high" }, to: { effort: "medium" }, startedAt: new Date(NOW.getTime() - DAY).toISOString(), baseline: { visits: 40, ok: 1, timeouts: 0, repaired: 0, changed: 0.5 }, status: "running" }] };
    const quiet = many(25, () => run([{ id: "review_1", effort: "medium" }, { id: "docs" }], 0.5));
    const r = round(quiet, t, { f: { review_1: { effort: "medium" } } });
    expect(r.tuning.trials[0]!.why).toContain("its reviews led to a change 0% of the time, before 50%");
  });

  it("only acts on what a step runs on now, and only on advice it can apply", () => {
    // the step moved from Sonnet to Haiku; the old Sonnet numbers still say "try Haiku"
    const runs = [...many(30, () => run([{ id: "docs" }], 6)), ...many(30, () => run([{ id: "docs", agent: HAIKU }], 1))];
    expect(round(runs, ON).events).toEqual([]);
    expect(parseTo("effort medium")).toEqual({ effort: "medium" });
    expect(parseTo("claude-haiku-5-5")).toEqual({ model: "claude-haiku-5-5" });
    expect(parseTo("a lower effort or a smaller model")).toBeUndefined();
    expect(parseTo("a limit above 40 minutes, or smaller work")).toBeUndefined();
  });

  it("reset ends the running trials", () => {
    const s = started();
    expect(resetTuning(s.tuning, NOW).trials[0]).toMatchObject({ status: "reverted", why: "reset by hand" });
  });
});

describe("the analyst's files", () => {
  it("runAnalyst applies a trial, says so in the report, and survives broken files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    saveTuning(join(dir, "tuning.json"), ON);
    const r = await runAnalyst({ runs: steady(), now: NOW, dir });
    expect(r.events).toHaveLength(1);
    expect(r.text).toContain("## What the analyst changed");
    expect(r.text).toContain("- f / docs: claude-haiku-5-5 (on trial)");
    expect(loadOverrides(join(dir, "overrides.json"))).toEqual({ f: { docs: { model: "claude-haiku-5-5" } } });
    expect(loadTuning(join(dir, "tuning.json")).trials).toHaveLength(1);
    writeFileSync(join(dir, "overrides.json"), "{broken");
    writeFileSync(join(dir, "tuning.json"), "{broken");
    expect(loadOverrides(join(dir, "overrides.json"))).toEqual({});
    expect(loadTuning(join(dir, "tuning.json"))).toEqual({ auto: false, trials: [] });
    writeFileSync(join(dir, "overrides.json"), JSON.stringify({ f: { docs: { effort: "enormous" } } }));
    expect(stepOverride("f", "docs", join(dir, "overrides.json"))).toEqual({});
  });
});

describe("the engine reads the analyst's overrides", () => {
  const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
  const flow = `
name: t
workspace: inplace
defaults: {model: claude-sonnet-5-5}
steps:
  - {id: a, type: claude, effort: high, prompt: "SHOWPROMPT"}
  - {id: b, type: claude, prompt: "SAY two"}
`;
  let tmp = "";
  afterEach(() => {
    delete process.env.FACTORY_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });
  const start = (overrides: Overrides, config: Record<string, unknown> = {}) => {
    tmp = mkdtempSync(join(tmpdir(), "scf-tuned-"));
    mkdirSync(join(tmp, "repo"));
    process.env.FACTORY_HOME = tmp;
    saveOverrides(overrides);
    return runFlow(parseFlow(flow), { task: "t", repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin, config: ConfigSchema.parse({ protected_branches: [], ...config }) });
  };
  const argsOf = (h: StepRecord) => h.output;

  it("runs a step on the model and effort the analyst set, and records both", async () => {
    const s = await start({ t: { a: { model: "claude-haiku-5-5", effort: "medium" } } });
    const [a, b] = s.history;
    expect([a!.agent, a!.effort]).toEqual(["claude:anthropic:claude-haiku-5-5", "medium"]);
    expect(argsOf(a!)).toContain("--effort medium");
    expect(argsOf(a!)).toContain("--model claude-haiku-5-5");
    expect([b!.agent, b!.effort]).toEqual(["claude:anthropic:claude-sonnet-5-5", undefined]);
  });

  it("leaves the flow's own values without an override, and lets a router rule win", async () => {
    const plain = await start({});
    expect([plain.history[0]!.agent, plain.history[0]!.effort]).toEqual(["claude:anthropic:claude-sonnet-5-5", "high"]);
    const routed = await start({ t: { a: { model: "claude-haiku-5-5" } } }, { router: { rules: [{ step: "^a$", model: "claude-opus-5-5" }] } });
    expect(routed.history[0]!.agent).toBe("claude:anthropic:claude-opus-5-5");
  });
});
