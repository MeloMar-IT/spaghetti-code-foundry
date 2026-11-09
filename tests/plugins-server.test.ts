import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server/server.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// startServer with plugins: order, failures, the config-only rule, the fresh drift check. Ports are picked by the system.

let tmp: string;
let home: string;
let startTestServer: typeof import("./helpers/port.js").startTestServer;
const fx = (name: string) => resolve("tests/fixtures/plugins", name);
const configPath = () => join(home, "config.yaml");
const yamlOf = (mods: string[]) => (mods.length ? `plugins:\n${mods.map((m) => `  - module: ${JSON.stringify(m)}\n    options: { token: SECRET-OPT }\n`).join("")}` : "");

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "factory-plugins-srv-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  process.env.FACTORY_HOME = home; // read at import time, so import afterwards
  ({ startTestServer } = await import("./helpers/port.js"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const start = (mods: string[]) => {
  writeFileSync(configPath(), yamlOf(mods));
  return startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
};
const asAdmin = async (base: string) => signInAs(base);
const call = (base: string, s: TestSession, method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...s.headers(method) }, body: body ? JSON.stringify(body) : undefined });

describe("plugins at server start", () => {
  it("loads two plugins in order and lists them without options", async () => {
    (globalThis as { __scfPlugins?: unknown[] }).__scfPlugins = [];
    const s = await start([fx("order-a.mjs"), fx("order-b.mjs")]);
    try {
      expect(s.ctx.plugins!.plugins.map((p) => p.label)).toEqual(["order-a.mjs", "order-b.mjs"]);
      expect(((globalThis as { __scfPlugins?: { name: string }[] }).__scfPlugins ?? []).map((p) => p.name)).toEqual(["order-a", "order-b"]);
      const admin = await asAdmin(s.base);
      const r = await call(s.base, admin, "GET", "/api/plugins");
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).not.toContain("SECRET-OPT");
      expect(JSON.parse(text)).toMatchObject({ apiVersion: "0.4", plugins: [{ label: "order-a.mjs", version: "1.0.0" }, { label: "order-b.mjs", version: "2.0.0" }], problems: [] });
      const user = await signInAs(s.base, { email: "user@example.com", role: "user", name: "User" });
      expect((await call(s.base, user, "GET", "/api/plugins")).status).toBe(403);
      expect((await fetch(`${s.base}/api/plugins`)).status).toBe(401);
    } finally {
      s.close();
    }
  });

  it("stops the start with the plugin's name and message", async () => {
    await expect(start([fx("refuse.mjs")])).rejects.toThrow(/plugin ".*refuse\.mjs" register\(api\) failed: needs plugin API 9\.x/);
    await expect(start([fx("import-throws.mjs")])).rejects.toThrow(/plugin ".*import-throws\.mjs" could not be imported/);
    await expect(start([fx("no-register.mjs")])).rejects.toThrow(/does not export a function register/);
    await expect(start(["/nonexistent/plugin.mjs"])).rejects.toThrow(/plugin "\/nonexistent\/plugin\.mjs"/);
  });

  it("lists an identity provider, and lets a non-local address start with an empty user store", async () => {
    const { hasIdentityProvider } = await import("../src/auth/identity.js");
    rmSync(join(home, "users.json"), { force: true }); // earlier tests made accounts: the store must be empty here
    const s = await start([fx("identity.mjs")]);
    try {
      expect(s.ctx.plugins!.plugins[0]!.registered).toEqual([{ point: "identity", name: "identityProvider" }]);
      expect(hasIdentityProvider()).toBe(true);
    } finally {
      s.close();
    }
    expect(hasIdentityProvider()).toBe(false);
    writeFileSync(configPath(), `server:\n  listen: 0.0.0.0\n${yamlOf([fx("identity.mjs")])}`);
    const wide = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    wide.close();
    // without the provider today's rule stands, and nothing is left registered
    writeFileSync(configPath(), "server:\n  listen: 0.0.0.0\n");
    await expect(startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") })).rejects.toThrow(/scf user create --admin/);
  });

  it("refuses a plugin inside the runs folder without importing it", async () => {
    mkdirSync(join(tmp, "runs"), { recursive: true });
    const file = join(tmp, "runs", "p.mjs");
    writeFileSync(file, "globalThis.__scfImported = true;\nexport function register() {}\n");
    await expect(start([file])).rejects.toThrow(/install it outside/);
    expect((globalThis as { __scfImported?: boolean }).__scfImported).toBeUndefined();
  });

  it("without plugins: nothing listed, no key in the settings or the health answer", async () => {
    const s = await start([]);
    try {
      expect(s.ctx.plugins!.plugins).toEqual([]);
      const admin = await asAdmin(s.base);
      expect(await (await call(s.base, admin, "GET", "/api/config")).json()).not.toHaveProperty("plugins");
      expect(await (await call(s.base, admin, "GET", "/api/health")).json()).not.toHaveProperty("pluginProblems");
      expect(await (await call(s.base, admin, "GET", "/api/plugins")).json()).toMatchObject({ plugins: [], problems: [] });
    } finally {
      s.close();
    }
  });

  it("is set in config.yaml only: a save with plugins is refused, one without keeps the file's plugins", async () => {
    const s = await start([fx("order-a.mjs")]);
    try {
      const admin = await asAdmin(s.base);
      const got = await call(s.base, admin, "GET", "/api/config");
      const settings = (await got.json()) as Record<string, unknown>;
      expect(settings).not.toHaveProperty("plugins");
      const refused = await call(s.base, admin, "PUT", "/api/config", { ...settings, plugins: [] });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("set in config.yaml only");
      expect(readFileSync(configPath(), "utf8")).toContain("order-a.mjs");
      const saved = await call(s.base, admin, "PUT", "/api/config", { ...settings, concurrency: 2 });
      expect(saved.status).toBe(200);
      const file = readFileSync(configPath(), "utf8");
      expect(file).toContain("order-a.mjs");
      expect(file).toContain("SECRET-OPT");
      expect(await (await call(s.base, admin, "GET", "/api/health")).json()).not.toHaveProperty("pluginProblems");
    } finally {
      s.close();
    }
  });

  describe("usage handlers", () => {
    const got = () => ((globalThis as { __scfUsage?: { instance: number; event: unknown }[] }).__scfUsage ??= []);
    const event = (id: string) => ({ id, time: "2026-11-04T10:00:00.000Z", runId: "r", workspace: "default", name: "run.started" }) as never;

    it("gets events while the server runs, and none after close()", async () => {
      const { emitUsage, usageIdle } = await import("../src/usage/hub.js");
      got().length = 0;
      const s = await start([fx("usage.mjs")]);
      try {
        expect(s.ctx.plugins!.plugins[0]!.registered).toEqual([{ point: "usage", name: "onUsage" }]);
        emitUsage(event("srv:1"));
        await usageIdle();
        expect(got().map((g) => (g.event as { id: string }).id)).toEqual(["srv:1"]);
      } finally {
        s.close();
      }
      emitUsage(event("srv:2"));
      await usageIdle();
      expect(got()).toHaveLength(1);
    });

    it("drops the handlers of a start that fails after the plugins loaded, so a second instance is not mixed up with it", async () => {
      const { emitUsage, usageIdle } = await import("../src/usage/hub.js");
      got().length = 0;
      const first = await start([]);
      try {
        // the same port again: listen() fails after the plugin was loaded
        writeFileSync(configPath(), yamlOf([fx("usage.mjs")]));
        await expect(startServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), port: first.port })).rejects.toThrow(/EADDRINUSE/);
        const second = await start([fx("usage.mjs")]);
        try {
          emitUsage(event("srv:3"));
          await usageIdle();
          // only the second instance (the second load of the plugin module) got it
          expect(got().map((g) => g.instance)).toHaveLength(1);
          expect(got()[0]!.instance).toBe(Math.max(...got().map((g) => g.instance)));
        } finally {
          second.close();
        }
      } finally {
        first.close();
      }
    });
  });

  it("notices an edited plugin list on disk without a settings write", async () => {
    const s = await start([fx("order-a.mjs")]);
    try {
      const admin = await asAdmin(s.base);
      writeFileSync(configPath(), yamlOf([fx("order-a.mjs"), fx("order-b.mjs")]));
      const health = (await (await call(s.base, admin, "GET", "/api/health")).json()) as { ok: boolean; summary: string; pluginProblems: { plugin: string; reason: string }[] };
      expect(health.ok).toBe(false);
      expect(health.pluginProblems[0]!.plugin).toBe("config.yaml");
      expect(health.summary).toMatch(/problem/);
      const view = (await (await call(s.base, admin, "GET", "/api/plugins")).json()) as { problems: unknown[] };
      expect(view.problems).toHaveLength(1);
      // an unreadable file is a problem too, and nothing of it is quoted
      writeFileSync(configPath(), "plugins: [SECRET-OPT\n");
      const broken = await (await call(s.base, admin, "GET", "/api/health")).text();
      expect(broken).toContain("cannot be read");
      expect(broken).not.toContain("SECRET-OPT");
    } finally {
      s.close();
    }
  });
});
