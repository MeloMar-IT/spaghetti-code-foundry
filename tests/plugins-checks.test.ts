import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { askPluginChecks, hasPluginChecks, registerPluginCheck, resetPluginChecks, type PluginCheck, type PluginCheckInput } from "../src/plugins/checks.js";
import { loadPlugins, type PluginApi } from "../src/plugins/load.js";

const temp = mkdtempSync(join(tmpdir(), "factory-plugin-checks-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
afterEach(() => resetPluginChecks());

const input = (over: Partial<PluginCheckInput> = {}): PluginCheckInput => ({ point: "step.before", runId: "r1", flow: "f", workspace: "default", owner: "admin", step: "a", stepType: "agent", visit: 1, runCostUsd: 0, ...over });

let n = 0;
/** Loads fake plugins: each `register` gets the api. */
async function load(...registers: ((api: PluginApi) => unknown)[]) {
  const dir = join(temp, `t${++n}`);
  mkdirSync(dir);
  const files = registers.map((_, i) => {
    const f = join(dir, `p${i}.mjs`);
    writeFileSync(f, "export function register() {}\n");
    return f;
  });
  return loadPlugins(files.map((module) => ({ module, options: {} })), {
    blockedDirs: [],
    importModule: async (url) => {
      const i = files.findIndex((f) => url.endsWith(f));
      return { register: registers[i] };
    },
  });
}
const reg = (fn: PluginCheck, point: "run.before" | "step.before" = "step.before") => (api: PluginApi) => api.check(point, fn);
const ask = async (o: { timeoutMs?: number; seen?: Set<string> } = {}) => {
  const lines: string[] = [];
  const r = await askPluginChecks("step.before", input(), (l) => lines.push(l), o.seen, { timeoutMs: o.timeoutMs });
  return { lines, ...r };
};

describe("api.check", () => {
  it("lists the registration and is asked", async () => {
    const r = await load(reg(() => undefined));
    expect(r.plugins[0]!.registered).toEqual([{ point: "check", name: "step.before" }]);
    expect(hasPluginChecks("step.before")).toBe(true);
    expect(hasPluginChecks("run.before")).toBe(false);
  });

  it("refuses a call after register, a bad point, a non-function and an 11th check", async () => {
    let api!: PluginApi;
    await load((a) => {
      api = a;
    });
    expect(() => api.check("step.before", () => undefined)).toThrow(/while register/);
    await expect(load((a) => a.check("run.after" as never, () => undefined))).rejects.toThrow(/point must be one of/);
    await expect(load((a) => a.check("step.before", "x" as never))).rejects.toThrow(/must be a function/);
    await expect(
      load((a) => {
        for (let i = 0; i < 11; i++) a.check("step.before", () => undefined);
      }),
    ).rejects.toThrow(/at most 10/);
    expect(hasPluginChecks("step.before")).toBe(false); // a failed start leaves nothing behind
  });

  it("dispose() removes the checks, and so does a later plugin that fails", async () => {
    const r = await load(reg(() => undefined));
    r.dispose?.();
    expect(hasPluginChecks("step.before")).toBe(false);
    await expect(load(reg(() => undefined), () => { throw new Error("boom"); })).rejects.toThrow();
    expect(hasPluginChecks("step.before")).toBe(false);
  });

  it("a plugin problem is listed once for two failing calls", async () => {
    const r = await load(reg(() => { throw new Error("x"); }));
    await ask();
    await ask();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.reason).toMatch(/step\.before check threw/);
  });
});

describe("askPluginChecks", () => {
  const add = (fn: PluginCheck, plugin = "p", point: "run.before" | "step.before" = "step.before") => registerPluginCheck({ owner: "o", plugin, point, fn, report: () => undefined });

  it("allow is logged once per seen set; warn logs and does not stop; stop logs and stops", async () => {
    const seen = new Set<string>();
    add(() => "allow", "a");
    add(() => ({ outcome: "warn", reason: "careful" }), "w");
    add(() => ({ outcome: "stop", reason: "no" }), "s");
    const first = await ask({ seen });
    expect(first.stop).toEqual({ plugin: "s", reason: "no" });
    expect(first.lines).toEqual(["· plugin a · step.before a: allow", "· plugin w · step.before a: warn — careful", "· plugin s · step.before a: stop — no"]);
    const second = await ask({ seen });
    expect(second.lines).toHaveLength(2); // no second allow line
  });

  it("the first stop wins and both lines are logged in order", async () => {
    add(async () => ({ outcome: "stop", reason: "one" }), "p1");
    add(() => ({ outcome: "stop", reason: "two" }), "p2");
    const r = await ask();
    expect(r.stop).toEqual({ plugin: "p1", reason: "one" });
    expect(r.lines.map((l) => l.split(" — ")[1])).toEqual(["one", "two"]);
  });

  it("a throw, a rejection and an invalid answer are logged and do not stop (fail open)", async () => {
    add(() => { throw new Error("x"); }, "t");
    add(() => Promise.reject(new Error("y")), "r");
    add((() => ({ outcome: "maybe" })) as unknown as PluginCheck, "i");
    add((() => 5) as unknown as PluginCheck, "j");
    const r = await ask();
    expect(r.stop).toBeUndefined();
    expect(r.lines).toEqual([
      "! plugin t · step.before a: the check failed (threw) — the run goes on",
      "! plugin r · step.before a: the check failed (threw) — the run goes on",
      "! plugin i · step.before a: the check failed (gave an answer that is not valid) — the run goes on",
      "! plugin j · step.before a: the check failed (gave an answer that is not valid) — the run goes on",
    ]);
  });

  it("a check that is too slow is logged and does not stop", async () => {
    add(() => new Promise(() => undefined), "slow");
    const r = await ask({ timeoutMs: 20 });
    expect(r.stop).toBeUndefined();
    expect(r.lines[0]).toBe("! plugin slow · step.before a: the check failed (took longer than 20 ms) — the run goes on");
  });

  it("a synchronous check that runs past the deadline fails open, even when it returns stop", async () => {
    add(() => {
      const until = performance.now() + 40; // a busy check: it blocks this thread, so only the answer can be refused
      while (performance.now() < until) { /* spin */ }
      return { outcome: "stop", reason: "too late" };
    }, "sync");
    const r = await ask({ timeoutMs: 10 });
    expect(r.stop).toBeUndefined();
    expect(r.lines).toEqual(["! plugin sync · step.before a: the check failed (took longer than 10 ms) — the run goes on"]);
  });

  it("after 3 calls that still run, the check is skipped", async () => {
    let calls = 0;
    add(() => { calls++; return new Promise(() => undefined); }, "stuck");
    for (let i = 0; i < 3; i++) await ask({ timeoutMs: 5 });
    const r = await ask({ timeoutMs: 5 });
    expect(calls).toBe(3);
    expect(r.lines[0]).toContain("is skipped: earlier calls still run");
  });

  it("the input is frozen and a change by the plugin does not reach the next check", async () => {
    const got: unknown[] = [];
    add((i) => { got.push(Object.isFrozen(i)); try { (i as { runId: string }).runId = "changed"; } catch { /* strict mode */ } });
    add((i) => { got.push(i.runId); });
    await ask();
    expect(got).toEqual([true, "r1"]);
  });

  it("the reason is one line of at most 200 characters without control characters", async () => {
    add(() => ({ outcome: "stop", reason: `first\u0007 line${"x".repeat(300)}\nsecond line` }), "p");
    const r = await ask();
    expect(r.stop!.reason).not.toContain("\n");
    expect(r.stop!.reason).not.toContain("\u0007");
    expect(r.stop!.reason.length).toBe(200);
    add(() => ({ outcome: "stop" }), "q");
    expect((await ask()).lines.some((l) => l.endsWith("stop — no reason given"))).toBe(true);
  });

  it("asks only the checks of the point", async () => {
    add(() => ({ outcome: "stop", reason: "run only" }), "p", "run.before");
    expect((await ask()).stop).toBeUndefined();
  });
});
