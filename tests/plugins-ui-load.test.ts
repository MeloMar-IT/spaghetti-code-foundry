import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emptyRegistry, loadPlugins, type PluginEntry } from "../src/plugins/load.js";

// api.ui during loadPlugins: registration, the handle, and the refusals.

const fx = (name: string) => resolve("tests/fixtures/plugins", name);
const entry = (module: string): PluginEntry => ({ module, options: {} });
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};
const temp = mkdtempSync(join(tmpdir(), "factory-plugins-ui-load-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(temp, `t${++n}`);
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "web", "p.js"), "x");
  return dir;
};
/** A plugin file whose body may use WEB for the quoted path of its web folder. */
const write = (dir: string, name: string, body: string) => {
  const file = join(dir, name);
  writeFileSync(file, body.replaceAll("WEB", JSON.stringify(join(dir, "web"))));
  return file;
};
const SPEC = `{ dir: WEB, pages: [{ id: "p", title: "P", module: "p.js", roles: ["user"] }], settings: { title: "S", fields: [{ key: "n", kind: "number", label: "N", default: 2 }] } }`;
type Handle = { name: string; settings(): unknown };
const handles = () => ((globalThis as { __scfUi?: Handle[] }).__scfUi ??= []);

describe("api.ui", () => {
  it("registers pages, menu items and settings, lists them, and gives a handle with the current values", async () => {
    handles().length = 0;
    let stored: Record<string, unknown> | undefined = { "ui-plugin": { limit: 9 } };
    const reg = await loadPlugins([entry(fx("ui-plugin.mjs"))], { blockedDirs: [], pluginSettings: () => stored });
    expect(reg.plugins[0]!.registered.map((r) => `${r.point} ${r.name}`)).toEqual(["ui page report", "ui page secret", "ui menu Report", "ui menu Secret", "ui settings Report plugin"]);
    expect(reg.ui.map((u) => u.name)).toEqual(["ui-plugin"]);
    const handle = handles()[0]!;
    expect(handle.name).toBe("ui-plugin");
    expect(handle.settings()).toMatchObject({ limit: 9, verbose: true });
    stored = { "ui-plugin": { limit: 7, verbose: false } };
    expect(handle.settings()).toMatchObject({ limit: 7, verbose: false });
    stored = undefined;
    expect(handle.settings()).toMatchObject({ limit: 5 });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(emptyRegistry().ui).toEqual([]);
  });

  it("stops the start with a message that names the plugin when the spec is bad, or ui is called twice", async () => {
    const dir = fresh();
    const bad = write(dir, "bad.mjs", `export function register(api) { api.ui({ dir: WEB, pages: [{ id: "p", title: "P", module: "../x.js", roles: ["user"] }] }); }`);
    expect((await failure(loadPlugins([entry(bad)], { blockedDirs: [] }))).message).toMatch(/plugin ".*bad\.mjs" register\(api\) failed: .*pages\[0\]\.module/);
    const twice = write(dir, "twice.mjs", `export function register(api) { api.ui(${SPEC}); api.ui(${SPEC}); }`);
    expect((await failure(loadPlugins([entry(twice)], { blockedDirs: [] }))).message).toMatch(/twice\.mjs".*only be called once/);
  });

  it("refuses a call after register has ended", async () => {
    const late = write(fresh(), "late.mjs", `export function register(api) { globalThis.__scfLateApi = api; }`);
    await loadPlugins([entry(late)], { blockedDirs: [] });
    const api = (globalThis as { __scfLateApi?: { ui(s: unknown): unknown } }).__scfLateApi!;
    expect(() => api.ui({ dir: "/x" })).toThrow(/while register\(api\) runs/);
  });

  it("refuses two plugins that get the same web address name", async () => {
    const a = write(fresh(), "same.mjs", `export function register(api) { api.ui(${SPEC}); }`);
    const b = write(fresh(), "same.mjs", `export function register(api) { api.ui(${SPEC}); }`);
    expect((await failure(loadPlugins([entry(a), entry(b)], { blockedDirs: [] }))).message).toMatch(/already used by another plugin/);
  });

  it("refuses a folder inside a blocked folder", async () => {
    const dir = fresh();
    const f = write(dir, "blocked.mjs", `export function register(api) { api.ui(${SPEC}); }`);
    expect((await failure(loadPlugins([entry(f)], { blockedDirs: [join(dir, "web")] }))).message).toMatch(/where runs write/);
  });
});
