import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_API_VERSION } from "../src/index.js";
import { ConfigSchema, parseConfigText } from "../src/config.js";
import {
  emptyRegistry, insideFolder, loadPlugins, PluginLoadError, pluginLabel, pluginModuleProblem, pluginProblems, pluginsView, readFilePlugins,
  type PluginEntry,
} from "../src/plugins/load.js";

const fx = (name: string) => resolve("tests/fixtures/plugins", name);
const entry = (module: string, options: Record<string, unknown> = {}): PluginEntry => ({ module, options });
const seen = () => ((globalThis as { __scfPlugins?: { name: string; api: any }[] }).__scfPlugins ??= []);
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};

let tmp: string;
const temp = mkdtempSync(join(tmpdir(), "factory-plugins-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const fresh = () => (tmp = join(temp, `t${++n}`)) && (mkdirSync(tmp, { recursive: true }), tmp);
beforeEach(() => void (seen().length = 0));

describe("pluginModuleProblem", () => {
  it("accepts a package name and an absolute path", () => {
    for (const ok of ["acme", "@acme/scf-plugin", "/abs/p.mjs"]) expect(pluginModuleProblem(ok)).toBeUndefined();
  });
  it("refuses relative paths, URLs, built-ins, unnormalised paths and control characters", () => {
    for (const bad of ["./p.mjs", "../p.mjs", "p/index.mjs", "plugins/x.mjs", "file:///p.mjs", "https://x/p.mjs", "node:fs", "fs", "/a/../p.mjs", "/a/./p.mjs", "/a/p\u0000.mjs", ""]) {
      expect(pluginModuleProblem(bad), bad).toBeTruthy();
    }
  });
  it("labels a package by name and a path by file name", () => {
    expect(pluginLabel("@acme/x")).toBe("@acme/x");
    expect(pluginLabel("/a/b/c.mjs")).toBe("c.mjs");
  });
  it("tells a path inside a folder from one beside it", () => {
    expect(insideFolder("/a/b/c", "/a/b")).toBe(true);
    expect(insideFolder("/a/b", "/a/b")).toBe(true);
    expect(insideFolder("/a/bc/c", "/a/b")).toBe(false);
  });
});

describe("the config key", () => {
  it("defaults to an empty list, and options to {}", () => {
    expect(ConfigSchema.parse({}).plugins).toEqual([]);
    expect(ConfigSchema.parse({ plugins: [{ module: "acme" }] }).plugins).toEqual([{ module: "acme", options: {} }]);
  });
  it("refuses unknown keys, duplicates and more than 20", () => {
    expect(ConfigSchema.safeParse({ plugins: [{ module: "acme", extra: 1 }] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ plugins: [{ module: "acme" }, { module: "acme" }] }).success).toBe(false);
    expect(ConfigSchema.safeParse({ plugins: Array.from({ length: 21 }, (_, i) => ({ module: `p${i}` })) }).success).toBe(false);
  });
  it("names the path of a bad module in the issue", () => {
    expect(() => parseConfigText("plugins:\n  - module: ./x.mjs\n")).toThrow(/plugins\.0\.module: must be a package name or an absolute path/);
  });
});

describe("loadPlugins", () => {
  it("loads in the listed order, once each, with the API version and a frozen copy of the options", async () => {
    const options = { a: { b: 1 } };
    const reg = await loadPlugins([entry(fx("order-a.mjs"), options), entry(fx("order-b.mjs"))], { blockedDirs: [] });
    expect(reg.plugins.map((p) => [p.label, p.version])).toEqual([["order-a.mjs", "1.0.0"], ["order-b.mjs", "2.0.0"]]);
    expect(seen().map((s) => s.name)).toEqual(["order-a", "order-b"]);
    const api = seen()[0]!.api;
    expect(api.version).toBe(PLUGIN_API_VERSION);
    expect(api.options).toEqual(options);
    expect(api.options).not.toBe(options);
    expect(Object.isFrozen(api.options)).toBe(true);
    expect(Object.isFrozen(api)).toBe(true);
    expect(reg.plugins.every((p) => p.registered.length === 0)).toBe(true);
  });

  it("waits for an async register, and accepts default.register of a CommonJS plugin", async () => {
    await loadPlugins([entry(fx("async.mjs")), entry(fx("cjs-default.cjs"))], { blockedDirs: [] });
    expect(seen().map((s) => s.name)).toEqual(["async", "cjs"]);
  });

  it("takes the version of a default export before the package.json above it", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(dir, "p.mjs"), "export default { version: '9.8.7', register() {} };\n");
    const reg = await loadPlugins([entry(join(dir, "p.mjs"))], { blockedDirs: [] });
    expect(reg.plugins[0]!.version).toBe("9.8.7");
  });

  it("takes the version from the nearest package.json when the module exports none", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "3.4.5" }));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "p.mjs"), "export function register() {}\n");
    expect((await loadPlugins([entry(join(dir, "lib", "p.mjs"))], { blockedDirs: [] })).plugins[0]!.version).toBe("3.4.5");
  });

  it("maps a package name through resolve and labels it by the name", async () => {
    const reg = await loadPlugins([entry("acme-plugin")], { blockedDirs: [], resolve: () => fx("order-a.mjs") });
    expect(reg.plugins[0]!.label).toBe("acme-plugin");
  });

  it("touches nothing for an empty list", async () => {
    const resolveFn = vi.fn();
    const importModule = vi.fn();
    expect(await loadPlugins([], { blockedDirs: [], resolve: resolveFn, importModule })).toEqual(emptyRegistry());
    expect(resolveFn).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it("fails with a message that names the plugin, and loads no later one", async () => {
    const cases: [PluginEntry, RegExp, Parameters<typeof loadPlugins>[1]?][] = [
      [entry("gone"), /cannot be found \(nope\)/, { blockedDirs: [], resolve: () => { throw new Error("nope\nsecond line"); } }],
      [entry(fx("import-throws.mjs")), /could not be imported: boom at import/],
      [entry(fx("no-register.mjs")), /does not export a function register\(api\)/],
      [entry(fx("refuse.mjs")), /register\(api\) failed: needs plugin API 9\.x/],
      [entry(fx("hangs.mjs")), /register\(api\) did not finish within/, { blockedDirs: [], timeoutMs: 50 }],
      [entry(fx("hangs-import.mjs")), /^plugin "[^"]+" import did not finish within 50 ms$/, { blockedDirs: [], timeoutMs: 50 }],
    ];
    for (const [e, re, deps] of cases) {
      const err = await failure(loadPlugins([e, entry(fx("order-b.mjs"))], deps ?? { blockedDirs: [] }));
      expect(err).toBeInstanceOf(PluginLoadError);
      expect(err.message).toContain(`plugin "${e.module}"`);
      expect(err.message).toMatch(re);
      expect(seen()).toEqual([]);
    }
  });

  it("refuses a plugin inside a blocked folder, also through symlinks, before importing it", async () => {
    const dir = fresh();
    const runs = join(dir, "runs");
    const repo = join(dir, "repo");
    mkdirSync(runs);
    mkdirSync(repo);
    writeFileSync(join(runs, "p.mjs"), "export function register() {}\n");
    writeFileSync(join(repo, "p.mjs"), "export function register() {}\n");
    const outside = join(dir, "outside");
    symlinkSync(runs, outside);
    const linkedDir = join(dir, "linked-repo");
    symlinkSync(repo, linkedDir);
    for (const [file, blocked] of [[join(runs, "p.mjs"), [runs]], [join(repo, "p.mjs"), [runs, repo]], [join(outside, "p.mjs"), [runs]], [join(repo, "p.mjs"), [linkedDir]]] as const) {
      const importModule = vi.fn();
      const err = await failure(loadPlugins([entry(file)], { blockedDirs: [...blocked], importModule }));
      expect(err.message).toContain(`plugin "${file}"`);
      expect(err.message).toContain("install it outside");
      expect(importModule).not.toHaveBeenCalled();
    }
  });
});

describe("problems and the view", () => {
  const reg = { entries: [entry("a")], plugins: [], problems: [{ plugin: "a", reason: "late" }] };
  it("passes registry problems through and compares with the file", () => {
    expect(pluginProblems({ ...reg, problems: [] }, [entry("a")])).toEqual([]);
    expect(pluginProblems({ ...reg, problems: [] }, [entry("b")])[0]!.plugin).toBe("config.yaml");
    expect(pluginProblems(reg, [entry("a")])).toEqual([{ plugin: "a", reason: "late" }]);
  });
  it("says the file cannot be read without quoting it", () => {
    const p = pluginProblems({ ...reg, problems: [] }, undefined);
    expect(p).toEqual([{ plugin: "config.yaml", reason: "cannot be read; the plugin list could not be checked" }]);
  });
  it("the view has no options", () => {
    const v = pluginsView({ entries: [entry("a", { secret: "x" })], plugins: [{ label: "a", module: "a", version: "1", registered: [] }], problems: [], ui: [] }, [entry("a", { secret: "x" })]);
    expect(JSON.stringify(v)).not.toContain("secret");
    expect(v.apiVersion).toBe(PLUGIN_API_VERSION);
  });
  it("readFilePlugins reads the file fresh, and gives undefined for a broken one", () => {
    const dir = fresh();
    const path = join(dir, "config.yaml");
    expect(readFilePlugins(path)).toEqual([]);
    writeFileSync(path, "plugins:\n  - module: acme\n    options: {k: 1}\n");
    expect(readFilePlugins(path)).toEqual([entry("acme", { k: 1 })]);
    writeFileSync(path, "plugins: [\n");
    expect(readFilePlugins(path)).toBeUndefined();
    writeFileSync(path, "plugins: 5\n");
    expect(readFilePlugins(path)).toBeUndefined();
  });
});

describe("api.onUsage", () => {
  const event = (id: string) => ({ id, time: "2026-11-04T10:00:00.000Z", runId: "r", workspace: "default", name: "run.started" }) as never;
  const load = (registers: ((api: any) => unknown)[], extra: Partial<Parameters<typeof loadPlugins>[1]> = {}) =>
    loadPlugins(registers.map((_, i) => entry(`/abs/p${i}.mjs`)), {
      blockedDirs: [],
      resolve: (s) => s,
      importModule: async (url) => ({ register: registers[Number(/p(\d+)\.mjs/.exec(url)![1])] }),
      ...extra,
    });

  it("reports version 0.2 and lists the handlers in `registered`", async () => {
    expect(PLUGIN_API_VERSION).toBe("0.3");
    const reg = await load([(api) => (api.onUsage(() => {}), api.onUsage(() => {}))]);
    expect(reg.plugins[0]!.registered).toEqual([{ point: "usage", name: "onUsage" }, { point: "usage", name: "onUsage" }]);
    reg.dispose!();
  });
  it("refuses a handler that is not a function, more than 10, and a call after register(api)", async () => {
    const err = await failure(load([(api) => api.onUsage("nope")]));
    expect(err.message).toMatch(/handler must be a function/);
    expect((await failure(load([(api) => Array.from({ length: 11 }, () => api.onUsage(() => {}))]))).message).toMatch(/at most 10/);
    let kept: any;
    const reg = await load([(api) => void (kept = api)]);
    expect(() => kept.onUsage(() => {})).toThrow(/only be called while register/);
    reg.dispose!();
  });
  it("delivers events to the handler, and not after dispose()", async () => {
    const { emitUsage, usageIdle } = await import("../src/usage/hub.js");
    const ids: string[] = [];
    const reg = await load([(api) => api.onUsage((e: { id: string }) => void ids.push(e.id))]);
    emitUsage(event("pl:1"));
    await usageIdle();
    reg.dispose!();
    emitUsage(event("pl:2"));
    await usageIdle();
    expect(ids).toEqual(["pl:1"]);
  });
  it("delivers only to the handlers of its own registry", async () => {
    const { emitUsage, usageIdle } = await import("../src/usage/hub.js");
    const a: string[] = [];
    const b: string[] = [];
    const first = await load([(api) => api.onUsage((e: { id: string }) => void a.push(e.id))]);
    first.dispose!();
    const second = await load([(api) => api.onUsage((e: { id: string }) => void b.push(e.id))]);
    emitUsage(event("own:1"));
    await usageIdle();
    expect([a, b]).toEqual([[], ["own:1"]]);
    second.dispose!();
  });
  it("removes the handlers of earlier plugins when a later one fails to load", async () => {
    const { emitUsage, usageIdle } = await import("../src/usage/hub.js");
    const ids: string[] = [];
    const err = await failure(
      load([
        (api) => api.onUsage((e: { id: string }) => void ids.push(e.id)),
        () => {
          throw new Error("no thanks");
        },
      ]),
    );
    expect(err.message).toMatch(/register\(api\) failed: no thanks/);
    emitUsage(event("fail:1"));
    await usageIdle();
    expect(ids).toEqual([]);
  });
  it("records a throwing handler in the problem list and the log, once", async () => {
    const { emitUsage, usageIdle } = await import("../src/usage/hub.js");
    const log: string[] = [];
    const reg = await load(
      [
        (api) =>
          api.onUsage(() => {
            throw new Error("TOP-SECRET detail");
          }),
      ],
      { log: (m) => void log.push(m) },
    );
    emitUsage([event("prob:1"), event("prob:2")]);
    await usageIdle();
    expect(reg.problems).toEqual([{ plugin: "p0.mjs", reason: "a usage handler threw an error" }]);
    expect(log.filter((m) => m.includes("threw"))).toHaveLength(1);
    const view = pluginsView(reg, reg.entries);
    expect(view.problems).toEqual(reg.problems);
    expect(JSON.stringify(view)).not.toContain("TOP-SECRET");
    reg.dispose!();
  });
});
