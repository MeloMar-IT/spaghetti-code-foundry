import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunIndex } from "../src/engine/run-index.js";
import { adoptRun, noteRunWritten, runReadCount, saveRun, setRunArchived, spentToday, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { ConfigSchema } from "../src/config.js";

let data: string;
let runs: string;
let ws: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "run-index-"));
  runs = join(data, "runs");
  ws = join(data, "workspaces", "team", "runs");
  mkdirSync(runs, { recursive: true });
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

const mk = (dir: string, id: string, over: Partial<RunSummary> = {}): RunSummary => {
  const runDir = join(dir, id);
  mkdirSync(runDir, { recursive: true });
  const s = { runId: id, flow: "f", task: "t", status: "succeeded", startedAt: "2026-10-01T10:00:00.000Z", totalCostUsd: 1, vars: {}, repo: "/r", runDir, history: [], state: { next: null, steps: {}, visits: {} }, ...over } as unknown as RunSummary;
  saveRun(s);
  return s;
};
const raw = (dir: string, id: string, text: string) => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "run.json"), text);
};
const ids = (x: RunIndex) => x.briefs().map((b) => b.runId);
const nextTick = () => Promise.resolve();

describe("RunIndex build", () => {
  it("reads in batches of 50 with a turn between them, newest first across folders", async () => {
    for (let i = 0; i < 100; i++) mk(runs, `r${String(i).padStart(4, "0")}`);
    for (let i = 0; i < 20; i++) mk(ws, `w${String(i).padStart(4, "0")}`);
    let turns = 0;
    const idx = new RunIndex(runs, { yieldTurn: async () => void turns++ });
    expect(idx.ready).toBe(false);
    await idx.build();
    expect(idx.ready).toBe(true);
    expect(turns).toBe(2); // 120 runs = 3 batches
    const got = ids(idx);
    expect(got).toHaveLength(120);
    expect(got).toEqual([...got].sort().reverse());
  });

  it("takes a duplicate id from the main runs folder", async () => {
    mk(runs, "dup", { flow: "main" });
    mk(ws, "dup", { flow: "workspace" });
    const idx = new RunIndex(runs);
    await idx.build();
    expect(idx.briefs().map((b) => b.flow)).toEqual(["main"]);
  });

  it("a second build() returns the same promise", () => {
    const idx = new RunIndex(runs);
    expect(idx.build()).toBe(idx.build());
  });

  it("does nothing once stopped", async () => {
    mk(runs, "a");
    const idx = new RunIndex(runs);
    idx.stop();
    await idx.build();
    expect(idx.ready).toBe(false);
    idx.start();
    expect(idx.ready).toBe(false);
  });
});

describe("RunIndex writes by this process", () => {
  it("shows saveRun, setRunArchived and adoptRun at once, without a read", async () => {
    mk(runs, "a", { status: "failed" });
    const idx = new RunIndex(runs);
    await idx.build();
    const reads = runReadCount();
    mk(runs, "b");
    expect(ids(idx)).toEqual(["b", "a"]);
    expect(runReadCount()).toBe(reads);
    expect(setRunArchived(join(runs, "a"), "2026-10-02T00:00:00Z")).toBe(true);
    expect(runReadCount()).toBe(reads + 1); // the rewrite itself reads the file once
    expect(idx.briefs().find((b) => b.runId === "a")?.archived).toBe(true);
    expect(adoptRun(join(runs, "b"), "acct")).toBe(true);
    expect(runReadCount()).toBe(reads + 2);
    expect(idx.briefs().find((b) => b.runId === "b")?.owner).toBe("acct");
    await idx.refresh();
    expect(runReadCount()).toBe(reads + 2); // the refresh finds nothing changed
  });

  it("a read that began before a local write does not undo it", async () => {
    mk(runs, "a", { status: "running" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const idx = new RunIndex(runs, { batch: 1, yieldTurn: async () => { if (++calls === 1) await gate; } });
    mk(runs, "z");
    const build = idx.build();
    await nextTick();
    // the pass waits at its first turn; a write by this process lands now
    saveRun({ ...mk(runs, "a", { status: "running" }), status: "failed" } as RunSummary);
    release();
    await build;
    expect(idx.briefs().find((b) => b.runId === "a")?.status).toBe("failed");
  });
});

describe("RunIndex writes by another process", () => {
  it("appear after refresh(), and only changed files are read again", async () => {
    for (let i = 0; i < 5; i++) mk(runs, `r${i}`);
    const idx = new RunIndex(runs);
    await idx.build();
    const reads = runReadCount();
    raw(runs, "r9", JSON.stringify({ runId: "r9", flow: "f", status: "failed", startedAt: "2026-10-01T10:00:00Z", totalCostUsd: 0 }));
    expect(ids(idx)).not.toContain("r9");
    await idx.refresh();
    expect(ids(idx)[0]).toBe("r9");
    expect(runReadCount()).toBe(reads + 1);
    await idx.refresh();
    expect(runReadCount()).toBe(reads + 1);
    raw(runs, "r2", JSON.stringify({ runId: "r2", flow: "changed", status: "failed", startedAt: "2026-10-01T10:00:00Z", totalCostUsd: 0 }));
    await idx.refresh();
    expect(runReadCount()).toBe(reads + 2);
    expect(idx.briefs().find((b) => b.runId === "r2")?.flow).toBe("changed");
  });

  it("skips a broken file, reads it once per change, and lists it when it is fixed", async () => {
    raw(runs, "bad", "{");
    const idx = new RunIndex(runs);
    await idx.build();
    const reads = runReadCount();
    await idx.refresh();
    await idx.refresh();
    expect(runReadCount()).toBe(reads);
    expect(ids(idx)).toEqual([]);
    raw(runs, "bad", JSON.stringify({ runId: "bad", flow: "f", status: "failed", startedAt: "2026-10-01T10:00:00Z", totalCostUsd: 0 }));
    await idx.refresh();
    expect(ids(idx)).toEqual(["bad"]);
  });

  it("drops a deleted run", async () => {
    mk(runs, "a");
    mk(ws, "b");
    const idx = new RunIndex(runs);
    await idx.build();
    expect(ids(idx)).toEqual(["b", "a"]);
    rmSync(join(runs, "a"), { recursive: true });
    await idx.refresh();
    expect(ids(idx)).toEqual(["b"]);
  });

  it("never runs two passes together", async () => {
    mk(runs, "a");
    let turns = 0;
    const idx = new RunIndex(runs, { batch: 1, yieldTurn: async () => void turns++ });
    mk(runs, "b");
    await idx.build();
    turns = 0;
    await Promise.all([idx.refresh(), idx.refresh()]);
    expect(turns).toBe(1); // 2 runs, 2 batches, one pass
  });
});

describe("RunIndex in sync mode", () => {
  it("is ready and lists a file written directly at once", () => {
    const idx = new RunIndex(runs, { live: false });
    expect(idx.ready).toBe(true);
    raw(runs, "x", JSON.stringify({ runId: "x", flow: "f", status: "failed", startedAt: "2026-10-01T10:00:00Z", totalCostUsd: 0 }));
    expect(ids(idx)).toEqual(["x"]);
  });
});

describe("RunIndex spentToday", () => {
  it("follows the rule of state.spentToday", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    mk(runs, "r3", { startedAt: "2026-10-01T09:00:00Z", totalCostUsd: 2, owner: "me" });
    mk(runs, "r2", { startedAt: "2026-10-01T08:00:00Z", totalCostUsd: 3 });
    mk(runs, "r1", { startedAt: "2026-09-29T08:00:00Z", totalCostUsd: 9 });
    const idx = new RunIndex(runs);
    await idx.build();
    expect(idx.spentToday(now)).toBe(spentToday(runs, now));
    expect(idx.spentToday(now)).toBe(5);
    expect(idx.spentToday(now, "me")).toBe(2);
  });
});

describe("RunIndex folder removal", () => {
  it("drops the runs of a removed workspace folder after refresh(), and entries() follows", async () => {
    mk(runs, "a");
    mk(ws, "b");
    const idx = new RunIndex(runs);
    await idx.build();
    expect(ids(idx)).toEqual(["b", "a"]); // populates the cache
    rmSync(join(data, "workspaces", "team"), { recursive: true });
    expect(ids(idx)).toEqual(["b", "a"]); // not yet refreshed: the store still has it
    await idx.refresh();
    expect(ids(idx)).toEqual(["a"]);
    expect(idx.entryOf("b")).toBeUndefined();
  });
});

describe("Scheduler with a built run index", () => {
  const sched = (idx: RunIndex) => new Scheduler({ runsDir: runs, config: () => ConfigSchema.parse({}), runIndex: idx });

  it("answers from memory, not from the disk", async () => {
    mk(runs, "a");
    mk(runs, "b", { status: "running" });
    const idx = new RunIndex(runs);
    const s = sched(idx);
    expect(s.runIndexReady()).toBe(false);
    await idx.build();
    expect(s.runIndexReady()).toBe(true);
    const reads = runReadCount();
    rmSync(runs, { recursive: true });
    const briefs = s.briefs();
    expect(briefs.map((b) => b.runId)).toEqual(["b", "a"]);
    expect(briefs[0]).toMatchObject({ status: "failed", interrupted: true });
    expect((await s.briefsAsync()).map((b) => b.runId)).toEqual(["b", "a"]);
    const slim = s.slimRuns();
    expect(slim[0]).toMatchObject({ status: "failed", reason: "interrupted — resume it to continue", finishedAt: briefs[0]!.updatedAt });
    expect(s.statusOf("b")).toBe("failed");
    expect(runReadCount()).toBe(reads);
    s.close();
  });

  it("shows the update of a run the scheduler runs, as the runner callback writes it", async () => {
    const a = mk(runs, "a", { status: "running" });
    const idx = new RunIndex(runs);
    await idx.build();
    noteRunWritten(a.runDir, { ...a, status: "succeeded" }, { stat: false });
    expect(idx.briefs()[0]!.status).toBe("succeeded");
    const reads = runReadCount();
    await idx.refresh(); // the file did not change: nothing is read, the newer entry stays
    expect(runReadCount()).toBe(reads);
    expect(idx.briefs()[0]!.status).toBe("succeeded");
  });

  it("slimOf reads from the index once it is ready, and whenIndexReady waits for the build", async () => {
    mk(runs, "a", { flow: "fl" });
    const idx = new RunIndex(runs);
    const s = sched(idx);
    const waiting = s.whenIndexReady();
    await idx.build();
    await waiting;
    const reads = runReadCount();
    expect(s.slimOf("a")).toMatchObject({ runId: "a", flow: "fl" });
    expect(s.slimOf("missing")).toBeUndefined();
    expect(runReadCount()).toBe(reads);
    s.close();
  });

  it("spentToday equals the state function", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    mk(runs, "r2", { startedAt: "2026-10-01T08:00:00Z", totalCostUsd: 3 });
    mk(runs, "r1", { startedAt: "2026-09-30T08:00:00Z", totalCostUsd: 9 });
    const idx = new RunIndex(runs);
    await idx.build();
    const s = sched(idx);
    expect(s.spentToday(now)).toBe(spentToday(runs, now));
    s.close();
  });
});
