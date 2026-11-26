import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { HEARTBEAT_FILE, heartbeatOf, parseHeartbeat, readHeartbeat, readyJobs, startHeartbeat, writeHeartbeat, type HeartbeatSource } from "../src/heartbeat.js";
import { Scheduler } from "../src/queue/scheduler.js";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const job = (o: object = {}) => ({ runId: "r", ...o }) as HeartbeatSource["queue"]["pending"][number];
const queue = (pending: HeartbeatSource["queue"]["pending"], active = 0, concurrency = 2) =>
  ({ pending, active: Array.from({ length: active }, (_, i) => ({ runId: `a${i}` })), concurrency }) as HeartbeatSource["queue"];
const source = (o: Partial<HeartbeatSource> = {}): HeartbeatSource => ({
  pid: 4343, supervisorPid: 4242, startedAt: "2026-11-26T10:00:00.000Z", queue: queue([job()]),
  pumpAt: "2026-11-26T11:00:00.000Z", lastStart: "2026-11-26T10:30:00.000Z", logAt: "2026-11-26T11:59:00.000Z",
  watchers: [{ every: "5m", lastTick: "2026-11-26T11:50:00.000Z" }, { every: "1h", lastTick: "2026-11-26T11:55:00.000Z" }, { every: "never" }],
  draining: false, restartWaits: false, ...o,
});

describe("heartbeat", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "scf-beat-"));
    dirs.push(d);
    return d;
  };

  it("counts only jobs that could start now", () => {
    const pending = [job(), job({ waitingFor: "x" }), job({ limit: "budget" }), job({ capped: true })];
    expect(readyJobs(queue(pending))).toBe(1);
    expect(readyJobs(queue(pending, 2))).toBe(0);
  });

  it("does not let architect runs and schedule chores fill the slots, as in the scheduler", () => {
    const pending = [job()];
    const active = (source: string) => ({ runId: "a", source }) as HeartbeatSource["queue"]["active"][number];
    const with1 = (...a: HeartbeatSource["queue"]["active"]) => ({ pending, active: a, concurrency: 1 }) as HeartbeatSource["queue"];
    expect(readyJobs(with1(active("refinement account-1 session")))).toBe(1);
    expect(readyJobs(with1(active("watcher w schedule")))).toBe(1);
    expect(readyJobs(with1(active("watcher w")))).toBe(0);
    expect(readyJobs(with1(active("watcher w"), active("refinement s")))).toBe(0);
  });

  it("holds the pids, the times, the newest watcher check and the shortest interval", () => {
    expect(heartbeatOf(source(), NOW)).toEqual({
      version: 1, at: NOW.toISOString(), pid: 4343, supervisorPid: 4242, startedAt: "2026-11-26T10:00:00.000Z",
      pumpAt: "2026-11-26T11:00:00.000Z", lastStart: "2026-11-26T10:30:00.000Z", watchAt: "2026-11-26T11:55:00.000Z",
      watchers: 3, watchEverySec: 300, logAt: "2026-11-26T11:59:00.000Z", ready: 1, readySince: NOW.toISOString(), pending: 1, active: 0, draining: false,
    });
  });

  it("keeps readySince while work stays ready, and has none ready while draining or a restart waits", () => {
    const before = "2026-11-26T11:00:00.000Z";
    expect(heartbeatOf(source(), NOW, before).readySince).toBe(before);
    for (const o of [{ draining: true }, { restartWaits: true }, { queue: queue([]) }]) {
      const hb = heartbeatOf(source(o), NOW, before);
      expect(hb.ready).toBe(0);
      expect(hb.readySince).toBeUndefined();
    }
  });

  it("reads back what it wrote, and knows a broken or newer file", () => {
    const dir = tmp();
    expect(readHeartbeat(dir)).toBeUndefined();
    const hb = heartbeatOf(source(), NOW);
    writeHeartbeat(dir, hb);
    expect(readHeartbeat(dir)).toEqual(hb);
    expect(existsSync(join(dir, `${HEARTBEAT_FILE}.tmp`))).toBe(false);
    expect(parseHeartbeat("{broken")).toBeUndefined();
    expect(parseHeartbeat("null")).toBeUndefined();
    expect(parseHeartbeat(JSON.stringify({ ...hb, pid: "1" }))).toBeUndefined();
    expect(parseHeartbeat(JSON.stringify({ ...hb, at: "soon" }))).toBeUndefined();
    expect(parseHeartbeat(JSON.stringify({ version: 2 }))).toBe("newer");
  });

  it("writes at once, beats the hook, and never throws", () => {
    const dir = tmp();
    let beats = 0;
    const stop = startHeartbeat({ dir, source, beat: () => void beats++, log: () => {}, everyMs: 3_600_000, now: () => NOW });
    stop();
    expect(beats).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, HEARTBEAT_FILE), "utf8")).at).toBe(NOW.toISOString());
    const file = join(dir, "not-a-folder");
    writeFileSync(file, "");
    const logs: string[] = [];
    startHeartbeat({ dir: file, source, log: (m) => logs.push(m), everyMs: 3_600_000 })();
    expect(logs).toEqual([expect.stringContaining("heartbeat: could not be written")]);
  });

  it("the scheduler knows when it last pumped", async () => {
    const dir = tmp();
    const s = new Scheduler({ runsDir: join(dir, "runs"), config: () => ConfigSchema.parse({}) });
    expect(s.lastPump()).toBeUndefined();
    await Promise.resolve(); // the first pump is a microtask
    const first = s.lastPump();
    expect(first).toBeDefined();
    s.drain();
    s.recheck();
    expect(s.lastPump()).toBe(first);
    let calls = 0;
    s.setStepGate(() => {
      calls++;
      return undefined;
    });
    expect(calls).toBe(1);
    s.close();
  });
});
