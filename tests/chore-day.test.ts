import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { RESTART_INTERRUPTED } from "../src/engine/running.js";
import { runsArchiveDir } from "../src/engine/state.js";
import { interruptedLockKey } from "../src/queue/interrupted-runs.js";
import { releaseBuildLock } from "../src/queue/release-trigger.js";
import { SUPERSEDED_BY } from "../src/release/superseded.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher, accountBudgetLeft, minutesNow, watcherAccount } from "../src/queue/watcher.js";

/** Which day a daily schedule chore belongs to: the day it was queued for, not the day it started. */
describe("daily schedule chore", () => {
  let tmp: string;
  let scheduler: Scheduler;
  const today = minutesNow("UTC").day;
  const yesterday = minutesNow("UTC", new Date(Date.now() - 86_400_000)).day;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-chore-day-"));
    mkdirSync(join(tmp, "runs"));
    scheduler = new Scheduler({ runsDir: join(tmp, "runs"), config: () => ConfigSchema.parse({ concurrency: 1 }) });
    scheduler.drain(); // what the watcher queues stays in the queue
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** A finished earlier run of the chore, started now. */
  const lastRun = (vars: Record<string, string>) => {
    const runDir = join(tmp, "runs", "20260101-000000-aaaa");
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      runId: "20260101-000000-aaaa", flow: "release-daily", task: "release", repo: tmp, runDir, status: "succeeded",
      vars: { github_repo: "acme/app", chore_watcher: "rel", ...vars }, startedAt: now, finishedAt: now, totalCostUsd: 0, history: [],
    }));
  };
  const tickChore = async () => {
    const w = new Watcher(WatcherSchema.parse({ id: "rel", github_repo: "acme/app", source: "schedule", flow: "release-daily", at: "00:00", timezone: "UTC", task: "release" }), {
      scheduler, runsDir: join(tmp, "runs"), repo: tmp, log: () => undefined,
    });
    await (w as unknown as { tickChore(): Promise<void> }).tickChore();
  };
  const queued = () => scheduler.queue().pending.map((p) => scheduler.queuedJob(p.runId)!.job);

  it("queues today's chore when the last one was yesterday's, although it started today", async () => {
    lastRun({ chore_day: yesterday });
    await tickChore();
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ vars: { chore_watcher: "rel", chore_day: today } });
  });

  it("does not queue a second chore for the same day", async () => {
    lastRun({ chore_day: today });
    await tickChore();
    expect(queued()).toHaveLength(0);
  });

  it("counts an older run without chore_day by the day it started", async () => {
    lastRun({});
    await tickChore();
    expect(queued()).toHaveLength(0);
  });

  it("queues no second chore while one is still queued", async () => {
    await tickChore();
    await tickChore();
    expect(queued()).toHaveLength(1);
  });

  it("queue() carries chore_day of a queued and of an active chore, briefs() of a run", async () => {
    await tickChore();
    const p = scheduler.queue().pending[0]!;
    expect(p.choreDay).toBe(today);
    const job = scheduler.queuedJob(p.runId)!;
    (scheduler as unknown as { active: Map<string, unknown> }).active.set("x", { queued: job });
    expect(scheduler.queue().active[0]!.choreDay).toBe(today);
    lastRun({ chore_day: "2026-01-01" });
    expect(scheduler.briefs().find((b) => b.runId === "20260101-000000-aaaa")?.choreDay).toBe("2026-01-01");
  });

  describe("after an interruption", () => {
    const schedule = () => WatcherSchema.parse({ id: "rel", github_repo: "acme/app", source: "schedule", flow: "release-daily", at: "00:00", timezone: "UTC", task: "release" });
    /** One check of the watcher, without its GitHub setup: the recovery, then the chore. */
    const watcher = () => new Watcher(schedule(), { scheduler, runsDir: join(tmp, "runs"), repo: tmp, log: () => undefined });
    const check = async (w = watcher()) => {
      const inner = w as unknown as { resumeInterrupted(): void; tickChore(): Promise<void> };
      inner.resumeInterrupted();
      await inner.tickChore();
    };
    const stored = (id: string, day: string, o: Record<string, unknown> = {}, root = join(tmp, "runs")) => {
      const runDir = join(root, id);
      mkdirSync(runDir, { recursive: true });
      const at = day === today ? new Date().toISOString() : `${day}T08:00:00.000Z`;
      writeFileSync(join(runDir, "run.json"), JSON.stringify({
        runId: id, flow: "release-daily", task: "release", repo: tmp, runDir, status: "failed", reason: RESTART_INTERRUPTED, source: "watcher rel schedule",
        vars: { github_repo: "acme/app", chore_watcher: "rel", chore_day: day }, startedAt: at, finishedAt: at, totalCostUsd: 0, history: [], ...o,
      }));
    };
    const pending = () => scheduler.queue().pending.map((p) => ({ lockKey: p.lockKey, source: p.source, job: scheduler.queuedJob(p.runId)!.job }));
    const NEWEST = "20260109-080000-bbbb";
    const resumeOf = (runId: string) => ({ lockKey: "acme/app#chore:rel", source: "watcher rel schedule", job: { kind: "resume", runId } });

    it("resumes the newest chore with its lock and source, and starts no second one", async () => {
      stored(NEWEST, today);
      const w = watcher();
      await check(w);
      await check(w);
      expect(pending()).toEqual([resumeOf(NEWEST)]);
    });

    it("resumes today's interrupted chore also when it still says running", async () => {
      stored(NEWEST, today, { status: "running", reason: undefined, pid: 999999 });
      await check();
      expect(pending()).toEqual([resumeOf(NEWEST)]);
    });

    it("also resumes an older chore behind a newer one that failed", async () => {
      stored("20260101-080000-aaaa", "2026-01-01", { status: "cancelled" });
      stored(NEWEST, today, { reason: "the tests failed" });
      await check();
      expect(pending()).toEqual([resumeOf("20260101-080000-aaaa")]);
    });

    it("archives a chore that a later release already did, and does not resume it", async () => {
      stored("20260101-080000-aaaa", "2026-01-01", { status: "cancelled" });
      stored(NEWEST, today, { status: "succeeded", reason: undefined });
      await check();
      expect(pending()).toEqual([]);
      expect(scheduler.get("20260101-080000-aaaa")?.archivedBy).toBe(SUPERSEDED_BY);
    });

    it("resumes a chore whose newer success came from another watcher on the same repository", async () => {
      stored("20260101-080000-aaaa", "2026-01-01", { status: "cancelled", vars: { github_repo: "acme/app", chore_watcher: "rel", chore_day: "2026-01-01" } });
      stored(NEWEST, today, { status: "succeeded", reason: undefined, vars: { github_repo: "acme/app", chore_watcher: "other", chore_day: today } });
      await check();
      expect(pending()).toEqual([resumeOf("20260101-080000-aaaa")]);
      expect(scheduler.get("20260101-080000-aaaa")?.archivedBy).toBeUndefined();
    });

    it("sees a later release that is kept in runs-archive, whatever ran before at start-up", async () => {
      stored("20260101-080000-aaaa", "2026-01-01", { status: "running", reason: undefined, pid: 999999 });
      stored("20260102-080000-cccc", "2026-01-02", { status: "succeeded", reason: undefined }, runsArchiveDir(join(tmp, "runs")));
      stored(NEWEST, today, { reason: "the tests failed" });
      await check();
      expect(pending()).toEqual([]);
      expect(scheduler.get("20260101-080000-aaaa")?.archivedBy).toBe(SUPERSEDED_BY);
    });

    it("leaves archived, user-cancelled and hand-started runs alone", async () => {
      stored("20260101-080000-aaaa", "2026-01-01", { archivedAt: new Date().toISOString() });
      stored("20260102-080000-cccc", "2026-01-02", { status: "cancelled", reason: "cancelled by user" });
      stored("20260103-080000-dddd", "2026-01-03", { source: "ui" });
      stored(NEWEST, today, { source: "cli", status: "running", reason: undefined, pid: 999999, vars: { github_repo: "acme/app" } });
      stored("20260110-080000-eeee", today, { reason: "the tests failed" });
      await check();
      expect(pending()).toEqual([]);
    });

    it("queues a resume that could not start only once", async () => {
      stored(NEWEST, today);
      const w = watcher();
      await check(w);
      // the job leaves the queue and the run.json stays as it was, as after a resume that was refused
      (scheduler as unknown as { pending: unknown[] }).pending.length = 0;
      await check(w);
      expect(pending()).toEqual([]);
    });

    it("knows the lock key of each kind of watcher run, and leaves issue runs to the label check", () => {
      const key = (source: string, vars: Record<string, string> = {}) => interruptedLockKey("w", "acme/app", { source, vars });
      expect(key("watcher w schedule")).toBe("acme/app#chore:w");
      expect(key("watcher w precheck #1 #2")).toBe("acme/app#precheck:w");
      expect(key("watcher w ci Build and test", { ci_workflow: "Build and test" })).toBe("acme/app#ci:Build and test");
      expect(key("watcher w pr #4", { pr: "4" })).toBe("acme/app#4");
      expect(key("watcher w release-build", { ref: "main" })).toBe(releaseBuildLock("acme/app", "main"));
      expect(key("watcher w issue #4", { issue: "4" })).toBeUndefined();
      expect(key("watcher other schedule")).toBeUndefined();
      expect(key("ui")).toBeUndefined();
    });
  });

  it("works out the account and the budget of a watcher", () => {
    const base = WatcherSchema.parse({ id: "a", github_repo: "x/y" });
    expect(watcherAccount(base)).toBeUndefined();
    expect(watcherAccount({ ...base, repoId: "r1", ownerId: "u1" })).toBe("u1");
    const cap = (n: number | undefined) => ({ userDailyBudget: () => n });
    expect(accountBudgetLeft(cap(0), "/nonexistent")).toBe(true);
    expect(accountBudgetLeft(cap(undefined), "/nonexistent", "u1")).toBe(true);
    expect(accountBudgetLeft(cap(0), "/nonexistent", "u1")).toBe(false);
  });
});
