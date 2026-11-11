import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { parsePlanChecks, recordPlanChecks } from "../src/engine/plan-checks.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";

const C = (t: string, e: string) => `- CHECK: Try: ${t} — Expect: ${e}`;

describe("parsePlanChecks", () => {
  it("reads the lines in order", () => {
    const r = parsePlanChecks(`## Try it\n${C("a", "b")}\n${C("c", "d")}\n`);
    expect(r.checks).toEqual([{ id: "plan-1", try: "a", expect: "b", source: "plan" }, { id: "plan-2", try: "c", expect: "d", source: "plan" }]);
    expect(r.problems).toEqual([]);
  });
  it("accepts other forms", () => {
    const text = ["CHECK: Try: a – Expect: b", "- CHECK: Try: c - Expect: d", "- CHECK: Try: e -- Expect: f", "- check: try: g Expect: h"].join("\r\n");
    expect(parsePlanChecks(text).checks.map((c) => [c.try, c.expect])).toEqual([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]);
  });
  it("ignores indented, mid-text and fenced lines", () => {
    const text = [` ${C("a", "b")}`, `see ${C("c", "d")}`, "```", C("e", "f"), "```", "~~~", C("g", "h"), "~~~"].join("\n");
    expect(parsePlanChecks(text).checks).toEqual([]);
  });
  it("drops incomplete lines with a problem", () => {
    const r = parsePlanChecks("- CHECK: Try: a\n- CHECK: Try:  — Expect: b\n");
    expect(r.checks).toEqual([]);
    expect(r.problems).toEqual(["a CHECK line has no Try or no Expect part", "a CHECK line has no Try or no Expect part"]);
  });
  it("keeps 4 and cuts long parts; control characters become spaces", () => {
    const r = parsePlanChecks([1, 2, 3, 4, 5].map((n) => C("x".repeat(n === 1 ? 400 : 2), `a\u0007b${n}`)).join("\n"));
    expect(r.checks).toHaveLength(4);
    expect(r.checks[0]!.try).toBe("x".repeat(299) + "…");
    expect(r.checks[1]!.expect).toBe("a b2");
    expect(r.problems).toEqual(["more than 4 CHECK lines; the first 4 are kept"]);
  });
  it("reads NO_CHECKS", () => {
    expect(parsePlanChecks("NO_CHECKS: refactor only")).toEqual({ checks: [], none: "refactor only", problems: [] });
    expect(parsePlanChecks("- NO_CHECKS: x").none).toBe("x");
    expect(parsePlanChecks("NO_CHECKS:  ")).toEqual({ checks: [], problems: ["the NO_CHECKS line gives no reason"] });
    const both = parsePlanChecks(`${C("a", "b")}\nNO_CHECKS: why`);
    expect(both.checks).toHaveLength(1);
    expect(both.none).toBeUndefined();
    expect(both.problems).toHaveLength(1);
    expect(parsePlanChecks("nothing")).toEqual({ checks: [], problems: [] });
  });
  it("stops at the review notes of the gate", () => {
    const text = `${C("a", "b")}\n## Review notes to work in\n- check: Try: x — Expect: y\n- NO_CHECKS: z\n`;
    expect(parsePlanChecks(text)).toEqual({ checks: [{ id: "plan-1", try: "a", expect: "b", source: "plan" }], problems: [] });
  });
});

const rec = (id: string, output: string, over: Partial<StepRecord> = {}): StepRecord => ({ id, type: "shell", visit: 1, ok: true, output, startedAt: "", durationMs: 0, logFile: "", ...over });
const flow = (f: string) => parseFlow(readFileSync(`flows/${f}.yaml`, "utf8"));
const runOf = (f: string, history: StepRecord[], extra: Partial<RunSummary> = {}) => ({ history, flowDef: flow(f), ...extra }) as unknown as RunSummary;

describe("recordPlanChecks", () => {
  const log = () => { const l: string[] = []; return { l, f: (m: string) => l.push(m) }; };
  it("stores the checks of risk_gate and of post_plan", () => {
    for (const [f, id] of [["issue-gitflow", "risk_gate"], ["issue-plan", "post_plan"]] as const) {
      const run = runOf(f, [rec("plan", ""), rec(id, `## Try it\n${C("a", "b")}\n`)]);
      const g = log();
      recordPlanChecks(run, id, g.f);
      expect(run.checks).toEqual([{ id: "plan-1", try: "a", expect: "b", source: "plan" }]);
      expect(g.l).toEqual(["    · checks a person can try: 1 from the plan"]);
    }
  });
  it("post_plan prints only the CHECK lines of the plan (fence-aware, not its text) and not Codex's notes", () => {
    const steps = flow("issue-plan").steps!;
    const gate = steps.find((s) => s.id === "post_plan")!;
    const run = gate.type === "shell" ? gate.run : "";
    expect(run).toContain("awk");
    expect(run).toContain("(- )?(check|no_checks)");
    expect(run.indexOf("awk")).toBeGreaterThan(run.indexOf("posted=$("));
    expect(run.indexOf("awk")).toBeLessThan(run.lastIndexOf('printf \'%s\\n\' "$posted"'));
  });
  it("stores NO_CHECKS and clears on neither", () => {
    const run = runOf("issue-gitflow", [rec("risk_gate", "NO_CHECKS: refactor")]);
    const g = log();
    recordPlanChecks(run, "risk_gate", g.f);
    expect(run.checks).toEqual([]);
    expect(run.checksNone).toBe("refactor");
    expect(g.l).toEqual(["    · checks a person can try: none — refactor"]);
    run.history = [rec("risk_gate", "no lines")];
    recordPlanChecks(run, "risk_gate", g.f);
    expect(run.checks).toBeUndefined();
    expect(run.checksNone).toBeUndefined();
    expect(g.l.at(-1)).toBe("⚠ the plan lists no checks a person can try and does not say why");
  });
  it("a second gate replaces the first", () => {
    const run = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: [{ id: "plan-9", try: "old", expect: "old", source: "plan" }] });
    run.history.push(rec("plan", ""), rec("risk_gate", C("c", "d")));
    recordPlanChecks(run, "risk_gate", () => {});
    expect(run.checks).toEqual([{ id: "plan-1", try: "c", expect: "d", source: "plan" }]);
  });
  it("changes nothing for other steps, a gate that is not final, or a flow without the check", () => {
    const old = [{ id: "plan-1", try: "o", expect: "o", source: "plan" as const }];
    const a = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: old });
    recordPlanChecks(a, "plan", () => {});
    const b = runOf("issue-gitflow", [rec("risk_gate", C("a", "b")), rec("plan", "")], { checks: old });
    recordPlanChecks(b, "risk_gate", () => {});
    const c = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: old });
    c.flowDef = { steps: [{ id: "risk_gate", type: "shell", run: "echo" }] } as never;
    recordPlanChecks(c, "risk_gate", () => {});
    for (const r of [a, b, c]) expect(r.checks).toBe(old);
  });
  it("does not throw for odd output", () => {
    for (const out of ["", "\u0000\u0001�".repeat(1000), undefined as unknown as string]) {
      expect(() => recordPlanChecks(runOf("issue-gitflow", [rec("risk_gate", out)]), "risk_gate", () => {})).not.toThrow();
    }
  });
});

describe("the built flows ask for checks", () => {
  for (const f of ["issue-plan", "issue-gitflow"]) {
    it(f, () => {
      const steps = flow(f).steps!;
      const prompt = (id: string) => { const s = steps.find((x) => x.id === id)!; return s.type === "claude" ? s.prompt : ""; };
      for (const id of ["plan", "revise_plan"]) {
        for (const t of ["- CHECK: Try: <what to do> — Expect: <what they should see>", "NO_CHECKS: <one line why>", "2 to 4", "## Try it"]) expect(prompt(id), `${id}: ${t}`).toContain(t);
      }
      expect(prompt("plan_review")).toContain("CHECK lines");
    });
  }
});
