import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { makeRedactor } from "../src/credentials/redact.js";
import {
  loadMemoryRecord, markMemoryHanded, memoryFile, memoryRestartGapMs, MemoryWatch, RESTART_GAP_MS, restartOnGrowth, saveMemoryRecord,
  type MemoryRecord, type MemoryWatchOptions,
} from "../src/memory-watch.js";
import type { Names } from "../src/monitor/clean.js";
import { DETECTORS } from "../src/monitor/detectors.js";
import { storiesVerdict } from "../src/monitor/guard.js";
import { memoryTakenOver, Monitor } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { markerFor } from "../src/monitor/story.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { SafeRestart } from "../src/safe-restart.js";
import { RESTART_CODE } from "../src/supervise.js";
import { fakeGithub } from "./helpers/fake-github.js";

const T0 = new Date(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const MB = 1_048_576;
const at = (min: number) => new Date(T0.getTime() + min * MIN);

/** A watch with a fake memory reader (in MB) and a fake clock; every sample is one minute later. */
function watch(file: string, over: Partial<MemoryWatchOptions> = {}, limit = 100) {
  const s = { mb: 50, limit, minute: 0 };
  const grown: MemoryRecord[] = [];
  const lines: string[] = [];
  const w = new MemoryWatch({
    limitMb: () => s.limit, onGrowth: (r) => grown.push(r), log: (m) => lines.push(m), read: () => s.mb * MB, now: () => at(s.minute), file, ...over,
  });
  const take = (...mbs: number[]) => {
    for (const mb of mbs) {
      s.mb = mb;
      s.minute++;
      w.sample();
    }
  };
  return { w, s, grown, lines, take };
}

describe("MemoryWatch", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-"));
    file = join(dir, "memory-growth.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records the time and whole MB of the reader, and keeps the newest 60", () => {
    let bytes = 10.6 * MB;
    const w = new MemoryWatch({ limitMb: () => 0, onGrowth: () => {}, log: () => {}, read: () => bytes, now: () => T0, file });
    expect(w.sample()).toEqual({ at: T0.toISOString(), mb: 11 });
    for (let i = 1; i <= 69; i++) {
      bytes = i * MB;
      w.sample();
    }
    expect(w.samples()).toHaveLength(60);
    expect(w.samples()[0]!.mb).toBe(10);
    expect(w.samples().at(-1)!.mb).toBe(69);
  });

  it("needs three samples in a row above the limit", () => {
    const t = watch(file);
    t.take(50, 100, 100, 100, 101, 101, 100, 101, 101);
    expect(t.grown).toEqual([]);
    expect(loadMemoryRecord(file)).toBeUndefined();
    t.take(101);
    expect(t.grown).toHaveLength(1);
  });

  it("saves the newest 12 samples and reports one growth per process", () => {
    const t = watch(file);
    t.take(...Array(20).fill(50), 200, 201, 202);
    const rec = loadMemoryRecord(file)!;
    expect(rec).toEqual(t.grown[0]);
    expect(rec.limit_mb).toBe(100);
    expect(rec.at).toBe(at(23).toISOString());
    expect(rec.samples).toHaveLength(12);
    expect(rec.samples.at(-1)!.mb).toBe(202);
    t.take(...Array(10).fill(500));
    expect(t.grown).toHaveLength(1);
    expect(loadMemoryRecord(file)).toEqual(rec);
  });

  it("reads the limit at every sample; 0 turns the check off", () => {
    const t = watch(file, {}, 0);
    t.take(900, 900, 900, 900);
    expect(t.grown).toEqual([]);
    t.s.limit = 1000;
    t.take(900, 900, 900);
    expect(t.grown).toEqual([]);
    t.s.limit = 800;
    t.take(900, 900, 900);
    expect(t.grown).toHaveLength(1);
  });

  it("does not throw when the reader does", () => {
    const t = watch(file, { read: () => { throw new Error("no memory today"); } });
    expect(t.w.sample()).toBeUndefined();
    expect(t.w.samples()).toEqual([]);
  });

  it("tries a failed save again and asks for nothing until the samples are saved", () => {
    mkdirSync(file); // the file cannot be written over a folder
    const t = watch(file);
    t.take(200, 200, 200, 200, 50);
    expect(t.grown).toEqual([]);
    expect(t.lines.filter((l) => l.includes("could not be saved"))).toHaveLength(1);
    rmSync(file, { recursive: true });
    t.take(50);
    expect(t.grown).toHaveLength(1);
    // the samples of the growth, not the later ones
    expect(loadMemoryRecord(file)!.samples.map((s) => s.mb)).toEqual([200, 200, 200]);
    t.take(200, 200, 200);
    expect(t.grown).toHaveLength(1);
  });

  it("waits before it restarts again, over restarts of the server", () => {
    const first = watch(file);
    first.take(200, 200, 200);
    expect(first.grown).toHaveLength(1);

    const next = watch(file);
    next.take(...Array(20).fill(200));
    expect(next.grown).toEqual([]);
    expect(next.lines.filter((l) => l.includes("waits before it restarts again"))).toHaveLength(1);
    expect(loadMemoryRecord(file)).toEqual(first.grown[0]);
    next.s.minute = RESTART_GAP_MS / MIN + 10;
    next.take(200);
    expect(next.grown).toHaveLength(1);
  });

  it("does not wait for a saved time far in the future (the clock was set back)", () => {
    saveMemoryRecord({ at: at(24 * 60).toISOString(), limit_mb: 100, samples: [{ at: at(24 * 60).toISOString(), mb: 200 }] }, file);
    const t = watch(file);
    t.take(200, 200, 200);
    expect(t.grown).toHaveLength(1);
  });

  it("waits longer than the quiet time after a start", () => {
    expect(memoryRestartGapMs(10)).toBe(RESTART_GAP_MS);
    expect(memoryRestartGapMs(1440)).toBe(1500 * MIN);
  });
});

describe("the record of a memory growth", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const rec: MemoryRecord = { at: T0.toISOString(), limit_mb: 100, samples: [{ at: T0.toISOString(), mb: 200 }] };

  it("is read back; a missing, broken or wrong file is no record", () => {
    const file = join(dir, "sub", "r.json");
    expect(loadMemoryRecord(file)).toBeUndefined();
    saveMemoryRecord(rec, file);
    expect(loadMemoryRecord(file)).toEqual(rec);
    for (const text of ["{", "null", JSON.stringify({ ...rec, samples: [] }), JSON.stringify({ ...rec, host: "x" }), JSON.stringify({ ...rec, samples: [{ at: "x", mb: 1 }] })]) {
      writeFileSync(file, text);
      expect(loadMemoryRecord(file), text).toBeUndefined();
    }
  });

  it("lives in the data folder", () => {
    expect(memoryFile()).toBe(join(process.env.FACTORY_HOME!, "memory-growth.json"));
  });

  it("is marked as taken over only when it is still the same growth", () => {
    const file = join(dir, "r.json");
    saveMemoryRecord(rec, file);
    markMemoryHanded(at(5).toISOString(), at(6), file);
    expect(loadMemoryRecord(file)).toEqual(rec);
    markMemoryHanded(rec.at, at(6), file);
    expect(loadMemoryRecord(file)).toEqual({ ...rec, handed: at(6).toISOString() });
  });

  it("is taken over by an owed or a covering story, not by a closed one whose fix ran before the growth", () => {
    const story = { repo: "acme/app", issue: 1, url: "u", at: at(0).toISOString(), seen: 0 };
    const grown = at(100).toISOString();
    expect(memoryTakenOver({}, grown)).toBe(false);
    expect(memoryTakenOver({ due: grown }, grown)).toBe(true);
    expect(memoryTakenOver({ needsYou: grown }, grown)).toBe(true);
    expect(memoryTakenOver({ report: story }, grown)).toBe(true);
    expect(memoryTakenOver({ report: { ...story, closedAt: at(10).toISOString() } }, grown)).toBe(true);
    expect(memoryTakenOver({ report: { ...story, closedAt: at(10).toISOString(), clockAt: at(200).toISOString() } }, grown)).toBe(true);
    expect(memoryTakenOver({ report: { ...story, closedAt: at(10).toISOString(), clockAt: at(20).toISOString() } }, grown)).toBe(false);
  });

  it("has a limit setting with a default of 2048 MB", () => {
    expect(ConfigSchema.parse({}).server.memory_limit_mb).toBe(2048);
    expect(ConfigSchema.parse({ server: { memory_limit_mb: 0 } }).server.memory_limit_mb).toBe(0);
    for (const bad of [-1, 1.5, 2_000_000]) expect(ConfigSchema.safeParse({ server: { memory_limit_mb: bad } }).success, String(bad)).toBe(false);
  });
});

describe("the restart after a memory growth", () => {
  let dir: string;
  let r: SafeRestart;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-"));
  });
  afterEach(() => {
    r.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const setup = (supervised: boolean) => {
    const steps = new Map([["a", "push_develop"], ["b", "implement"]]);
    const interrupt = vi.fn(async (ids: string[]) => {
      for (const id of ids) steps.delete(id);
      return true;
    });
    const drain = vi.fn();
    const exit = vi.fn();
    const lines: string[] = [];
    r = new SafeRestart({
      scheduler: { queue: () => ({ active: [...steps.keys()].map((runId) => ({ runId })), pending: [], concurrency: 2 }) as never, currentStep: (id) => steps.get(id), interrupt, retryResumes: () => true },
      drain, exit, beforeExit: () => {}, log: (m) => lines.push(m), supervised: () => supervised,
    });
    const t = watch(join(dir, "r.json"), { onGrowth: restartOnGrowth(r, (m) => lines.push(m)) });
    return { steps, interrupt, drain, exit, lines, take: t.take };
  };

  it("waits for a push step, then interrupts the runs and exits for the supervisor", async () => {
    const t = setup(true);
    t.take(200, 200, 200, 200);
    expect(t.drain).toHaveBeenCalledTimes(1);
    expect(t.lines[0]).toContain("health: restart asked for (memory 200 MB is above the limit of 100 MB)");
    await r.tick();
    expect(t.interrupt).not.toHaveBeenCalled();
    expect(t.exit).not.toHaveBeenCalled();
    t.steps.set("a", "implement");
    await r.tick();
    expect(t.interrupt.mock.calls[0]![0]).toEqual(["a", "b"]);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(RESTART_CODE);
  });

  it("says that an unsupervised server cannot restart itself", () => {
    const t = setup(false);
    t.take(200, 200, 200);
    expect(t.drain).not.toHaveBeenCalled();
    expect(t.lines).toEqual(["health: memory 200 MB is above the limit of 100 MB; this server cannot restart itself: stop it and start it again"]);
  });
});

describe("the bug story of a memory growth (monitor checks)", () => {
  const TARGET = "acme/app";
  const NAMES: Names = { target: TARGET, users: ["Jane Doe"], emails: ["jane@acme.example"], repos: [], watchers: [], complete: true };
  const detector = DETECTORS.find((d) => d.name === "memory-growth")!;
  let gh: ReturnType<typeof fakeGithub>;
  let savedHome: string | undefined;
  let clock: number;

  beforeEach(() => {
    gh = fakeGithub();
    savedHome = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = join(gh.tmp, "home"); // a fresh record, guard file and log for every test
    clock = 0;
  });
  afterEach(() => {
    process.env.FACTORY_HOME = savedHome;
    gh.restore();
  });

  /** The monitor of one server process, with the real guard (the quiet time of 10 minutes after its start). */
  const monitor = (startedAt: Date) => {
    const cfg = () => ConfigSchema.parse({ monitor: { report_to: TARGET, report_limits: { per_day: 10, per_check: 3 } } }).monitor;
    const reporter = new Reporter({
      config: cfg, buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({}), guard: () => storiesVerdict({ startedAt, cooldownMinutes: cfg().cooldown_minutes, now: at(clock) }),
      mutes: () => [], record: () => {}, rateLimit: () => undefined, log: () => {}, clean: { redactor: () => makeRedactor([]), scan: async (t: string) => t },
    });
    return new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }), watchers: () => [], thresholds: cfg,
      log: () => {}, file: join(gh.tmp, "monitor-findings.json"), now: () => at(clock), reporter, detectors: [detector], guard: { startedAt },
    });
  };
  const check = async (m: Monitor, minute: number) => {
    clock = minute;
    await m.tick(true);
  };
  /** A server process whose memory is above the limit from its start. Returns the growths it restarts for. */
  const grow = (startMinute: number, samples = 3) => {
    const t = watch(memoryFile());
    t.s.minute = startMinute;
    t.take(...Array(samples).fill(200));
    return t.grown;
  };

  it("makes one story with the samples and no private text, also when the memory grows again", async () => {
    expect(grow(0)).toHaveLength(1);
    const m = monitor(at(-60));
    await check(m, 5);
    expect(gh.createdBodies()).toHaveLength(0);
    await check(m, 10);
    expect(gh.createdBodies()).toHaveLength(1);
    const { body } = gh.createdBodies()[0]!;
    expect(body).toContain(markerFor("memory-growth"));
    expect(body).toContain("Memory samples (MB):");
    expect(body).toContain(`${at(3).toISOString()}  200 MB`);
    for (const bad of [homedir(), hostname(), userInfo().username, "/Users/", gh.tmp]) expect(body).not.toContain(bad);
    expect(loadMemoryRecord()!.handed).toBeDefined();
    for (const min of [15, 20, 25]) await check(m, min);
    expect(grow(RESTART_GAP_MS / MIN + 30)).toHaveLength(1);
    for (const min of [400, 405, 410]) await check(m, min);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("still makes the story when the memory is high again after every restart", async () => {
    let restarts = 0;
    // each server lives 3 minutes if it restarts for its memory; one that waits stays up and its monitor looks every 5 minutes
    let start = 0;
    for (let process_ = 0; process_ < 5; process_++) {
      const grown = grow(start);
      const m = monitor(at(start));
      await check(m, start + 1);
      if (grown.length) {
        restarts++;
        start += 4;
        continue;
      }
      for (const min of [6, 11, 16]) await check(m, start + min);
      break;
    }
    expect(restarts).toBe(1);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("makes the story of a growth that could only be reported days later", async () => {
    grow(0);
    const later = 3 * 24 * 60;
    const quiet = monitor(at(later));
    await check(quiet, later + 1);
    await check(quiet, later + 2);
    expect(gh.createdBodies()).toHaveLength(0);
    expect(loadMemoryRecord()!.handed).toBeUndefined();
    await check(quiet, later + 11);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(loadMemoryRecord()!.handed).toBeDefined();
  });

  it("makes the story from samples that could be saved only at a later try", async () => {
    mkdirSync(memoryFile(), { recursive: true });
    const t = watch(memoryFile());
    t.take(200, 200, 200);
    expect(t.grown).toEqual([]);
    rmSync(memoryFile(), { recursive: true });
    t.take(50);
    const m = monitor(at(-60));
    await check(m, 5);
    await check(m, 10);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(gh.createdBodies()[0]!.body).toContain("200 MB");
  });
});
