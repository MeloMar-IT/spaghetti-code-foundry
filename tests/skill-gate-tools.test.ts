import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import type { RunSummary } from "../src/engine/state.js";
import { discoverSkills, pinSkill } from "../src/skills/registry.js";
import { planRunSkills, recheckRunSkills, startRunSkills } from "../src/skills/run-plan.js";

let tmp: string;
let repo: string;
let root: string;
let n = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-skilltools-"));
  repo = join(tmp, "repo");
  root = join(tmp, "skills");
  mkdirSync(repo);
  mkdirSync(root);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const cfg = (unresolved: Record<string, unknown> = {}, include: string[] = [], tools: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ protected_branches: [], skills: { builtin: false, releases: { allow_unreleased: true }, roots: [root], unresolved, selection: { include }, tools } });
/** A unique id per call: the pin lock lives in the shared test home. */
const uid = (base: string) => `${base}-${++n}-x${process.pid}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
const install = (id: string, tail = "") => {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n${tail}`);
};
const pin = (c: Config, id: string) => {
  const reg = discoverSkills(c.skills);
  pinSkill(reg, `${id}@1.0.0`, reg.byKey.get(`${id}@1.0.0`)!.digest);
};
const line = (ids: string[]) =>
  `SKILL_REQUEST: ${JSON.stringify({ version: 1, skills: ids.map((id) => ({ id, reason: "needed", evidence: ["issue:asks for it"] })) })}`;

const NET = "tool_profile: {network: true}\n";
const SHELL = "risk: medium\ntool_profile: {shell: true}\n";
const CONN = "risk: medium\nconnectors: [ibm-mq]\n";
const ALLOW = { shell: true, network: true, filesystem: "write" };
const gate = { id: "risk_gate", type: "shell", run: "echo # $FACTORY_TOOLS/skill-request" };
const claude = (over: Record<string, unknown> = {}) => ({ id: "impl", type: "claude", prompt: "x", ...over });
const noop = () => {};

const mk = (ids: string[], steps: unknown[] = [], over: Record<string, unknown> = {}): RunSummary =>
  ({
    flowDef: { steps: [gate, ...steps, { id: "implement", type: "shell", run: "true" }] }, repo, workdir: repo,
    history: [{ id: "risk_gate", type: "shell", ok: true, visit: 1, output: line(ids) + "\n" }],
    ...over,
  }) as unknown as RunSummary;
const withCarry = (ids: string[]): RunSummary =>
  ({
    flowDef: { steps: [{ id: "plan_check", type: "shell", run: "x" }, { id: "implement", type: "shell", run: "true" }] }, repo, workdir: repo, history: [],
    skillCarry: { request: { version: 1, skills: ids.map((id) => ({ id, reason: "needed", evidence: [] })) }, planHash: "p", lockHash: "p", commentId: "1", changes: [], at: "" },
  }) as unknown as RunSummary;
const ready = (base: string, tail = "") => {
  const id = uid(base);
  install(id, tail);
  pin(cfg(), id);
  return id;
};
const plan = (r: RunSummary) => r.skillPlan as unknown as Record<string, any>;

describe("skill tools at the plan gate", () => {
  it("1: network under the default policy stops", () => {
    const id = ready("tnet", NET);
    const run = mk([id]);
    const logs: string[] = [];
    const reason = planRunSkills(run, cfg(), "risk_gate", (m) => logs.push(m));
    expect(reason).toMatch(new RegExp(`^skills not resolved: 1 skill\\(s\\) cannot be used — ${id} \\[tool-not-approved\\]: `));
    expect(run.skillPlan).toMatchObject({ action: "stop" });
    expect(plan(run).tools.missing).toHaveLength(1);
    expect(logs[logs.length - 1]).toMatch(/^■ skills not resolved:/);
  });

  it("2: degrade goes on with a warning and does not filter", () => {
    const id = ready("tnet", NET);
    const run = mk([id]);
    const logs: string[] = [];
    expect(planRunSkills(run, cfg({}, [], { missing: "degrade" }), "risk_gate", (m) => logs.push(m))).toBeUndefined();
    expect(run.skillPlan!.action).toBe("warn");
    expect(plan(run).tools.action).toBe("degrade");
    expect(plan(run).tools.leftOut).toHaveLength(1);
    expect(logs.some((l) => new RegExp(`^⚠ skill ${id} \\[tool-not-approved\\]`).test(l))).toBe(true);
    expect(run.skillPlan!.selected.map((s) => s.id)).toContain(id);
  });

  it("3: a connector stops, and no policy grants it", () => {
    const id = ready("tconn", CONN);
    const run = mk([id]);
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toContain("[connector-unavailable]");
    expect(plan(run).tools.missing[0].need).toBe("connector:ibm-mq");
    const c = cfg({}, [id], { ...ALLOW, missing: "degrade" });
    expect(planRunSkills(mk([id]), c, "risk_gate", noop)).toContain("[connector-unavailable]");
  });

  it("4: a shell needs a flow that gives one", () => {
    const id = ready("tsh", SHELL);
    const run = mk([id], [claude({ permission_mode: "plan" })]);
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toContain("[tool-not-in-flow]");
    expect(recheckRunSkills(run, cfg({}, [], ALLOW), "implement", noop)).toContain("[tool-not-in-flow]");
    expect(run.skillPlan!.checks).toBe(2);
    const open = mk([id], [claude({ permission_mode: "plan" }), { id: "sub", type: "flow", flow: "x" }]);
    expect(planRunSkills(open, cfg(), "risk_gate", noop)).toBeUndefined();
    expect(plan(open).tools).toMatchObject({ action: "continue", missing: [] });
  });

  it("5: a shell the flow gives is met, and a passed run is not checked again", () => {
    const id = ready("tsh", SHELL);
    const key = `${id}@1.0.0`;
    const run = mk([id], [claude({ allowed_tools: ["Bash(npm *)"] })]);
    const logs: string[] = [];
    expect(planRunSkills(run, cfg(), "risk_gate", (m) => logs.push(m))).toBeUndefined();
    expect(plan(run).tools.met[0]).toMatchObject({ key, need: "shell" });
    expect(plan(run).tools.met[0].sources).toContain("flow:step:impl");
    expect(logs).toContain(`· skill tools: ${key} shell — skill:${key}, policy:skills.tools.shell, flow:step:impl`);
    expect(recheckRunSkills(run, cfg({}, [], { shell: false }), "implement", noop)).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ action: "continue", checks: 1 });
  });

  it("6: a dependency that needs network stops the run", () => {
    const dep = ready("tdep", NET);
    const parent = ready("tpar", `dependencies:\n  - id: ${dep}\n`);
    const run = mk([parent]);
    const reason = planRunSkills(run, cfg(), "risk_gate", noop);
    expect(reason).toContain(dep);
    expect(plan(run).tools.missing[0].key).toBe(`${dep}@1.0.0`);
  });

  it("7: a mandatory skill still stops under degrade", () => {
    const id = ready("tnet", NET);
    const degrade = { missing: "degrade" };
    expect(planRunSkills(mk([]), cfg({}, [id], degrade), "risk_gate", noop)).toContain("[tool-not-approved]");
    const dep = ready("tdep", NET);
    const parent = ready("tpar", `dependencies:\n  - id: ${dep}\n`);
    const reason = planRunSkills(mk([]), cfg({}, [parent], degrade), "risk_gate", noop);
    expect(reason).toContain(dep);
  });

  it("8: a stop is checked again on resume", () => {
    const id = ready("tnet", NET);
    const run = mk([id]);
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toBeDefined();
    expect(recheckRunSkills(run, cfg({}, [], { missing: "degrade" }), "implement", noop)).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ action: "warn", checks: 2 });
  });

  it("9: the default profile needs nothing", () => {
    const id = ready("tplain");
    const run = mk([id]);
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toBeUndefined();
    expect(run.skillPlan!.action).toBe("continue");
    expect(plan(run).tools).toEqual({ action: "continue", met: [], missing: [], leftOut: [], warnings: [] });
  });

  it("10: no tools when the resolver stops", () => {
    const run = mk([uid("tnone")]);
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toBeDefined();
    expect(run.skillPlan!.action).toBe("stop");
    expect("tools" in run.skillPlan!).toBe(false);
  });

  it("11: an error in the tool check fails closed", () => {
    const id = ready("tsh", SHELL);
    const c = cfg();
    const broken = { ...c, skills: { ...c.skills, tools: undefined } } as unknown as Config;
    const run = mk([id], [claude({ allowed_tools: ["Bash"] })]);
    expect(planRunSkills(run, broken, "risk_gate", noop)).toBe("skills not resolved: the skills could not be checked");
    expect(run.skillPlan!.action).toBe("stop");
    expect("tools" in run.skillPlan!).toBe(false);
  });

  it("12: an explicit flow is checked at the start", () => {
    const id = ready("tnet", NET);
    const run = mk([], [], { flowDef: { steps: [claude()], skills: { mode: "explicit", ids: [id] } } });
    expect(startRunSkills(run, cfg(), noop)).toContain("[tool-not-approved]");
    expect(run.skillPlan!.gate).toBe("(flow)");
  });

  it("13: plan_check stops and resumes", () => {
    const id = ready("tnet", NET);
    const run = withCarry([id]);
    expect(planRunSkills(run, cfg(), "plan_check", noop)).toContain("[tool-not-approved]");
    expect(run.skillPlan).toMatchObject({ action: "stop", gate: "plan_check" });
    expect(plan(run).tools.missing).toHaveLength(1);
    expect(recheckRunSkills(run, cfg({}, [], { missing: "degrade" }), "implement", noop)).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ action: "warn", gate: "plan_check", checks: 2 });
  });
});
