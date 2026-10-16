import { describe, expect, it } from "vitest";
import { CHECK_FIRST, PLAN_MAX, checkPlan, type Impact, type PlanInput } from "../src/help/plan.js";

const STATE = { id: "S1", kind: "state" };
const DIAG = { id: "diagnosis-run-0123456789", kind: "state" };
const DOC = { id: "D1", kind: "doc" };
const PAGES = [{ to: "#/runs", title: "Runs" }];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  cited: [STATE, DIAG, DOC],
  uncertain: [],
  certainty: "confirmed",
  action: () => undefined,
  page: (to) => PAGES.find((p) => p.to === to),
  clean: (v, max) => (typeof v === "string" ? v.replace(/hunter2/g, "[removed]").replace(/[\u0000-\u0008]/g, "").trim().slice(0, max) : ""),
  ...over,
});
const signals = { expected: "It shows.", failure: "It does not.", fallback: "Stop." };
const step = (over: Record<string, unknown> = {}) => ({ kind: "reversible", title: "Make a copy", evidence: ["S1"], ...signals, ...over });
const high = (over: Record<string, unknown> = {}) => step({ kind: "high-impact", title: "Start it again", evidence: [DIAG.id], ...over });
const run = (raw: unknown[], over: Partial<PlanInput> = {}) => checkPlan(raw, input(over));
const kinds = (raw: unknown[], over: Partial<PlanInput> = {}) => run(raw, over).plan.map((s) => s.kind);

describe("checkPlan: what a step is", () => {
  it("keeps a valid plan of all six kinds, in order", () => {
    const raw = [
      { kind: "explanation", title: "What happened" },
      { kind: "navigation", title: "Open the runs", to: "#/runs" },
      { kind: "check", title: "Look at the log" },
      { kind: "input", title: "Decide which branch" },
      step(),
    ];
    const r = run(raw);
    expect(r.plan.map((s) => s.kind)).toEqual(["explanation", "navigation", "check", "input", "reversible"]);
    expect(r.dropped).toEqual([]);
  });

  it("drops an unknown kind and an empty title", () => {
    const r = run([{ kind: "run-it", title: "x" }, { kind: "check", title: "  " }, "text", null, { kind: "check", title: "ok" }]);
    expect(r.plan).toHaveLength(1);
    expect(r.dropped).toEqual(["plan step: unknown kind", "plan step: empty", "plan step: unknown kind", "plan step: unknown kind"]);
  });

  it.each(["expected", "failure", "fallback"])("drops a change without %s", (field) => {
    for (const make of [step, high]) {
      const r = run([make({ [field]: "" })]);
      expect(r.plan).toEqual([]);
      expect(r.dropped).toContain("plan step: a change needs what to expect, how it fails and a fallback");
    }
  });

  it("removes an evidence id the reply did not keep", () => {
    const r = run([step({ evidence: ["S1", "X9", 4, "S1"] })]);
    expect(r.plan[0]!.evidence).toEqual(["S1"]);
    expect(r.dropped).toContain("plan step: evidence not kept by the reply");
  });

  it("cleans every text through the cleaner", () => {
    const r = run([{ kind: "check", title: "the key is hunter2\u0001", instructions: "use hunter2" }]);
    expect(r.plan[0]).toMatchObject({ title: "the key is [removed]", instructions: "use [removed]" });
  });
});

describe("checkPlan: pages and actions", () => {
  it("a navigation step to a foreign page loses its link and becomes an explanation", () => {
    for (const to of ["https://evil.example", "javascript:alert(1)", "#/settings", "#/runs/abc"]) {
      const r = run([{ kind: "navigation", title: "Go", to }]);
      expect(r.plan[0]).toMatchObject({ kind: "explanation" });
      expect(r.plan[0]!.to).toBeUndefined();
    }
    expect(run([{ kind: "navigation", title: "Go", to: "#/runs" }]).plan[0]).toMatchObject({ kind: "navigation", to: "#/runs" });
  });

  it("an action that is not on the list is removed and the step stays manual", () => {
    const r = run([step({ action: "delete-run" })]);
    expect(r.plan[0]!.action).toBeUndefined();
    expect(r.plan[0]!.kind).toBe("reversible");
    expect(r.dropped).toContain("plan step: action not on the server's list");
  });

  it("the level of an action can raise a step, never lower it", () => {
    const action = (id: string) => ({ id, impact: (id === "big" ? "high" : id === "small" ? "reversible" : "read-only") as Impact });
    expect(run([{ kind: "check", title: "Look", action: "big", evidence: [DIAG.id], ...signals }], { action }).plan[0]).toMatchObject({ kind: "high-impact", action: "big" });
    expect(run([high({ action: "small" })], { action }).plan[0]).toMatchObject({ kind: "high-impact", action: "small" });
    expect(run([step({ action: "small" })], { action }).plan[0]).toMatchObject({ kind: "reversible" });
  });
});

describe("checkPlan: destructive words raise a step", () => {
  it("an explanation that says delete is raised, and demoted without a diagnosis", () => {
    const r = run([{ kind: "explanation", title: "Delete the run", evidence: [], ...signals }]);
    expect(r.plan[0]).toMatchObject({ kind: "check", wouldBe: "high-impact", proposal: "Delete the run" });
  });

  it("a destructive fallback raises a reversible step", () => {
    const r = run([step({ fallback: "Force-push the branch." })]);
    expect(r.plan[0]).toMatchObject({ kind: "check", wouldBe: "high-impact" });
    const ok = run([step({ fallback: "Force-push the branch.", evidence: [DIAG.id] })]);
    expect(ok.plan[0]).toMatchObject({ kind: "high-impact" });
  });

  it("matches whole words only, in any case", () => {
    expect(kinds([step({ title: "Keep the undeleted copy" })])).toEqual(["reversible"]);
    expect(kinds([step({ title: "DELETE the copy", evidence: [DIAG.id] })])).toEqual(["high-impact"]);
  });
});

describe("checkPlan: the gates", () => {
  const demoted = (s: Record<string, unknown>) => {
    expect(s).toMatchObject({ kind: "check", title: CHECK_FIRST.title, instructions: CHECK_FIRST.instructions });
    expect(s.action).toBeUndefined();
    expect(s.expected).toBeDefined();
    expect(s.fallback).toBeDefined();
  };

  it("a reversible step without state evidence becomes a check", () => {
    for (const evidence of [[], ["D1"]]) {
      const s = run([step({ evidence, instructions: "Do the thing.", action: "x" })]).plan[0]!;
      demoted(s as never);
      expect(s).toMatchObject({ wouldBe: "reversible", proposal: "Make a copy" });
      expect(s.instructions).toBe(CHECK_FIRST.instructions);
    }
  });

  it("a high-impact step needs a confirmed reply and a diagnosis the server did not doubt", () => {
    const cases: Partial<PlanInput>[] = [{ certainty: "likely" }, { certainty: "unverified" }, { uncertain: [DIAG.id] }];
    for (const c of cases) demoted(run([high({ instructions: "Original text." })], c).plan[0] as never);
    for (const evidence of [["S1"], ["D1"], []]) demoted(run([high({ evidence })]).plan[0] as never);
    const s = run([high({ instructions: "Original text.", action: "x" })], { certainty: "likely" }).plan[0]!;
    expect(s).toMatchObject({ wouldBe: "high-impact", proposal: "Start it again" });
    expect(JSON.stringify(s)).not.toContain("Original text.");
  });

  it("a demoted step shows none of the model's expected, failure or fallback text", () => {
    const s = run([step({ evidence: [], fallback: "Force-push the branch.", expected: "A copy.", failure: "Delete the copy." })]).plan[0]!;
    expect(s).toMatchObject({ kind: "check", expected: CHECK_FIRST.expected, failure: CHECK_FIRST.failure, fallback: CHECK_FIRST.fallback, proposal: "Make a copy" });
    expect(JSON.stringify(s)).not.toMatch(/force|delete|A copy\./i);
  });

  it("a destructive word in expected or failure raises a read-only step, which then needs a diagnosis", () => {
    const check = { kind: "check", title: "Look at the run", ...signals, failure: "If it still fails, delete the run." };
    expect(run([check]).plan[0]).toMatchObject({ kind: "check", wouldBe: "high-impact", proposal: "Look at the run" });
    expect(run([{ ...check, evidence: [DIAG.id] }]).plan[0]).toMatchObject({ kind: "high-impact" });
    expect(run([{ ...check, kind: "explanation", expected: "" }]).plan).toEqual([]);
  });

  it("a high-impact step with a confirmed diagnosis and a confirmed reply is kept", () => {
    expect(run([high()]).plan[0]).toMatchObject({ kind: "high-impact", title: "Start it again" });
    expect(run([high()]).plan[0]!.wouldBe).toBeUndefined();
  });
});

describe("checkPlan: no claimed results", () => {
  it("drops a step that says something worked or was done", () => {
    for (const title of ["Done: the run was resumed.", "The branch has been reset", "It succeeded", "Fixed", "The run is resolved"]) {
      const r = run([{ kind: "explanation", title }]);
      expect(r.plan, title).toEqual([]);
      expect(r.dropped).toEqual(["plan step: claimed a result that was not checked"]);
    }
    for (const instructions of ["I restarted the run", "It completed successfully"]) expect(run([{ kind: "check", title: "Look", instructions }]).plan, instructions).toEqual([]);
  });

  it("keeps a check, a question or a condition about a result, so the verification of a change survives", () => {
    for (const title of ["Check whether the run completed", "Is the run fixed?", "Verify the problem is resolved", "If the run has been restarted, open it"]) expect(run([{ kind: "check", title }]).plan, title).toHaveLength(1);
    expect(run([{ kind: "check", title: "Open the run page. The run has been restarted." }]).plan).toEqual([]);
  });

  it("what success looks like belongs in expected, which is not matched", () => {
    expect(run([step({ expected: "The run is done and shows as running." })]).plan).toHaveLength(1);
  });
});

describe("checkPlan: order and size", () => {
  const R = (t: string) => step({ title: t });
  const H = (t: string) => high({ title: t });
  const C = (t: string) => ({ kind: "check", title: t });
  const titles = (raw: unknown[]) => run(raw).plan.map((s) => s.title);

  it("puts reversible steps first and keeps a check right after its high-impact step", () => {
    expect(titles([H("h"), C("c"), R("r")])).toEqual(["r", "h", "c"]);
    expect(titles([H("h1"), C("c1"), R("r"), C("c2"), H("h2")])).toEqual(["r", "c2", "h1", "c1", "h2"]);
  });

  it("is stable when nothing is high impact", () => {
    expect(titles([C("a"), R("b"), C("c")])).toEqual(["a", "b", "c"]);
  });

  it("cuts a long plan to the maximum", () => {
    const r = run(Array.from({ length: PLAN_MAX + 4 }, (_, i) => C(`s${i}`)));
    expect(r.plan).toHaveLength(PLAN_MAX);
    expect(r.dropped).toContain("plan step: too many");
  });
});
