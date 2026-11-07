import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { registerPluginCheck, resetPluginChecks, type PluginCheck, type PluginCheckInput } from "../src/plugins/checks.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let runsDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-plugin-checks-run-"));
  runsDir = join(tmp, "runs");
  mkdirSync(runsDir);
});
afterEach(() => {
  resetPluginChecks();
  rmSync(tmp, { recursive: true, force: true });
});

const config = ConfigSchema.parse({ protected_branches: [] });
const FLOW = `
name: t
workspace: empty
steps:
  - {id: a, type: shell, run: 'echo a'}
  - {id: b, type: shell, run: 'echo b'}
`;
const add = (point: "run.before" | "step.before", fn: PluginCheck, plugin = "acme") => registerPluginCheck({ owner: "o", plugin, point, fn, report: () => undefined });
const run = (yaml = FLOW) => runFlow(parseFlow(yaml), { task: "t", repo: tmp, runsDir, claudeBin, config, vars: { github_repo: "acme/app", issue: "5" } });
const log = (s: { runDir: string }) => readFileSync(liveLogFile(s.runDir), "utf8");

describe("plugin checks in a run (#786)", () => {
  it("a stop at step.before for step b stops the run there; step a ran", async () => {
    add("step.before", (i) => (i.step === "b" ? { outcome: "stop", reason: "x" } : undefined));
    const s = await run();
    expect(s.status).toBe("stopped");
    expect(s.state.next).toBe("b");
    expect(s.history.map((h) => h.id)).toEqual(["a"]);
    expect(s.reason).toBe("stopped by plugin acme: x");
    expect(log(s)).toContain("· plugin acme · step.before b: stop — x");
  });

  it("a warn is logged and the run goes on", async () => {
    add("step.before", () => ({ outcome: "warn", reason: "hmm" }));
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(log(s)).toContain("· plugin acme · step.before a: warn — hmm");
  });

  it("a throwing check is logged and the run goes on", async () => {
    add("step.before", () => { throw new Error("boom"); });
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(log(s)).toContain("! plugin acme · step.before a: the check failed (threw) — the run goes on");
  });

  it("the check gets ids and counts only", async () => {
    const seen: PluginCheckInput[] = [];
    add("step.before", (i) => { seen.push(i); });
    await run();
    expect(seen[0]).toMatchObject({ point: "step.before", flow: "t", workspace: "default", repository: "acme/app", issue: 5, step: "a", stepType: "shell", visit: 1 });
    expect(Object.keys(seen[0]!).sort()).toEqual(["flow", "issue", "owner", "point", "repository", "runCostUsd", "runId", "step", "stepType", "visit", "workspace"]);
  });

  it("run.before: a stop runs no step, and a resume asks again", async () => {
    let stop = true;
    let asked = 0;
    add("run.before", () => { asked++; return stop ? { outcome: "stop", reason: "closed" } : undefined; });
    const s = await run();
    expect(s.status).toBe("failed"); // asked beside run.start, before the workspace is made: nothing to resume
    expect(s.reason).toBe("stopped by plugin acme: closed");
    expect(s.history).toHaveLength(0);
    expect(asked).toBe(1);
  });

  it("run.before is asked again on a resume, and a stop there keeps the step", async () => {
    let asked = 0;
    add("step.before", (i) => (i.step === "b" && asked === 0 ? { outcome: "stop", reason: "later" } : undefined));
    const s = await run();
    expect(s.state.next).toBe("b");
    add("run.before", () => { asked++; return asked === 1 ? { outcome: "stop", reason: "still no" } : undefined; });
    const r1 = await resumeRun({ runId: s.runId, runsDir, claudeBin, config });
    expect(r1.status).toBe("stopped");
    expect(r1.state.next).toBe("b");
    const r2 = await resumeRun({ runId: s.runId, runsDir, claudeBin, config });
    expect(r2.status).toBe("succeeded");
    expect(asked).toBe(2);
  });

  it("a stop inside a sub-flow ends the whole run", async () => {
    const dir = join(tmp, "flows");
    mkdirSync(dir);
    writeFileSync(join(dir, "inner.yaml"), "name: inner\nworkspace: empty\nsteps:\n  - {id: x, type: shell, run: 'echo x'}\n");
    add("step.before", (i) => (i.step === "sub/x" ? { outcome: "stop", reason: "nested" } : undefined));
    const s = await run(`
name: outer
workspace: empty
steps:
  - {id: sub, type: flow, flow: ${JSON.stringify(join(dir, "inner.yaml"))}, on_failure: after}
  - {id: after, type: shell, run: 'echo after'}
`);
    expect(s.status).toBe("stopped");
    expect(s.state.next).toBe("sub");
    expect(s.reason).toBe("stopped by plugin acme: nested");
    expect(s.history.some((h) => h.id === "after")).toBe(false);
  });

  it("a stop of a parallel child inside a sub-flow reaches the top: the parent's on_failure is not followed", async () => {
    const dir = join(tmp, "flows");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "inner.yaml"),
      "name: inner\nworkspace: empty\nsteps:\n  - {id: par, type: parallel, steps: [p, q], on_failure: tail}\n  - {id: p, type: shell, run: 'echo p', jump_only: true}\n  - {id: q, type: shell, run: 'echo q', jump_only: true}\n  - {id: tail, type: shell, run: 'echo tail'}\n",
    );
    add("step.before", (i) => (i.step === "sub/q" ? { outcome: "stop", reason: "in parallel" } : undefined));
    const s = await run(`
name: outer
workspace: empty
steps:
  - {id: sub, type: flow, flow: ${JSON.stringify(join(dir, "inner.yaml"))}, on_failure: after}
  - {id: after, type: shell, run: 'echo after'}
`);
    expect(s.status).toBe("stopped");
    expect(s.reason).toBe("stopped by plugin acme: in parallel");
    expect(s.state.next).toBe("sub");
    expect(s.history.map((h) => h.id)).not.toContain("after");
    expect(s.history.map((h) => h.id)).not.toContain("tail");
  });

  it("a stop two sub-flows deep reaches the top through both parents", async () => {
    const dir = join(tmp, "flows");
    mkdirSync(dir);
    writeFileSync(join(dir, "leaf.yaml"), "name: leaf\nworkspace: empty\nsteps:\n  - {id: x, type: shell, run: 'echo x'}\n  - {id: y, type: shell, run: 'echo y'}\n");
    writeFileSync(join(dir, "mid.yaml"), `name: mid\nworkspace: empty\nsteps:\n  - {id: leaf, type: flow, flow: ${JSON.stringify(join(dir, "leaf.yaml"))}, on_failure: mid_after}\n  - {id: mid_after, type: shell, run: 'echo mid_after'}\n`);
    add("step.before", (i) => (i.step === "sub/leaf/y" ? { outcome: "stop", reason: "deep" } : undefined));
    const s = await run(`
name: outer
workspace: empty
steps:
  - {id: sub, type: flow, flow: ${JSON.stringify(join(dir, "mid.yaml"))}, on_failure: after}
  - {id: after, type: shell, run: 'echo after'}
`);
    expect(s.status).toBe("stopped");
    expect(s.reason).toBe("stopped by plugin acme: deep");
    expect(s.state.next).toBe("sub");
    expect(s.history.map((h) => h.id)).not.toContain("after");
    expect(s.history.map((h) => h.id)).not.toContain("mid_after");
  });

  it("a plugin can stop a single child of a parallel step", async () => {
    add("step.before", (i) => (i.step === "q" ? { outcome: "stop", reason: "child" } : undefined));
    const s = await run(`
name: t
workspace: empty
steps:
  - {id: par, type: parallel, steps: [p, q], on_failure: after}
  - {id: p, type: shell, run: 'echo p', jump_only: true}
  - {id: q, type: shell, run: 'echo q', jump_only: true}
  - {id: after, type: shell, run: 'echo after'}
`);
    expect(s.status).toBe("stopped");
    expect(s.reason).toBe("stopped by plugin acme: child");
    expect(s.history.some((h) => h.id === "after")).toBe(false);
    expect(s.history.some((h) => h.id === "q")).toBe(false);
  });
});
