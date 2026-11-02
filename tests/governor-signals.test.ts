import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cpuBusy, cpuTimes, decide, loadState, parseSwap, parseTherm, runGovernor, throttleReason, type CpuTimes, type Decision, type GovernorState, type Sample } from "../src/ops/governor.js";

const T0 = new Date(2026, 9, 20, 9, 0);
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const START: CpuTimes = { idle: 1_000_000, total: 2_000_000 };

/** Counters for a series of checks: each step adds 100 000 ms in total, of which `busy` is not idle. */
function cpuSeq(busy: number[], start: CpuTimes = START): CpuTimes[] {
  let c = start;
  return busy.map((b) => (c = { total: c.total + 100_000, idle: c.idle + (1 - b) * 100_000 }));
}

const smp = (load1: number, load5: number, extra: Partial<Sample> = {}): Sample => ({ load1, load5, load15: load5, pressure: 1, ...extra });

/** Feeds samples one minute apart; the first state may carry the counters of the previous check. */
function feed(state: GovernorState, samples: Sample[], configured = 4, start = 0) {
  const changes: string[] = [];
  let d: Decision = { state };
  samples.forEach((x, i) => {
    d = decide(d.state, x, configured, at(start + i));
    if (d.change?.startsWith("runs at once")) changes.push(d.change);
  });
  return { d, changes };
}

const withCpu = (load1: number, load5: number, busy: number[], extra: Partial<Sample> = {}) =>
  cpuSeq(busy).map((cpu) => smp(load1, load5, { cpu, ...extra }));
const base: GovernorState = { calm: 0, cpu: START };

describe("cpuTimes and cpuBusy", () => {
  it("sums over cores", () => {
    const core = (idle: number) => ({ times: { user: 10, nice: 0, sys: 5, idle, irq: 0 } });
    expect(cpuTimes([core(100), core(200)])).toEqual({ idle: 300, total: 330 });
    expect(cpuTimes([])).toBeUndefined();
  });

  it("gives the busy share between two readings", () => {
    expect(cpuBusy({ idle: 0, total: 0 }, { idle: 75_000, total: 100_000 })).toBeCloseTo(0.25);
    expect(cpuBusy(undefined, START)).toBeUndefined();
    expect(cpuBusy(START, START)).toBeUndefined();
    expect(cpuBusy(START, { idle: 10, total: 100 })).toBeUndefined();
    expect(cpuBusy(START, { idle: START.idle + 200, total: START.total + 100 })).toBeUndefined();
  });
});

describe("parsers", () => {
  it("parseSwap", () => {
    expect(parseSwap("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)")).toBe(1024.5);
    expect(parseSwap("total = 0.00M  used = 0.00M  free = 0.00M")).toBe(0);
    expect(parseSwap("total = 4.00G  used = 1.50G  free = 2.50G")).toBe(1536);
    for (const bad of ["", "sysctl: unknown oid 'vm.swapusage'", "used = abcM"]) expect(parseSwap(bad)).toBeUndefined();
  });

  it("parseTherm", () => {
    const none = "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded";
    expect(parseTherm(none)).toEqual({ speedLimit: 100, warning: 0 });
    const limited = "CPU Power notify\n  CPU_Scheduler_Limit \t= 100\n  CPU_Available_CPUs \t= 8\n  CPU_Speed_Limit \t= 70";
    expect(parseTherm(limited)).toEqual({ speedLimit: 70, warning: 0 });
    expect(parseTherm("CPU_Scheduler_Limit = 50\nCPU_Speed_Limit = 100")).toEqual({ speedLimit: 50, warning: 0 });
    expect(parseTherm("Thermal warning level set to 2.")).toEqual({ speedLimit: 100, warning: 2 });
    expect(parseTherm("")).toBeUndefined();
    expect(parseTherm("pmset: command not found")).toBeUndefined();
  });

  it("throttleReason", () => {
    expect(throttleReason(undefined)).toBeUndefined();
    expect(throttleReason({ speedLimit: 100, warning: 0 })).toBeUndefined();
    expect(throttleReason({ speedLimit: 70, warning: 0 })).toBe("throttled: CPU speed limit 70%");
    expect(throttleReason({ speedLimit: 100, warning: 2 })).toBe("throttled: thermal warning level 2");
  });
});

describe("decide with the CPU", () => {
  it("a high load on an idle CPU lowers nothing", () => {
    const r = feed(base, withCpu(3, 3, [0.2, 0.2, 0.2, 0.2, 0.2]));
    expect(r.changes).toEqual([]);
    expect(r.d.state.hot).toBeUndefined();
    expect(r.d.state.tests).toBeUndefined();
    const e = decide(base, smp(5, 5, { cpu: cpuSeq([0.2])[0]! }), 4, at(0));
    expect(e.state.tests).toBeUndefined();
  });

  it("the same load on a busy CPU lowers the cap and names the CPU", () => {
    const r = feed(base, withCpu(3, 3, [0.9]));
    expect(r.changes).toEqual(["runs at once 4 → 3 (load 3.0 per core over 5 minutes, CPU 90% busy)"]);
  });

  it("the first check, with no previous reading, uses the load rules", () => {
    const d = decide({ calm: 0 }, smp(3, 3, { cpu: START }), 4, at(0));
    expect(d.state.runs).toBe(3);
    expect(d.state.cpu).toEqual(START);
  });

  it("a band load on an idle CPU is calm, also for the last step", () => {
    const prev: GovernorState = { ...base, runs: 3, changedAt: at(-60).toISOString() };
    const r = feed(prev, withCpu(1.8, 1.8, [0.3, 0.3, 0.3, 0.3, 0.3]));
    expect(r.changes).toEqual(["runs at once 3 → 4 (calm: load 1.8 per core, CPU 30% busy)"]);
    expect(r.d.state.runs).toBeUndefined();
  });

  it("a band load on a half busy CPU, or with no CPU figure, never steps up", () => {
    const prev: GovernorState = { ...base, runs: 3, changedAt: at(-60).toISOString() };
    expect(feed(prev, withCpu(1.8, 1.8, Array(8).fill(0.7))).changes).toEqual([]);
    expect(feed({ calm: 0, runs: 3, changedAt: prev.changedAt }, Array(8).fill(smp(1.8, 1.8))).changes).toEqual([]);
  });

  it("sustained CPU saturation at a low load neither lowers nor raises the cap", () => {
    const prev: GovernorState = { ...base, runs: 3, changedAt: at(-60).toISOString() };
    const r = feed(prev, withCpu(1.0, 1.0, Array(10).fill(0.95)));
    expect(r.changes).toEqual([]);
    expect(r.d.state.runs).toBe(3);
    expect(r.d.state.hot).toBeUndefined();
  });

  it("a busy CPU stops calm counting even with a low load, with and without a measurement", () => {
    const prev: GovernorState = { ...base, runs: 3, changedAt: at(-60).toISOString() };
    expect(feed(prev, withCpu(1.0, 1.0, Array(8).fill(0.95))).changes).toEqual([]);
    const measured = { cores: 16, other: 0, perRun: 2 };
    expect(feed(prev, withCpu(1.0, 1.0, Array(8).fill(0.95), { measured })).changes).toEqual([]);
    expect(feed(prev, withCpu(1.0, 1.0, Array(8).fill(0.3), { measured })).changes).toHaveLength(1);
  });
});

describe("decide: throttled and swapping", () => {
  const hotChip = "throttled: CPU speed limit 70%";

  it("three throttled checks in a row lower the cap with the reason", () => {
    const r = feed({ calm: 0 }, Array(3).fill(smp(0.5, 0.5, { throttled: hotChip })));
    expect(r.changes).toEqual([`runs at once 4 → 3 (${hotChip})`]);
    expect(feed({ calm: 0 }, [0, 1, 3, 4, 5].map((i) => smp(0.5, 0.5, i === 3 ? {} : { throttled: hotChip }))).changes).toEqual([]);
  });

  it("swap that keeps growing lowers the cap; steady or shrinking swap does not", () => {
    const grow = [1100, 1200, 1300].map((swapMb) => smp(0.5, 0.5, { swapMb }));
    const r = feed({ calm: 0, swapMb: 1000 }, grow);
    expect(r.changes).toEqual(["runs at once 4 → 3 (swapping: swap grew by 100 MB)"]);
    expect(feed({ calm: 0, swapMb: 5000 }, Array(6).fill(smp(0.5, 0.5, { swapMb: 5000 }))).changes).toEqual([]);
    expect(feed({ calm: 0, swapMb: 5000 }, [4800, 4600, 4400].map((swapMb) => smp(0.5, 0.5, { swapMb }))).changes).toEqual([]);
  });

  it("a check without swap figure resets the count and the stored swap", () => {
    const d1 = decide({ calm: 0, swapMb: 1000, strain: 2 }, smp(0.5, 0.5), 4, at(0));
    expect(d1.state.strain).toBeUndefined();
    expect(d1.state.swapMb).toBeUndefined();
  });

  it("throttling stops calm checks and steps up", () => {
    const prev: GovernorState = { calm: 4, runs: 3, changedAt: at(-60).toISOString() };
    const d = decide(prev, smp(0.5, 0.5, { throttled: hotChip }), 4, at(0));
    expect(d.state.calm).toBe(0);
    expect(d.state.runs).toBe(3);
    expect(d.state.strain).toBe(1);
  });

  it("with a measurement the reason is named next to the runs that fit", () => {
    const measured = { cores: 16, other: 0, perRun: 2 };
    const d = decide({ calm: 0, strain: 2 }, smp(0.5, 0.5, { throttled: hotChip, measured }), 4, at(0));
    expect(d.change).toBe(`runs at once 4 → 3 (7 runs fit, ${hotChip})`);
    const over = decide({ calm: 0, over: 2, strain: 2 }, smp(0.5, 0.5, { throttled: hotChip, measured: { cores: 4, other: 2, perRun: 2 } }), 4, at(0));
    expect(over.change).toContain("0 runs fit");
    expect(over.change).toContain(hotChip);
  });

  it("an emergency is named first", () => {
    const d = decide({ calm: 0, strain: 2 }, smp(0.5, 0.5, { pressure: 4, throttled: hotChip }), 4, at(0));
    expect(d.change?.startsWith("runs at once 4 → 3 (memory pressure critical")).toBe(true);
  });
});

describe("old samples", () => {
  it("leave no trace of the new fields in the state", () => {
    const r = feed({ calm: 0 }, Array(3).fill(smp(2.8, 1.6)));
    expect(r.changes).toEqual(["runs at once 4 → 3 (load 2.8 per core for 3 checks)"]);
    expect(Object.keys(r.d.state)).not.toEqual(expect.arrayContaining(["cpu"]));
    expect(r.d.state).not.toHaveProperty("swapMb");
    expect(r.d.state).not.toHaveProperty("strain");
  });
});

describe("loadState", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "gov-signals-"));
    dirs.push(d);
    return d;
  };
  const run = (d: string, sample: Sample, now = T0) => runGovernor({ dir: d, slotsDir: join(d, "slots"), capsFile: join(d, "caps.json"), configured: 4, now, sample });

  it("keeps cpu, swapMb and strain", () => {
    const d = dir();
    run(d, smp(0.5, 0.5, { cpu: START, swapMb: 100, throttled: "throttled: CPU speed limit 70%" }));
    expect(loadState(d, T0)).toMatchObject({ cpu: START, swapMb: 100, strain: 1 });
  });

  it("drops values of the wrong shape", () => {
    const bad: Partial<Record<keyof GovernorState, unknown>>[] = [{ cpu: "x" }, { cpu: { idle: -1, total: 5 } }, { cpu: { idle: 6, total: 5 } }, { swapMb: -3 }, { swapMb: "x" }, { strain: "x" }];
    for (const b of bad) {
      const d = dir();
      run(d, smp(0.5, 0.5));
      const file = join(d, "state.json");
      const cur = JSON.parse(require_read(file));
      writeJson(file, { ...cur, ...b });
      const s = loadState(d, T0);
      expect(s).not.toHaveProperty("cpu");
      expect(s).not.toHaveProperty("swapMb");
      expect(s).not.toHaveProperty("strain");
    }
  });
});

import { readFileSync, writeFileSync } from "node:fs";
function require_read(p: string): string {
  return readFileSync(p, "utf8");
}
function writeJson(p: string, v: unknown) {
  writeFileSync(p, JSON.stringify(v));
}
