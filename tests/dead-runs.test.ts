import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { markRunning, RESTART_INTERRUPTED, sweepStaleRunning, withRunStateLock } from "../src/engine/running.js";
import { loadRun } from "../src/engine/state.js";
import { runNextStep } from "../src/next-step.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { archiveSupersededReleases, SUPERSEDED_BY } from "../src/release/superseded.js";
import { settleDeadRuns, type DeadRunScheduler } from "../src/server/dead-runs.js";

const DEAD = 999999;

describe("runs whose process is gone", () => {
  let tmp: string;
  let runsDir: string;
  let scheduler: Scheduler;
  let lines: string[];
  let savedLock: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dead-runs-"));
    runsDir = join(tmp, "runs");
    mkdirSync(runsDir);
    savedLock = process.env.FACTORY_LOCK_DIR;
    process.env.FACTORY_LOCK_DIR = join(tmp, "locks");
    scheduler = new Scheduler({ runsDir, config: () => ConfigSchema.parse({ concurrency: 1 }) });
    scheduler.drain();
    lines = [];
  });
  afterEach(() => {
    process.env.FACTORY_LOCK_DIR = savedLock;
    rmSync(tmp, { recursive: true, force: true });
  });

  const make = (id: string, o: Record<string, unknown> = {}) => {
    const runDir = join(runsDir, id);
    mkdirSync(runDir, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: id, flow: "quick", task: "t", repo: tmp, runDir, status: "running", pid: DEAD, vars: {}, startedAt: at, totalCostUsd: 0, history: [], ...o }));
    const when = new Date(Date.now() - 1000);
    utimesSync(join(runDir, "run.json"), when, when);
    return runDir;
  };
  const settle = (o: { ids?: string[]; ownPidDead?: boolean } = {}) => settleDeadRuns(scheduler, { ...o, log: (m) => lines.push(m) });

  /** The stored run, the lists and `runs cancel` say the same. */
  const agrees = (id: string) => {
    expect(loadRun(runsDir, id)).toMatchObject({ status: "failed", reason: RESTART_INTERRUPTED });
    expect(scheduler.get(id)).toMatchObject({ status: "failed", reason: RESTART_INTERRUPTED });
    expect(scheduler.list().find((r) => r.runId === id)?.status).toBe("failed");
    expect(scheduler.briefs().find((b) => b.runId === id)).toMatchObject({ status: "failed", interrupted: true });
    expect(scheduler.cancel(id)).toBe(false);
    expect(runNextStep(scheduler.get(id)!).kind).toBe("interrupted");
    expect(scheduler.queue().pending).toHaveLength(0);
  };

  it("at start: a run behind a freed marker, also with the server's own pid", () => {
    make("r1", { pid: process.pid });
    markRunning("r1");
    const swept = sweepStaleRunning(runsDir, () => false, { atStart: true });
    expect(settle({ ids: swept.markers, ownPidDead: true })).toEqual(["r1"]);
    agrees("r1");
    expect(lines).toEqual(["run r1 is saved as interrupted: its process is gone"]);
  });

  it("at start: a run without a marker", () => {
    make("r1");
    expect(settle()).toEqual(["r1"]);
    agrees("r1");
  });

  it("in the periodic sweep: the run behind the freed marker", () => {
    make("r1");
    markRunning("r1");
    const swept = sweepStaleRunning(runsDir, (id) => scheduler.isActive(id));
    expect(settle({ ids: swept.markers })).toEqual(["r1"]);
    agrees("r1");
  });

  it("tells viewers and the monitor", () => {
    make("r1");
    const seen: string[] = [];
    const acts: string[] = [];
    scheduler.subscribe("r1", (e) => {
      if (e.type === "update") seen.push(e.summary.reason ?? "");
    });
    settleDeadRuns(scheduler, { log: () => undefined, act: (m) => acts.push(m) });
    expect(seen.at(-1)).toBe(RESTART_INTERRUPTED);
    expect(acts).toHaveLength(1);
  });

  it("leaves live, active, queued and own-pid runs alone", () => {
    make("live", { pid: process.ppid });
    make("own", { pid: process.pid });
    make("act");
    make("que");
    const inner = scheduler as unknown as { active: Map<string, unknown>; pending: unknown[] };
    inner.active.set("act", { queued: { runId: "act" } });
    inner.pending.push({ runId: "que", job: { kind: "resume", runId: "que" }, enqueuedAt: new Date().toISOString() });
    expect(settle()).toEqual([]);
    expect(settle({ ids: ["act", "que", "own", "live"] })).toEqual([]);
    for (const id of ["live", "own", "act", "que"]) expect(loadRun(runsDir, id)?.status).toBe("running");
    expect(lines).toEqual([]);
    // at start the own pid is gone, but an active or queued run is still left alone
    expect(settle({ ownPidDead: true })).toEqual(["own"]);
    expect(loadRun(runsDir, "own")?.status).toBe("failed");
    expect(loadRun(runsDir, "act")?.status).toBe("running");
    expect(loadRun(runsDir, "que")?.status).toBe("running");
    expect(loadRun(runsDir, "live")?.status).toBe("running");
  });

  it("at start, a run that names this pid and has no marker is saved; while the server runs it is not", () => {
    make("r1", { pid: process.pid });
    expect(settle()).toEqual([]);
    expect(settle({ ownPidDead: true })).toEqual(["r1"]);
    agrees("r1");
  });

  it("tries a write that did not work again, also when its marker is gone", () => {
    const dir = make("r1");
    markRunning("r1");
    const first = sweepStaleRunning(runsDir, () => false);
    withRunStateLock(dir, () => expect(settle({ ids: first.markers })).toEqual([]), 0);
    expect(sweepStaleRunning(runsDir, () => false).markers).toEqual([]);
    expect(settle()).toEqual(["r1"]);
    agrees("r1");
  });

  const release = (id: string, day: number, o: Record<string, unknown> = {}) =>
    make(id, { flow: "release-daily", vars: { github_repo: "acme/app", chore_watcher: "rel" }, startedAt: `2026-01-0${day}T08:00:00.000Z`, ...o });
  const raw = (id: string) => JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));

  it("archives a dead release that a later release already did", () => {
    release("20260101-080000-aaaa", 1);
    release("20260102-080000-bbbb", 2, { status: "succeeded" });
    settle();
    expect(raw("20260101-080000-aaaa")).toMatchObject({ status: "failed", reason: RESTART_INTERRUPTED, archivedBy: SUPERSEDED_BY });
    expect(scheduler.queue().pending).toHaveLength(0);
  });

  it("also counts a later success of the same watcher that is kept in runs-archive", () => {
    release("20260101-080000-aaaa", 1);
    settleDeadRuns(scheduler, { log: () => undefined, retained: () => [{ runId: "kept", flow: "release-daily", status: "succeeded", startedAt: "2026-01-02T08:00:00.000Z", githubRepo: "acme/app", choreWatcher: "rel" }] });
    expect(raw("20260101-080000-aaaa").archivedBy).toBe(SUPERSEDED_BY);
  });

  it("does not archive a dead release that a release of another watcher on the same repository replaced", () => {
    make("20260101-080000-aaaa", { flow: "release-daily", vars: { github_repo: "acme/app", chore_watcher: "rel-a" }, startedAt: "2026-01-01T08:00:00.000Z" });
    make("20260102-080000-bbbb", { flow: "release-daily", vars: { github_repo: "acme/app", chore_watcher: "rel-b" }, startedAt: "2026-01-02T08:00:00.000Z", status: "succeeded" });
    settle();
    expect(raw("20260101-080000-aaaa")).toMatchObject({ status: "failed", reason: RESTART_INTERRUPTED });
    expect(raw("20260101-080000-aaaa")).not.toHaveProperty("archivedBy");
    // the same watcher's later success does replace it
    make("20260103-080000-cccc", { flow: "release-daily", vars: { github_repo: "acme/app", chore_watcher: "rel-a" }, startedAt: "2026-01-03T08:00:00.000Z", status: "succeeded" });
    archiveSupersededReleases(scheduler, { runId: "20260103-080000-cccc", flow: "release-daily", status: "succeeded", startedAt: "2026-01-03T08:00:00.000Z", vars: { github_repo: "acme/app", chore_watcher: "rel-a" } } as never);
    expect(raw("20260101-080000-aaaa").archivedBy).toBe(SUPERSEDED_BY);
    expect(raw("20260102-080000-bbbb")).not.toHaveProperty("archivedBy");
  });

  it("goes on after a run that fails, and never throws", () => {
    const stub: DeadRunScheduler = {
      staleRunIds: () => ["bad", "good"],
      markInterrupted: (id) => {
        if (id === "bad") throw new Error("boom");
        return { runId: id, flow: "quick", vars: {} } as never;
      },
      briefs: () => [],
      setArchived: () => "done",
    };
    expect(settleDeadRuns(stub, { log: (m) => lines.push(m) })).toEqual(["good"]);
    expect(lines[0]).toContain("could not save run bad");
    const broken: DeadRunScheduler = {
      ...stub,
      staleRunIds: () => {
        throw new Error("no list");
      },
    };
    expect(settleDeadRuns(broken, { log: () => undefined })).toEqual([]);
  });
});
