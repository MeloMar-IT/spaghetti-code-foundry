import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { DrainLimit, drainOverLimit, type DrainLimitOptions } from "../src/drain-limit.js";
import { watchDataHome } from "../src/home.js";
import { restartIdle, safeRestartFor, type SafeRestart, type SafeRestartOptions } from "../src/safe-restart.js";
import { settingsRestartFor } from "../src/server/api-restart.js";
import type { RestartState } from "../src/server/next.js";
import { isCovered } from "../src/settings/describe.js";
import { RESTART_CODE } from "../src/supervise.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const since = new Date(T0).toISOString();

describe("drainOverLimit", () => {
  it.each([["new_version", "a new version"], ["data_folder", "a moved data folder"], ["settings", "a changed setting"]] as const)("acts on a %s drain only past the limit", (why, what) => {
    expect(drainOverLimit({ why, since }, 60, T0 + 59 * MIN)).toBeUndefined();
    expect(drainOverLimit({ why, since }, 60, T0 + 61 * MIN)).toBe(`the restart for ${what} waited longer than 60 minutes`);
  });

  it("does nothing with limit 0, a health restart, no restart or an unreadable time", () => {
    const late = T0 + 1000 * MIN;
    expect(drainOverLimit({ why: "new_version", since }, 0, late)).toBeUndefined();
    expect(drainOverLimit({ why: "health", since }, 60, late)).toBeUndefined();
    expect(drainOverLimit(undefined, 60, late)).toBeUndefined();
    expect(drainOverLimit({ why: "settings", since: "x" }, 60, late)).toBeUndefined();
  });

  it("says one minute", () => {
    expect(drainOverLimit({ why: "settings", since }, 1, T0 + 2 * MIN)).toMatch(/longer than 1 minute$/);
  });
});

describe("DrainLimit", () => {
  afterEach(() => vi.useRealTimers());

  const setup = (extra: Partial<DrainLimitOptions> = {}) => {
    const state: { restart?: RestartState; now: number } = { restart: { why: "new_version", since }, now: T0 + 59 * MIN };
    const request = vi.fn((_reason: string): "started" | "waiting" | "unsupervised" => {
      state.restart = { why: "health", since: new Date(state.now).toISOString() };
      return "started";
    });
    const lines: string[] = [];
    const d = new DrainLimit({ restart: () => state.restart, limitMinutes: () => 60, safeRestart: { request }, log: (m) => lines.push(m), now: () => state.now, ...extra });
    return { d, state, request, lines };
  };

  it("asks for the safe restart once", () => {
    const t = setup();
    expect(t.d.check()).toBe("none");
    expect(t.request).not.toHaveBeenCalled();
    t.state.now = T0 + 61 * MIN;
    expect(t.d.check()).toBe("started");
    t.state.now = T0 + 500 * MIN;
    expect(t.d.check()).toBe("none");
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  it("logs once per drain that an unsupervised server cannot restart itself", () => {
    const t = setup({ safeRestart: { request: () => "unsupervised" } });
    t.state.now = T0 + 61 * MIN;
    expect([t.d.check(), t.d.check(), t.d.check()]).toEqual(["unsupervised", "unsupervised", "unsupervised"]);
    expect(t.lines).toEqual(["restart: the restart for a new version waited longer than 60 minutes, but this server cannot restart itself (no supervisor); it keeps waiting for the runs"]);
    t.state.restart = { why: "settings", since: new Date(T0 + MIN).toISOString() };
    t.state.now = T0 + 70 * MIN;
    t.d.check();
    t.d.check();
    expect(t.lines).toHaveLength(2);
  });

  it("does not throw, and logs an error once", () => {
    const t = setup({ limitMinutes: () => { throw new Error("bad config"); } });
    expect([t.d.check(), t.d.check()]).toEqual(["none", "none"]);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain("bad config");
  });

  it("checks on its timer until it is stopped", () => {
    vi.useFakeTimers();
    const restart = vi.fn(() => undefined);
    const t = setup({ restart });
    t.d.start();
    vi.advanceTimersByTime(60_000);
    expect(restart).toHaveBeenCalledTimes(2);
    t.d.stop();
    vi.advanceTimersByTime(60_000);
    expect(restart).toHaveBeenCalledTimes(2);
  });
});

describe("the drain limit setting", () => {
  it("has a default and a range, and a settings control", () => {
    expect(ConfigSchema.parse({}).restarts.drain_limit_minutes).toBe(60);
    for (const v of [0, 10080]) expect(ConfigSchema.parse({ restarts: { drain_limit_minutes: v } }).restarts.drain_limit_minutes).toBe(v);
    for (const v of [-1, 1.5, 10081]) expect(ConfigSchema.safeParse({ restarts: { drain_limit_minutes: v } }).success).toBe(false);
    expect(isCovered("restarts.drain_limit_minutes")).toBe(true);
  });
});

describe("a drain that waits too long", () => {
  let supervised: string | undefined;
  const stops: (() => void)[] = [];
  beforeEach(() => {
    supervised = process.env.FACTORY_SUPERVISED;
    process.env.FACTORY_SUPERVISED = "1";
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.useRealTimers();
    if (supervised === undefined) delete process.env.FACTORY_SUPERVISED;
    else process.env.FACTORY_SUPERVISED = supervised;
  });

  /** A fake scheduler whose saved queue survives the restart, with the restart paths around it. */
  const harness = (runs: Record<string, string>, pending: string[]) => {
    const steps = new Map(Object.entries(runs));
    const saved = [...pending];
    const unsaved: string[] = [];
    const disk = { fails: false };
    const retryResumes = () => {
      if (disk.fails) return unsaved.length === 0;
      saved.push(...unsaved.splice(0));
      return true;
    };
    const scheduler = {
      draining: false,
      drain() { this.draining = true; },
      resume() { this.draining = false; },
      queue: () => ({ active: [...steps.keys()].map((runId) => ({ runId })), pending: [...saved], concurrency: 1 }) as any,
      currentStep: (id: string) => steps.get(id),
      interrupt: vi.fn(async (ids: string[], _ms?: number, o?: { resume?: (q: any) => boolean }) => {
        for (const id of ids) {
          steps.delete(id);
          if (o?.resume?.({ source: "ui" })) unsaved.push(`resume ${id}`);
        }
        retryResumes();
        return true;
      }),
      retryResumes: vi.fn(retryResumes),
    };
    /** A new server: it knows only the saved queue. Resolves with the jobs it started. */
    const startup = (): Promise<string[]> => {
      const queue = [...saved];
      const started: string[] = [];
      return new Promise((resolve) => {
        const next = () => {
          const job = queue.shift();
          if (job === undefined) return resolve(started);
          started.push(job);
          queueMicrotask(next);
        };
        queueMicrotask(next);
      });
    };
    const lines: string[] = [];
    const log = (m: string) => { lines.push(m); };
    const exits: string[] = [];
    let exited!: (code: number) => void;
    const firstExit = new Promise<number>((r) => { exited = r; });
    const exit = (who: string) => (code: number) => {
      exits.push(`${who} ${code}`);
      exited(code);
    };
    const ctx = { scheduler, config: () => ({ watchers: [] }), opts: { watchers: false }, restart: undefined as RestartState | undefined } as any;
    const safeRestart = (extra: Partial<SafeRestartOptions> = {}): SafeRestart => {
      const r: SafeRestart = safeRestartFor(ctx, { beforeExit: () => r.stop(), exit: exit("safe"), log, ...extra });
      stops.push(() => r.stop());
      return r;
    };
    const settingsRestart = () => {
      const r = settingsRestartFor(ctx, { idle: () => restartIdle(scheduler), beforeExit: () => r.stop(), exit: exit("settings"), log });
      stops.push(() => r.stop());
      return r;
    };
    const drainLimit = (r: SafeRestart) => {
      const d = new DrainLimit({ restart: () => ctx.restart, limitMinutes: () => 60, safeRestart: r, log });
      d.start();
      stops.push(() => d.stop());
    };
    /** A restart for a new version waits since now. */
    const newVersion = () => {
      ctx.restart = { why: "new_version", since: new Date().toISOString() };
      scheduler.drain();
    };
    /** A self-update on its own timer. Like SelfUpdater.tick, it catches a round that rejects. */
    const updater = (round: () => Promise<void>) => {
      const timer = setInterval(() => void round().catch(() => {}), 7_000);
      stops.push(() => clearInterval(timer));
    };
    /** A self-update that exits once the queue is idle and it is not busy. */
    const finishingUpdater = (busy: () => boolean = () => false) => {
      let done = false;
      updater(async () => {
        if (done || busy() || !restartIdle(scheduler)) return;
        done = true;
        exit("update")(RESTART_CODE);
      });
    };
    return { steps, scheduler, disk, startup, ctx, lines, log, exits, exit, firstExit, safeRestart, settingsRestart, drainLimit, newVersion, updater, finishingUpdater };
  };

  it("does not keep new work waiting", async () => {
    const h = harness({ a: "implement" }, ["queued"]);
    h.drainLimit(h.safeRestart());
    h.newVersion();
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(h.scheduler.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(await h.firstExit).toBe(RESTART_CODE);
    expect(h.exits).toEqual([`safe ${RESTART_CODE}`]);
    expect(await h.startup()).toEqual(["queued", "resume a"]);
  });

  it("waits for a push step before it cuts", async () => {
    const h = harness({ a: "push_develop" }, ["queued"]);
    h.drainLimit(h.safeRestart());
    h.newVersion();
    await vi.advanceTimersByTimeAsync(90 * MIN);
    expect(h.ctx.restart.why).toBe("health");
    expect(h.scheduler.interrupt).not.toHaveBeenCalled();
    expect(h.exits).toEqual([]);
    h.steps.set("a", "report");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await h.firstExit).toBe(RESTART_CODE);
    expect(await h.startup()).toEqual(["queued", "resume a"]);
  });

  it("takes over a restart for a changed setting", async () => {
    const h = harness({ a: "implement" }, ["queued"]);
    const settings = h.settingsRestart();
    h.drainLimit(h.safeRestart());
    expect(settings.request()).toBe("started");
    await vi.advanceTimersByTimeAsync(62 * MIN);
    expect(await h.firstExit).toBe(RESTART_CODE);
    expect(settings.waiting()).toBeUndefined();
    expect(h.exits).toEqual([`safe ${RESTART_CODE}`]);
  });

  it("lets no restart path exit with an unsaved resume", async () => {
    const h = harness({ a: "implement" }, ["queued"]);
    const idle = () => restartIdle(h.scheduler);
    stops.push(watchDataHome({ idle, beforeExit: () => {}, log: h.log, reason: () => "the data folder moved", exit: h.exit("data") }));
    h.finishingUpdater();
    const safe = h.safeRestart();
    const settings = h.settingsRestart();
    // its own context, so it does not see the health restart and stays on its timer
    const other = settingsRestartFor({ scheduler: h.scheduler, opts: { watchers: false } } as any, { idle, beforeExit: () => other.stop(), exit: h.exit("other settings"), log: h.log });
    stops.push(() => other.stop());
    h.disk.fails = true;
    settings.request();
    other.request();
    safe.request("memory");
    await safe.tick(); // the run stops, and its resume cannot be saved
    expect(h.steps.size).toBe(0);
    expect(idle()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.exits).toEqual([]);
    h.disk.fails = false;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(await h.firstExit).toBe(RESTART_CODE);
    expect(await h.startup()).toEqual(["queued", "resume a"]);
  });

  it("hands the exit to a self-update that can finish", async () => {
    const h = harness({ a: "implement" }, ["queued"]);
    let busy = true;
    h.finishingUpdater(() => busy);
    h.drainLimit(h.safeRestart({ handOff: () => true, busy: () => busy }));
    h.newVersion();
    await vi.advanceTimersByTimeAsync(70 * MIN);
    expect(h.scheduler.interrupt).not.toHaveBeenCalled();
    busy = false;
    // the safe restart stops the run first; the updater then installs
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await h.firstExit).toBe(RESTART_CODE);
    expect(h.exits).toEqual([`update ${RESTART_CODE}`]);
    expect(await h.startup()).toEqual(["queued", "resume a"]);
  });

  describe("when the self-update never restarts the server", () => {
    const stuck = () => {
      const h = harness({ a: "implement" }, ["queued"]);
      const state = { busy: false };
      const beforeExit = vi.fn(() => safe.stop());
      const safe: SafeRestart = h.safeRestart({ handOff: () => true, handOffChecks: 3, busy: () => state.busy, beforeExit });
      safe.request("memory");
      const ticks = async (n: number) => { for (let i = 0; i < n; i++) await safe.tick(); };
      const fellBack = async () => {
        expect(h.exits).toEqual([`safe ${RESTART_CODE}`]);
        expect(h.lines).toContain("health: the self-update did not restart the server; restarting without waiting for it");
        await ticks(3);
        expect(beforeExit).toHaveBeenCalledTimes(1);
        expect(h.exits).toHaveLength(1);
        expect(await h.startup()).toEqual(["queued", "resume a"]);
      };
      return { ...h, state, ticks, fellBack };
    };

    it("does not count checks while it builds, and never exits then", async () => {
      const t = stuck();
      t.state.busy = true;
      await t.ticks(50);
      expect(t.exits).toEqual([]);
      t.state.busy = false;
      await t.ticks(3);
      expect(t.exits).toEqual([]);
      await t.ticks(1);
      await t.fellBack();
    });

    it.each([
      ["its journal cannot be written", async () => {}],
      ["its check keeps failing", async () => { throw new Error("boom"); }],
    ])("exits when %s", async (_name, install) => {
      const t = stuck();
      const round = vi.fn(install);
      t.updater(round);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(t.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(round).toHaveBeenCalled();
      await t.fellBack();
    });

    it("keeps the count over short busy periods", async () => {
      const t = stuck();
      for (let i = 0; i < 3; i++) {
        await t.ticks(1);
        t.state.busy = true;
        await t.ticks(2);
        t.state.busy = false;
      }
      expect(t.exits).toEqual([]);
      await t.ticks(1);
      await t.fellBack();
    });
  });
});
