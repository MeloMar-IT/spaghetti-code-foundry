import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { signInAs, type TestSession } from "./helpers/session.js";

// The ui extension point through a real server: the file route, the views, the settings. One server with the plugin, one without.

let tmp: string;
let home: string;
let plug: string;
let startTestServer: typeof import("./helpers/port.js").startTestServer;
let started: Awaited<ReturnType<typeof import("./helpers/port.js").startTestServer>>;
let admin: TestSession;
let user: TestSession;
const configPath = () => join(home, "config.yaml");
const call = (s: TestSession, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(started.base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...s.headers(method, extra) }, body: body ? JSON.stringify(body) : undefined });

const PLUGIN = (dir: string) => `
export function register(api) {
  const handle = api.ui({
    dir: ${JSON.stringify(dir)},
    pages: [
      { id: "report", title: "Report", module: "report.js", roles: ["user", "admin"], files: ["style.css", "gone.css", "link.css"] },
      { id: "secret", title: "Secret", module: "secret.js", roles: ["admin"] },
    ],
    menu: [{ page: "report", label: "Report", roles: ["user", "admin"] }, { page: "secret", label: "Secret", roles: ["admin"] }],
    settings: { title: "Tui", fields: [
      { key: "limit", kind: "number", label: "Limit", help: "h", integer: true, min: 1, max: 10, default: 5 },
      { key: "verbose", kind: "yes-no", label: "Verbose", help: "h", default: true },
    ] },
  });
  (globalThis.__scfTui ??= []).push(handle);
}
`;

let PLUGIN_BLOCK = "";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "factory-plugins-ui-srv-"));
  home = join(tmp, "home");
  plug = join(tmp, "plug");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(plug, "web"), { recursive: true });
  mkdirSync(join(tmp, "repo"), { recursive: true });
  for (const f of ["report.js", "secret.js", "unlisted.js", "style.css", "gone.css"]) writeFileSync(join(plug, "web", f), `// ${f}\n`);
  writeFileSync(join(plug, "web", "link.css"), "ok\n");
  writeFileSync(join(plug, "outside.css"), "OUTSIDE-CONTENT\n");
  writeFileSync(join(plug, "tui.mjs"), PLUGIN(join(plug, "web")));
  process.env.FACTORY_HOME = home; // read at import time, so import afterwards
  ({ startTestServer } = await import("./helpers/port.js"));
  PLUGIN_BLOCK = `plugins:\n  - module: ${JSON.stringify(join(plug, "tui.mjs"))}\n    options: { token: SECRET-OPT }\n`;
  writeFileSync(configPath(), PLUGIN_BLOCK);
  started = await startTestServer({ repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
  admin = await signInAs(started.base);
  user = await signInAs(started.base, { email: "user@example.com", role: "user", name: "User" });
});
afterAll(() => {
  started?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the file route", () => {
  it("answers 401 without a session, 200 for a listed role, 403 for another role, and 200 for an admin", async () => {
    expect((await fetch(`${started.base}/plugins/tui/report.js`)).status).toBe(401);
    const ok = await call(user, "GET", "/plugins/tui/report.js");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await ok.text()).toBe("// report.js\n");
    expect((await call(user, "GET", "/plugins/tui/style.css")).headers.get("content-type")).toMatch(/^text\/css/);
    expect((await call(user, "GET", "/plugins/tui/secret.js")).status).toBe(403);
    expect((await call(admin, "GET", "/plugins/tui/secret.js")).status).toBe(200);
  });

  it("answers 404 for a file that is not registered, an unknown plugin, other methods and paths that climb", async () => {
    for (const p of ["/plugins/tui/unlisted.js", "/plugins/nope/report.js", "/plugins/tui/", "/plugins/tui", "/plugins/tui/%2e%2e/plug/outside.css", "/plugins/x/y.js"]) {
      expect((await call(admin, "GET", p)).status, p).toBe(404);
    }
    expect((await call(admin, "POST", "/plugins/tui/report.js", {})).status).toBe(404);
    expect((await call(admin, "DELETE", "/plugins/tui/report.js")).status).toBe(404);
  });

  it("answers 404 with no path when a registered file became a link out of the folder, or was removed", async () => {
    unlinkSync(join(plug, "web", "link.css"));
    symlinkSync(join(plug, "outside.css"), join(plug, "web", "link.css"));
    unlinkSync(join(plug, "web", "gone.css"));
    for (const f of ["link.css", "gone.css"]) {
      const r = await call(admin, "GET", `/plugins/tui/${f}`);
      expect(r.status, f).toBe(404);
      const body = await r.text();
      expect(body).toBe("not found");
      expect(body).not.toContain(plug);
      expect(body).not.toContain("OUTSIDE");
    }
  });
});

describe("the views", () => {
  it("lists what each role may see, never the folder or the options", async () => {
    const asUser = await (await call(user, "GET", "/api/plugins/ui")).json();
    expect(asUser).toEqual({ pages: [{ plugin: "tui", id: "report", title: "Report", module: "/plugins/tui/report.js", roles: ["user", "admin"] }], menu: [{ plugin: "tui", page: "report", label: "Report" }] });
    const text = await (await call(admin, "GET", "/api/plugins/ui")).text();
    const asAdmin = JSON.parse(text);
    expect(asAdmin.pages.map((p: { id: string }) => p.id)).toEqual(["report", "secret"]);
    expect(asAdmin.menu.map((m: { label: string }) => m.label)).toEqual(["Report", "Secret"]);
    expect(text).not.toContain(plug);
    expect(text).not.toContain("SECRET-OPT");
    expect((await fetch(`${started.base}/api/plugins/ui`)).status).toBe(401);
  });

  it("lists the registrations in GET /api/plugins", async () => {
    const v = await (await call(admin, "GET", "/api/plugins")).json();
    expect(v.plugins[0].registered.map((r: { point: string; name: string }) => `${r.point} ${r.name}`)).toEqual(["ui page report", "ui page secret", "ui menu Report", "ui menu Secret", "ui settings Tui"]);
    expect(JSON.stringify(v)).not.toContain(join(plug, "web"));
  });

  it("shows a settings section with the effective values", async () => {
    const s = await (await call(admin, "GET", "/api/settings")).json();
    expect(s.plugins).toHaveLength(1);
    expect(s.plugins[0]).toMatchObject({ plugin: "tui", title: "Tui", values: { limit: 5, verbose: true } });
    expect(s.plugins[0].fields.map((f: { key: string }) => f.key)).toEqual(["plugin_settings.tui.limit", "plugin_settings.tui.verbose"]);
    expect(JSON.stringify(s)).not.toContain(plug);
  });
});

describe("saving plugin settings", () => {
  const save = async (mutate: (c: Record<string, unknown>) => void) => {
    const get = await call(admin, "GET", "/api/config");
    const config = (await get.json()) as Record<string, unknown>;
    mutate(config);
    return call(admin, "PUT", "/api/config", config, { "x-config-version": get.headers.get("x-config-version")! });
  };
  const stored = () => (parse(readFileSync(configPath(), "utf8")) as { plugin_settings?: Record<string, unknown>; plugins?: unknown[] });
  const handle = () => (globalThis as { __scfTui?: { settings(): unknown }[] }).__scfTui!.at(-1)!;

  it("keeps the settings pages clean for a save without a plugin section", async () => {
    expect((await save(() => {})).status).toBe(200);
    expect(stored().plugin_settings).toBeUndefined();
    expect(stored().plugins).toHaveLength(1);
  });

  it("keeps stored plugin settings when a save leaves the key out of the body", async () => {
    expect((await save((c) => void (c.plugin_settings = { tui: { limit: 6 } }))).status).toBe(200);
    const get = await call(admin, "GET", "/api/config");
    const body = (await get.json()) as Record<string, unknown>;
    delete body.plugin_settings;
    const r = await call(admin, "PUT", "/api/config", body, { "x-config-version": get.headers.get("x-config-version")! });
    expect(r.status).toBe(200);
    expect(stored().plugin_settings).toEqual({ tui: { limit: 6 } });
    expect(handle().settings()).toEqual({ limit: 6, verbose: true });
  });

  it("saves valid values, and the handle returns them", async () => {
    const r = await save((c) => void (c.plugin_settings = { tui: { limit: 8, verbose: false } }));
    expect(r.status).toBe(200);
    expect(stored().plugin_settings).toEqual({ tui: { limit: 8, verbose: false } });
    expect(handle().settings()).toEqual({ limit: 8, verbose: false });
    expect((await (await call(admin, "GET", "/api/settings")).json()).plugins[0].values).toEqual({ limit: 8, verbose: false });
  });

  it("refuses an out-of-range value and a new unknown key, naming the key", async () => {
    const low = await save((c) => void (c.plugin_settings = { tui: { limit: 11 } }));
    expect(low.status).toBe(400);
    const body = await low.json();
    expect(body.error).toMatch(/^invalid config: plugin_settings\.tui\.limit: /);
    expect(body.issues[0].path).toBe("plugin_settings.tui.limit");
    expect((await save((c) => void (c.plugin_settings = { tui: { limit: 8, extra: 1 } }))).status).toBe(400);
    expect((await save((c) => void (c.plugin_settings = { other: { a: 1 } }))).status).toBe(400);
    expect(stored().plugin_settings).toEqual({ tui: { limit: 8, verbose: false } });
  });

  it("does not let an obsolete stored key block a save, and removes it", async () => {
    writeFileSync(configPath(), `${PLUGIN_BLOCK}plugin_settings:\n  tui: { limit: 8, verbose: false, old: 1 }\n`);
    const r = await save(() => {});
    expect(r.status).toBe(200);
    expect(stored().plugin_settings).toEqual({ tui: { limit: 8, verbose: false } });
  });

  it("keeps the stored section of a plugin that is not loaded", async () => {
    writeFileSync(configPath(), `${PLUGIN_BLOCK}plugin_settings:\n  tui: { limit: 3 }\n  gone: { a: 1 }\n`);
    expect((await save(() => {})).status).toBe(200);
    expect(stored().plugin_settings).toEqual({ tui: { limit: 3 }, gone: { a: 1 } });
    expect((await save((c) => void (c.plugin_settings = { tui: { limit: 3 }, gone: { a: 2 } }))).status).toBe(400);
    expect((await save((c) => void (c.plugin_settings = { tui: { limit: 4 } }))).status).toBe(200);
    expect(stored().plugin_settings).toEqual({ tui: { limit: 4 }, gone: { a: 1 } });
  });
});

describe("without plugins", () => {
  it("changes nothing", async () => {
    started.close();
    writeFileSync(configPath(), "");
    started = await startTestServer({ repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    admin = await signInAs(started.base);
    expect(await (await call(admin, "GET", "/api/settings")).json()).not.toHaveProperty("plugins");
    expect(await (await call(admin, "GET", "/api/plugins/ui")).json()).toEqual({ pages: [], menu: [] });
    expect((await call(admin, "GET", "/plugins/x/y.js")).status).toBe(404);
    const get = await call(admin, "GET", "/api/config");
    const config = await get.json();
    expect((await call(admin, "PUT", "/api/config", config, { "x-config-version": get.headers.get("x-config-version")! })).status).toBe(200);
    expect(readFileSync(configPath(), "utf8")).not.toContain("plugin_settings");
  });
});
