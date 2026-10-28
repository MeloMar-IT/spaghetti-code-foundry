import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { MEASURE_NAMES, MEASURES, measureRun, readRunEvents, runMeasuresTelemetry } from "../src/monitor/measures.js";
import { detectorInfo } from "../src/monitor/work-detectors.js";
import { streamMeter } from "../src/steps/claude.js";
import { TelemetryEventSchema, TelemetryMeasuresSchema } from "../src/telemetry/envelope.js";

const T0 = Date.parse("2026-03-10T12:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let n = 0;
const ev = (type: string, sec: number, rest: object = {}): EvidenceEvent => ({ version: 1, id: `ev-${++n}`, seq: n, runId: "r1", time: at(sec), type, ...rest }) as unknown as EvidenceEvent;
const step = (id: string, type = "claude", visit = 1) => ({ id, visit, type });
const rec = (o: Partial<StepRecord> & { id: string }): StepRecord => ({ type: "claude", visit: 1, ok: true, output: "", startedAt: at(0), durationMs: 1000, logFile: "x.log", ...o }) as StepRecord;
const run = (o: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: "r1", flow: "f", flowDef: { steps: [{ id: "approve", type: "approval" }] }, task: "", vars: {}, repo: "", status: "succeeded", runDir: "/x",
    startedAt: at(0), finishedAt: at(100), totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...o,
  }) as unknown as RunSummary;
const decision = (outcome: string, reasonCode = "ok.fine") => ev("policy.decided", 1, { decision: { policy: { id: "p", version: "1" }, boundary: "step.before", mode: "observe", outcome, reasonCode }, step: step("a") });

beforeEach(() => {
  n = 0;
});

describe("catalogue", () => {
  it("has the 12 measures, each with an owner and a decision", () => {
    expect(MEASURES.map((m) => m.name)).toEqual([...MEASURE_NAMES]);
    expect(new Set(MEASURES.map((m) => m.name)).size).toBe(12);
    for (const m of MEASURES) {
      expect(["admin", "repository owner"], m.name).toContain(m.owner);
      const d = m.decision as { detector?: string; setting?: string };
      expect(Boolean(d.detector) !== Boolean(d.setting), m.name).toBe(true);
      expect(m.unit, m.name).toBeTruthy();
    }
  });

  it("names only detectors that exist", () => {
    const known = detectorInfo().map((d) => d.name);
    for (const m of MEASURES) if ("detector" in m.decision) expect(known, m.name).toContain(m.decision.detector);
  });
});

describe("measureRun", () => {
  const full = () => {
    const history = [
      rec({ id: "a", durationMs: 4000, retried: { blips: 1, models: 1 }, tokens: { input: 1000, output: 50 }, costUsd: 0.25, contextTokens: 900, tools: { calls: 3, totalMs: 40, maxMs: 25 } }),
      rec({ id: "b", type: "shell", durationMs: 500 }),
    ];
    const events = [
      ev("run.queued", 0),
      ev("run.started", 5),
      ev("step.started", 6, { step: step("a") }),
      ev("step.denied", 7, { step: step("a"), denial: { kind: "tool", tool: { name: "Bash" } } }),
      ev("step.denied", 7, { denial: { kind: "policy", policy: { id: "p", version: "1" }, packSha256: "a".repeat(64), reasonCode: "x.y" } }), // about the whole run: no step
      ev("step.denied", 8, { step: step("a"), denial: { kind: "tool", tool: { name: "Bash" } } }),
      decision("allow"),
      decision("deny"),
      decision("warn", "policy.unavailable"),
      ev("run.completed", 90, { pullRequest: { repository: "o/n", number: 1, url: "https://github.com/o/n/pull/1" } }),
    ];
    return { r: run({ history, totalCostUsd: 0.4 }), events };
  };

  it("measures a whole run", () => {
    const { r, events } = full();
    const m = measureRun(r, events);
    expect(m.outcome).toBe("succeeded");
    expect(m.durationMs).toBe(100_000);
    expect(m.queueMs).toBe(5000);
    expect(m.steps[0]).toMatchObject({ step: "a", durationMs: 4000, retries: 2, tokensIn: 1000, tokensOut: 50, costUsd: 0.25, denials: 2, contextTokens: 900, tools: { calls: 3, totalMs: 40, maxMs: 25 } });
    expect(m.steps[1]).toMatchObject({ step: "b", durationMs: 500 });
    expect(m.steps[1]!.tools).toBeUndefined();
    expect(m.policy).toEqual({ allow: 1, warn: 1, require_approval: 0, deny: 1, unavailable: 1 });
    expect(m.pullRequest).toEqual({ delivered: true });
    expect(m.stops).toBe(0);
    expect(m.resumes).toBe(0);
  });

  it("carries the run's total cost, which can be more than its steps", () => {
    const { r, events } = full();
    const m = measureRun(r, events);
    expect(m.costUsd).toBe(0.4);
    expect(runMeasuresTelemetry(m).costUsd).toBe(0.4);
  });

  it("leaves out what has no source when there is no evidence", () => {
    const { r } = full();
    r.history[0]!.denied = ["Bash: x", "Bash: y", "Bash: z"];
    const m = measureRun(r, []);
    expect(m.steps[0]!.denials).toBe(3);
    expect(m.steps[0]!.durationMs).toBe(4000);
    for (const k of ["queueMs", "stops", "approvals", "policy", "pullRequest"] as const) expect(m[k], k).toBeUndefined();
  });

  it("measures an old run without the newer fields", () => {
    const r = run({ history: [rec({ id: "a" })], resumes: 2 });
    const m = measureRun(r, []);
    expect(m.resumes).toBe(2);
    expect(m.steps[0]!.retries).toBeUndefined();
    expect(m.steps[0]!.tools).toBeUndefined();
    expect(m.steps[0]!.contextTokens).toBeUndefined();
    expect(m.steps[0]!.denials).toBeUndefined();
  });

  it("measures approval latency from when the run began waiting at the step (distinct stop, start and decision times)", () => {
    const events = [
      ev("run.started", 1),
      ev("run.stopped", 10, { at: "approve" }),
      ev("run.queued", 100),
      ev("run.resumed", 101, { from: "approve", by: { kind: "user", id: "u" } }),
      ev("step.started", 130, { step: step("approve", "approval") }),
      ev("step.approved", 190, { step: step("approve", "approval"), by: { kind: "user", id: "u" } }),
    ];
    const m = measureRun(run(), events);
    // stopped at 10 s, decided at 190 s; the step.started at 130 s is only the moment the decision was consumed
    expect(m.approvals).toEqual({ decided: 1, totalMs: 180_000, maxMs: 180_000, cancelled: 0 });
    expect(m.stops).toBe(1);
    expect(m.resumes).toBe(1);
  });

  it("falls back to the approval step's start when the run never stopped there", () => {
    const events = [
      ev("run.stopped", 5, { at: "other" }),
      ev("step.started", 130, { step: step("approve", "approval") }),
      ev("step.approved", 190, { step: step("approve", "approval"), by: { kind: "user", id: "u" } }),
    ];
    expect(measureRun(run(), events).approvals).toMatchObject({ decided: 1, totalMs: 60_000 });
  });

  it("keeps the denials of the record when the evidence is cut short, and never adds the two", () => {
    const history = [rec({ id: "a", denied: ["Bash: x", "Bash: y"] }), rec({ id: "b", denied: ["Bash: z"] }), rec({ id: "c" })];
    const deny = (id: string) => ev("step.denied", 3, { step: step(id), denial: { kind: "tool", tool: { name: "Bash" } } });
    const events = [
      ev("step.started", 1, { step: step("a") }), // evidence stops after the start: zero events for a
      ev("step.started", 2, { step: step("b") }),
      deny("b"),
      deny("b"),
      // c has no evidence at all
    ];
    const m = measureRun(run({ history }), events);
    expect(m.steps.map((s) => s.denials)).toEqual([2, 2, undefined]);
  });

  it("measures a rejected approval", () => {
    const events = [
      ev("step.started", 10, { step: step("approve", "approval") }),
      ev("step.denied", 25, { step: step("approve", "approval"), denial: { kind: "approval", by: { kind: "user", id: "u" } } }),
    ];
    expect(measureRun(run(), events).approvals).toEqual({ decided: 1, totalMs: 15_000, maxMs: 15_000, cancelled: 0 });
  });

  it("counts an approval that was cancelled while waiting, with no latency", () => {
    const events = [ev("run.started", 1), ev("run.stopped", 10, { at: "approve" }), ev("run.cancelled", 50, { by: { kind: "user", id: "u" } })];
    const m = measureRun(run({ status: "cancelled" }), events);
    expect(m.approvals).toEqual({ decided: 0, totalMs: 0, maxMs: 0, cancelled: 1 });
  });

  it("does not count a stop at an approval as cancelled when the run was resumed", () => {
    const events = [ev("run.stopped", 10, { at: "approve" }), ev("run.resumed", 20, { from: "approve", by: { kind: "user", id: "u" } }), ev("run.cancelled", 50, { by: { kind: "user", id: "u" } })];
    expect(measureRun(run(), events).approvals?.cancelled).toBe(0);
  });

  it("gives the denials to the right visit when a visit was recorded twice", () => {
    const history = [rec({ id: "a" }), rec({ id: "a" })];
    const events = [
      ev("step.started", 1, { step: step("a") }),
      ev("step.denied", 2, { step: step("a"), denial: { kind: "tool", tool: { name: "Bash" } } }),
      ev("step.started", 3, { step: step("a") }),
    ];
    const m = measureRun(run({ history }), events);
    expect(m.steps.map((s) => s.denials)).toEqual([1, 0]);
  });

  it("does not throw on odd data and leaves odd numbers out", () => {
    const bad = run({ history: undefined as unknown as StepRecord[], startedAt: "nope", totalCostUsd: Number.NaN });
    expect(() => measureRun(bad, [])).not.toThrow();
    expect(measureRun(bad, []).durationMs).toBeUndefined();
    const odd = run({ history: [null, 5, { id: 3 }, rec({ id: "a", durationMs: -4, costUsd: Number.NaN, tokens: { input: Number.POSITIVE_INFINITY, output: 2 } })] as unknown as StepRecord[] });
    const m = measureRun(odd, [null, { type: "policy.decided" }] as unknown as EvidenceEvent[]);
    expect(m.steps).toHaveLength(1);
    expect(m.steps[0]).toMatchObject({ step: "a", tokensOut: 2 });
    expect(m.steps[0]!.durationMs).toBeUndefined();
    expect(m.steps[0]!.costUsd).toBeUndefined();
    expect(m.steps[0]!.tokensIn).toBeUndefined();
    expect(() => measureRun(null as unknown as RunSummary, null as unknown as EvidenceEvent[])).not.toThrow();
  });
});

describe("runMeasuresTelemetry", () => {
  it("sums and takes maxima, and passes the schema", () => {
    const history = [
      rec({ id: "a", durationMs: 100, tokens: { input: 10, output: 1 }, contextTokens: 50, tools: { calls: 2, totalMs: 30, maxMs: 20 }, retried: { blips: 1, models: 0 } }),
      rec({ id: "b", durationMs: 200, tokens: { input: 5, output: 2 }, contextTokens: 80, tools: { calls: 1, totalMs: 70, maxMs: 70 } }),
    ];
    const t = runMeasuresTelemetry(measureRun(run({ history, totalCostUsd: 1.5 }), []));
    expect(t).toMatchObject({ steps: 2, stepMs: 300, tokensIn: 15, tokensOut: 3, contextTokensMax: 80, toolCalls: 3, toolMs: 100, toolMaxMs: 70, retries: 1, costUsd: 1.5 });
    expect(TelemetryMeasuresSchema.safeParse(t).success).toBe(true);
    expect(t.queueMs).toBeUndefined();
    expect(t.policyAllow).toBeUndefined();
    expect(t.approvals).toBeUndefined();
  });

  it("makes an event that the envelope accepts", () => {
    const events = [ev("run.queued", 0), ev("run.started", 2), decision("allow")];
    const measures = runMeasuresTelemetry(measureRun(run({ totalCostUsd: 0.123456 }), events));
    const e = { version: 2, id: `tm:${"ab".repeat(16)}`, time: at(0), kind: "run", name: "run.measured", runId: "r1", outcome: "ok", durationMs: 100_000, measures };
    expect(TelemetryEventSchema.safeParse(e).success).toBe(true);
  });
});

describe("readRunEvents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "measures-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const good = (seq: number, runId = "r1") => JSON.stringify({ version: 1, id: `ev-${seq}`, seq, runId, time: at(seq), type: "run.queued" });

  it("skips lines that cannot be read and events of another run", () => {
    writeFileSync(join(dir, "evidence.jsonl"), [good(0), "{ not json", JSON.stringify({ version: 1, type: "nope" }), "", good(1, "other"), good(2)].join("\n"));
    expect(readRunEvents(dir, "r1").map((e) => e.seq)).toEqual([0, 2]);
  });

  it("gives nothing for a missing file, a folder or a link", () => {
    expect(readRunEvents(dir, "r1")).toEqual([]);
    expect(readRunEvents(join(dir, "missing"), "r1")).toEqual([]);
    writeFileSync(join(dir, "real.jsonl"), good(0));
    symlinkSync(join(dir, "real.jsonl"), join(dir, "evidence.jsonl"));
    expect(readRunEvents(dir, "r1")).toEqual([]);
    rmSync(join(dir, "evidence.jsonl"));
    mkdirSync(join(dir, "evidence.jsonl"));
    expect(readRunEvents(dir, "r1")).toEqual([]);
  });
});

describe("streamMeter", () => {
  const use = (id: string | undefined, name = "Write", usage?: object) => ({ type: "assistant", message: { ...(usage ? { usage } : {}), content: [{ type: "tool_use", ...(id ? { id } : {}), name }] } });
  const result = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  const clock = (...t: number[]) => () => t.shift() ?? 0;

  it("times a call from its tool_use to its tool_result", () => {
    const seen: [string, number | undefined][] = [];
    const m = streamMeter({ now: clock(10, 35), onTool: (a, b) => seen.push([a, b]) });
    m.line(use("t1"));
    expect(seen).toEqual([]);
    m.line(result("t1"));
    expect(seen).toEqual([["Write", 25]]);
    expect(m.end().tools).toEqual({ calls: 1, totalMs: 25, maxMs: 25 });
    expect(seen).toHaveLength(1);
  });

  it("rounds a fractional clock to whole milliseconds", () => {
    const seen: (number | undefined)[] = [];
    const m = streamMeter({ now: clock(1.25, 12.9), onTool: (_n, ms) => seen.push(ms) });
    m.line(use("t1"));
    m.line(result("t1"));
    expect(seen).toEqual([12]);
    expect(Number.isInteger(m.end().tools.totalMs)).toBe(true);
  });

  it("adds up several calls and keeps the longest", () => {
    const m = streamMeter({ now: clock(0, 0, 10, 50) });
    m.line(use("a"));
    m.line(use("b"));
    m.line(result("a"));
    m.line(result("b"));
    expect(m.end().tools).toEqual({ calls: 2, totalMs: 60, maxMs: 50 });
  });

  it("reports a call without a result at the end, without a time", () => {
    const seen: [string, number | undefined][] = [];
    const m = streamMeter({ now: clock(0), onTool: (a, b) => seen.push([a, b]) });
    m.line(use("a", "Bash"));
    m.line(use(undefined, "Read"));
    expect(m.end().tools).toEqual({ calls: 2, totalMs: 0, maxMs: 0 });
    expect(seen).toEqual([["Bash", undefined], ["Read", undefined]]);
  });

  it("ignores a second result for the same call and results nobody asked for", () => {
    const seen: string[] = [];
    const m = streamMeter({ now: clock(0, 5), onTool: (a) => seen.push(a) });
    m.line(use("a"));
    m.line(result("a"));
    m.line(result("a"));
    m.line(result("zzz"));
    expect(seen).toEqual(["Write"]);
    expect(m.end().tools.totalMs).toBe(5);
  });

  it("takes the largest turn as the context size", () => {
    const m = streamMeter({});
    m.line({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 99 }, content: [] } });
    m.line({ type: "assistant", message: { usage: { input_tokens: 1, cache_read_input_tokens: 20 }, content: [] } });
    expect(m.end().contextTokens).toBe(115);
  });

  it("has no context size without usage and zero tools without calls", () => {
    const m = streamMeter({});
    m.line({ type: "assistant", message: { content: [] } });
    m.line("garbage");
    m.line(null);
    expect(m.end()).toEqual({ tools: { calls: 0, totalMs: 0, maxMs: 0 } });
  });

  it("is not stopped by a callback that throws", () => {
    const m = streamMeter({ now: clock(0, 1), onTool: () => { throw new Error("x"); } });
    m.line(use("a"));
    expect(() => m.line(result("a"))).not.toThrow();
  });
});
