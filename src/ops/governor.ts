import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { setCap } from "./caps.js";

/** What the governor measures each minute. */
export interface Sample {
  /** Load average over 1 and 5 minutes, divided by the number of cores. */
  load1: number;
  load5: number;
  /** macOS memory pressure: 1 normal, 2 warning, 4 critical. 1 where it cannot be read. */
  pressure: number;
}

export interface GovernorState {
  /** Runs allowed at once now; undefined: no cap (the configured number applies). */
  runs?: number;
  tests?: number;
  /** Checks in a row in which the machine was calm. */
  calm: number;
  /** Checks in a row in which it was not under load (calm or in between), since the cap last moved. */
  cool?: number;
  /** When this was decided. A state older than the hold time says nothing about the machine now. */
  at?: string;
}

export interface Settings {
  /** Load per core above which the cap goes one down, and at or below which the machine counts as calm. */
  high: number;
  low: number;
  /** Load per core above which only one test run may work at a time. */
  testsHigh: number;
  /** Calm checks in a row before the cap goes one up. */
  calmChecks: number;
  /** Checks in a row without load (calm or in between `low` and `high`) before the cap goes one up all the same. */
  coolChecks: number;
  /** The cap never goes below this; 0: half of the configured number (at least 2). */
  floor: number;
}

export const DEFAULTS: Settings = { high: 2.5, low: 1.5, testsHigh: 4, calmChecks: 5, coolChecks: 15, floor: 0 };

export interface Decision { state: GovernorState; change?: string }

/**
 * One step at a time. Too much load or memory pressure: one run fewer (running work is never stopped,
 * only new starts wait). Calm for a while: one run more, until the configured number is back and the
 * cap goes away. In between (load between `low` and `high`, or a memory warning without load) nothing
 * moves at first, but after `coolChecks` checks in a row without load the cap goes one up as well: a
 * cap must not stay for hours on a machine that is only a little busy. Memory pressure "warning" alone
 * is no reason to go down (macOS reports it for hours on a full but idle machine); with load above `low`
 * it is, and "critical" always is. Very high load: one test run at a time, because tests are what loads
 * the machine most.
 */
export function decide(prev: GovernorState, s: Sample, configured: number, set: Settings = DEFAULTS): Decision {
  const floor = Math.min(configured, set.floor >= 1 ? set.floor : Math.max(2, Math.ceil(configured / 2)));
  // a stored cap above the configured number is no cap: the number was lowered in the settings meanwhile
  const now = Math.min(prev.runs ?? configured, configured);
  const pressed = s.pressure >= 4 || (s.pressure >= 2 && s.load1 > set.low);
  const hot = s.load1 > set.high || pressed;
  const tests = s.load1 > set.testsHigh || s.pressure >= 4 ? 1 : undefined;
  const why = pressed ? `memory pressure ${s.pressure >= 4 ? "critical" : `warning, load ${s.load1.toFixed(1)} per core`}` : `load ${s.load1.toFixed(1)} per core`;
  const notes: string[] = [];
  let runs = now;
  let calm = 0;
  let cool = 0;
  if (hot) {
    if (now > floor) {
      runs = now - 1;
      notes.push(`runs at once ${now} → ${runs} (${why})`);
    }
  } else {
    const isCalm = s.load1 <= set.low && s.load5 <= set.low;
    calm = isCalm ? prev.calm + 1 : 0;
    cool = (prev.cool ?? 0) + 1;
    const up = calm >= set.calmChecks ? `calm: load ${s.load5.toFixed(1)} per core` : cool >= set.coolChecks ? `no load for ${cool} checks: load ${s.load1.toFixed(1)} per core` : "";
    if (up && now < configured) {
      runs = now + 1;
      notes.push(`runs at once ${now} → ${runs} (${up})`);
    }
    if (up) calm = cool = 0;
  }
  if (tests !== prev.tests) notes.push(tests ? `test runs at once → 1 (${s.pressure >= 4 ? "memory pressure critical" : `load ${s.load1.toFixed(1)} per core`})` : "test runs at once: back to normal");
  const state: GovernorState = { calm, ...(cool ? { cool } : {}), ...(runs < configured ? { runs } : {}), ...(tests ? { tests } : {}) };
  return { state, ...(notes.length ? { change: notes.join("; ") } : {}) };
}

export function sample(): Sample {
  const cores = availableParallelism();
  const [l1, l5] = loadavg();
  let pressure = 1;
  try {
    pressure = Number(execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || 1;
  } catch {
    // not macOS
  }
  return { load1: l1! / cores, load5: l5! / cores, pressure };
}

/** How long a cap holds without a new check: three missed checks and the Foundry is free again. */
export const HOLD_MS = 4 * 60_000;

/**
 * What the last check decided. A state older than the hold time (the machine slept, the governor was stopped) is
 * not used: its caps have ended, and the first check after a night must not put yesterday's cap back.
 */
export function loadState(dir: string, now = new Date()): GovernorState {
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as GovernorState;
    const age = now.getTime() - Date.parse(s.at ?? "");
    if (!(age <= HOLD_MS)) return { calm: 0 };
    return { calm: Number(s.calm) || 0, ...(Number(s.cool) > 0 ? { cool: Number(s.cool) } : {}), ...(Number.isInteger(s.runs) ? { runs: s.runs } : {}), ...(s.tests ? { tests: 1 } : {}) };
  } catch {
    return { calm: 0 };
  }
}

/** One check: measure, decide, write the caps, log a change. `dir` is <data folder>/governor. */
export function runGovernor(o: { dir: string; slotsDir: string; capsFile: string; configured: number; now: Date; sample: Sample; settings?: Settings }): Decision {
  mkdirSync(o.dir, { recursive: true });
  const d = decide(loadState(o.dir, o.now), o.sample, o.configured, o.settings);
  writeFileSync(join(o.dir, "state.json"), JSON.stringify({ ...d.state, at: o.now.toISOString() }));
  try {
    setCap("load", d.state.runs ? { runs: d.state.runs, until: new Date(o.now.getTime() + HOLD_MS).toISOString(), why: "machine load" } : undefined, o.capsFile);
  } finally {
    // also when the cap on runs could not be written. Written again at every check while it holds: test-slot
    // ignores a cap file that was not touched for the hold time, so a governor that stopped cannot hold tests down.
    const capFile = join(o.slotsDir, "cap");
    if (d.state.tests) {
      mkdirSync(o.slotsDir, { recursive: true });
      writeFileSync(capFile, String(d.state.tests));
    } else rmSync(capFile, { force: true });
    if (d.change) appendFileSync(join(o.dir, "changes.log"), `${o.now.toISOString()} ${d.change}\n`);
  }
  return d;
}

/** Take away everything the governor set. */
export function clearGovernor(dir: string, slotsDir: string, capsFile: string) {
  rmSync(join(slotsDir, "cap"), { force: true });
  rmSync(join(dir, "state.json"), { force: true });
  setCap("load", undefined, capsFile);
}
