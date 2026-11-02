import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { GATE_CHECK_IDS, evalCoverage, promotionGate, readGateFindings, type EvalCoverage, type GateDeps, type GateFindings, type GateRuns, type PromotionGate } from "../src/governance/gate.js";
import type { Finding } from "../src/monitor/findings.js";
import type { OutcomeFacts } from "../src/outcome-facts.js";

// The gate is pure over its deps: every case here hands it fake runs, facts, reports and findings.

const NOW = new Date("2026-06-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SETTINGS = { min_runs: 3, evidence_completeness: 0.9, eval_pass_rate: 0.8, within_days: 30 };
const REPO_ID = "11111111-1111-4111-8111-111111111111";

let seq = 0;
const run = (o: Partial<RunSummary> = {}): RunSummary =>
  ({ runId: `r${++seq}`, flow: "build", task: "", vars: {}, repo: "", status: "succeeded", runDir: `/x/${seq}`, startedAt: ago(2 * DAY + HOUR), finishedAt: ago(2 * DAY), totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...o }) as unknown as RunSummary;
const facts = (r: RunSummary, o: Partial<OutcomeFacts> & { evidence?: Partial<OutcomeFacts["evidence"]> } = {}): OutcomeFacts => {
  const { evidence, ...rest } = o;
  return {
    runId: r.runId, evidence: { stream: true, read: true, manifest: true, incomplete: false, ...evidence }, pushed: false, delivered: false, policyBlocks: 0, observeDenies: 0,
    policyBadAt: [], linesSkipped: 0, models: [], policies: [], approvals: { decided: 0, totalMs: 0, maxMs: 0 }, resumes: 0, ...rest,
  };
};
const world = (runs: RunSummary[], over: (r: RunSummary) => Parameters<typeof facts>[1] = () => ({}), failedLoads = 0): GateRuns => ({
  runs, facts: new Map(runs.map((r) => [r.runId, facts(r, over(r))])), failedLoads,
});
const good = (n = 3): RunSummary[] => Array.from({ length: n }, () => run());
const cover = (flows: Record<string, number | { rate: number; problem?: string }>, cut = false): EvalCoverage => ({
  flows: new Map(Object.entries(flows).map(([k, v]) => {
    const rate = typeof v === "number" ? v : v.rate;
    return [k, { report: `suite-2026-06-01T00-00-00-000Z`, suite: "suite", stamp: "2026-06-01T00-00-00-000Z", passed: Math.round(rate * 10), total: 10, rate, ...(typeof v === "object" && v.problem ? { problem: v.problem } : {}) }];
  })),
  cut,
});
const finding = (o: Partial<Finding> = {}): Finding =>
  ({ detector: "policy-service-failure", fingerprint: "fp", severity: "major", summary: "s", evidence: { flows: ["build"] }, about: "foundry", firstSeen: ago(HOUR), lastSeen: ago(HOUR), count: 1, gone: false, ...o }) as Finding;
const quiet: GateFindings = { findings: [], broken: false, monitorOkAt: new Date(NOW.getTime() - HOUR) };

function deps(over: Partial<GateDeps> & { loaded?: GateRuns } = {}): GateDeps {
  const { loaded, ...rest } = over;
  return {
    settings: SETTINGS,
    repoName: (id) => (id === REPO_ID ? "Acme/Web" : undefined),
    runs: async () => loaded ?? world(good()),
    evals: async () => cover({ build: 0.9 }),
    findings: () => quiet,
    ...rest,
  };
}
const gate = (d: GateDeps = deps(), kind: "flows" | "repos" = "flows", id = "build"): Promise<PromotionGate> => promotionGate(kind, id, "guarded-write", NOW, d);
const check = (g: PromotionGate, id: (typeof GATE_CHECK_IDS)[number]) => g.checks.find((c) => c.id === id)!;

describe("promotionGate", () => {
  it("gives the five checks in order with all six fields, and passes on the four evidence checks while approval stays pending", async () => {
    const g = await gate();
    expect(g.checks.map((c) => c.id)).toEqual([...GATE_CHECK_IDS]);
    for (const c of g.checks) expect(Object.keys(c).sort()).toEqual(["detail", "id", "label", "passed", "threshold", "value"]);
    expect(g.checks.slice(0, 4).map((c) => c.passed)).toEqual([true, true, true, true]);
    expect(check(g, "approval")).toMatchObject({ passed: false, value: "pending", threshold: "approved" });
    expect(g.passed).toBe(true);
  });

  it("uses the same checks for every target level", async () => {
    const a = await promotionGate("flows", "build", "plan-only", NOW, deps());
    const b = await promotionGate("flows", "build", "delivery-handoff", NOW, deps());
    expect(a).toEqual(b);
  });

  it.each([
    ["evidence_completeness", () => deps({ loaded: world(good(), () => ({ evidence: { manifest: false } })) })],
    ["eval_pass_rate", () => deps({ evals: async () => cover({ build: 0.5 }) })],
    ["policy_conformance", () => deps({ loaded: world(good(), () => ({ policyBadAt: [ago(DAY)] })) })],
    ["operational_slos", () => deps({ findings: () => ({ ...quiet, findings: [finding()] }) })],
  ] as const)("fails as a whole when only %s fails", async (id, make) => {
    const g = await gate(make());
    expect(g.passed).toBe(false);
    expect(g.checks.filter((c) => !c.passed && c.id !== "approval").map((c) => c.id)).toEqual([id]);
  });

  it("never throws: a dependency that throws fails its checks with a plain reason", async () => {
    const boom = () => {
      throw new Error("/secret/path");
    };
    const g = await gate(deps({ runs: async () => boom(), evals: async () => boom(), findings: boom }));
    expect(g.passed).toBe(false);
    for (const c of g.checks.slice(0, 4)) {
      expect(c).toMatchObject({ passed: false, value: null });
      expect(c.detail).toContain("could not be read");
      expect(c.detail).not.toContain("secret");
    }
  });
});

describe("evidence_completeness", () => {
  const ev = async (loaded: GateRuns) => check(await gate(deps({ loaded })), "evidence_completeness");

  it("fails with no runs and with one run less than min_runs, with a null value", async () => {
    expect(await ev(world([]))).toMatchObject({ passed: false, value: null });
    const c = await ev(world(good(2)));
    expect(c).toMatchObject({ passed: false, value: null });
    expect(c.detail).toContain("at least 3");
  });

  it("passes exactly at the threshold and fails just below it", async () => {
    const ten = good(10);
    const at = ten.slice(0, 9).map((r) => r.runId);
    expect(await ev(world(ten, (r) => ({ evidence: { manifest: at.includes(r.runId) } })))).toMatchObject({ passed: true, value: 0.9 });
    const below = ten.slice(0, 8).map((r) => r.runId);
    expect(await ev(world(ten, (r) => ({ evidence: { manifest: below.includes(r.runId) } })))).toMatchObject({ passed: false, value: 0.8 });
  });

  it("does not count refinement runs or local-test runs towards min_runs, nor runs outside the window", async () => {
    const runs = [...good(2), run({ source: "refinement architect" }), run({ localTest: true }), run({ finishedAt: ago(31 * DAY), startedAt: ago(31 * DAY + HOUR) })];
    expect((await ev(world(runs))).passed).toBe(false);
    expect((await ev(world([...runs, run()]))).passed).toBe(true);
  });

  it("fails when a run of the window could not be loaded", async () => {
    const c = await ev(world(good(5), () => ({}), 1));
    expect(c).toMatchObject({ passed: false, value: null });
    expect(c.detail).toContain("could not be read");
  });
});

describe("policy_conformance", () => {
  const pol = async (loaded: GateRuns) => check(await gate(deps({ loaded })), "policy_conformance");

  it("passes for enough clean runs", async () => {
    expect(await pol(world(good()))).toMatchObject({ passed: true, value: 0 });
  });

  it("fails for a deny, whatever its mode, and for policy.unavailable and policy.invalid (all are recorded by time)", async () => {
    for (const times of [[ago(DAY)], [ago(2 * HOUR), ago(HOUR)]]) {
      const [first] = good(1);
      const rest = good(2);
      const runs = [first!, ...rest];
      const c = await pol(world(runs, (r) => (r === first ? { policyBadAt: times } : {})));
      expect(c).toMatchObject({ passed: false, value: times.length });
    }
  });

  it("fails for a recent denial that follows fifty old ones in the same run", async () => {
    const runs = [run({ finishedAt: ago(5 * 60_000), startedAt: ago(40 * DAY) }), ...good(2)];
    const old = Array.from({ length: 50 }, (_, i) => ago(40 * DAY + i));
    const c = await pol(world(runs, (r) => (r === runs[0] ? { policyBadAt: [...old, ago(HOUR)] } : {})));
    expect(c).toMatchObject({ passed: false, value: 1 });
  });

  it("counts a decision by its own time: an old denial in a run that ended just now does not fail, a recent one does", async () => {
    const runs = [run({ finishedAt: ago(5 * 60_000), startedAt: ago(40 * DAY) }), ...good(2)];
    expect((await pol(world(runs, (r) => (r === runs[0] ? { policyBadAt: [ago(35 * DAY)] } : {})))).passed).toBe(true);
    expect((await pol(world(runs, (r) => (r === runs[0] ? { policyBadAt: [ago(DAY)] } : {})))).passed).toBe(false);
  });

  it("fails for a run with no facts, an unread stream and skipped lines: their decisions are unknown, not clean", async () => {
    const runs = good(4);
    const lacking: GateRuns = { runs, facts: new Map(runs.slice(1).map((r) => [r.runId, facts(r)])), failedLoads: 0 };
    expect(await pol(lacking)).toMatchObject({ passed: false, value: null });
    expect((await pol(world(runs, (r) => (r === runs[0] ? { evidence: { read: false } } : {})))).passed).toBe(false);
    expect((await pol(world(runs, (r) => (r === runs[0] ? { evidence: { stream: false, read: false } } : {})))).passed).toBe(false);
    const skipped = await pol(world(runs, (r) => (r === runs[0] ? { linesSkipped: 1 } : {})));
    expect(skipped.passed).toBe(false);
    expect(skipped.detail).toContain("in full");
  });

  it("fails while a run is still running, even one that started before the window", async () => {
    const active = run({ status: "running", startedAt: ago(40 * DAY), finishedAt: undefined });
    const runs = [...good(3), active];
    const c = await pol({ runs, facts: new Map(runs.filter((r) => r !== active).map((r) => [r.runId, facts(r)])), failedLoads: 0 });
    expect(c.passed).toBe(false);
    expect(c.detail).toContain("not ended yet");
  });

  it("fails with too few ended runs, and when a run could not be loaded", async () => {
    expect((await pol(world(good(2)))).detail).toContain("at least 3");
    expect(await pol(world(good(5), () => ({}), 2))).toMatchObject({ passed: false, value: null });
  });
});

describe("eval_pass_rate", () => {
  const evals = async (c: EvalCoverage | undefined, kind: "flows" | "repos" = "flows", id = "build", loaded?: GateRuns) =>
    check(await gate(deps({ evals: async () => c ?? Promise.reject(new Error("x")), ...(loaded ? { loaded } : {}) }), kind, kind === "repos" ? REPO_ID : id), "eval_pass_rate");

  it("fails with no report for the flow, with a null value and a reason", async () => {
    const c = await evals(cover({ other: 1 }));
    expect(c).toMatchObject({ passed: false, value: null });
    expect(c.detail).toContain("no eval report");
  });

  it("passes at the threshold, above it, and fails below it", async () => {
    expect(await evals(cover({ build: 0.8 }))).toMatchObject({ passed: true, value: 0.8 });
    expect(await evals(cover({ build: 1 }))).toMatchObject({ passed: true, value: 1 });
    expect(await evals(cover({ build: 0.7 }))).toMatchObject({ passed: false, value: 0.7 });
  });

  it("fails for a covering report that has a problem, and says when only the newest reports were read", async () => {
    expect(await evals(cover({ build: { rate: 1, problem: "a newer report of the same suite (x) could not be read" } }))).toMatchObject({ passed: false });
    expect((await evals(cover({}, true))).detail).toContain("newest reports were read");
  });

  it("checks every flow of a repository: the lowest rate counts, an uncovered flow fails, no runs fails", async () => {
    const runs = [...good(2), run({ flow: "review" })];
    const loaded = world(runs);
    expect(await evals(cover({ build: 0.9, review: 0.85 }), "repos", "", loaded)).toMatchObject({ passed: true, value: 0.85 });
    const low = await evals(cover({ build: 0.9, review: 0.5 }), "repos", "", loaded);
    expect(low).toMatchObject({ passed: false, value: 0.5 });
    expect(low.detail).toContain("review");
    expect(await evals(cover({ build: 0.9 }), "repos", "", loaded)).toMatchObject({ passed: false, value: null });
    expect((await evals(cover({ build: 0.9 }), "repos", "", world([]))).passed).toBe(false);
  });

  it("names at most 5 failing flows and then the count of the rest", async () => {
    const runs = Array.from({ length: 8 }, (_, i) => run({ flow: `f${i}` }));
    const c = await evals(cover({}), "repos", "", world(runs));
    expect(c.detail).toContain("and 3 more");
  });
});

describe("operational_slos", () => {
  const slo = async (found: GateFindings | (() => never), kind: "flows" | "repos" = "flows") =>
    check(await gate(deps({ findings: typeof found === "function" ? found : () => found }), kind, kind === "repos" ? REPO_ID : "build"), "operational_slos");

  it("fails for an open SLO finding that names the flow, and passes for another flow", async () => {
    expect(await slo({ ...quiet, findings: [finding()] })).toMatchObject({ passed: false, value: 1 });
    expect((await slo({ ...quiet, findings: [finding({ evidence: { flows: ["other"] } })] })).passed).toBe(true);
  });

  it("names a repository by finding.repo or evidence.repos, in any case", async () => {
    expect((await slo({ ...quiet, findings: [finding({ repo: "acme/WEB", evidence: {} })] }, "repos")).passed).toBe(false);
    expect((await slo({ ...quiet, findings: [finding({ evidence: { repos: ["ACME/web"] } })] }, "repos")).passed).toBe(false);
    expect((await slo({ ...quiet, findings: [finding({ repo: "acme/other", evidence: {} })] }, "repos")).passed).toBe(true);
  });

  it("ignores a gone finding and a finding of a detector that is not an SLO detector; a mute does not hide one", async () => {
    expect((await slo({ ...quiet, findings: [finding({ gone: true }), finding({ detector: "orphan-lock" })] })).passed).toBe(true);
    expect((await slo({ ...quiet, findings: [finding({ fingerprint: "muted", report: undefined, muted: true } as Partial<Finding>)] })).passed).toBe(false);
  });

  it("fails for a broken, a missing or a stale monitor, and when the findings cannot be read at all", async () => {
    expect((await slo({ findings: [], broken: true, monitorOkAt: quiet.monitorOkAt })).detail).toContain("could not be read");
    expect((await slo({ findings: [], broken: false })).detail).toContain("has not finished a check");
    expect((await slo({ findings: [], broken: false, monitorOkAt: new Date(NOW.getTime() - 25 * HOUR) })).passed).toBe(false);
    expect((await slo(() => {
      throw new Error("x");
    })).passed).toBe(false);
  });
});

describe("a repository without a GitHub name", () => {
  it("fails the four evidence checks with one plain reason", async () => {
    const g = await gate(deps(), "repos", "22222222-2222-4222-8222-222222222222");
    expect(g.passed).toBe(false);
    for (const c of g.checks.slice(0, 4)) expect(c).toMatchObject({ passed: false, value: null, detail: "This repository has no GitHub name, so its runs cannot be found." });
  });

  it("asks for the runs of the repository by its name", async () => {
    const asked: unknown[] = [];
    await gate(deps({ runs: async (scope) => (asked.push(scope), world(good())) }), "repos", REPO_ID);
    expect(asked).toEqual([{ repo: "Acme/Web" }]);
  });
});

describe("evalCoverage", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const stamp = (day: number) => `2026-06-${String(day).padStart(2, "0")}T10-00-00-000Z`;
  const folder = (): string => {
    const d = mkdtempSync(join(tmpdir(), "gate-evals-"));
    dirs.push(d);
    return d;
  };
  const report = (dir: string, suite: string, day: number, results: Record<string, boolean[]>) =>
    writeFileSync(join(dir, `${suite}-${stamp(day)}.json`), JSON.stringify({ suite, results: Object.entries(results).flatMap(([variant, ps]) => ps.map((passed) => ({ variant, passed }))) }));

  it("reads nothing from a missing folder", async () => {
    expect(await evalCoverage(join(tmpdir(), "gate-evals-none-xyz"))).toEqual({ flows: new Map(), cut: false });
  });

  it("takes the newest report that covers the flow and falls back to an older one when a newer one does not cover it", async () => {
    const d = folder();
    report(d, "safety", 1, { build: [true, false] });
    report(d, "safety", 2, { build: [true, true, true, false] });
    report(d, "safety", 3, { other: [true] });
    const c = await evalCoverage(d);
    expect(c.flows.get("build")).toMatchObject({ report: `safety-${stamp(2)}`, passed: 3, total: 4, rate: 0.75 });
    expect(c.flows.get("other")?.report).toBe(`safety-${stamp(3)}`);
    expect(c.cut).toBe(false);
  });

  it("counts a `<flow>@<model>` variant for the flow", async () => {
    const d = folder();
    report(d, "safety", 1, { "build@sonnet": [true, true], "build@haiku": [false, false] });
    expect(await evalCoverage(d).then((c) => c.flows.get("build"))).toMatchObject({ passed: 2, total: 4, rate: 0.5 });
  });

  it("lets a corrupt newer report block only the flows of its own suite", async () => {
    const d = folder();
    report(d, "safety", 1, { build: [true] });
    report(d, "other", 1, { review: [true] });
    writeFileSync(join(d, `safety-${stamp(5)}.json`), "{not json");
    const c = await evalCoverage(d);
    expect(c.flows.get("build")?.problem).toContain(`safety-${stamp(5)}`);
    expect(c.flows.get("review")?.problem).toBeUndefined();
    expect(c.flows.get("build")?.problem).not.toContain(d);
  });

  it("treats a report with one malformed result as unusable: partly read reports never give a rate", async () => {
    const d = folder();
    report(d, "safety", 1, { build: [true, true] });
    writeFileSync(join(d, `safety-${stamp(2)}.json`), JSON.stringify({ suite: "safety", results: [{ variant: "build", passed: true }, { variant: "build" }] }));
    const c = await evalCoverage(d);
    expect(c.flows.get("build")?.problem).toContain(`safety-${stamp(2)}`);
    expect(c.flows.get("build")?.rate).toBe(1);
  });

  it("does not fall back to an older passing report when the newer one has only malformed results", async () => {
    const d = folder();
    report(d, "safety", 1, { build: [true] });
    writeFileSync(join(d, `safety-${stamp(2)}.json`), JSON.stringify({ suite: "safety", results: [{ variant: "build", passed: "yes" }, { passed: true }] }));
    const c = await evalCoverage(d);
    expect(c.flows.get("build")?.problem).toContain(`safety-${stamp(2)}`);
    const gate = await promotionGate("flows", "build", "guarded-write", NOW, deps({ evals: async () => c }));
    expect(gate.checks[1]).toMatchObject({ passed: false });
  });

  it("ignores a file without a timestamp, does not follow a link, and sets cut past the maximum", async () => {
    const d = folder();
    writeFileSync(join(d, "safety.json"), JSON.stringify({ results: [{ variant: "ghost", passed: true }] }));
    mkdirSync(join(d, "elsewhere"));
    writeFileSync(join(d, "elsewhere", "t.json"), JSON.stringify({ results: [{ variant: "linked", passed: true }] }));
    symlinkSync(join(d, "elsewhere", "t.json"), join(d, `link-${stamp(9)}.json`));
    for (const day of [1, 2, 3]) report(d, "safety", day, { build: [true] });
    const c = await evalCoverage(d, 2);
    expect(c.flows.has("ghost")).toBe(false);
    expect(c.flows.has("linked")).toBe(false);
    expect(c.cut).toBe(true);
  });
});

describe("readGateFindings", () => {
  it("keeps a broken findings file where it is and reports it as broken", async () => {
    const d = folder();
    const file = join(d, "monitor-findings.json");
    writeFileSync(file, "{broken");
    const when = new Date(NOW.getTime() - HOUR);
    expect(readGateFindings(when, file)).toEqual({ findings: [], broken: true, monitorOkAt: when });
    expect(readGateFindings(undefined, join(d, "none.json"))).toEqual({ findings: [], broken: false });
    expect(await import("node:fs").then((fs) => fs.existsSync(`${file}.broken`))).toBe(false);
  });

  function folder(): string {
    const d = mkdtempSync(join(tmpdir(), "gate-findings-"));
    afterEach(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }
});
