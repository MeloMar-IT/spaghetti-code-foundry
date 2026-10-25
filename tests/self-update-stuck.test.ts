import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { RESTART_CODE } from "../src/supervise.js";
import { stuckRuns } from "../src/server/stuck-runs.js";
import { fixture, removeFixtures, updater } from "./helpers/self-update.js";

vi.setConfig({ testTimeout: 60_000 });

const NOW = Date.parse("2026-06-01T12:00:00Z");
const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => {
  removeFixtures();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const touch = (file: string, ageMs: number) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "x");
  const t = new Date(NOW - ageMs);
  utimesSync(file, t, t);
};
const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();

/** A fake scheduler with one active run per entry; each run folder is a fresh temporary folder. */
function world(runs: Record<string, Partial<RunSummary> | "throws" | undefined>) {
  const root = mkdtempSync(join(tmpdir(), "stuck-"));
  dirs.push(root);
  const full: Record<string, RunSummary | "throws" | undefined> = {};
  for (const [id, r] of Object.entries(runs)) {
    full[id] = r === undefined || r === "throws" ? r : ({ runId: id, status: "running", runDir: join(root, id), startedAt: iso(40 * MIN), stepStartedAt: iso(40 * MIN), history: [], state: { next: "x" }, ...r } as unknown as RunSummary);
    mkdirSync(join(root, id), { recursive: true });
  }
  return {
    root,
    scheduler: {
      queue: () => ({ active: Object.keys(runs).map((runId) => ({ runId })) }),
      get: (id: string) => {
        if (full[id] === "throws") throw new Error("unreadable");
        return full[id] as RunSummary | undefined;
      },
    } as unknown as Parameters<typeof stuckRuns>[0],
  };
}

describe("stuckRuns", () => {
  it("a run that waits at claim_areas is stuck on the area lock", () => {
    const w = world({ r1: { state: { next: "claim_areas" } as RunSummary["state"] } });
    const logs = join(w.root, "r1", "logs");
    touch(join(logs, "001-claim_areas.log"), 0);
    writeFileSync(join(logs, "001-claim_areas.log"), "waiting for run X (@develop)\n");
    expect(stuckRuns(w.scheduler, Date.now()).runs).toEqual([{ runId: "r1", why: "area_lock" }]);
  });

  it("a fresh area-wait.json (merge_develop) is an area lock wait even when the folder is quiet", () => {
    const w = world({ r1: { state: { next: "merge_develop" } as RunSummary["state"] } });
    touch(join(w.root, "r1", "area-wait.json"), 10_000);
    touch(join(w.root, "r1", "old.log"), 2 * 60 * MIN);
    expect(stuckRuns(w.scheduler, NOW)).toEqual({ active: 1, runs: [{ runId: "r1", why: "area_lock" }] });
  });

  it("a stale area-wait.json does not count; the quiet rule applies", () => {
    const w = world({ r1: {} });
    touch(join(w.root, "r1", "area-wait.json"), 2 * MIN);
    touch(join(w.root, "r1", "old.log"), 31 * MIN);
    expect(stuckRuns(w.scheduler, NOW).runs).toEqual([{ runId: "r1", why: "quiet" }]);
  });

  it("a run with nothing new for 31 minutes is quiet", () => {
    const w = world({ r1: { startedAt: iso(31 * MIN), stepStartedAt: iso(31 * MIN) } });
    touch(join(w.root, "r1", "run.json"), 31 * MIN);
    touch(join(w.root, "r1", "logs", "001-a.log"), 31 * MIN);
    expect(stuckRuns(w.scheduler, NOW).runs).toEqual([{ runId: "r1", why: "quiet" }]);
  });

  it("is not stuck with a fresh tests.log, a fresh log write or a recent resume", () => {
    const a = world({ r1: {} });
    touch(join(a.root, "r1", "run.json"), 31 * MIN);
    touch(join(a.root, "r1", "tests.log"), MIN);
    expect(stuckRuns(a.scheduler, NOW).runs).toEqual([]);
    const b = world({ r1: {} });
    touch(join(b.root, "r1", "logs", "001-a.log"), MIN);
    expect(stuckRuns(b.scheduler, NOW).runs).toEqual([]);
    const c = world({ r1: { resumeLog: [{ at: iso(MIN), from: "a" }] } });
    expect(stuckRuns(c.scheduler, NOW).runs).toEqual([]);
  });

  it("ignores runs without a summary or not running, and skips a run that cannot be read", () => {
    const w = world({ none: undefined, stopped: { status: "stopped" }, bad: "throws", quiet: {} });
    const res = stuckRuns(w.scheduler, NOW);
    expect(res.active).toBe(4);
    expect(res.runs).toEqual([{ runId: "quiet", why: "quiet" }]);
  });
});

describe("SelfUpdater with stuck runs", () => {
  const stuck = (ids: string[], all: boolean) => ({ runs: ids.map((runId) => ({ runId, why: "quiet" as const })), all });

  it("names the stuck runs while it waits, logs once, and does not install", async () => {
    const f = fixture();
    f.publish({ "app.txt": "v2\n" });
    const t = updater(f, { stuck: () => stuck(["r1"], false), interrupt: async () => true });
    t.idle = false;
    for (let i = 0; i < 3; i++) await t.u.tick(true);
    expect(t.exits).toEqual([]);
    expect(t.u.view().update?.text).toContain("Stuck: r1 (no activity for 30 minutes)");
    expect(t.logs.filter((l) => l.includes("stuck runs: r1"))).toHaveLength(1);
  });

  it("interrupts when every active run is stuck, then installs", async () => {
    const f = fixture();
    f.publish({ "app.txt": "v2\n" });
    let ids: string[] = [];
    const t = updater(f, {
      stuck: () => stuck(["r1", "r2"], true),
      interrupt: async (x) => {
        ids = x;
        t.idle = true;
        return true;
      },
    });
    t.idle = false;
    await t.u.tick(true);
    await t.u.tick(true);
    expect(ids).toEqual(["r1", "r2"]);
    expect(t.exits).toEqual([RESTART_CODE]);
    expect(f.dist()).toBe("v2");
    expect(t.logs.some((l) => l.includes("interrupted"))).toBe(true);
  });

  it("does not install when the runs did not stop", async () => {
    const f = fixture();
    f.publish({ "app.txt": "v2\n" });
    const t = updater(f, { stuck: () => stuck(["r1"], true), interrupt: async () => false });
    t.idle = false;
    await t.u.tick(true);
    await t.u.tick(true);
    expect(t.exits).toEqual([]);
    expect(f.dist()).toBe("v1");
    expect(t.logs.filter((l) => l.includes("did not stop in time"))).toHaveLength(1);
  });

  it("does not install when stuck throws", async () => {
    const f = fixture();
    f.publish({ "app.txt": "v2\n" });
    const t = updater(f, {
      stuck: () => {
        throw new Error("boom");
      },
      interrupt: async () => true,
    });
    t.idle = false;
    await t.u.tick(true);
    await t.u.tick(true);
    expect(t.exits).toEqual([]);
  });

  it("when switched off while draining with every run stuck, it interrupts and then restarts", async () => {
    const f = fixture();
    f.publish({ "app.txt": "v2\n" });
    let enabled = true;
    const t = updater(f, {
      config: () => ({ enabled, repo: "acme/foundry" }),
      stuck: () => stuck(["r1"], true),
      interrupt: async () => {
        t.idle = true;
        return true;
      },
    });
    t.idle = false;
    await t.u.tick(true);
    expect(t.drained).toBe(1);
    enabled = false;
    await t.u.tick(true);
    expect(t.exits).toEqual([RESTART_CODE]);
    expect(f.dist()).toBe("v1");
  });
});
