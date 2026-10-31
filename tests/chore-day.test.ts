import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
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
