import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { runDetectors, type DetectorInput } from "../src/monitor/detectors.js";
import { loadFindings, type FindingInput } from "../src/monitor/findings.js";
import { Monitor } from "../src/monitor/monitor.js";
import { median, p95, SLO_DETECTORS } from "../src/monitor/slo-detectors.js";
import { deniedTool, MAX_EVIDENCE_BYTES, SETTLE_MS, SloInputCache, sloLookbackHours, type EvidenceState, type MeasuredRun, type StepVisit, type ToolDenial } from "../src/monitor/slo-input.js";
import { ALL_DETECTORS, detectorInfo } from "../src/monitor/work-detectors.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { emitRunMeasured } from "../src/monitor/measures.js";
import { closeTelemetry, configureTelemetry, resetTelemetry } from "../src/telemetry/telemetry.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const at = (ms: number) => NOW.getTime() - ms;
const iso = (ms: number) => new Date(ms).toISOString();
const config = ConfigSchema.parse({}).monitor;
const withConfig = (patch: Record<string, unknown>) => ConfigSchema.parse({ monitor: patch }).monitor;

const input = (over: Partial<DetectorInput> = {}): DetectorInput => ({ now: NOW, asleep: false, config, runs: [], watchers: [], log: [], queue: { pending: [], active: [], concurrency: 2 }, monitorId: "mon", ...over });
const find = (name: string, over: Partial<DetectorInput> = {}): FindingInput[] => SLO_DETECTORS.find((d) => d.name === name)!.run(input(over));

let n = 0;
const measured = (over: Partial<MeasuredRun> = {}): MeasuredRun => ({ runId: `r${++n}`, flow: "issue-gitflow", repo: "acme/app", visits: [], toolDenials: [], policyFailures: [], ...over });
const evid = (over: Partial<EvidenceState> = {}): EvidenceState => ({ runId: `r${++n}`, flow: "issue-gitflow", repo: "acme/app", finishedAt: iso(at(10 * MIN)), stream: true, manifest: false, incomplete: false, ...over });
const visit = (over: Partial<StepVisit> = {}): StepVisit => ({ flow: "issue-gitflow", step: "build", type: "shell", repo: "acme/app", at: at(MIN), durationMs: MIN, ...over });
const denial = (over: Partial<ToolDenial> = {}): ToolDenial => ({ tool: "Bash", repo: "acme/app", count: 1, at: at(MIN), ...over });

describe("policy-service-failure", () => {
  const run = (times: number[]) => measured({ policyFailures: times });
  it("finds decisions at the threshold, not below", () => {
    expect(find("policy-service-failure", { measures: [measured()] })).toEqual([]);
    const f = find("policy-service-failure", { measures: [run([at(MIN)])] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fingerprint: "policy-service-failure", severity: "major", about: "foundry", evidence: { counts: { decisions: 1, runs: 1 } } });
    const three = withConfig({ policy_service_failure: { decisions: 3 } });
    expect(find("policy-service-failure", { config: three, measures: [run([at(MIN), at(2 * MIN)])] })).toEqual([]);
    expect(find("policy-service-failure", { config: three, measures: [run([at(MIN), at(2 * MIN)]), run([at(3 * MIN)])] })).toHaveLength(1);
  });
  it("judges the time of each decision: an old one in a run that just ended does not count, a recent one in a running run does", () => {
    expect(find("policy-service-failure", { measures: [run([at(61 * MIN)])] })).toEqual([]);
    expect(find("policy-service-failure", { measures: [run([at(59 * MIN)])] })).toHaveLength(1);
    expect(find("policy-service-failure", { measures: [run([at(10 * HOUR), at(5 * MIN)])] })[0]!.evidence.counts).toMatchObject({ decisions: 1 });
  });
  it("makes nothing from missing data", () => {
    expect(find("policy-service-failure")).toEqual([]);
    expect(find("policy-service-failure", { measures: [] })).toEqual([]);
  });
});

describe("evidence-finalization", () => {
  it("waits 2 minutes after the end of a run", () => {
    expect(find("evidence-finalization", { evidence: [evid({ finishedAt: iso(at(SETTLE_MS - 1000)) })] })).toEqual([]);
    expect(find("evidence-finalization", { evidence: [evid({ finishedAt: iso(at(SETTLE_MS)) })] })).toEqual([]);
    const f = find("evidence-finalization", { evidence: [evid({ finishedAt: iso(at(SETTLE_MS + 1000)) })] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fingerprint: "evidence-finalization", severity: "major", about: "foundry", evidence: { counts: { runs: 1, no_manifest: 1, incomplete: 0 } } });
  });
  it("finds an incomplete stream without a file, and leaves whole or older runs alone", () => {
    const f = find("evidence-finalization", { evidence: [evid({ stream: false, incomplete: true })] });
    expect(f[0]!.evidence.counts).toMatchObject({ incomplete: 1 });
    expect(find("evidence-finalization", { evidence: [evid({ manifest: true })] })).toEqual([]);
    expect(find("evidence-finalization", { evidence: [evid({ stream: false })] })).toEqual([]);
    expect(find("evidence-finalization", { evidence: [evid({ finishedAt: iso(at(25 * HOUR)) })] })).toEqual([]);
  });
  it("counts runs against the threshold", () => {
    const two = withConfig({ evidence_finalization: { runs: 2 } });
    expect(find("evidence-finalization", { config: two, evidence: [evid()] })).toEqual([]);
    expect(find("evidence-finalization", { config: two, evidence: [evid(), evid()] })).toHaveLength(1);
  });
  it("makes nothing from missing data", () => {
    expect(find("evidence-finalization")).toEqual([]);
    expect(find("evidence-finalization", { evidence: [evid({ finishedAt: "nonsense" })] })).toEqual([]);
  });
});

describe("step-latency-p95", () => {
  const five = (last: number, over: Partial<StepVisit> = {}) => measured({ visits: [50, 50, 50, 50, last].map((m) => visit({ durationMs: m * MIN, ...over })) });
  it("finds a p95 above the limit, not at it", () => {
    const f = find("step-latency-p95", { measures: [five(61)] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fingerprint: "step-latency-p95|acme/app|issue-gitflow|build", severity: "minor", about: "foundry", repo: "acme/app", evidence: { counts: { visits: 5, p95_minutes: 61 } } });
    expect(find("step-latency-p95", { measures: [five(60)] })).toEqual([]);
  });
  it("needs the least visits, and only counts visits in the window", () => {
    expect(find("step-latency-p95", { measures: [measured({ visits: five(90).visits.slice(1) })] })).toEqual([]);
    const old = five(90);
    old.visits[0]!.at = at(25 * HOUR);
    expect(find("step-latency-p95", { measures: [old] })).toEqual([]);
  });
  it("ignores approval and flow steps and visits without a duration, and groups per repository", () => {
    expect(find("step-latency-p95", { measures: [five(90, { type: "approval" })] })).toEqual([]);
    expect(find("step-latency-p95", { measures: [five(90, { type: "flow" })] })).toEqual([]);
    const some = five(90);
    some.visits[4] = visit({ durationMs: undefined });
    expect(find("step-latency-p95", { measures: [some] })).toEqual([]);
    const a = measured({ visits: [90, 90, 90].map((m) => visit({ durationMs: m * MIN })) });
    const b = measured({ repo: "acme/other", visits: [90, 90, 90].map((m) => visit({ durationMs: m * MIN, repo: "acme/other" })) });
    expect(find("step-latency-p95", { measures: [a, b] })).toEqual([]);
    expect(find("step-latency-p95", { measures: [a, b], config: withConfig({ step_latency_p95: { min_visits: 3 } }) })).toHaveLength(2);
  });
  it("makes nothing from missing data", () => {
    expect(find("step-latency-p95")).toEqual([]);
  });
  it("computes the nearest-rank p95 and the median", () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("repeated-tool-denial", () => {
  it("finds the same tool at the threshold, not below", () => {
    expect(find("repeated-tool-denial", { measures: [measured({ toolDenials: [denial({ count: 2 })] })] })).toEqual([]);
    const f = find("repeated-tool-denial", { measures: [measured({ toolDenials: [denial({ count: 2 })] }), measured({ toolDenials: [denial()] })] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fingerprint: "repeated-tool-denial|acme/app|Bash", severity: "minor", about: "project", repo: "acme/app", evidence: { counts: { denials: 3, runs: 2 }, lines: ["tool Bash"] } });
  });
  it("does not add different tools or repositories, and leaves out old denials", () => {
    expect(find("repeated-tool-denial", { measures: [measured({ toolDenials: [denial({ count: 2 }), denial({ tool: "Read" })] })] })).toEqual([]);
    expect(find("repeated-tool-denial", { measures: [measured({ toolDenials: [denial({ count: 2 }), denial({ repo: "acme/other" })] })] })).toEqual([]);
    expect(find("repeated-tool-denial", { measures: [measured({ toolDenials: [denial({ count: 2 }), denial({ at: at(25 * HOUR) })] })] })).toEqual([]);
  });
  it("makes nothing from missing data", () => {
    expect(find("repeated-tool-denial")).toEqual([]);
  });
  it("names the tool before the colon", () => {
    expect(deniedTool("Bash: mkdir out")).toBe("Bash");
    expect(deniedTool("Read")).toBe("Read");
    expect(deniedTool(" : x")).toBeUndefined();
  });
});

describe("abnormal-output", () => {
  const samples = (tokens: number[], over: Partial<StepVisit> = {}) => measured({ visits: tokens.map((t) => visit({ tokensOut: t, ...over })) });
  const base = [4000, 4000, 4000, 4000, 4000];
  it("finds a visit above factor × median and above the least tokens", () => {
    const f = find("abnormal-output", { measures: [samples([...base, 25000])] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fingerprint: "abnormal-output|acme/app|issue-gitflow|build", severity: "minor", about: "project", repo: "acme/app", evidence: { counts: { visits: 1, largest_tokens: 25000, median_tokens: 4000 } } });
    expect(find("abnormal-output", { measures: [samples([...base, 20000])] })).toEqual([]);
  });
  it("needs more than the least tokens, enough samples and the window", () => {
    expect(find("abnormal-output", { measures: [samples([1000, 1000, 1000, 1000, 1000, 15000])] })).toEqual([]);
    expect(find("abnormal-output", { measures: [samples([4000, 4000, 4000, 25000])] })).toEqual([]);
    const old = samples([...base, 25000]);
    old.visits[5]!.at = at(25 * HOUR);
    expect(find("abnormal-output", { measures: [old] })).toEqual([]);
  });
  it("ignores visits without tokens, takes the median across repositories and reports per repository", () => {
    const m = samples([...base, 25000]);
    m.visits.push(visit({ tokensOut: undefined }));
    expect(find("abnormal-output", { measures: [m] })).toHaveLength(1);
    const a = samples([4000, 4000, 4000]);
    const b = measured({ repo: "acme/other", visits: [4000, 4000, 25000].map((t) => visit({ tokensOut: t, repo: "acme/other" })) });
    const f = find("abnormal-output", { measures: [a, b] });
    expect(f.map((x) => x.fingerprint)).toEqual(["abnormal-output|acme/other|issue-gitflow|build"]);
  });
  it("makes nothing from missing data", () => {
    expect(find("abnormal-output")).toEqual([]);
  });
});

describe("detector info", () => {
  it("names the five detectors with owner, threshold, window and next action", () => {
    const info = detectorInfo(config);
    const owners: Record<string, string> = { "policy-service-failure": "admin", "evidence-finalization": "admin", "step-latency-p95": "admin", "repeated-tool-denial": "repository owner", "abnormal-output": "repository owner" };
    for (const [name, owner] of Object.entries(owners)) {
      const d = info.find((x) => x.name === name)!;
      expect(d.slo, name).toMatchObject({ owner });
      expect(d.slo!.threshold.length, name).toBeGreaterThan(0);
      expect(d.slo!.window.length, name).toBeGreaterThan(0);
      expect(d.slo!.action.length, name).toBeGreaterThan(0);
      expect(ALL_DETECTORS.map((x) => x.name)).toContain(name);
    }
    expect(info.filter((d) => d.slo)).toHaveLength(5);
  });
  it("follows the settings, and is absent without a config", () => {
    const info = detectorInfo(withConfig({ step_latency_p95: { minutes: 90 }, abnormal_output: { within_hours: 48 } }));
    expect(info.find((d) => d.name === "step-latency-p95")!.slo!.threshold).toContain("90");
    expect(info.find((d) => d.name === "abnormal-output")!.slo!.window).toContain("48");
    expect(detectorInfo().some((d) => d.slo)).toBe(false);
    expect(sloLookbackHours(withConfig({ abnormal_output: { within_hours: 48 } }))).toBe(48);
  });
  it("the policy action tells to repair the packs, not to resume runs", () => {
    const a = detectorInfo(config).find((d) => d.name === "policy-service-failure")!.slo!.action;
    expect(a).toMatch(/repair/i);
    expect(a).toContain("policy.packs");
    expect(a).not.toMatch(/resume/i);
  });
  it("has descriptions of two sentences, at most 240 characters", () => {
    for (const d of SLO_DETECTORS) {
      expect(d.description.length, d.name).toBeLessThanOrEqual(240);
      expect(d.description.match(/[.!?](?:\s|$)/g)?.length, d.name).toBe(2);
    }
  });
});

describe("files", () => {
  let tmp: string;
  let seq = 0;
  beforeEach(() => {
    tmp = join(tmpdir(), `scf-slo-${process.pid}-${Date.now()}-${++seq}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    resetTelemetry();
    rmSync(tmp, { recursive: true, force: true });
  });

  const stepId = (id = "build", visitNo = 1, type = "shell") => ({ id, visit: visitNo, type });
  const line = (i: number, type: string, minutesAgo: number, runId: string, rest: object = {}) => JSON.stringify({ version: 1, id: `ev-${i}`, seq: i, runId, time: iso(NOW.getTime() - minutesAgo * MIN), type, ...rest });
  const sha = "a".repeat(64);
  /** A valid decision: `policy.unavailable` and `policy.invalid` have no pack and no rule and deny; any other code here is "no rule matched". */
  const policy = (i: number, minutesAgo: number, runId: string, code: string) => {
    const failed = code === "policy.unavailable" || code === "policy.invalid";
    const decision = { version: 1, policy: { id: "p", version: "1" }, ...(failed ? {} : { packSha256: sha }), mode: "observe", boundary: "step.before", inputSha256: sha, outcome: failed ? "deny" : "allow", reasonCode: failed ? code : "policy.no-rule-matched", evaluatedAt: iso(NOW.getTime() - minutesAgo * MIN) };
    return line(i, "policy.decided", minutesAgo, runId, { decision, step: stepId() });
  };
  const toolDenied = (i: number, minutesAgo: number, runId: string, tool: string, id = "build") => line(i, "step.denied", minutesAgo, runId, { step: stepId(id), denial: { kind: "tool", tool: { name: tool } } });
  const started = (i: number, minutesAgo: number, runId: string, id = "build") => line(i, "step.started", minutesAgo, runId, { step: stepId(id) });

  let k = 0;
  const makeRun = (over: Partial<RunSummary> = {}, events?: string[]): RunSummary => {
    const runId = `20261001-11${String(++k).padStart(4, "0")}-abcd`;
    const runDir = join(tmp, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const r = {
      runId, flow: "issue-gitflow", task: "t", status: "succeeded", startedAt: iso(at(30 * MIN)), finishedAt: iso(at(10 * MIN)), vars: { github_repo: "acme/app" }, totalCostUsd: 0,
      history: [], state: { next: null, steps: {}, visits: {} }, runDir, ...over,
    } as unknown as RunSummary;
    saveRun(r);
    if (events) writeFileSync(join(runDir, "evidence.jsonl"), `${events.join("\n")}\n`);
    return r;
  };
  const rec = (over: object = {}) => ({ id: "build", type: "shell", visit: 1, ok: true, output: "", startedAt: iso(at(20 * MIN)), durationMs: MIN, logFile: "x", ...over });
  const stamps = (runs: RunSummary[]) => new Map(runs.map((r) => [r.runDir, "2026-10-01T11:50:00.000Z"]));

  describe("SloInputCache", () => {
    it("reads policy failures and judges them at the time of the decision", async () => {
      const id = "20261001-110000-abcd";
      const r = makeRun({ runId: id, status: "running", finishedAt: undefined }, []);
      writeFileSync(join(r.runDir, "evidence.jsonl"), [policy(0, 5, id, "policy.unavailable"), policy(1, 90, id, "policy.invalid"), policy(2, 4, id, "ok.fine")].join("\n"));
      const out = await new SloInputCache().build([r], stamps([r]), NOW, config);
      expect(out.measures[0]!.policyFailures.sort()).toEqual([at(90 * MIN), at(5 * MIN)].sort());
      expect(out.evidence).toEqual([]); // a running run is not judged for its evidence
      // a recent failure in an unfinished run is found; an old one in a run that just ended is not
      expect(find("policy-service-failure", { measures: out.measures })).toHaveLength(1);
      expect(find("policy-service-failure", { measures: [{ ...out.measures[0]!, policyFailures: [at(90 * MIN)] }] })).toEqual([]);
    });

    it("reconciles tool denials per visit and tool: complementary data across visits adds up, the same refusal is not counted twice", async () => {
      const id = "20261001-110001-abcd";
      const r = makeRun({
        runId: id,
        history: [rec({ id: "a", denied: ["Bash: x", "Bash: y"] }), rec({ id: "b", startedAt: iso(at(15 * MIN)), denied: ["Bash: z"] }), rec({ id: "c", startedAt: iso(at(12 * MIN)), denied: ["Read: q"] })] as never,
      }, [
        started(0, 20, id, "a"), started(1, 15, id, "b"), toolDenied(2, 15, id, "Bash", "b"), toolDenied(3, 15, id, "Bash", "b"),
        toolDenied(4, 11, id, "Write", "d"), // no record for this step: evidence only
      ]);
      const out = await new SloInputCache().build([r], stamps([r]), NOW, config);
      const total = (tool: string) => out.measures[0]!.toolDenials.filter((d) => d.tool === tool).reduce((s, d) => s + d.count, 0);
      expect(total("Bash")).toBe(4); // a: 2 (record only), b: max(1, 2)
      expect(total("Read")).toBe(1);
      expect(total("Write")).toBe(1);
    });

    it("matches the denials of a nested step in the record and in the evidence, and counts them once", async () => {
      const id = "20261001-110005-abcd";
      const nested = (type: string, minutesAgo: number) => line(0, type, minutesAgo, id, { step: { id: "test", visit: 1, type: "shell", parent: "build" }, ...(type === "step.denied" ? { denial: { kind: "tool", tool: { name: "Bash" } } } : {}) });
      const r = makeRun({ runId: id, history: [rec({ id: "build/test", parent: "build", denied: ["Bash: a", "Bash: b"] })] as never }, [nested("step.started", 20), nested("step.denied", 19), nested("step.denied", 19)]);
      const out = await new SloInputCache().build([r], stamps([r]), NOW, config);
      expect(out.measures[0]!.toolDenials.reduce((s, d) => s + d.count, 0)).toBe(2);
      expect(find("repeated-tool-denial", { measures: out.measures })).toEqual([]);
    });

    it("measures a visit once per updatedAt, sees a manifest written later, and does not cache a run that just ended", async () => {
      const id = "20261001-110002-abcd";
      const r = makeRun({ runId: id, history: [rec({ denied: ["Bash: a"] })] as never }, [started(0, 20, id), toolDenied(1, 19, id, "Bash")]);
      const cache = new SloInputCache();
      const first = await cache.build([r], stamps([r]), NOW, config);
      expect(first.evidence[0]).toMatchObject({ stream: true, manifest: false, incomplete: false });
      rmSync(join(r.runDir, "evidence.jsonl"));
      writeFileSync(join(r.runDir, "evidence.json"), "{}");
      const again = await cache.build([r], stamps([r]), NOW, config);
      expect(again.measures[0]).toBe(first.measures[0]); // the same updatedAt: not read again
      expect(again.evidence[0]).toMatchObject({ stream: false, manifest: true });
      const changed = await cache.build([r], new Map([[r.runDir, "2026-10-01T11:59:00.000Z"]]), NOW, config);
      expect(changed.measures[0]).not.toBe(first.measures[0]);
      const fresh = makeRun({ finishedAt: iso(at(MIN)) }, []);
      const c2 = new SloInputCache();
      const a = await c2.build([fresh], stamps([fresh]), NOW, config);
      const b = await c2.build([fresh], stamps([fresh]), NOW, config);
      expect(b.measures[0]).not.toBe(a.measures[0]);
    });

    it("leaves out runs that ended before the longest window, notes an incomplete mark, and drops cache entries of runs that are gone", async () => {
      const old = makeRun({ finishedAt: iso(at(30 * HOUR)) }, []);
      const marked = makeRun({}, []);
      writeFileSync(join(marked.runDir, "evidence.incomplete"), "");
      const cache = new SloInputCache();
      const out = await cache.build([old, marked], stamps([old, marked]), NOW, config);
      expect(out.evidence.map((e) => e.runId)).toEqual([marked.runId]);
      expect(out.evidence[0]).toMatchObject({ incomplete: true });
      await cache.build([], new Map(), NOW, config);
      expect(((cache as unknown) as { cache: Map<string, unknown> }).cache.size).toBe(0);
    });

    it("survives broken lines, other runs' events, a link, an oversized file and a missing folder", async () => {
      const id = "20261001-110003-abcd";
      const r = makeRun({ runId: id, history: [rec()] as never }, ["{not json", policy(0, 5, id, "policy.unavailable"), policy(1, 5, "other-run", "policy.unavailable"), `{"a":${"1".repeat(10)}`]);
      const out = await new SloInputCache().build([r], stamps([r]), NOW, config);
      expect(out.measures[0]!.policyFailures).toHaveLength(1);
      expect(out.measures[0]!.visits).toHaveLength(1);
      const linked = makeRun({}, []);
      rmSync(join(linked.runDir, "evidence.jsonl"));
      writeFileSync(join(tmp, "elsewhere"), policy(0, 5, linked.runId, "policy.unavailable"));
      symlinkSync(join(tmp, "elsewhere"), join(linked.runDir, "evidence.jsonl"));
      expect((await new SloInputCache().build([linked], stamps([linked]), NOW, config)).measures[0]!.policyFailures).toEqual([]);
      const big = makeRun({}, []);
      writeFileSync(join(big.runDir, "evidence.jsonl"), Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 0x20));
      const bigOut = await new SloInputCache().build([big], stamps([big]), NOW, config);
      expect(bigOut.measures[0]!.policyFailures).toEqual([]);
      const gone = makeRun({}, []);
      rmSync(gone.runDir, { recursive: true });
      await expect(new SloInputCache().build([gone], stamps([gone]), NOW, config)).resolves.toBeDefined();
    });

    it("keeps the event loop free while it reads a large stream", async () => {
      const id = "20261001-110004-abcd";
      const many = Array.from({ length: 5000 }, (_, i) => policy(i, 5, id, "ok.fine"));
      const r = makeRun({ runId: id }, many);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 0);
      await new SloInputCache().build([r], stamps([r]), NOW, config);
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(0);
    });
  });

  describe("the monitor", () => {
    const source = (f: string) => readFileSync(new URL(`../src/monitor/${f}`, import.meta.url), "utf8");
    it("no SLO file imports telemetry", () => {
      for (const f of ["slo-detectors.ts", "slo-input.ts"]) expect(source(f)).not.toMatch(/telemetry\//);
    });

    /** A run with three refusals of Bash and an evidence stream with no manifest, as found by a monitor with its own files. */
    async function check(name: string): Promise<string[]> {
      const dir = join(tmp, name);
      mkdirSync(dir, { recursive: true });
      const runsDir = join(dir, "runs");
      const id = "20261001-115000-abcd";
      const runDir = join(runsDir, id);
      mkdirSync(runDir, { recursive: true });
      const fin = Date.now() - 10 * MIN;
      saveRun({
        runId: id, flow: "issue-gitflow", task: "t", status: "succeeded", startedAt: new Date(fin - 20 * MIN).toISOString(), finishedAt: new Date(fin).toISOString(), vars: { github_repo: "acme/app" }, totalCostUsd: 0,
        history: [{ id: "build", type: "shell", visit: 1, ok: true, output: "", startedAt: new Date(fin - 5 * MIN).toISOString(), durationMs: MIN, logFile: "x", denied: ["Bash: a", "Bash: b", "Bash: c"] }],
        state: { next: null, steps: {}, visits: {} }, runDir,
      } as unknown as RunSummary);
      writeFileSync(join(runDir, "evidence.jsonl"), `${line(0, "run.started", 25, id)}\n`);
      const file = join(dir, "monitor-findings.json");
      const cfg = ConfigSchema.parse({ protected_branches: [] });
      const scheduler = new Scheduler({ runsDir, config: () => cfg });
      const m = new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), { scheduler, watchers: () => [], thresholds: () => cfg.monitor, log: () => {}, file });
      await m.tick();
      expect(m.status.lastError).toBeUndefined();
      return loadFindings(file).findings.map((f) => f.fingerprint).sort();
    }

    it("gives the same findings with telemetry off and with a collector that cannot be reached", async () => {
      resetTelemetry();
      configureTelemetry(ConfigSchema.parse({ protected_branches: [], telemetry: { local: false } }));
      const off = await check("off");
      expect(off).toContain("evidence-finalization");
      expect(off).toContain("repeated-tool-denial|acme/app|Bash");

      resetTelemetry();
      const calls: string[] = [];
      configureTelemetry(ConfigSchema.parse({ protected_branches: [], telemetry: { local: false, otlp: { enabled: true, endpoint: "http://127.0.0.1:9/v1/logs", timeout_ms: 200 } } }), {
        fetch: async (url) => {
          calls.push(String(url));
          throw new Error("connect ECONNREFUSED");
        },
      });
      // an event is exported, so the failing collector is really in use during the check
      emitRunMeasured({ runId: "20261001-115000-abcd", flow: "issue-gitflow", status: "succeeded", startedAt: iso(at(20 * MIN)), finishedAt: iso(at(10 * MIN)), vars: { github_repo: "acme/app" }, history: [], runDir: join(tmp, "nowhere") } as unknown as RunSummary);
      const broken = await check("broken");
      await closeTelemetry(1000);
      expect(calls.length).toBeGreaterThan(0);
      expect(broken).toEqual(off);
    });
  });
});

describe("runDetectors with the SLO detectors", () => {
  it("never throws on a bad input and the five are in ALL_DETECTORS", () => {
    const out = runDetectors(SLO_DETECTORS, input({ measures: [{ runId: "x" } as never], evidence: [{ finishedAt: 1 } as never] }));
    expect(Array.isArray(out)).toBe(true);
    expect(SLO_DETECTORS.every((d) => ALL_DETECTORS.includes(d))).toBe(true);
  });
});
