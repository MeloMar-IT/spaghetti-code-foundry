import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { liveLogFile, loadRun, saveRun, type RunSummary } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { discoverSkills, pinSkill } from "../src/skills/registry.js";
import { planHashOf } from "../src/skills/run-lock.js";
import { flowSkillSource, planRunSkills, recheckRunSkills, startRunSkills } from "../src/skills/run-plan.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let repo: string;
let runsDir: string;
let root: string;
let n = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-skillgate-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  root = join(tmp, "skills");
  mkdirSync(repo);
  mkdirSync(root);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const cfg = (unresolved: Record<string, unknown> = {}, include: string[] = []): Config =>
  ConfigSchema.parse({ protected_branches: [], skills: { builtin: false, roots: [root], unresolved, selection: { include } } });
/** A unique id per call: the pin lock lives in the shared test home. */
const uid = (base = "skill") => `${base}-${++n}-x${process.pid}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
const install = (id: string) => {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
};
const pin = (c: Config, id: string) => {
  const reg = discoverSkills(c.skills);
  pinSkill(reg, `${id}@1.0.0`, reg.byKey.get(`${id}@1.0.0`)!.digest);
};
const line = (ids: string[]) =>
  `SKILL_REQUEST: ${JSON.stringify({ version: 1, skills: ids.map((id) => ({ id, reason: "needed", evidence: ["issue:asks for it"] })) })}`;

describe("flow skill modes (run plan)", () => {
  const steps = [{ id: "risk_gate", type: "shell", run: "echo # $FACTORY_TOOLS/skill-request" }, { id: "impl", type: "claude", prompt: "x" }];
  const mk = (skills: unknown, over: Record<string, unknown> = {}): RunSummary =>
    ({ flowDef: { steps, ...(skills ? { skills } : {}) }, repo, workdir: repo, history: [{ id: "risk_gate", type: "shell", ok: true, visit: 1, output: line(["nope-skill"]) + "\n" }], ...over }) as unknown as RunSummary;
  const noop = () => {};

  it("reads the mode and falls back to planned", () => {
    expect(flowSkillSource(undefined)).toEqual({ mode: "planned" });
    expect(flowSkillSource({})).toEqual({ mode: "planned" });
    expect(flowSkillSource({ skills: { mode: "recorded" } })).toEqual({ mode: "planned" });
    expect(flowSkillSource({ skills: { mode: "explicit" } })).toEqual({ mode: "planned" });
    expect(flowSkillSource({ skills: { mode: "off" } })).toEqual({ mode: "off" });
    const a = flowSkillSource({ skills: { mode: "explicit", ids: ["a", "b"] } });
    expect(a).toMatchObject({ mode: "explicit", request: { skills: [{ id: "a", reason: "named by the flow", evidence: [] }, { id: "b" }] } });
    const same = flowSkillSource({ skills: { mode: "explicit", ids: ["a", "b"] } });
    const other = flowSkillSource({ skills: { mode: "explicit", ids: ["b", "a"] } });
    expect((same as { planHash: string }).planHash).toBe((a as { planHash: string }).planHash);
    expect((other as { planHash: string }).planHash).not.toBe((a as { planHash: string }).planHash);
  });

  it("off: no check, no registry read, even after a stored stop", () => {
    const discover = vi.fn(() => discoverSkills(cfg().skills));
    const run = mk({ mode: "off" }, { skillPlan: { action: "stop", gate: "risk_gate", checks: 1 } });
    expect(planRunSkills(run, cfg({}, ["x"]), "risk_gate", noop, { discover })).toBeUndefined();
    expect(recheckRunSkills(run, cfg(), "impl", noop, { discover })).toBeUndefined();
    expect(startRunSkills(run, cfg(), noop, { discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });

  it("explicit: checks at the start, ignores a plan gate, checks again on resume", () => {
    const id = uid("exp");
    const c = cfg();
    const run = mk({ mode: "explicit", ids: [id] });
    const reason = startRunSkills(run, c, noop);
    expect(reason).toMatch(/^skills not resolved:/);
    const planned = mk(undefined, { history: [{ id: "risk_gate", type: "shell", ok: true, visit: 1, output: line([id]) + "\n" }] });
    expect(planRunSkills(planned, c, "risk_gate", noop)).toBe(reason);
    expect(planRunSkills(run, c, "risk_gate", noop)).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ gate: "(flow)", action: "stop", checks: 1 });
    install(id);
    pin(c, id);
    expect(recheckRunSkills(run, c, "risk_gate", noop)).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ gate: "(flow)", checks: 2 });
    expect(run.skillPlan!.action).not.toBe("stop");
    expect(recheckRunSkills(run, c, "impl", noop)).toBeUndefined();
    expect(run.skillPlan!.checks).toBe(2);
  });

  it("explicit: warn policy goes on; other modes do nothing at the start", () => {
    const logs: string[] = [];
    const run = mk({ mode: "explicit", ids: ["some-style"] });
    expect(startRunSkills(run, cfg({ unknown: "warn" }), (m) => logs.push(m))).toBeUndefined();
    expect(logs[0]).toMatch(/^⚠ skill some-style \[unknown\]/);
    expect(startRunSkills(mk(undefined), cfg(), noop)).toBeUndefined();
    expect(startRunSkills(mk({ mode: "off" }), cfg(), noop)).toBeUndefined();
  });
});

describe("planRunSkills and recheckRunSkills", () => {
  const flowDef = { steps: [{ id: "risk_gate", type: "shell", run: "echo # $FACTORY_TOOLS/skill-request" }, { id: "implement", type: "shell", run: "true" }] };
  const mk = (ids: string[] | null, over: Record<string, unknown> = {}): RunSummary =>
    ({
      flowDef, repo, workdir: repo,
      history: ids ? [{ id: "risk_gate", type: "shell", ok: true, visit: 1, output: line(ids) + "\n" }] : [],
      ...over,
    }) as unknown as RunSummary;
  const registry = () => discoverSkills(cfg().skills);
  const noop = () => {};

  it("ignores a step that is not a gate and never reads the registry", () => {
    const discover = vi.fn(registry);
    expect(planRunSkills(mk(["a"]), cfg(), "implement", noop, { discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });

  it("an empty request without include does not read the registry and clears a stale plan", () => {
    const discover = vi.fn(registry);
    const run = mk([], { skillPlan: { action: "stop", checks: 1 } });
    expect(planRunSkills(run, cfg(), "risk_gate", noop, { discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
    expect("skillPlan" in run).toBe(false);
  });

  it("a gate that did not run the request tool gives no plan", () => {
    const run = mk(["a"], { flowDef: { steps: [{ id: "risk_gate", type: "shell", run: "echo" }] } });
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toBeUndefined();
    expect(run.skillPlan).toBeUndefined();
  });

  it("stops when the registry cannot be read", () => {
    const run = mk(["a"]);
    const reason = planRunSkills(run, cfg(), "risk_gate", noop, { discover: () => { throw new Error("boom"); } });
    expect(reason).toBe("skills not resolved: the skills could not be checked");
    expect(run.skillPlan).toMatchObject({ action: "stop", gate: "risk_gate", checks: 1 });
  });

  it("keeps the hash of the gate output it checked", () => {
    const run = mk(["a"]);
    planRunSkills(run, cfg(), "risk_gate", noop, { discover: () => { throw new Error("boom"); } });
    const gate = run.history.find((h) => h.id === "risk_gate")!;
    expect(run.skillPlan!.planHash).toBe(planHashOf(gate.output));
  });

  it("counts the checks and logs warnings and the stop", () => {
    const logs: string[] = [];
    const run = mk(["some-style"]);
    expect(planRunSkills(run, cfg({ unknown: "warn" }), "risk_gate", (m) => logs.push(m))).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ action: "warn", checks: 1 });
    expect(logs[0]).toMatch(/^⚠ skill some-style \[unknown\]/);
    expect(planRunSkills(run, cfg(), "risk_gate", (m) => logs.push(m))).toMatch(/^skills not resolved:/);
    expect(run.skillPlan!.checks).toBe(2);
    expect(logs.at(-1)).toMatch(/^■ skills not resolved:/);
  });

  it("recheck does nothing unless the run stopped for skills, and not when planning or the gate runs again", () => {
    const stopped = () => {
      const run = mk(["a-unknown"]);
      planRunSkills(run, cfg(), "risk_gate", noop);
      return run;
    };
    const discover = vi.fn(registry);
    expect(recheckRunSkills(mk(["a"]), cfg(), "implement", noop, { discover })).toBeUndefined();
    const warned = mk(["a-unknown"]);
    planRunSkills(warned, cfg({ unknown: "warn" }), "risk_gate", noop);
    expect(recheckRunSkills(warned, cfg(), "implement", noop, { discover })).toBeUndefined();
    expect(recheckRunSkills(stopped(), cfg(), "plan", noop, { discover })).toBeUndefined();
    expect(recheckRunSkills(stopped(), cfg(), "risk_gate", noop, { discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
    const run = stopped();
    expect(recheckRunSkills(run, cfg(), "implement", noop)).toMatch(/^skills not resolved:/);
    expect(run.skillPlan!.checks).toBe(2);
  });

  it("recheck succeeds once the skill is installed and pinned", () => {
    const id = uid("late");
    const c = cfg();
    const run = mk([id]);
    expect(planRunSkills(run, c, "risk_gate", noop)).toBeDefined();
    install(id);
    pin(c, id);
    expect(recheckRunSkills(run, c, "implement", noop)).toBeUndefined();
    expect(run.skillPlan).toMatchObject({ action: "continue", checks: 2 });
    expect(run.skillPlan!.selected[0]!.id).toBe(id);
  });

  it("recheck stays stopped when the stored request is missing or malformed", () => {
    for (const history of [[], [{ id: "risk_gate", type: "shell", ok: true, visit: 1, output: "SKILL_REQUEST: {nope\n" }]]) {
      const run = mk(["a-unknown"]);
      planRunSkills(run, cfg(), "risk_gate", noop);
      run.history = history as never;
      const reason = recheckRunSkills(run, cfg(), "implement", noop);
      expect(reason).toBe("skills not resolved: the skill request of the plan could not be read again");
      expect(run.skillPlan).toMatchObject({ action: "stop", checks: 2 });
    }
  });

  it("an initial run with a malformed request is left to the gate (no plan)", () => {
    const run = mk(["a"]);
    run.history[0]!.output = "SKILL_REQUEST: {nope\n";
    expect(planRunSkills(run, cfg(), "risk_gate", noop)).toBeUndefined();
    expect(run.skillPlan).toBeUndefined();
  });
});

describe("a run with skills in its plan", () => {
  const flow = (ids: string[], tail = "") =>
    parseFlow(
      [
        "name: t", "workspace: empty", "steps:",
        "  - id: risk_gate", "    type: shell", "    run: |",
        `      echo '${line(ids)}'`, "      # $FACTORY_TOOLS/skill-request",
        "  - id: implement", "    type: shell", "    run: echo done > marker.txt", tail,
      ].join("\n"),
    );
  const start = (ids: string[], c: Config) => runFlow(flow(ids), { task: "t", repo, runsDir, claudeBin, config: c });
  const resume = (runId: string, c: Config, from?: string) => resumeRun({ runId, runsDir, claudeBin, config: c, from });
  const marker = (r: RunSummary) => existsSync(join(r.workdir!, "marker.txt"));
  const count = (r: RunSummary, id: string) => r.history.filter((h) => h.id === id).length;

  it("stops before the next step for a skill that is not installed", async () => {
    const r = await start(["db-migrations"], cfg());
    expect(r.status).toBe("stopped");
    expect(r.reason).toMatch(/^skills not resolved:/);
    expect(r.state.next).toBe("implement");
    expect(marker(r)).toBe(false);
    expect(r.skillPlan).toMatchObject({ action: "stop", gate: "risk_gate" });
    expect(r.skillPlan!.unresolved[0]).toMatchObject({ risk: "high", code: "unknown" });
    expect(count(r, "risk_gate")).toBe(1);
    expect(loadRun(runsDir, r.runId)!.skillPlan!.action).toBe("stop");
  });

  it("warns and goes on for a low-risk skill when the policy says so", async () => {
    const r = await start(["some-style"], cfg({ unknown: "warn" }));
    expect(r.status).toBe("succeeded");
    expect(marker(r)).toBe(true);
    expect(r.skillPlan!.warnings).toHaveLength(1);
    expect(readFileSync(liveLogFile(r.runDir), "utf8")).toContain("⚠ skill some-style [unknown]");
  });

  it("high risk beats warn", async () => {
    const all = { unknown: "warn", missing: "warn", untrusted: "warn", conflict: "warn", oversized: "warn" };
    const r = await start(["security"], cfg(all));
    expect(r.status).toBe("stopped");
    expect(marker(r)).toBe(false);
  });

  it("stays stopped until the skill is approved, then goes on without running the gate again", async () => {
    const id = uid("a");
    install(id);
    const c = cfg();
    const r = await start([id], c);
    expect(r.status).toBe("stopped");
    expect(r.skillPlan!.unresolved[0]).toMatchObject({ code: "unpinned", risk: "low" });
    const again = await resume(r.runId, c);
    expect(again.status).toBe("stopped");
    expect(again.skillPlan!.checks).toBe(2);
    expect(count(again, "risk_gate")).toBe(1);
    pin(c, id);
    const done = await resume(r.runId, c);
    expect(done.status).toBe("succeeded");
    expect(done.skillPlan).toMatchObject({ action: "continue", checks: 3 });
    expect(done.skillPlan!.selected[0]!.id).toBe(id);
    expect(count(done, "risk_gate")).toBe(1);
    expect(marker(done)).toBe(true);
  });

  it("an unknown low-risk id stops by default; installing and pinning it lets the resume succeed", async () => {
    const id = uid("late");
    const c = cfg();
    const r = await start([id], c);
    expect(r.status).toBe("stopped");
    install(id);
    pin(c, id);
    expect((await resume(r.runId, c)).status).toBe("succeeded");
  });

  it("resuming from the gate runs the plan gate again", async () => {
    const r = await start(["db-migrations"], cfg());
    const again = await resume(r.runId, cfg(), "risk_gate");
    expect(count(again, "risk_gate")).toBe(2);
    expect(again.status).toBe("stopped");
  });

  it("a run without a request is unchanged, and an old run file resumes as before", async () => {
    const r = await start([], cfg());
    expect(r.status).toBe("succeeded");
    expect("skillPlan" in r).toBe(false);
    const old = loadRun(runsDir, r.runId)!;
    delete old.skillPlan;
    saveRun(old);
    expect((await resume(r.runId, cfg(), "implement")).status).toBe("succeeded");
  });

  it("stops at a gate that is the last step, and a retry after installing the skill succeeds", async () => {
    const id = uid("sec-notes");
    const f = parseFlow(["name: t", "workspace: empty", "steps:", "  - id: post_plan", "    type: shell", "    run: |", `      echo '${line([id])}'`, "      # $FACTORY_TOOLS/skill-request"].join("\n"));
    const c = cfg();
    const r = await runFlow(f, { task: "t", repo, runsDir, claudeBin, config: c });
    expect(r.status).toBe("stopped");
    expect(r.state.next).toBe("post_plan");
    expect(r.skillPlan!.action).toBe("stop");
    install(id);
    pin(c, id);
    const done = await resume(r.runId, c);
    expect(done.status).toBe("succeeded");
    expect(done.skillPlan).toMatchObject({ action: "continue" });
    expect(count(done, "post_plan")).toBe(2);
  });
});
