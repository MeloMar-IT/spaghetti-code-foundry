import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}

export interface Settings {
  /** Load per core above which the cap goes one down, and at or below which the machine counts as calm. */
  high: number;
  low: number;
  /** Load per core above which only one test run may work at a time. */
  testsHigh: number;
  /** Calm checks in a row before the cap goes one up. */
  calmChecks: number;
  /** The cap never goes below this; 0: half of the configured number (at least 2). */
  floor: number;
}

export const DEFAULTS: Settings = { high: 2.5, low: 1.5, testsHigh: 4, calmChecks: 5, floor: 0 };

export interface Decision { state: GovernorState; change?: string }

/**
 * One step at a time. Too much load or memory pressure: one run fewer (running work is never stopped,
 * only new starts wait). Calm for a while: one run more, until the configured number is back and the
 * cap goes away. Very high load: one test run at a time, because tests are what loads the machine most.
 */
export function decide(prev: GovernorState, s: Sample, configured: number, set: Settings = DEFAULTS): Decision {
  const floor = Math.min(configured, set.floor >= 1 ? set.floor : Math.max(2, Math.ceil(configured / 2)));
  const now = prev.runs ?? configured;
  const hot = s.load1 > set.high || s.pressure >= 2;
  const tests = s.load1 > set.testsHigh || s.pressure >= 4 ? 1 : undefined;
  const why = s.pressure >= 2 ? `memory pressure ${s.pressure >= 4 ? "critical" : "warning"}` : `load ${s.load1.toFixed(1)} per core`;
  const notes: string[] = [];
  let runs = now;
  let calm = 0;
  if (hot) {
    if (now > floor) {
      runs = now - 1;
      notes.push(`runs at once ${now} → ${runs} (${why})`);
    }
  } else if (s.load1 <= set.low && s.load5 <= set.low) {
    calm = prev.calm + 1;
    if (calm >= set.calmChecks && now < configured) {
      runs = now + 1;
      calm = 0;
      notes.push(`runs at once ${now} → ${runs} (calm: load ${s.load5.toFixed(1)} per core)`);
    }
  }
  if (tests !== prev.tests) notes.push(tests ? `test runs at once → 1 (${why})` : "test runs at once: back to normal");
  const state: GovernorState = { calm, ...(runs < configured ? { runs } : {}), ...(tests ? { tests } : {}) };
  return { state, ...(notes.length ? { change: notes.join("; ") } : {}) };
}

export function sample(): Sample {
  const cores = availableParallelism();
  const [l1, l5] = loadavg();
  let pressure = 1;
  try {
    pressure = Number(execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || 1;
  } catch {
    // not macOS
  }
  return { load1: l1! / cores, load5: l5! / cores, pressure };
}

export function loadState(dir: string): GovernorState {
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as GovernorState;
    return { calm: Number(s.calm) || 0, ...(Number.isInteger(s.runs) ? { runs: s.runs } : {}), ...(s.tests ? { tests: 1 } : {}) };
  } catch {
    return { calm: 0 };
  }
}

/** How long a cap holds without a new check: three missed checks and the Foundry is free again. */
export const HOLD_MS = 4 * 60_000;

/** One check: measure, decide, write the caps, log a change. `dir` is <data folder>/governor. */
export function runGovernor(o: { dir: string; slotsDir: string; capsFile: string; configured: number; now: Date; sample: Sample; settings?: Settings }): Decision {
  mkdirSync(o.dir, { recursive: true });
  const d = decide(loadState(o.dir), o.sample, o.configured, o.settings);
  writeFileSync(join(o.dir, "state.json"), JSON.stringify(d.state));
  setCap("load", d.state.runs ? { runs: d.state.runs, until: new Date(o.now.getTime() + HOLD_MS).toISOString(), why: "machine load" } : undefined, o.capsFile);
  const capFile = join(o.slotsDir, "cap");
  if (d.state.tests) {
    mkdirSync(o.slotsDir, { recursive: true });
    writeFileSync(capFile, String(d.state.tests));
  } else if (existsSync(capFile)) rmSync(capFile);
  if (d.change) appendFileSync(join(o.dir, "changes.log"), `${o.now.toISOString()} ${d.change}\n`);
  return d;
}

/** Take away everything the governor set. */
export function clearGovernor(dir: string, slotsDir: string, capsFile: string) {
  setCap("load", undefined, capsFile);
  rmSync(join(slotsDir, "cap"), { force: true });
  rmSync(join(dir, "state.json"), { force: true });
}
