import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkUiSpec, pluginSettingsProblem, pluginUiName, registrationsOf, settingSections, settingsSchema, settingsValues, uiView,
  type PluginUiEntry,
} from "../src/plugins/ui.js";

const temp = mkdtempSync(join(tmpdir(), "factory-plugins-ui-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
/** A folder with report.js, secret.js, a.css, a.svg and page.html. */
const folder = () => {
  const dir = join(temp, `d${++n}`);
  mkdirSync(dir, { recursive: true });
  for (const f of ["report.js", "secret.js", "a.css", "a.svg", "page.html", "mod.mjs"]) writeFileSync(join(dir, f), "x");
  return dir;
};
const who = { label: "acme.mjs", name: "acme", blocked: [] as string[] };
const FIELDS = [
  { key: "limit", kind: "number", label: "Limit", help: "h", integer: true, min: 1, max: 10, default: 5 },
  { key: "verbose", kind: "yes-no", label: "Verbose", help: "h", default: true },
  { key: "heading", kind: "text", label: "Heading", help: "h" },
  { key: "tags", kind: "list", label: "Tags", help: "h", maxItems: 2 },
  { key: "mode", kind: "choice", label: "Mode", help: "h", choices: ["a", "b"], default: "a" },
];
const full = (dir: string) => ({
  dir,
  pages: [
    { id: "report", title: "Report", module: "report.js", roles: ["user", "admin"], files: ["a.css", "a.svg"] },
    { id: "secret", title: "Secret", module: "secret.js", roles: ["admin"], files: ["a.css"] },
  ],
  menu: [{ page: "report", label: "Report", roles: ["user", "admin"] }, { page: "secret", label: "Secret", roles: ["admin"] }],
  settings: { title: "Acme", fields: FIELDS },
});
const problem = (spec: unknown, w = who) => {
  try {
    checkUiSpec(spec, w);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};
const entry = (): PluginUiEntry => checkUiSpec(full(folder()), who);

describe("pluginUiName", () => {
  it("makes a web address name from the label", () => {
    expect(pluginUiName("acme.mjs")).toBe("acme");
    expect(pluginUiName("@Acme/Scf_Plugin")).toBe("acme-scf-plugin");
    expect(pluginUiName("my.plugin.cjs")).toBe("my-plugin");
    expect(pluginUiName("a".repeat(100))).toHaveLength(64);
  });
  it("refuses a label that leaves no valid name", () => {
    expect(() => pluginUiName("@@")).toThrow(/web address name/);
    expect(() => pluginUiName("ä.mjs")).toThrow(/web address name/);
  });
});

describe("checkUiSpec", () => {
  it("accepts a full spec, with one rule per file and the roles of every page that lists it", () => {
    const e = checkUiSpec(full(folder()), who);
    expect(e.rules.map((r) => [r.path, r.roles])).toEqual([
      ["report.js", ["admin", "user"]], ["a.css", ["admin", "user"]], ["a.svg", ["admin", "user"]], ["secret.js", ["admin"]],
    ]);
    expect(e.rules.every((r) => r.method === "GET" && r.plugin === "acme" && r.note)).toBe(true);
    expect(registrationsOf(e).map((r) => `${r.point} ${r.name}`)).toEqual(["ui page report", "ui page secret", "ui menu Report", "ui menu Secret", "ui settings Acme"]);
  });
  it("accepts a spec with only a folder", () => {
    expect(checkUiSpec({ dir: folder() }, who).rules).toEqual([]);
  });
  it("refuses a bad folder", () => {
    expect(problem(null)).toMatch(/needs an object/);
    expect(problem({ dir: "rel" })).toMatch(/absolute path/);
    expect(problem({ dir: join(temp, "nope") })).toMatch(/not a folder/);
    const d = folder();
    expect(problem({ dir: d }, { ...who, blocked: [realpathSync(temp)] })).toMatch(/where runs write/);
    expect(problem({ dir: d, extra: 1 })).toMatch(/unknown key "extra"/);
  });
  it("refuses module and file paths that leave the folder or do not exist", () => {
    const d = folder();
    const page = (module: string, files?: string[]) => ({ dir: d, pages: [{ id: "p", title: "P", module, roles: ["user"], files }] });
    expect(problem(page("../x.js"))).toMatch(/\.\. parts/);
    expect(problem(page("/etc/x.js"))).toMatch(/relative path/);
    expect(problem(page("missing.js"))).toMatch(/does not name a file/);
    expect(problem(page("page.html"))).toMatch(/must end in \.js/);
    expect(problem(page("mod.mjs"))).toMatch(/must end in \.js/);
    expect(problem(page("a.css"))).toMatch(/must end in \.js/);
    expect(problem(page("a.svg"))).toMatch(/must end in \.js/);
    expect(problem(page("report.js", ["page.html"]))).toMatch(/must end in \.js, \.css, \.svg/);
    expect(problem(page("report.js", ["a\\b.css"]))).toMatch(/backslash/);
  });
  it("refuses a symlink that leads out of the folder", () => {
    const d = folder();
    const outside = join(temp, "outside.js");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(d, "link.js"));
    expect(problem({ dir: d, pages: [{ id: "p", title: "P", module: "link.js", roles: ["user"] }] })).toMatch(/leads out/);
  });
  it("refuses bad pages", () => {
    const d = folder();
    const p = (extra: object) => ({ dir: d, pages: [{ id: "p", title: "P", module: "report.js", roles: ["user"], ...extra }] });
    expect(problem(p({ roles: [] }))).toMatch(/roles must list/);
    expect(problem(p({ roles: ["root"] }))).toMatch(/unknown role/);
    expect(problem(p({ id: "Bad Id" }))).toMatch(/id must be/);
    expect(problem(p({ title: "" }))).toMatch(/title must be/);
    expect(problem(p({ junk: 1 }))).toMatch(/unknown key/);
    expect(problem({ dir: d, pages: [p({}).pages[0], p({}).pages[0]] })).toMatch(/used twice/);
    expect(problem({ dir: d, pages: Array.from({ length: 21 }, (_, i) => ({ ...p({}).pages[0], id: `p${i}` })) })).toMatch(/at most 20/);
  });
  it("refuses bad menu items", () => {
    const d = folder();
    const base = full(d);
    expect(problem({ ...base, menu: [{ page: "nope", label: "X", roles: ["user"] }] })).toMatch(/names no page/);
    expect(problem({ ...base, menu: [{ page: "secret", label: "X", roles: ["user"] }] })).toMatch(/wider than/);
    expect(problem({ ...base, menu: [{ page: "report", label: "X", roles: [] }] })).toMatch(/roles must list/);
    expect(problem({ ...base, menu: [{ page: "report", label: "", roles: ["user"] }] })).toMatch(/label must be/);
  });
  it("refuses bad settings", () => {
    const d = folder();
    const s = (fields: object[]) => ({ dir: d, settings: { title: "S", fields } });
    const f = (extra: object) => [{ key: "k", kind: "number", label: "K", help: "h", ...extra }];
    expect(problem(s([]))).toMatch(/1 to 50/);
    expect(problem(s(f({ kind: "date" })))).toMatch(/kind must be/);
    expect(problem(s(f({ key: "Bad" })))).toMatch(/key must be/);
    expect(problem(s([...f({}), ...f({})]))).toMatch(/names a key twice/);
    expect(problem(s(f({ default: "x" })))).toMatch(/default/);
    expect(problem(s(f({ min: 5, default: 1 })))).toMatch(/default/);
    expect(problem(s(f({ integer: true, default: 1.5 })))).toMatch(/default/);
    expect(problem(s(f({ min: 3, max: 1 })))).toMatch(/min is larger/);
    expect(problem(s(f({ choices: ["a"] })))).toMatch(/unknown key "choices"/);
    expect(problem(s(f({ kind: "choice" })))).toMatch(/choices must list/);
    expect(problem(s(f({ kind: "choice", choices: ["a"], default: "b" })))).toMatch(/default/);
    expect(problem(s(f({ kind: "yes-no", default: "yes" })))).toMatch(/default/);
    expect(problem(s(f({ kind: "list", maxItems: 1, default: ["a", "b"] })))).toMatch(/default/);
    expect(problem(s(f({ kind: "text", default: 3 })))).toMatch(/default/);
  });
});

describe("settings", () => {
  const e = entry();
  it("fills in defaults and ignores invalid and unknown stored values", () => {
    expect(settingsValues(e, undefined)).toEqual({ limit: 5, verbose: true, mode: "a" });
    expect(settingsValues(e, { limit: 7, verbose: false, heading: "Hi", tags: ["x"], old: 1 })).toEqual({ limit: 7, verbose: false, heading: "Hi", tags: ["x"], mode: "a" });
    expect(settingsValues(e, { limit: 99, mode: "z" })).toEqual({ limit: 5, verbose: true, mode: "a" });
    expect(settingsValues(e, { verbose: false, limit: 0 }).verbose).toBe(false);
  });
  it("checks values with the schema of the fields", () => {
    const schema = settingsSchema(FIELDS as never);
    expect(schema.safeParse({ limit: 3 }).success).toBe(true);
    expect(schema.safeParse({ limit: 11 }).success).toBe(false);
    expect(schema.safeParse({ tags: ["a", "b", "c"] }).success).toBe(false);
  });
  it("describes the sections with the effective values", () => {
    const [s] = settingSections([e], { acme: { verbose: false } });
    expect(s!.plugin).toBe("acme");
    expect(s!.values).toEqual({ limit: 5, verbose: false, mode: "a" });
    expect(s!.fields.map((f) => f.key)).toEqual(FIELDS.map((f) => `plugin_settings.acme.${f.key}`));
    expect(s!.fields[0]).toMatchObject({ kind: "number", integer: true, min: 1, max: 10, default: 5, optional: false, control: "generated", label: "Limit" });
    expect(s!.fields[2]).toMatchObject({ kind: "text", optional: true });
    expect(settingSections([checkUiSpec({ dir: folder() }, who)], {})).toEqual([]);
  });
});

describe("uiView", () => {
  const e = entry();
  it("encodes each part of a module address, so a reserved character reaches the file", () => {
    const d = join(temp, "reserved");
    mkdirSync(d, { recursive: true });
    for (const f of ["report#v2.js", "what?.js", "100%.js", "sub dir/a b.js"]) {
      mkdirSync(join(d, f.includes("/") ? "sub dir" : ""), { recursive: true });
      writeFileSync(join(d, f), "x");
    }
    const x = checkUiSpec({ dir: d, pages: ["report#v2.js", "what?.js", "100%.js", "sub dir/a b.js"].map((m, i) => ({ id: `p${i}`, title: "P", module: m, roles: ["user"] })) }, who);
    const modules = uiView([x], "user").pages.map((p) => p.module);
    expect(modules).toEqual(["/plugins/acme/report%23v2.js", "/plugins/acme/what%3F.js", "/plugins/acme/100%25.js", "/plugins/acme/sub%20dir/a%20b.js"]);
    // the server decodes the address once, then looks the file up by its name
    expect(modules.map((m) => decodeURIComponent(m.slice("/plugins/acme/".length)))).toEqual(["report#v2.js", "what?.js", "100%.js", "sub dir/a b.js"]);
  });
  it("gives each role only its pages and menu items, and never the folder", () => {
    const user = uiView([e], "user");
    expect(user.pages.map((p) => p.id)).toEqual(["report"]);
    expect(user.menu.map((m) => m.label)).toEqual(["Report"]);
    const admin = uiView([e], "admin");
    expect(admin.pages.map((p) => p.id)).toEqual(["report", "secret"]);
    expect(admin.menu.map((m) => m.label)).toEqual(["Report", "Secret"]);
    expect(user.pages[0]!.module).toBe("/plugins/acme/report.js");
    expect(JSON.stringify(admin)).not.toContain(e.dir);
  });
  it("gives an admin only the menu items that list admin", () => {
    const d = folder();
    const x = checkUiSpec({ dir: d, pages: [{ id: "p", title: "P", module: "report.js", roles: ["user", "admin"] }], menu: [{ page: "p", label: "P", roles: ["user"] }] }, who);
    expect(uiView([x], "admin")).toMatchObject({ pages: [{ id: "p" }], menu: [] });
  });
  it("is empty without plugins", () => {
    expect(uiView([], "user")).toEqual({ pages: [], menu: [] });
  });
});

describe("pluginSettingsProblem", () => {
  const e = entry();
  const check = (next: object, stored: object = {}) => pluginSettingsProblem(next as never, stored as never, [e]);
  it("accepts valid values and keeps them", () => {
    expect(check({ acme: { limit: 3, verbose: false } })).toEqual({ cleaned: { acme: { limit: 3, verbose: false } } });
  });
  it("refuses an out-of-range value and a new unknown key", () => {
    expect(check({ acme: { limit: 11 } }).problem).toMatchObject({ path: "plugin_settings.acme.limit" });
    expect(check({ acme: { nope: 1 } }).problem).toEqual({ path: "plugin_settings.acme.nope", message: "is not a setting of this plugin" });
  });
  it("drops an obsolete stored key without an error", () => {
    expect(check({ acme: { limit: 3, old: "x" } }, { acme: { limit: 3, old: "x" } })).toEqual({ cleaned: { acme: { limit: 3 } } });
  });
  it("keeps an unchanged invalid stored value, and refuses a changed one", () => {
    expect(check({ acme: { limit: 99 } }, { acme: { limit: 99 } })).toEqual({ cleaned: { acme: { limit: 99 } } });
    expect(check({ acme: { limit: 98 } }, { acme: { limit: 99 } }).problem).toBeTruthy();
  });
  it("keeps the entry of a plugin that is not loaded, and refuses a change to it", () => {
    expect(check({ gone: { a: 1 } }, { gone: { a: 1 } })).toEqual({ cleaned: { gone: { a: 1 } } });
    expect(check({}, { gone: { a: 1 } }).cleaned).toEqual({ gone: { a: 1 } });
    expect(check({ gone: { a: 2 } }, { gone: { a: 1 } }).problem).toMatchObject({ path: "plugin_settings.gone" });
    expect(check({ gone: { a: 1 } }, {}).problem).toBeTruthy();
  });
  it("leaves out an empty section", () => {
    expect(check({ acme: {} })).toEqual({ cleaned: {} });
  });
});
