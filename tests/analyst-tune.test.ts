import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advise } from "../src/analyst/advise.js";
import { runAnalyst } from "../src/analyst/cli.js";
import { collect } from "../src/analyst/collect.js";
import { loadOverrides, saveOverrides, stepOverride, type Overrides } from "../src/analyst/overrides.js";
import { saveReference, type Reference } from "../src/analyst/reference.js";
import { loadTuning, parseTo, reconcile, resetTuning, saveTuning, tune, type Trial, type Tuning } from "../src/analyst/tune.js";
import { analystSet } from "../src/agents/run.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const SONNET = "claude:anthropic:claude-sonnet-5-5";
const HAIKU = "claude:anthropic:claude-haiku-5-5";
const OPUS = "claude:anthropic:claude-opus-5-5";
const NONE: Reference = { checkedAt: "", figures: [] };
/** A published figure for each Claude level: a model trial starts only for a model that has one. */
const REF: Reference = { checkedAt: NOW.toISOString(), figures: ["haiku", "sonnet", "opus"].map((m) => ({ model: `claude-${m}-5-5`, metric: "speed", value: 100, kind: "vendor" as const, source: "https://example.test", test: "", note: "" })) };
/** What the flow itself said when the analyst set an override, as the override stores it. */
const WAS = { model: "claude-sonnet-5-5", effort: "" };

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
const round = (runs: RunSummary[], tuning: Tuning, overrides: Overrides = {}, now = NOW, ref = REF) => tune({ tuning, overrides, advice: advise(collect(runs, now), NONE), runs, now, ref });
const ON: Tuning = { auto: true, trials: [] };

describe("self-tuning", () => {
  it("changes nothing while it is switched off", () => {
    const r = round(steady(), { auto: false, trials: [] });
    expect([r.events, r.overrides, r.tuning.trials]).toEqual([[], {}, []]);
  });

  it("starts one trial per flow, the biggest token user first, and writes the override", () => {
    const runs = [...steady("docs"), ...many(30, () => run([{ id: "fix_develop", tokens: { input: 9000, output: 100 } }])), ...steady("docs", "g")];
    const r = round(runs, ON);
    expect(r.overrides).toEqual({ f: { fix_develop: { model: "claude-haiku-5-5", from: WAS } }, g: { docs: { model: "claude-haiku-5-5", from: WAS } } });
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
    expect(r.overrides).toEqual({ f: { docs: { model: "claude-haiku-5-5", from: WAS } } });
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

  it("reset ends the running trials and the kept ones, so the same change does not start again at the next check", () => {
    const s = started();
    expect(resetTuning(s.tuning, NOW).trials[0]).toMatchObject({ status: "reverted", why: "reset by hand" });
    const kept = round(after(() => onHaiku()), s.tuning, s.overrides).tuning;
    expect(kept.trials[0]!.status).toBe("kept");
    const reset = resetTuning(kept, NOW);
    expect(reset.trials[0]).toMatchObject({ status: "reverted", why: "reset by hand", endedAt: NOW.toISOString() });
    // ten days later the step ran on Sonnet again and the numbers say "try Haiku" as before
    const later = new Date(NOW.getTime() + 10 * DAY);
    expect(round(many(30, () => run([{ id: "docs" }], -9)), reset, {}, later).events).toEqual([]);
  });
});

describe("the analyst's files", () => {
  it("runAnalyst applies a trial, says so in the report, and survives broken files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    saveTuning(join(dir, "tuning.json"), ON);
    saveReference(join(dir, "reference.json"), REF);
    const r = await runAnalyst({ runs: steady(), now: NOW, dir });
    expect(r.events).toHaveLength(1);
    expect(r.text).toContain("## What the analyst changed");
    expect(r.text).toContain("- f / docs: claude-haiku-5-5 (on trial)");
    expect(loadOverrides(join(dir, "overrides.json"))).toEqual({ f: { docs: { model: "claude-haiku-5-5", from: WAS } } });
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

describe("self-tuning: what the code review found", () => {
  const trial = (o: Partial<Trial> = {}): Trial => ({
    flow: "f", step: "docs", direction: "lower", reviewer: false, from: WAS, to: { model: "claude-haiku-5-5" },
    startedAt: new Date(NOW.getTime() - DAY).toISOString(), baseline: { visits: 30, ok: 1, timeouts: 0, repaired: 0, changed: 0 }, status: "running", ...o,
  });

  it("puts a lowered review back when it finds half as much as before, and starts no trial for a review that found nothing", () => {
    // 8% of the reviews led to a change before; on the lower level none does
    const t: Tuning = { auto: true, trials: [trial({ step: "review_1", reviewer: true, from: { model: "claude-sonnet-5-5", effort: "high" }, to: { effort: "medium" }, baseline: { visits: 40, ok: 1, timeouts: 0, repaired: 0, changed: 0.08 } })] };
    const quiet = many(25, () => run([{ id: "review_1", effort: "medium" }, { id: "docs" }], 0.5));
    const r = round(quiet, t, { f: { review_1: { effort: "medium" } } });
    expect(r.tuning.trials[0]).toMatchObject({ status: "reverted" });
    expect(r.tuning.trials[0]!.why).toContain("its reviews led to a change 0% of the time, before 8%");
    // half as often or more is not worse
    const some = many(25, (i) => run([{ id: "review_1", effort: "medium" }, { id: i < 2 ? "address_review_1" : "docs" }], 0.5));
    expect(round(some, t, { f: { review_1: { effort: "medium" } } }).tuning.trials[0]!.status).toBe("kept");
    // a review that never led to a change is advised to go lower, but nothing could put that trial back
    const idle = many(30, () => run([{ id: "review_2", effort: "high" }, { id: "docs", agent: HAIKU }]));
    const none = round(idle, ON);
    expect(none.tuning.trials).toEqual([]);
    expect(none.notes.join()).toContain("f / review_2 on effort medium: none of these reviews led to a change");
    // one that sometimes does may be tried
    const rare = many(30, (i) => run([{ id: "review_2", effort: "high" }, { id: i < 2 ? "address_review_2" : "docs", agent: HAIKU }]));
    expect(round(rare, ON).overrides).toEqual({ f: { review_2: { effort: "medium", from: { model: "claude-sonnet-5-5", effort: "high" } } } });
  });

  it("starts a model trial only for a model with a published figure; an effort trial needs none", () => {
    const r = round(steady(), ON, {}, NOW, NONE);
    expect([r.events, r.overrides, r.tuning.trials]).toEqual([[], {}, []]);
    expect(r.notes).toEqual(["f / docs on claude-haiku-5-5: no published figure names this model, so it is not known to exist"]);
    const other: Reference = { checkedAt: "", figures: [{ ...REF.figures[0]!, model: "claude-sonnet-5-5" }] };
    expect(round(steady(), ON, {}, NOW, other).events).toEqual([]);
    const effort = many(30, () => run([{ id: "plan", effort: "high" }]));
    expect(round(effort, ON, {}, NOW, NONE).overrides).toEqual({ f: { plan: { effort: "medium", from: { model: "claude-sonnet-5-5", effort: "high" } } } });
  });

  it("says in the report why advice was not tried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    saveTuning(join(dir, "tuning.json"), ON);
    const r = await runAnalyst({ runs: steady(), now: NOW, dir });
    expect(r.events).toEqual([]);
    expect(r.text).toContain("Advice not tried by itself:\n- f / docs on claude-haiku-5-5: no published figure names this model");
    expect(loadOverrides(join(dir, "overrides.json"))).toEqual({});
  });

  it("only advises for a step inside a sub-flow, and reads what such a step does from the last part of its id", () => {
    const sub = (then: Shape[] = []) => run([{ id: "build/implement", parent: "build" }, ...then]);
    const c = collect([sub([{ id: "build/fix_tests", parent: "build" }]), sub([{ id: "build/review_1", parent: "build" }, { id: "build/address_review_1", parent: "build" }]), sub()], NOW);
    const implement = c.steps.find((s) => s.step === "build/implement")!;
    expect([implement.parent, implement.visits, implement.fixed, implement.changed]).toEqual(["build", 3, 1, 1]);
    expect(c.steps.find((s) => s.step === "build/review_1")).toMatchObject({ reviewer: true, changed: 1 });
    expect(c.steps.find((s) => s.step === "build/address_review_1")!.reviewer).toBe(false);
    const r = round(many(30, () => run([{ id: "build/docs", parent: "build" }])), ON);
    expect([r.events, r.overrides]).toEqual([[], {}]);
    expect(r.notes[0]).toContain("f / build/docs on claude-haiku-5-5: the step is inside a sub-flow");
  });

  it("does not start a trial from the numbers of a trial that was put back while the step has not run since", () => {
    const s = round(steady(), ON, {}, new Date(NOW.getTime() - DAY));
    const runs = [...steady(), ...many(25, (i) => run([{ id: "docs", agent: HAIKU, ok: i >= 6 }], 0.5))];
    const back = round(runs, s.tuning, s.overrides);
    expect([back.tuning.trials[0]!.status, back.overrides]).toEqual(["reverted", {}]);
    // four days later the newest visits are still the trial's: "raise Haiku to Sonnet" is what the flow says anyway
    const later = round(runs, back.tuning, back.overrides, new Date(NOW.getTime() + 4 * DAY));
    expect([later.events, later.overrides, later.tuning.trials.length]).toEqual([[], {}, 1]);
  });

  it("does not start a trial back to what the flow itself says", () => {
    const kept = trial({ status: "kept", endedAt: new Date(NOW.getTime() - 10 * DAY).toISOString() });
    const overrides = { f: { docs: { model: "claude-haiku-5-5", from: WAS } } };
    const failing = many(30, (i) => run([{ id: "docs", agent: HAIKU, ok: i >= 9 }]));
    const r = round(failing, { auto: true, trials: [kept] }, overrides);
    expect([r.events, r.overrides]).toEqual([[], overrides]);
    expect(r.notes[0]).toContain("f / docs on claude-sonnet-5-5: that is what the flow itself says");
  });

  it("does not take a router fallback for what a step runs on now", () => {
    // the newest visits ended on Haiku after a usage limit; the step itself is still set to Opus at effort high
    const runs = [
      ...many(30, () => run([{ id: "plan", agent: OPUS, effort: "high" }], 6)),
      ...many(30, () => run([{ id: "plan", agent: HAIKU, effort: "high", retried: { blips: 0, models: 1 } }], 1)),
    ];
    const c = collect(runs, NOW);
    expect(c.steps.map((s) => [s.agent, s.lastAt !== ""]).sort()).toEqual([[HAIKU, false], [OPUS, true]]);
    expect(round(runs, ON).overrides).toEqual({ f: { plan: { effort: "medium", from: { model: "claude-opus-5-5", effort: "high" } } } });
  });

  it("drops an override that no trial owns and sets the override of a running trial again", async () => {
    const running: Tuning = { auto: false, trials: [trial()] };
    expect(reconcile({ f: { docs: { model: "claude-haiku-5-5", from: WAS }, other: { effort: "low" } }, g: { x: { effort: "max" } } }, running)).toEqual({ f: { docs: { model: "claude-haiku-5-5", from: WAS } } });
    expect(reconcile({}, running)).toEqual({ f: { docs: { model: "claude-haiku-5-5", from: WAS } } });
    expect(reconcile({ f: { docs: { effort: "low" } } }, { auto: false, trials: [trial({ status: "kept", to: { effort: "low" } })] })).toEqual({ f: { docs: { effort: "low" } } });
    expect(reconcile({ f: { docs: { effort: "low" } } }, { auto: false, trials: [trial({ status: "reverted" })] })).toEqual({});
    // a check that stopped after the record was saved: the next check finishes it; one that left an override alone: it goes
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    saveTuning(join(dir, "tuning.json"), running);
    saveOverrides({ g: { x: { effort: "max" } } }, join(dir, "overrides.json"));
    await runAnalyst({ runs: [], now: NOW, dir });
    expect(loadOverrides(join(dir, "overrides.json"))).toEqual({ f: { docs: { model: "claude-haiku-5-5", from: WAS } } });
  });

  it("drops a trial entry that is cut off or edited, and keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-analyst-"));
    const file = join(dir, "tuning.json");
    writeFileSync(file, JSON.stringify({ auto: true, trials: [trial(), { flow: "f", step: "docs", status: "running" }, { ...trial(), startedAt: "soon" }, { ...trial(), to: { effort: "enormous" } }, null, "x"] }));
    const t = loadTuning(file);
    expect([t.auto, t.trials]).toEqual([true, [trial()]]);
    expect(() => round(steady(), t)).not.toThrow();
    // trials that own an override are never cut from the record
    const many300 = [trial({ status: "kept" }), ...Array.from({ length: 300 }, () => trial({ status: "reverted" })), trial({ step: "plan" })];
    saveTuning(file, { auto: true, trials: many300 });
    const saved = JSON.parse(readFileSync(file, "utf8")).trials as Trial[];
    expect([saved.length, saved[0]!.status, saved.at(-1)!.step]).toEqual([202, "kept", "plan"]);
  });
});

describe("where an override applies", () => {
  const flow = parseFlow(`
name: t
workspace: inplace
defaults: {model: claude-sonnet-5-5}
steps:
  - {id: a, type: claude, effort: high, prompt: "x"}
  - {id: proxied, type: claude, provider: proxy, prompt: "x"}
  - {id: local, type: claude, model: "ollama:qwen3-coder", prompt: "x"}
  - {id: other, type: claude, agent: codex, prompt: "x"}
`);
  const step = (id: string) => flow.steps.find((s) => s.id === id) as Parameters<typeof analystSet>[0];
  const config = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: [], providers: { proxy: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:9" } }, ...extra });
  let tmp = "";
  afterEach(() => {
    delete process.env.FACTORY_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });
  const set = (id: string, o: Overrides[string][string], cfg = config()) => {
    tmp = mkdtempSync(join(tmpdir(), "scf-set-"));
    process.env.FACTORY_HOME = tmp;
    saveOverrides({ t: { [id]: o } });
    const r = analystSet(step(id), flow, cfg, 1);
    return { label: r.target?.label, free: r.target?.free, effort: r.effort };
  };

  it("replaces the model only: the provider and the agent of the step stay", () => {
    expect(set("a", { model: "claude-haiku-5-5", effort: "medium" })).toEqual({ label: "claude:anthropic:claude-haiku-5-5", free: false, effort: "medium" });
    expect(set("proxied", { model: "claude-haiku-5-5" }).label).toBe("claude:proxy:claude-haiku-5-5");
    expect(set("local", { model: "claude-haiku-5-5" })).toMatchObject({ label: "claude:ollama:claude-haiku-5-5", free: true });
    // not a Claude step: the model is left alone
    expect(set("other", { model: "claude-haiku-5-5", effort: "low" })).toEqual({ label: undefined, free: undefined, effort: "low" });
  });

  it("applies only while the flow still says what it said when the analyst set it", () => {
    const from = { model: "claude-sonnet-5-5", effort: "high" };
    expect(set("a", { model: "claude-haiku-5-5", effort: "medium", from })).toMatchObject({ label: "claude:anthropic:claude-haiku-5-5", effort: "medium" });
    // the flow was edited since: another effort, or another model
    expect(set("a", { model: "claude-haiku-5-5", effort: "medium", from: { ...from, effort: "" } })).toEqual({ label: undefined, free: undefined, effort: undefined });
    expect(set("a", { effort: "medium", from: { ...from, model: "claude-opus-5-5" } }).effort).toBeUndefined();
    // an override of an older version has no `from` and applies as before
    expect(set("a", { effort: "medium" }).effort).toBe("medium");
    writeFileSync(join(tmp, "analyst", "overrides.json"), JSON.stringify({ t: { a: { effort: "medium", from: { model: 5 } } } }));
    expect(analystSet(step("a"), flow, config(), 1)).toEqual({});
  });

  it("lets a router rule win for the effort too", () => {
    const routed = config({ router: { rules: [{ step: "^a$", model: "claude-opus-5-5" }] } });
    expect(set("a", { model: "claude-haiku-5-5", effort: "medium" }, routed)).toEqual({ label: undefined, free: undefined, effort: undefined });
    expect(set("proxied", { effort: "medium" }, routed).effort).toBe("medium");
  });
});
