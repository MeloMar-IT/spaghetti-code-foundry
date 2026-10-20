import { beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { detectorInfo } from "../src/monitor/work-detectors.js";
import { outcomeFactsOf, type OutcomeFacts } from "../src/outcome-facts.js";
import { computeOutcomes, median, OUTCOME_DEFINITIONS, OUTCOME_IDS, outcomeText, type OutcomeId, type OutcomeWindow } from "../src/outcomes.js";

const T0 = Date.parse("2026-03-10T00:00:00.000Z");
const H = 3600; // an hour, in seconds (the unit of `at`)
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const WIN: OutcomeWindow = { from: new Date(T0), to: new Date(T0 + 10 * H * 1000), previousFrom: new Date(T0 - 10 * H * 1000) };
const EV = { stream: true, read: true, manifest: true, incomplete: false };

let n = 0;
const ev = (runId: string, type: string, sec: number, rest: object = {}): EvidenceEvent => ({ version: 3, id: `ev-${++n}`, seq: n, runId, time: at(sec), type, ...rest }) as unknown as EvidenceEvent;
const step = { id: "a", visit: 1, type: "claude" };
const push = (id: string, outcome = "allow", mode = "enforce") => ev(id, "policy.decided", 1, { decision: { policy: { id: "p", version: "1" }, boundary: "push", mode, outcome, reasonCode: "x.y" }, step });
const tested = (id: string, outcome: string) => ev(id, "step.completed", 2, { step, durationMs: 1, artifacts: [], test: { suite: "unit", outcome } });

interface Spec { id: string; issue?: string; owner?: string; status?: string; start?: number; end?: number; cost?: number; events?: EvidenceEvent[]; ev?: Partial<OutcomeFacts["evidence"]> | null; extra?: Partial<RunSummary>; flow?: string }
const mk = (s: Spec): { run: RunSummary; facts?: OutcomeFacts } => {
  const status = s.status ?? "succeeded";
  const open = status === "running" || status === "waiting";
  const run = {
    runId: s.id, flow: s.flow ?? "build", vars: s.issue ? { github_repo: "o/r", issue: s.issue } : {}, status, startedAt: at(s.start ?? 0), ...(open ? {} : { finishedAt: at(s.end ?? 100) }),
    totalCostUsd: s.cost ?? 0, owner: s.owner, runDir: `/x/${s.id}`, history: [], ...s.extra,
  } as unknown as RunSummary;
  return { run, ...(s.ev === null ? {} : { facts: outcomeFactsOf(run, s.events ?? [], { ...EV, ...s.ev }) }) };
};
const compute = (specs: Spec[], w = WIN) => {
  const made = specs.map(mk);
  return computeOutcomes(made.map((m) => m.run), new Map(made.flatMap((m) => (m.facts ? [[m.run.runId, m.facts] as const] : []))), w);
};
const get = (o: ReturnType<typeof compute>, id: OutcomeId) => o.measures.find((m) => m.id === id)!;
const good = (id: string, extra: Partial<Spec> = {}): Spec => ({ id, events: [ev(id, "run.queued", 0), tested(id, "passed"), push(id)], ...extra });

beforeEach(() => {
  n = 0;
});

describe("catalogue", () => {
  it("has the ten ids in order, once", () => {
    expect(OUTCOME_DEFINITIONS.map((d) => d.id)).toEqual([...OUTCOME_IDS]);
    expect(new Set(OUTCOME_IDS).size).toBe(10);
  });

  it("describes every measure completely", () => {
    for (const d of OUTCOME_DEFINITIONS) {
      expect(d.label, d.id).toBeTruthy();
      expect(["ms", "share", "count", "usd"], d.id).toContain(d.unit);
      expect(["speed", "quality", "rework", "policy", "cost", "user"], d.id).toContain(d.category);
      expect(["admin", "repository owner"], d.id).toContain(d.owner);
      expect(d.decision.text, d.id).toBeTruthy();
      const x = d.decision as { detector?: string; setting?: string };
      expect(Boolean(x.detector) !== Boolean(x.setting), d.id).toBe(true);
      expect(d.definition.trim(), d.id).not.toBe("");
      expect(d.exclusions.trim(), d.id).not.toBe("");
      for (const p of d.pairedWith) {
        expect(OUTCOME_IDS, d.id).toContain(p);
        expect(p).not.toBe(d.id);
      }
    }
  });

  it("names only detectors that exist", () => {
    const known = detectorInfo().map((d) => d.name);
    for (const d of OUTCOME_DEFINITIONS) if ("detector" in d.decision) expect(known, d.id).toContain(d.decision.detector);
  });

  it("pairs every speed and cost measure with quality, rework, policy and user", () => {
    const cat = (id: OutcomeId) => OUTCOME_DEFINITIONS.find((d) => d.id === id)!.category;
    for (const d of OUTCOME_DEFINITIONS.filter((x) => x.category === "speed" || x.category === "cost")) {
      const cats = d.pairedWith.map(cat);
      for (const c of ["quality", "rework", "policy", "user"]) expect(cats, d.id).toContain(c);
    }
  });

  it("marks only returning users as admin only", () => {
    expect(OUTCOME_DEFINITIONS.filter((d) => d.adminOnly).map((d) => d.id)).toEqual(["returning_users"]);
  });
});

describe("computeOutcomes", () => {
  it("measures two issues, one delivered and one not", () => {
    const o = compute([
      good("a", { issue: "1", owner: "u1", start: 0, end: 1000, cost: 1 }),
      { id: "b", issue: "2", owner: "u2", status: "failed", start: 0, end: 2000, cost: 0.5, events: [ev("b", "run.queued", 0), tested("b", "failed"), push("b")], ev: { manifest: false } },
      { id: "old", owner: "u1", start: -3 * H, end: -2 * H, events: [], ev: null },
    ]);
    expect(o.open).toBe(0);
    const at_ = (id: OutcomeId) => {
      const m = get(o, id);
      return [m.value, m.counted, m.excluded];
    };
    expect(at_("issue_to_pr_time")).toEqual([1_000_000, 1, 0]);
    expect(get(o, "issue_to_pr_time").detail.longestMs).toBe(1_000_000);
    expect(at_("first_pass_test_success")).toEqual([0.5, 2, 0]);
    expect(at_("merge_rate")).toEqual([0.5, 2, 0]);
    expect(at_("rework")).toEqual([0, 1, 0]);
    expect(at_("policy_blocks")).toEqual([0, 2, 0]);
    expect(at_("evidence_completeness")).toEqual([0.5, 2, 0]);
    expect(at_("resume_count")).toEqual([0, 2, 0]);
    expect(at_("approval_latency")).toEqual([null, 0, 0]);
    expect(at_("cost_per_successful_run")).toEqual([1.5, 2, 0]);
    expect(get(o, "cost_per_successful_run").detail).toEqual({ costUsd: 1.5, succeeded: 1 });
    expect(at_("returning_users")).toEqual([1, 2, 0]);
    expect(get(o, "returning_users").detail.previous).toBe(1);
    expect(o.from).toBe(WIN.from.toISOString());
  });

  it("counts every run as excluded when there is no evidence, but still measures cost, resumes and users", () => {
    const o = compute([{ id: "a", issue: "1", owner: "u1", cost: 2, ev: null, extra: { resumes: 2 } }, { id: "b", issue: "2", ev: null, status: "failed" }]);
    for (const id of ["issue_to_pr_time", "first_pass_test_success", "merge_rate", "evidence_completeness", "approval_latency"] as const) {
      expect([get(o, id).value, get(o, id).counted, get(o, id).excluded], id).toEqual([null, 0, 2]);
    }
    expect(get(o, "policy_blocks")).toMatchObject({ value: 0, counted: 0, excluded: 2 });
    expect(get(o, "rework")).toMatchObject({ value: 0, counted: 0, excluded: 2 });
    expect(get(o, "cost_per_successful_run").value).toBe(2);
    expect(get(o, "resume_count").value).toBe(2);
    expect(get(o, "returning_users")).toMatchObject({ counted: 1, excluded: 1 });
  });

  it("scores a run cut short below complete, and leaves out a file that was not read", () => {
    const o = compute([
      good("a", { ev: { manifest: false, incomplete: true } }),
      good("b", { ev: { read: false } }),
      good("c"),
    ]);
    expect(get(o, "evidence_completeness")).toMatchObject({ value: 0.6667, counted: 3, excluded: 0 });
    expect(get(o, "first_pass_test_success")).toMatchObject({ counted: 2, excluded: 1 });
    expect(get(o, "policy_blocks")).toMatchObject({ counted: 2, excluded: 1 });
  });

  it("counts policy blocks and the denials of observed packs", () => {
    const denied = (id: string) => ev(id, "step.denied", 3, { step, denial: { kind: "policy", policy: { id: "p", version: "1" }, reasonCode: "x.y" } });
    const o = compute([good("a", { events: [denied("a"), push("a", "deny", "observe")] }), good("b")]);
    expect(get(o, "policy_blocks")).toMatchObject({ value: 1, counted: 2 });
    expect(get(o, "policy_blocks").detail.wouldBlock).toBe(1);
  });

  it("leaves a flow that never pushes out of merge rate and first test", () => {
    const o = compute([good("a", { issue: "1" }), { id: "p", issue: "2", flow: "plan", events: [ev("p", "run.queued", 0)] }]);
    expect(get(o, "merge_rate")).toMatchObject({ value: 1, counted: 1, excluded: 1 });
    expect(get(o, "first_pass_test_success")).toMatchObject({ value: 1, counted: 1, excluded: 1 });
  });

  it("counts an issue delivered twice once, and starts at the earlier queueing of a failed first run", () => {
    const o = compute([
      { id: "a", issue: "1", status: "failed", start: 500, end: 600, events: [ev("a", "run.queued", 100)] },
      good("b", { issue: "1", start: 700, end: 1100, events: [ev("b", "run.queued", 650), push("b")] }),
      good("c", { issue: "1", start: 1200, end: 1500, events: [ev("c", "run.queued", 1200), push("c")] }),
    ]);
    expect(get(o, "merge_rate")).toMatchObject({ value: 1, counted: 1 });
    expect(get(o, "rework")).toMatchObject({ value: 1, counted: 1 });
    expect(get(o, "issue_to_pr_time")).toMatchObject({ value: 1_000_000, counted: 1 });
  });

  it("does not count a follow-up run without evidence as rework, and counts an evidenced one in a flow that never pushes", () => {
    const first = good("a", { issue: "1", end: 1000 });
    const noEv: Spec = { id: "b", issue: "1", start: 1100, end: 1200, ev: null };
    const o1 = compute([first, noEv]);
    expect(get(o1, "rework")).toMatchObject({ value: 0, counted: 1, excluded: 1 });
    const plan: Spec = { id: "c", issue: "1", flow: "plan", start: 1100, end: 1200, events: [ev("c", "run.queued", 1100)] };
    const o2 = compute([first, plan]);
    expect(get(o2, "rework")).toMatchObject({ value: 1, counted: 1, excluded: 0 });
    expect(get(o2, "merge_rate").excluded).toBe(1);
  });

  it("ignores a delivery before the window, and rework after it", () => {
    const before = compute([good("a", { issue: "1", start: -2 * H, end: -H }), good("b", { issue: "1", start: 0, end: 100 })]);
    expect(get(before, "issue_to_pr_time")).toMatchObject({ value: null, counted: 0 });
    expect(get(before, "rework")).toMatchObject({ value: 0, counted: 0 });
    const after = compute([good("a", { issue: "1", end: 1000 }), good("b", { issue: "1", start: 11 * H, end: 12 * H })]);
    expect(get(after, "rework")).toMatchObject({ value: 0, counted: 1 });
  });

  it("gives no cost per run when nothing succeeded, and every value is finite", () => {
    const o = compute([{ id: "a", status: "failed", cost: 3, events: [] }]);
    const c = get(o, "cost_per_successful_run");
    expect(c.value).toBeNull();
    expect(outcomeText(OUTCOME_DEFINITIONS.find((d) => d.id === c.id)!, c.value)).toBe("—");
    for (const m of o.measures) if (m.value !== null) expect(Number.isFinite(m.value)).toBe(true);
  });

  it("leaves refinement runs out everywhere and out of open", () => {
    const refinement = (s: Spec): Spec => ({ ...s, extra: { source: "refinement x" } });
    const o = compute([good("a", { issue: "1" }), refinement(good("r1", { issue: "2" })), refinement({ id: "r2", status: "running" })]);
    expect(o.open).toBe(0);
    for (const m of o.measures) expect(m.excluded, m.id).toBeGreaterThanOrEqual(1);
    expect(get(o, "merge_rate")).toMatchObject({ counted: 1, excluded: 1 });
    expect(get(o, "cost_per_successful_run").counted).toBe(1);
  });

  it("counts open runs in open only", () => {
    const o = compute([{ id: "a", status: "running", start: 100 }, { id: "b", status: "waiting", start: 200 }, { id: "c", status: "running", start: -H }, good("d")]);
    expect(o.open).toBe(2);
    expect(get(o, "cost_per_successful_run").counted).toBe(1);
  });

  it("counts a finished run without a usable finish time in open, not in the measures", () => {
    const o = compute([
      { id: "a", status: "failed", start: 100, events: [], extra: { finishedAt: undefined } },
      { id: "b", start: 200, events: [], extra: { finishedAt: "not a date" } },
      good("c"),
    ]);
    expect(o.open).toBe(2);
    expect(get(o, "cost_per_successful_run").counted).toBe(1);
  });

  it("counts returning users without naming them", () => {
    const o = compute([
      { id: "a", owner: "secret-1", events: [] },
      { id: "b", owner: "secret-2", events: [] },
      { id: "c", events: [] },
      { id: "p1", owner: "secret-1", start: -2 * H, end: -H, events: [] },
      { id: "p2", owner: "secret-3", start: -2 * H, end: -H, events: [] },
    ]);
    expect(get(o, "returning_users")).toMatchObject({ value: 1, counted: 2, excluded: 1, detail: { previous: 2 } });
    expect(JSON.stringify(o)).not.toContain("secret");
  });

  it("takes the mean of the two middle values for an even count", () => {
    const o = compute([good("a", { issue: "1", end: 100 }), good("b", { issue: "2", end: 300 }), good("c", { issue: "3", end: 400 }), good("d", { issue: "4", end: 1000 })]);
    expect(get(o, "issue_to_pr_time")).toMatchObject({ value: 350_000, counted: 4 });
    expect(get(o, "issue_to_pr_time").detail.longestMs).toBe(1_000_000);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
  });

  it("measures approval latency over decisions", () => {
    const approval = (id: string, wait: number) => [ev(id, "step.started", 10, { step: { id: "ok", visit: 1, type: "approval" } }), ev(id, "step.approved", 10 + wait, { step: { id: "ok", visit: 1, type: "approval" }, by: {} })];
    const o = compute([good("a", { events: approval("a", 60) }), good("b", { events: approval("b", 180) }), good("c")]);
    expect(get(o, "approval_latency")).toMatchObject({ value: 120_000, counted: 2, detail: { longestMs: 180_000, decisions: 2 } });
  });

  it("returns every measure as null for a bad window, and does not throw on bad input", () => {
    const bad = [{ from: new Date("x"), to: WIN.to, previousFrom: WIN.previousFrom }, { from: WIN.to, to: WIN.from, previousFrom: WIN.previousFrom }, { from: WIN.from, to: WIN.from, previousFrom: WIN.previousFrom }];
    for (const w of bad) {
      const o = computeOutcomes([mk(good("a")).run], new Map(), w);
      expect(o.measures).toHaveLength(10);
      expect(o.measures.every((m) => m.value === null && m.counted === 0)).toBe(true);
    }
    expect(computeOutcomes("x" as never, new Map(), WIN).measures).toHaveLength(10);
    expect(() => computeOutcomes([null, 3, mk(good("a")).run] as never, new Map(), WIN)).not.toThrow();
    expect(() => computeOutcomes([], null as never, WIN)).not.toThrow();
    expect(computeOutcomes([], new Map(), null as never).measures.every((m) => m.value === null)).toBe(true);
  });
});

describe("outcomeText", () => {
  const def = (id: OutcomeId) => OUTCOME_DEFINITIONS.find((d) => d.id === id)!;
  it("formats each unit", () => {
    expect(outcomeText(def("rework"), null)).toBe("—");
    expect(outcomeText(def("issue_to_pr_time"), 59 * 60_000)).toBe("59 min");
    expect(outcomeText(def("issue_to_pr_time"), 60 * 60_000)).toBe("1 h");
    expect(outcomeText(def("issue_to_pr_time"), 90 * 60_000)).toBe("1.5 h");
    expect(outcomeText(def("merge_rate"), 0.1234)).toBe("12.3%");
    expect(outcomeText(def("merge_rate"), 1)).toBe("100%");
    expect(outcomeText(def("cost_per_successful_run"), 0)).toBe("$0.00");
    expect(outcomeText(def("cost_per_successful_run"), 1.2345)).toBe("$1.23");
    expect(outcomeText(def("rework"), 7)).toBe("7");
    expect(outcomeText(def("rework"), Number.NaN)).toBe("—");
  });
});
