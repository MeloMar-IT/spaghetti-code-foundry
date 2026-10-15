import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { cancelStoppedRun } from "../src/engine/runner.js";
import { isStoppedCancel, saveRun, setRunParked, STOPPED_CANCEL_REASON, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";

describe("cancelling a stopped run, and the parked mark", () => {
  let dir: string;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 1 });
  const runsDir = () => join(dir, "runs");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cancel-stopped-"));
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin: "unused" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plant = (id: string, status: RunSummary["status"], reason?: string): RunSummary => {
    const runDir = join(runsDir(), id);
    mkdirSync(runDir, { recursive: true });
    const s = {
      runId: id, flow: "issue-deliver", task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: "/x", status, reason, runDir,
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [],
      flowDef: { name: "issue-deliver", steps: [] }, state: { next: "send_back", steps: {}, visits: {} },
    } as unknown as RunSummary;
    saveRun(s);
    return s;
  };
  const asked = 'stopped at step "send_back"';

  it("cancels a stopped run once, with the reason that sets it apart", () => {
    plant("r1", "stopped", asked);
    expect(scheduler.cancel("r1")).toBe(true);
    const s = scheduler.get("r1")!;
    expect(s.status).toBe("cancelled");
    expect(s.reason).toBe(STOPPED_CANCEL_REASON);
    expect(isStoppedCancel(s.reason)).toBe(true);
    expect(s.finishedAt).not.toBe("2026-01-01T00:01:00.000Z");
    expect(scheduler.cancel("r1")).toBe(false);
  });

  it("leaves finished runs alone", () => {
    plant("ok", "succeeded");
    plant("bad", "failed", "step failed");
    expect(scheduler.cancel("ok")).toBe(false);
    expect(scheduler.cancel("bad")).toBe(false);
    expect(scheduler.get("ok")?.status).toBe("succeeded");
    expect(scheduler.get("bad")?.status).toBe("failed");
    expect(cancelStoppedRun(runsDir(), "ok", config)).toBeUndefined();
    expect(cancelStoppedRun(runsDir(), "missing", config)).toBeUndefined();
  });

  it("a queued resume of a stopped run is only dropped", () => {
    plant("r2", "stopped", asked);
    const busy = new Scheduler({ runsDir: runsDir(), config: () => ({ ...config, concurrency: 0 }), claudeBin: "unused" });
    busy.submit({ kind: "resume", runId: "r2" });
    expect(busy.isQueued("r2")).toBe(true);
    expect(busy.cancel("r2")).toBe(true);
    expect(busy.isQueued("r2")).toBe(false);
    expect(busy.get("r2")?.status).toBe("stopped");
    // a second cancel, with nothing queued, cancels the stopped run
    expect(busy.cancel("r2")).toBe(true);
    expect(busy.get("r2")).toMatchObject({ status: "cancelled", reason: STOPPED_CANCEL_REASON });
  });

  it("setParked writes the mark once, keeps the file time, and refuses a run that is queued", () => {
    const s = plant("r3", "stopped", asked);
    const file = join(s.runDir, "run.json");
    const t = new Date("2026-02-02T02:02:02.000Z");
    utimesSync(file, t, t);
    expect(scheduler.setParked("r3")).toBe(true);
    expect(scheduler.get("r3")?.parkedAt).toBeTruthy();
    expect(Math.round(statSync(file).mtimeMs)).toBe(t.getTime());
    expect(scheduler.setParked("r3")).toBe(false);

    plant("r4", "stopped", asked);
    const busy = new Scheduler({ runsDir: runsDir(), config: () => ({ ...config, concurrency: 0 }), claudeBin: "unused" });
    busy.submit({ kind: "resume", runId: "r4" });
    expect(busy.setParked("r4")).toBe(false);
    expect(busy.get("r4")?.parkedAt).toBeUndefined();
  });

  it("setRunParked marks only a stopped or cancelled run", () => {
    const ok = plant("done", "succeeded");
    const running = plant("go", "running");
    const stopped = plant("st", "stopped", asked);
    const cancelled = plant("ca", "cancelled", STOPPED_CANCEL_REASON);
    expect(setRunParked(ok.runDir, "2026-03-03T00:00:00.000Z")).toBe(false);
    expect(setRunParked(running.runDir, "2026-03-03T00:00:00.000Z")).toBe(false);
    expect(setRunParked(stopped.runDir, "2026-03-03T00:00:00.000Z")).toBe(true);
    expect(setRunParked(cancelled.runDir, "2026-03-03T00:00:00.000Z")).toBe(true);
    expect(setRunParked(join(runsDir(), "nowhere"), "2026-03-03T00:00:00.000Z")).toBe(false);
  });
});
