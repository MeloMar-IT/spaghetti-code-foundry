import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_GATE_MAX_OUTPUT, stepMaxOutput } from "../src/engine/guards.js";
import type { StepRecord } from "../src/engine/state.js";
import { parseSkillRequestLine, planSkillRequest, SkillRequestError, SKILL_REQUEST_LIMITS } from "../src/skills/request.js";
import { flowPath } from "./helpers/fake-github.js";
import { parseFlow } from "../src/flow/load.js";
import { readFileSync } from "node:fs";

const FAILED_LAST = "planning failed: the skill request of the plan is not valid";
const tool = (input: string) => spawnSync(process.execPath, [resolve("tools/skill-request")], { input, encoding: "utf8" });
const L = (o: unknown) => `SKILL_REQUEST: ${JSON.stringify(o)}`;
const item = (over: Record<string, unknown> = {}) => ({ id: "typescript", reason: "The change is in src/*.ts.", evidence: ["path:src/skills/request.ts"], ...over });
const req = (skills: unknown[] = [item()], over: Record<string, unknown> = {}) => ({ version: 1, skills, ...over });
const plan = (line: string) => `## Goal\nDo it.\n${line}\nPLAN_STATUS: READY\n`;
const lastLine = (out: string) => out.trimEnd().split("\n").at(-1)!;

describe("tools/skill-request", () => {
  it("prints the section and a canonical last line for a valid request", () => {
    const r = tool(plan(L(req([item({ id: "zeta", reason: "  later  ", evidence: [" issue:asks for it "] }), item({ evidence: ["path:src/skills/request.ts", "catalogue:typescript: high confidence"] })]))));
    expect(r.status).toBe(0);
    const canonical = lastLine(r.stdout);
    expect(canonical).toBe(L({ version: 1, skills: [
      { id: "typescript", reason: "The change is in src/*.ts.", evidence: ["path:src/skills/request.ts", "catalogue:typescript: high confidence"] },
      { id: "zeta", reason: "later", evidence: ["issue:asks for it"] },
    ] }));
    expect(r.stdout).toContain("## Required skills\n\n- `typescript` — The change is in src/*.ts. Evidence: `path:src/skills/request.ts`, `catalogue:typescript: high confidence`\n- `zeta` — later Evidence: `issue:asks for it`\n");
    expect(parseSkillRequestLine(canonical)).toEqual(JSON.parse(canonical.slice("SKILL_REQUEST: ".length)));
  });

  it("says None. for an empty request and names a missing line", () => {
    const empty = tool(plan(L(req([]))));
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe(`## Required skills\n\nNone.\n${L(req([]))}\n`);
    for (const text of ["no line at all\n", "A SKILL_REQUEST line is written by the planner.\n", "see SKILL_REQUEST: here\n"]) {
      const none = tool(text);
      expect(none.status, text).toBe(0);
      expect(none.stdout).toBe(`## Required skills\n\nNone — the plan did not name any.\n${L(req([]))}\n`);
    }
  });

  it("accepts an extra space after the marker, like the TypeScript reader", () => {
    const line = `SKILL_REQUEST:  ${JSON.stringify(req())}`;
    expect(tool(plan(line)).status).toBe(0);
    expect(parseSkillRequestLine(line).skills).toHaveLength(1);
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => item({ id: `skill-${i}` }));
  const bad = (n: number) => `skill 1: bad ${n === 0 ? "id" : n === 1 ? "reason" : "evidence"}`;
  // [name, request line, problem]. Every one is rejected by the tool and by the TypeScript reader.
  const LINES: Array<[string, string, string]> = [
    ["bad JSON", "SKILL_REQUEST: {nope", "not valid JSON"],
    ["an array", "SKILL_REQUEST: []", "not valid JSON"],
    ["a string", 'SKILL_REQUEST: "x"', "not valid JSON"],
    ["version 2", L(req([], { version: 2 })), "unknown version"],
    ['version "1"', L(req([], { version: "1" })), "unknown version"],
    ["no version", L({ skills: [] }), 'missing key "version"'],
    ["an extra top-level key", L(req([], { extra: 1 })), 'unknown key "extra"'],
    ["an extra entry key", L(req([item({ more: 1 })])), 'unknown key "more"'],
    ["no evidence key", L(req([{ id: "a", reason: "r" }])), 'missing key "evidence"'],
    ["21 skills", L(req(many(21))), "too many skills"],
    ["20 skills with a duplicate", L(req([...many(19), item({ id: "skill-0" })])), 'duplicate skill "skill-0"'],
    ["a bad id", L(req([item({ id: "Bad_ID" })])), bad(0)],
    ["an empty reason", L(req([item({ reason: "  " })])), bad(1)],
    ["a reason of 301 characters", L(req([item({ reason: "x".repeat(301) })])), bad(1)],
    ["a newline in the reason", L(req([item({ reason: "a\nb" })])), bad(1)],
    ["markup in the reason", L(req([item({ reason: "a <!-- b" })])), bad(1)],
    ["an empty evidence list", L(req([item({ evidence: [] })])), bad(2)],
    ["6 evidence entries", L(req([item({ evidence: Array(6).fill("issue:x") })])), bad(2)],
    ["evidence without a prefix", L(req([item({ evidence: ["src/a.ts"] })])), bad(2)],
    ["evidence that is not a string", L(req([item({ evidence: [1] })])), bad(2)],
    ["an empty path", L(req([item({ evidence: ["path:"] })])), bad(2)],
    ["an empty issue text", L(req([item({ evidence: ["issue: "] })])), bad(2)],
    ["an absolute path", L(req([item({ evidence: ["path:/abs"] })])), bad(2)],
    ["a drive path", L(req([item({ evidence: ["path:C:/x"] })])), bad(2)],
    ["an empty path segment", L(req([item({ evidence: ["path:a//b"] })])), bad(2)],
    ["a dot segment", L(req([item({ evidence: ["path:a/./b"] })])), bad(2)],
    ["a dot-dot segment", L(req([item({ evidence: ["path:a/../b"] })])), bad(2)],
    ["a backslash", L(req([item({ evidence: ["path:a\\b"] })])), bad(2)],
    ["evidence of 201 characters", L(req([item({ evidence: [`path:${"a".repeat(196)}`] })])), bad(2)],
    ["a backtick in evidence", L(req([item({ evidence: ["issue:a`b"] })])), bad(2)],
    ["a line over 8000 bytes", `SKILL_REQUEST: {"version":1,${" ".repeat(SKILL_REQUEST_LIMITS.lineBytes)}"skills":[]}`, "too long"],
    ["no space after the marker", `SKILL_REQUEST:${JSON.stringify(req())}`, "the SKILL_REQUEST line is not on its own line"],
  ];

  it.each(LINES)("rejects %s", (_name, line, problem) => {
    const r = tool(plan(line));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`skill request: ${problem}\n${FAILED_LAST}\n`);
    expect(() => parseSkillRequestLine(line)).toThrow(SkillRequestError);
  });

  it("accepts evidence of exactly 200 characters, in both readers", () => {
    const line = L(req([item({ evidence: [`path:${"a".repeat(195)}`] })]));
    expect(tool(plan(line)).status).toBe(0);
    expect(parseSkillRequestLine(line).skills).toHaveLength(1);
  });

  it.each([
    ["two request lines", `${L(req())}\n${L(req([]))}`, "more than one SKILL_REQUEST line"],
    ["an indented marker", `  ${L(req())}`, "the SKILL_REQUEST line is not on its own line"],
    ["a quoted marker", `> ${L(req())}`, "the SKILL_REQUEST line is not on its own line"],
    ["a bold marker", `**SKILL_REQUEST:** ${JSON.stringify(req())}`, "the SKILL_REQUEST line is not on its own line"],
  ])("rejects %s", (_name, text, problem) => {
    const r = tool(plan(text));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`skill request: ${problem}\n${FAILED_LAST}\n`);
  });

  it("lets a prose mention or an indented example stand next to one proper line", () => {
    const r = tool(plan(`The planner writes a SKILL_REQUEST line.\n  ${L(req([]))}\n${L(req())}`));
    expect(r.status).toBe(0);
    expect(lastLine(r.stdout)).toBe(L(req()));
  });

  it("rejects a plan that quotes the issue's request line and has its own", () => {
    const r = tool(plan(`The issue says:\n${L(req([item({ id: "evil" })]))}\nMy own:\n${L(req())}`));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("more than one SKILL_REQUEST line");
    expect(r.stdout).not.toContain("evil");
  });

  it("never echoes input text other than a plain key name or a checked id", () => {
    const keys: Array<[string, string]> = [["extra-key_1", 'unknown key "extra-key_1"'], ["$(touch x)<b>`", "unknown key"], ["a".repeat(41), "unknown key"], ["", "unknown key"]];
    for (const [key, problem] of keys) {
      const r = tool(plan(L(req([], { [key]: 1 }))));
      expect(r.stdout, key).toBe(`skill request: ${problem}\n${FAILED_LAST}\n`);
    }
  });
});

describe("planSkillRequest", () => {
  const flowDef = { steps: [
    { id: "risk_gate", type: "shell", run: 'x | node "$FACTORY_TOOLS/skill-request"' },
    { id: "post_plan", type: "shell", run: 'x | node "$FACTORY_TOOLS/skill-request"' },
    { id: "legacy_gate", type: "shell", run: "echo" },
  ] };
  const rec = (id: string, over: Partial<StepRecord> = {}): StepRecord => ({ id, type: "shell", visit: 1, ok: true, output: "", startedAt: "", durationMs: 0, logFile: "", ...over });
  const gate = (line: string, id = "risk_gate", over: Partial<StepRecord> = {}) => rec(id, { output: `the plan\n\nRISK: 20\nGATE: no\n${line}\n`, ...over });
  const run = (history: StepRecord[], def: unknown = flowDef) => planSkillRequest({ history, flowDef: def } as never);

  it("reads the line of the last ok risk_gate and of post_plan", () => {
    expect(run([rec("plan"), gate(L(req()))])).toEqual(req());
    expect(run([rec("plan"), gate(L(req()), "post_plan")])).toEqual(req());
  });

  it("still finds the line when other lines follow it", () => {
    expect(run([gate(`${L(req())}\nwarning: something on stderr\n`)])).toEqual(req());
  });

  it("is undefined without a gate, with a failed gate, or when planning went on", () => {
    expect(run([])).toBeUndefined();
    expect(run([rec("plan")])).toBeUndefined();
    expect(run([gate(L(req()), "risk_gate", { ok: false })])).toBeUndefined();
    for (const id of ["plan", "pull_ticket", "send_back", "split_gate", "force_split", "create_split"]) {
      expect(run([gate(L(req())), rec(id)]), id).toBeUndefined();
    }
  });

  it("is undefined for a gate without the line, and for a gate of a flow that did not check it", () => {
    expect(run([rec("risk_gate", { output: "the plan\nRISK: 20\nGATE: no\n" })])).toBeUndefined();
    expect(run([gate(L(req()))], { steps: [{ id: "risk_gate", type: "shell", run: "echo" }] })).toBeUndefined();
    expect(run([gate(L(req()))], { steps: [] })).toBeUndefined();
  });

  it("can be called with the history alone", () => {
    expect(planSkillRequest({ history: [gate(L(req()))] })).toEqual(req());
  });

  it("throws for a broken line and for two lines", () => {
    expect(() => run([gate(L(req([], { version: 2 })))])).toThrow(SkillRequestError);
    expect(() => run([gate(`${L(req())}\n${L(req())}`)])).toThrow(SkillRequestError);
  });

  it("lets the second READY round win, and ignores records of sub-flows", () => {
    const first = gate(L(req([item({ id: "a-skill" })])));
    const second = gate(L(req([item({ id: "b-skill" })])));
    expect(run([first, rec("plan", { visit: 2 }), second])?.skills.map((s) => s.id)).toEqual(["b-skill"]);
    expect(run([first, rec("plan", { parent: "sub" })])?.skills.map((s) => s.id)).toEqual(["a-skill"]);
  });
});

describe("the generated flows", () => {
  const flowOf = (name: string) => parseFlow(readFileSync(flowPath(name), "utf8"), flowPath(name));
  const shell = (name: string, id: string) => {
    const s = flowOf(name).steps.find((x) => x.id === id);
    if (!s || s.type !== "shell") throw new Error(`${name}/${id}`);
    return s.run;
  };

  it("check the request in both gates, also after the hotfix swap", () => {
    expect(shell("issue-plan", "post_plan")).toContain('node "$FACTORY_TOOLS/skill-request"');
    expect(shell("issue-deliver", "risk_gate")).toContain('node "$FACTORY_TOOLS/skill-request"');
    const hotfix = shell("issue-gitflow", "risk_gate");
    expect(hotfix).toContain('node "$FACTORY_TOOLS/skill-request"');
    expect(hotfix).toContain("{{run.dir}}/hotfix");
  });

  it("strip the marker wherever a plan or a split is reused", () => {
    for (const [flow, ids] of [["issue-plan", ["send_back"]], ["issue-deliver", ["send_back", "split_gate", "create_split"]], ["issue-gitflow", ["send_back", "split_gate", "create_split"]]] as const) {
      for (const id of ids) expect(shell(flow, id), `${flow}/${id}`).toContain("/^SKILL_REQUEST:/d");
    }
  });

  it("ask for the line in the plan prompt without the literal that the fake and the template engine key on", () => {
    for (const name of ["issue-plan", "issue-deliver", "issue-gitflow"]) {
      const steps = flowOf(name).steps;
      const planStep = steps.find((s) => s.id === "plan");
      if (planStep?.type !== "claude") throw new Error(name);
      expect(planStep.prompt).toContain('SKILL_REQUEST: {"version":1');
      expect(planStep.prompt).not.toContain("PLAN_STATUS: NEEDS_INFO");
      const lines = planStep.prompt.slice(planStep.prompt.indexOf("For READY, also write exactly one line"), planStep.prompt.indexOf("End with exactly one line"));
      expect(lines).toContain("Do not write this line for NEEDS_INFO");
      expect(lines).not.toContain("}}"); // the template engine
    }
  });

  it("give only the plan gate of the code flows more room for its output", () => {
    expect(stepMaxOutput({ id: "risk_gate" }, 0, "issue-gitflow")).toBe(PLAN_GATE_MAX_OUTPUT);
    expect(stepMaxOutput({ id: "risk_gate" }, 0, "issue-deliver")).toBe(PLAN_GATE_MAX_OUTPUT);
    expect(stepMaxOutput({ id: "risk_gate" }, 1, "issue-gitflow")).toBeUndefined();
    expect(stepMaxOutput({ id: "post_plan" }, 0, "issue-plan")).toBeUndefined();
  });
});
