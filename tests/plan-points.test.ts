import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { makeRedactor } from "../src/credentials/redact.js";
import { recordStep, type Engine, type StepResult } from "../src/engine/execute.js";
import { parsePlanPoints, planPointsAfter, PLAN_POINT_LIMITS, type PlanPoint } from "../src/engine/plan-points.js";
import { parseFlow } from "../src/flow/load.js";

const id = (t: string) => t;
const P = (text: string) => parsePlanPoints(text, id);

describe("parsePlanPoints", () => {
  it("keeps the order of ASKED and ASSUMED lines", () => {
    expect(P("ASKED: a\nASSUMED: b\nASKED: c")).toEqual([
      { kind: "asked", text: "a" },
      { kind: "assumed", text: "b" },
      { kind: "asked", text: "c" },
    ]);
  });

  it("accepts bullets and bold, and \\r\\n line endings", () => {
    expect(P("- ASKED: x\r\n* ASSUMED: y\r\n+ ASKED: w\r\n**ASKED:** z")).toEqual([
      { kind: "asked", text: "x" },
      { kind: "assumed", text: "y" },
      { kind: "asked", text: "w" },
      { kind: "asked", text: "z" },
    ]);
  });

  it("ignores lowercase markers, markers inside a line and fenced blocks", () => {
    const out = "asked: no\nsee ASKED: no\n    ASKED: indented code\n```\nASKED: in fence\n```\n~~~\nASSUMED: in tilde fence\n~~~\nASSUMED: yes";
    expect(P(out)).toEqual([{ kind: "assumed", text: "yes" }]);
  });

  it("skips empty text, collapses whitespace and removes control characters", () => {
    expect(P("ASKED:\nASKED:   \nASKED:  a \t b\u0001c  ")).toEqual([{ kind: "asked", text: "a bc" }]);
  });

  it("cuts the text to 500 characters", () => {
    expect(P(`ASKED: ${"x".repeat(900)}`)[0]!.text).toHaveLength(PLAN_POINT_LIMITS.text);
  });

  it("keeps at most 100 points and drops exact duplicates", () => {
    const many = Array.from({ length: 150 }, (_, i) => `ASKED: p${i}`).join("\n");
    expect(P(many)).toHaveLength(100);
    expect(P("ASKED: a\nASKED: a\nASSUMED: a")).toHaveLength(2);
  });

  it("redacts a registered secret before the text is cut", () => {
    const secret = "S3CRET-" + "k".repeat(30);
    const r = makeRedactor([secret]);
    // the secret starts just before the 500-character cut: cutting first would leave a fragment
    const out = parsePlanPoints(`ASKED: ${"x".repeat(495)}${secret}`, (t) => r.redact(t));
    expect(out[0]!.text).not.toContain("S3CRET");
    expect(out[0]!.text).toContain("[reda"); // the marker itself is cut, but no part of the secret is left
  });

  it("gives [] for a plan without lines", () => {
    expect(P("## Goal\nnothing here\nPLAN_STATUS: READY")).toEqual([]);
  });
});

describe("planPointsAfter", () => {
  const LINES = "ASKED: a\nASSUMED: b\n";
  const prev: PlanPoint[] = [{ kind: "asked", text: "old" }];
  const o = (over: Partial<{ stepId: string; type: string; topLevel: boolean; ok: boolean; output: string }>) => ({
    stepId: "plan",
    type: "claude",
    topLevel: true,
    ok: true,
    output: `${LINES}PLAN_STATUS: READY`,
    ...over,
  });
  const after = (prevPoints: PlanPoint[] | undefined, over: Parameters<typeof o>[0]) => planPointsAfter(prevPoints, o(over), id);

  it("takes the points of a READY plan, or nothing when it has no lines", () => {
    expect(after(undefined, {})).toEqual([{ kind: "asked", text: "a" }, { kind: "assumed", text: "b" }]);
    expect(after(prev, { output: "## Goal\nPLAN_STATUS: READY" })).toBeUndefined();
  });

  it("clears the points of a plan that is not READY or failed", () => {
    expect(after(prev, { output: `${LINES}PLAN_STATUS: NEEDS_INFO` })).toBeUndefined();
    expect(after(prev, { output: `${LINES}PLAN_STATUS: TOO_BIG` })).toBeUndefined();
    expect(after(prev, { ok: false })).toBeUndefined();
  });

  it("replaces the points with a READY revision, also when the step failed (like PICK_PLAN)", () => {
    const out = "ASKED: new\nPLAN_STATUS: READY";
    expect(after(prev, { stepId: "revise_plan", output: out })).toEqual([{ kind: "asked", text: "new" }]);
    expect(after(prev, { stepId: "revise_plan", ok: false, output: out })).toEqual([{ kind: "asked", text: "new" }]);
  });

  it("keeps the draft's points when the revision failed or was cut off", () => {
    expect(after(prev, { stepId: "revise_plan", ok: false, output: "ASKED: x\nPLAN_STATUS: NEEDS_INFO" })).toBe(prev);
    expect(after(prev, { stepId: "revise_plan", output: "ASKED: x" })).toBe(prev);
  });

  it("clears the points when the revision ends with another status", () => {
    expect(after(prev, { stepId: "revise_plan", output: "ASKED: x\nPLAN_STATUS: NEEDS_INFO" })).toBeUndefined();
  });

  it("leaves shell steps, nested steps and other steps alone", () => {
    expect(after(prev, { type: "shell" })).toBe(prev);
    expect(after(prev, { topLevel: false })).toBe(prev);
    expect(after(prev, { stepId: "plan_review" })).toBe(prev);
  });

  it("never throws", () => {
    const bad = () => {
      throw new Error("boom");
    };
    expect(planPointsAfter(prev, o({}), bad)).toBe(prev);
  });
});

describe("recordStep", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-points-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const record = (stepId: string, output: string, summaryExtra: Record<string, unknown> = {}) => {
    const flow = parseFlow(`name: t\nsteps:\n  - { id: ${stepId}, type: claude, prompt: p }\n`, "t.yaml");
    let saved = 0;
    const summary = { runDir: dir, history: [], totalCostUsd: 0, outputs: {}, flow: "t", runId: "r", ...summaryExtra } as never as { planPoints?: PlanPoint[] };
    const engine = { summary, config: ConfigSchema.parse({}), log() {}, save: () => void saved++ } as unknown as Engine;
    const scope = { flow, ctx: { vars: {}, steps: {}, run: {} }, visits: {}, prefix: "", depth: 0 } as never;
    const res: StepResult = { ok: true, output };
    recordStep(flow.steps[0]!, scope, engine, res, new Date(), join(dir, "l.log"), 1);
    return { summary, saved };
  };

  it("stores the points of a READY plan and saves", () => {
    const { summary, saved } = record("plan", "ASKED: a\nASSUMED: b\nPLAN_STATUS: READY");
    expect(summary.planPoints).toEqual([{ kind: "asked", text: "a" }, { kind: "assumed", text: "b" }]);
    expect(saved).toBe(1);
  });

  it("leaves an old run without the field when the plan has no lines", () => {
    const { summary } = record("plan", "## Goal\nPLAN_STATUS: READY");
    expect("planPoints" in summary).toBe(false);
  });

  it("does not touch other steps", () => {
    const keep = [{ kind: "asked", text: "old" }];
    expect(record("build", "ASKED: z", { planPoints: keep }).summary.planPoints).toBe(keep);
  });
});

describe("built flows", () => {
  for (const name of ["issue-plan", "issue-gitflow"]) {
    const flow = parseFlow(readFileSync(join(__dirname, "..", "flows", `${name}.yaml`), "utf8"), `${name}.yaml`);
    const step = (sid: string) => flow.steps.find((s) => s.id === sid) as { prompt?: string } | undefined;

    it(`${name}: the planner asks for ASKED and ASSUMED lines, and the revision keeps them`, () => {
      const plan = step("plan")!.prompt!;
      for (const s of ["## Asked and assumed", "ASKED:", "ASSUMED:", "a default value", "a file location", "who may see something"]) expect(plan).toContain(s);
      expect(step("revise_plan")!.prompt).toContain("ASKED: and ASSUMED: lines");
    });

    it(`${name}: no shell step strips the lines`, () => {
      for (const s of flow.steps) if (s.type === "shell") expect(s.run).not.toMatch(/\/\^ASK|\/\^ASSUM/);
    });
  }
});
