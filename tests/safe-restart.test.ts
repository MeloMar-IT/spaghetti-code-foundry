import { afterEach, describe, expect, it, vi } from "vitest";
import { mustNotCut, restartIdle, SafeRestart,safeRestartFor, uncuttableRuns, UNCUTTABLE_STEPS, watcherResumes, type SafeRestartOptions } from "../src/safe-restart.js";
import { settingsRestartFor } from "../src/server/api-restart.js";
import { RESTART_CODE } from "../src/supervise.js";

const fake = (runs: Record<string, string>) => {
  const steps = new Map(Object.entries(runs));
  const scheduler = {
    queue: () => ({ active: [...steps.keys()].map((runId) => ({ runId })), pending: [], concurrency: 1 }) as any,
    currentStep: (id: string) => steps.get(id),
    interrupt: vi.fn(async (ids: string[], _ms?: number, _o?: { resume?: (q: any) => boolean }) => {
      for (const id of ids) steps.delete(id);
      return true;
    }),
    retryResumes: vi.fn(() => true),
  };
  return { steps, scheduler };
};

describe("which steps must not be cut", () => {
  it("knows the push, merge and release steps", () => {
    const listed = ["push", "push_feature", "merge_develop", "push_develop", "merge_main", "push_main", "merge_back", "push_back", "release_pr", "publish"];
    expect([...UNCUTTABLE_STEPS]).toEqual(listed);
    for (const id of listed) expect([mustNotCut(id), mustNotCut(`deliver/${id}`)]).toEqual([true, true]);
    for (const id of ["implement", "test_develop", "merge", "pushx", "", null, undefined]) expect(mustNotCut(id)).toBe(false);
  });

  it("lists only the active runs in such a step", () => {
    const { scheduler } = fake({ a: "push_develop", b: "implement", c: "publish" });
    expect(uncuttableRuns(scheduler)).toEqual([{ runId: "a", step: "push_develop" }, { runId: "c", step: "publish" }]);
  });

  it("knows which interrupted runs a watcher resumes", () => {
    const watchers = [{ id: "w", enabled: true }, { id: "off", enabled: false }];
    expect(watcherResumes("watcher w issue #7", watchers)).toBe(true);
    for (const source of ["watcher off issue #7", "watcher gone issue #7", "watcher w pr #7", "watcher w ci build", "watcher w schedule", "watcher w release-build", "ui", undefined]) {
      expect(watcherResumes(source, watchers)).toBe(false);
    }
  });
});

describe("restartIdle", () => {
  const scheduler = (active: number, pending: number, draining: boolean, saved = true) => ({
    queue: () => ({ active: Array(active).fill({}), pending: Array(pending).fill({}), concurrency: 1 }) as any,
    draining,
    retryResumes: vi.fn(() => saved),
  });

  it("is idle only with no active run, nothing queued that would be lost and every resume saved", () => {
    expect(restartIdle(scheduler(0, 0, false))).toBe(true);
    expect(restartIdle(scheduler(1, 0, true))).toBe(false);
    expect(restartIdle(scheduler(0, 1, false))).toBe(false);
    expect(restartIdle(scheduler(0, 1, true))).toBe(true);
    expect(restartIdle(scheduler(0, 0, true, false))).toBe(false);
  });

  it("does not try to save while a run is active", () => {
    const s = scheduler(1, 0, true);
    restartIdle(s);
    expect(s.retryResumes).not.toHaveBeenCalled();
  });
});

describe("SafeRestart", () => {
  const made: SafeRestart[] = [];
  afterEach(() => {
    for (const r of made.splice(0)) r.stop();
    vi.useRealTimers();
  });
  const setup = (runs: Record<string, string>, extra: Partial<SafeRestartOptions> = {}) => {
    const f = fake(runs);
    const calls: string[] = [];
    const lines: string[] = [];
    const drain = vi.fn();
    const beforeExit = vi.fn(() => { calls.push("beforeExit"); });
    const exit = vi.fn((code: number) => { calls.push(`exit ${code}`); });
    const r = new SafeRestart({ scheduler: f.scheduler, drain, beforeExit, exit, log: (m) => lines.push(m), supervised: () => true, ...extra });
    made.push(r);
    return { ...f, r, drain, beforeExit, exit, calls, lines };
  };

  it("does nothing on an unsupervised server", async () => {
    const t = setup({}, { supervised: () => false });
    expect(t.r.request("memory")).toBe("unsupervised");
    await t.r.tick();
    expect(t.drain).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("drains once", () => {
    const t = setup({});
    expect(t.r.request("memory")).toBe("started");
    expect(t.r.request("again")).toBe("waiting");
    expect(t.drain).toHaveBeenCalledTimes(1);
    expect(t.r.waiting()).toMatchObject({ reason: "memory" });
  });

  it("does not cut a push step; then it interrupts all runs and exits once", async () => {
    const t = setup({ a: "push_develop", b: "implement" });
    t.r.request("memory");
    await t.r.tick();
    await t.r.tick();
    expect(t.scheduler.interrupt).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
    expect(t.lines.filter((l) => l.includes("waits for a (push_develop)"))).toHaveLength(1);
    t.steps.set("a", "report");
    await t.r.tick();
    expect(t.scheduler.interrupt).toHaveBeenCalledTimes(1);
    expect(t.scheduler.interrupt.mock.calls[0]![0]).toEqual(["a", "b"]);
    expect(t.calls).toEqual(["beforeExit", `exit ${RESTART_CODE}`]);
    await t.r.tick();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("does not cut a merge or release step", async () => {
    const t = setup({ a: "merge_main", b: "release_pr", c: "implement" });
    t.r.request("memory");
    await t.r.tick();
    expect(t.scheduler.interrupt).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("checks by itself on its timer, and exits at once with no active run", async () => {
    vi.useFakeTimers();
    const t = setup({});
    t.r.request("memory");
    expect(t.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.exit).toHaveBeenCalledWith(75);
    expect(t.scheduler.interrupt).not.toHaveBeenCalled();
  });

  it("asks for a saved resume only for the runs no watcher resumes", async () => {
    const t = setup({ a: "implement" }, { watcherResumes: (s) => s === "watched" });
    t.r.request("memory");
    await t.r.tick();
    const resume = t.scheduler.interrupt.mock.calls[0]![2]!.resume!;
    expect([resume({ source: "watched" }), resume({ source: "ui" })]).toEqual([false, true]);
  });

  it("tries again when the runs did not stop or interrupt failed", async () => {
    const t = setup({ a: "implement" });
    t.scheduler.interrupt.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("boom"));
    t.r.request("memory");
    await t.r.tick();
    await expect(t.r.tick()).resolves.toBeUndefined();
    expect(t.exit).not.toHaveBeenCalled();
    await t.r.tick();
    expect(t.scheduler.interrupt).toHaveBeenCalledTimes(3);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("waits while the self-updater is busy", async () => {
    let busy = true;
    const t = setup({}, { busy: () => busy });
    t.r.request("memory");
    await t.r.tick();
    expect(t.exit).not.toHaveBeenCalled();
    busy = false;
    await t.r.tick();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("does not exit when the self-updater gets busy while the runs stop", async () => {
    let busy = false;
    let done!: () => void;
    const t = setup({ a: "implement" }, { busy: () => busy });
    t.scheduler.interrupt.mockImplementationOnce(() => new Promise<boolean>((r) => { done = () => { t.steps.clear(); r(true); }; }));
    t.r.request("memory");
    const first = t.r.tick();
    await t.r.tick(); // one check at a time
    expect(t.scheduler.interrupt).toHaveBeenCalledTimes(1);
    busy = true;
    done();
    await first;
    expect(t.beforeExit).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
    busy = false;
    await t.r.tick();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("does not exit while a resume is not saved yet", async () => {
    const t = setup({ a: "implement" });
    t.scheduler.retryResumes.mockReturnValueOnce(false);
    t.r.request("memory");
    await t.r.tick();
    expect(t.exit).not.toHaveBeenCalled();
    await t.r.tick();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("takes over another restart through the context", () => {
    const scheduler = { ...fake({}).scheduler, drain: vi.fn(), resume: vi.fn() };
    const ctx = { scheduler, config: () => ({ watchers: [] }), restart: { why: "settings", since: "x" } } as any;
    const o = { beforeExit: () => {}, log: () => {}, supervised: () => true, exit: () => {} };
    const r = safeRestartFor(ctx, o);
    made.push(r);
    r.request("memory");
    expect(ctx.restart.why).toBe("health");
    expect(scheduler.drain).toHaveBeenCalled();
    expect(settingsRestartFor(ctx, { ...o, idle: () => true }).request()).toBe("other");
  });
});
