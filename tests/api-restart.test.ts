import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { ConfigSchema, WatcherSchema, type Config } from "../src/config.js";
import { WatcherManager } from "../src/queue/watchers.js";
import { SettingsRestart, settingsRestartFor, type SettingsRestartOptions } from "../src/server/api-restart.js";
import { health } from "../src/server/health.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");

describe("SettingsRestart", () => {
  afterEach(() => vi.useRealTimers());

  function make(over: Partial<SettingsRestartOptions> = {}) {
    vi.useFakeTimers();
    const state = { idle: false, other: false };
    const calls = { drain: vi.fn(), undrain: vi.fn(), exit: vi.fn(), beforeExit: vi.fn() };
    const r = new SettingsRestart({
      idle: () => state.idle,
      drain: calls.drain,
      undrain: calls.undrain,
      other: () => state.other,
      beforeExit: calls.beforeExit,
      log: () => {},
      supervised: () => true,
      exit: calls.exit,
      everyMs: 10,
      ...over,
    });
    return { r, state, calls };
  }

  it("does nothing when the server is not supervised", () => {
    const { r, calls } = make({ supervised: () => false });
    expect(r.available()).toBe(false);
    expect(r.request()).toBe("unsupervised");
    vi.advanceTimersByTime(1000);
    expect(calls.drain).not.toHaveBeenCalled();
    expect(calls.exit).not.toHaveBeenCalled();
  });

  it("drains once, waits while busy and does not drain again", () => {
    const { r, calls } = make();
    expect(r.request()).toBe("started");
    expect(r.request()).toBe("waiting");
    vi.advanceTimersByTime(1000);
    expect(calls.drain).toHaveBeenCalledTimes(1);
    expect(calls.exit).not.toHaveBeenCalled();
    expect(r.waiting()).toBeDefined();
    r.stop();
  });

  it("exits with 75 once idle, after beforeExit, exactly once", () => {
    const { r, state, calls } = make();
    r.request();
    state.idle = true;
    vi.advanceTimersByTime(1000);
    expect(calls.beforeExit).toHaveBeenCalledTimes(1);
    expect(calls.exit).toHaveBeenCalledTimes(1);
    expect(calls.exit).toHaveBeenCalledWith(75);
    expect(calls.beforeExit.mock.invocationCallOrder[0]!).toBeLessThan(calls.exit.mock.invocationCallOrder[0]!);
  });

  it("does not exit inside request(), even when idle: the first check is one tick away", () => {
    const { r, state, calls } = make();
    state.idle = true;
    r.request();
    expect(calls.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(calls.exit).toHaveBeenCalledTimes(1);
  });

  it("cancel undrains, stops the wait and prevents the exit", () => {
    const { r, state, calls } = make();
    r.request();
    expect(r.cancel()).toBe(true);
    expect(calls.undrain).toHaveBeenCalledTimes(1);
    expect(r.waiting()).toBeUndefined();
    state.idle = true;
    vi.advanceTimersByTime(1000);
    expect(calls.exit).not.toHaveBeenCalled();
    expect(r.cancel()).toBe(false);
  });

  it("gives way when another restart waits, and cannot be cancelled then", () => {
    const { r, state, calls } = make();
    r.request();
    state.other = true;
    expect(r.cancel()).toBe(false); // before the next tick
    expect(calls.undrain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(r.waiting()).toBeUndefined();
    state.idle = true;
    vi.advanceTimersByTime(1000);
    expect(calls.exit).not.toHaveBeenCalled();
    expect(r.request()).toBe("other");
  });
});

describe("WatcherManager.sync during a restart wait", () => {
  it("starts no watcher, and a save keeps working", () => {
    const config: Config = {
      ...ConfigSchema.parse({}),
      watchers: [WatcherSchema.parse({ id: "w", source: "issues", flow: "issue-gitflow", github_repo: "o/r" })],
    };
    const m = new WatcherManager({ scheduler: {} as never, runsDir: "/x", repo: "/x", config: () => config, log: () => {}, restart: () => ({ why: "settings", since: "now" }) } as never);
    m.sync();
    expect(m.tracked()).toEqual([]);
  });
});

describe("restart routes", () => {
  const savedHome = process.env.FACTORY_HOME;
  let kc: FakeKeychain;
  beforeAll(() => void (kc = fakeKeychain()));
  afterAll(() => {
    kc.remove();
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
  });

  async function boot() {
    const tmp = mkdtempSync(join(tmpdir(), "api-restart-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    process.env.FACTORY_HOME = join(tmp, "home");
    const s = await startTestServer({ repo, runsDir: join(tmp, "runs"), claudeBin, watchers: false, accountSweepMs: 3_600_000 });
    const admin = await signInAs(s.base);
    const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
      const r = await fetch(s.base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, text, json: () => JSON.parse(text) };
    };
    const lines = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : []);
    const events = (action: string) => lines().filter((l) => l.action === action);
    const setListen = async (listen: string) => {
      const c = (await call(admin, "GET", "/api/config")).json();
      expect((await call(admin, "PUT", "/api/config", { ...c, server: { ...c.server, listen } })).status).toBe(200);
    };
    return { s, ctx: s.ctx, admin, call, events, setListen, close: () => { s.close(); rmSync(tmp, { recursive: true, force: true }); } };
  }

  it("shows what needs a restart, and refuses the action on a server that cannot restart itself", async () => {
    const t = await boot();
    try {
      const first = (await t.call(t.admin, "GET", "/api/restart")).json();
      expect(first.needed).toEqual([]);
      expect(first.canRestart).toBe(false);
      expect(first.manual).toContain("FACTORY_NO_SUPERVISE=1");
      await t.setListen("0.0.0.0");
      expect((await t.call(t.admin, "GET", "/api/restart")).json().needed).toEqual([{ key: "server.listen", label: "Listen on", running: "127.0.0.1", saved: "0.0.0.0" }]);
      expect((await t.call(t.admin, "POST", "/api/restart", {})).status).toBe(409);
      expect(t.events("restart-request")).toEqual([]);
      expect((await t.call(t.admin, "DELETE", "/api/restart")).status).toBe(409);
    } finally {
      t.close();
    }
  });

  it("waits, drains, audits once, cancels and exits once idle", async () => {
    const t = await boot();
    try {
      let busy = true;
      let exited!: (code: number) => void;
      const exit = new Promise<number>((r) => (exited = r));
      const fakeExit = vi.fn((code: number) => exited(code));
      const beforeExit = vi.fn();
      t.ctx.settingsRestart = settingsRestartFor(t.ctx, { idle: () => !busy, supervised: () => true, exit: fakeExit, beforeExit, log: () => {}, everyMs: 10 });

      // nothing to restart for yet
      expect((await t.call(t.admin, "POST", "/api/restart", {})).status).toBe(409);
      await t.setListen("0.0.0.0");

      const post = await t.call(t.admin, "POST", "/api/restart", {});
      expect(post.status).toBe(200);
      expect(post.json().canRestart).toBe(true);
      expect(post.json().waiting).toMatchObject({ why: "settings", cancellable: true });
      expect(t.ctx.restart?.why).toBe("settings");
      expect(t.ctx.scheduler.draining).toBe(true);
      const requests = t.events("restart-request");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ target: "server", by: t.admin.user.id });
      expect(requests[0]!.detail).toContain("server.listen");
      expect((await t.call(t.admin, "POST", "/api/restart", {})).status).toBe(200);
      expect(t.events("restart-request")).toHaveLength(1);
      const problems = health(t.ctx).problems.filter((p) => p.kind === "restart");
      expect(problems).toHaveLength(1);
      expect(problems[0]!.text).toContain("changed setting");

      // cancel
      const del = await t.call(t.admin, "DELETE", "/api/restart");
      expect(del.status).toBe(200);
      expect(t.ctx.restart).toBeUndefined();
      expect(t.ctx.scheduler.draining).toBe(false);
      expect(t.events("restart-cancel")).toHaveLength(1);
      expect((await t.call(t.admin, "DELETE", "/api/restart")).status).toBe(409);
      busy = false;
      await new Promise((r) => setTimeout(r, 60)); // negative check: a cancelled wait does not exit
      expect(fakeExit).not.toHaveBeenCalled();

      // ask again; it exits when idle
      busy = true;
      expect((await t.call(t.admin, "POST", "/api/restart", {})).status).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
      expect(fakeExit).not.toHaveBeenCalled();
      busy = false;
      expect(await exit).toBe(75);
      expect(beforeExit).toHaveBeenCalledTimes(1);
    } finally {
      t.close();
    }
  });

  it("another restart owns the wait: no ask, no cancel, also after a takeover", async () => {
    const t = await boot();
    try {
      const fakeExit = vi.fn();
      t.ctx.settingsRestart = settingsRestartFor(t.ctx, { idle: () => false, supervised: () => true, exit: fakeExit, beforeExit: () => {}, log: () => {}, everyMs: 3_600_000 });
      await t.setListen("0.0.0.0");
      expect((await t.call(t.admin, "POST", "/api/restart", {})).status).toBe(200);
      // a moved data folder takes the wait over (as src/cli.ts does)
      t.ctx.restart = { why: "data_folder", since: new Date().toISOString() };
      const del = await t.call(t.admin, "DELETE", "/api/restart");
      expect(del.status).toBe(409);
      expect(t.ctx.restart.why).toBe("data_folder");
      expect(t.ctx.scheduler.draining).toBe(true);
      expect(t.events("restart-cancel")).toEqual([]);
      expect((await t.call(t.admin, "POST", "/api/restart", {})).status).toBe(409);
      const view = (await t.call(t.admin, "GET", "/api/restart")).json();
      expect(view.waiting).toMatchObject({ why: "data_folder", cancellable: false });
    } finally {
      t.close();
    }
  });
});
