import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { setCap } from "./caps.js";
import { localDay } from "./digest.js";

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
  /** Checks in a row in which the 1-minute load was above `high`. Absent: 0. */
  hot?: number;
  /** When the cap on runs last moved (ISO time). Kept only while a pause after a change can still hold. */
  changedAt?: string;
  /** When this was decided. A state older than the hold time says nothing about the machine now. */
  at?: string;
}

export interface Settings {
  /** Load per core above which the cap may go one down. */
  high: number;
  /** Load per core at or below which the machine counts as calm. */
  low: number;
  /** Load per core above which only one test run may work at a time. This is an emergency: it acts at once. */
  testsHigh: number;
  /** Calm checks in a row before the cap goes one up. */
  calmChecks: number;
  /** Checks in a row without load (calm or in between `low` and `high`) before the cap goes one up all the same. */
  coolChecks: number;
  /** The cap never goes below this; 0: half of the configured number (at least 2). */
  floor: number;
  /** Checks in a row with the 1-minute load above `high` before the cap goes down (a spike is shorter). */
  hotChecks: number;
  /** Minutes after the cap moved before it may go up. */
  settleMinutes: number;
  /** Minutes after the cap moved before it may go further down. */
  downPauseMinutes: number;
}

export const DEFAULTS: Settings = { high: 2.5, low: 1.2, testsHigh: 4, calmChecks: 5, coolChecks: 15, floor: 0, hotChecks: 3, settleMinutes: 10, downPauseMinutes: 3 };

export interface Decision { state: GovernorState; change?: string }

/**
 * One step at a time. Sustained load (5-minute load above `high`, or the 1-minute load above `high` for
 * `hotChecks` checks in a row): one run fewer (running work is never stopped, only new starts wait). A spike of
 * a minute or two moves nothing. An emergency (memory pressure critical, 1-minute load above `testsHigh`) acts at
 * once. After the cap moved there is no step down for `downPauseMinutes` and no step up for `settleMinutes`,
 * except for an emergency. Calm for a while: one run more, until the configured number is back and the cap goes
 * away. In between (load between `low` and `high`) nothing moves at first, but after `coolChecks` checks in a row
 * without load the cap goes one up as well, once the pause is over. Memory pressure "warning" alone is no reason
 * to go down (macOS reports it for hours on a full but idle machine). Very high load: one test run at a time,
 * because tests are what loads the machine most. `now` is the time of the check.
 */
export function decide(prev: GovernorState, s: Sample, configured: number, now: Date, set: Settings = DEFAULTS): Decision {
  const floor = Math.min(configured, set.floor >= 1 ? set.floor : Math.max(2, Math.ceil(configured / 2)));
  // a stored cap above the configured number is no cap: the number was lowered in the settings meanwhile
  const have = Math.min(prev.runs ?? configured, configured);
  const critical = s.pressure >= 4;
  const emergency = critical || s.load1 > set.testsHigh;
  const hot = s.load1 > set.high ? (prev.hot ?? 0) + 1 : 0;
  const sustained = s.load5 > set.high || hot >= set.hotChecks;
  const loaded = emergency || s.load1 > set.high || s.load5 > set.high;
  const changed = Date.parse(prev.changedAt ?? "");
  const t = now.getTime();
  // no time, an unreadable time or one in the future (the clock moved back): no pause
  const age = Number.isFinite(changed) && changed <= t ? t - changed : Infinity;
  const tests = emergency ? 1 : undefined;
  const why = critical ? "memory pressure critical" : s.load1 > set.testsHigh ? `load ${s.load1.toFixed(1)} per core` : s.load5 > set.high ? `load ${s.load5.toFixed(1)} per core over 5 minutes` : `load ${s.load1.toFixed(1)} per core for ${hot} checks`;
  const notes: string[] = [];
  let runs = have;
  let calm = 0;
  let cool = 0;
  let moved = false;
  if (loaded) {
    if (have > floor && (emergency || (sustained && age >= set.downPauseMinutes * 60_000))) {
      runs = have - 1;
      moved = true;
      notes.push(`runs at once ${have} → ${runs} (${why})`);
    }
  } else {
    const isCalm = s.load1 <= set.low && s.load5 <= set.low;
    calm = isCalm ? prev.calm + 1 : 0;
    cool = (prev.cool ?? 0) + 1;
    const up = calm >= set.calmChecks ? `calm: load ${s.load5.toFixed(1)} per core` : cool >= set.coolChecks ? `no load for ${cool} checks: load ${s.load1.toFixed(1)} per core` : "";
    if (up && have >= configured) calm = cool = 0;
    else if (up && age >= set.settleMinutes * 60_000) {
      runs = have + 1;
      moved = true;
      notes.push(`runs at once ${have} → ${runs} (${up})`);
      calm = cool = 0;
    }
    // held by the pause: the counts go on, and the step comes when the pause is over
  }
  if (tests !== prev.tests) notes.push(tests ? `test runs at once → 1 (${critical ? "memory pressure critical" : `load ${s.load1.toFixed(1)} per core`})` : "test runs at once: back to normal");
  const keep = Number.isFinite(changed) && age < Math.max(set.settleMinutes, set.downPauseMinutes) * 60_000 ? changed : undefined;
  const stamp = moved ? t : keep;
  const state: GovernorState = {
    calm,
    ...(cool ? { cool } : {}),
    ...(hot ? { hot } : {}),
    ...(runs < configured ? { runs } : {}),
    ...(tests ? { tests } : {}),
    ...(stamp !== undefined ? { changedAt: new Date(stamp).toISOString() } : {}),
  };
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
    return { calm: Number(s.calm) || 0, ...(Number(s.cool) > 0 ? { cool: Number(s.cool) } : {}), ...(Number(s.hot) > 0 ? { hot: Number(s.hot) } : {}), ...(Number.isInteger(s.runs) ? { runs: s.runs } : {}), ...(s.tests ? { tests: 1 } : {}), ...(typeof s.changedAt === "string" && Number.isFinite(Date.parse(s.changedAt)) ? { changedAt: s.changedAt } : {}) };
  } catch {
    return { calm: 0 };
  }
}

/** One check: measure, decide, write the caps, log a change. `dir` is <data folder>/governor. */
export function runGovernor(o: { dir: string; slotsDir: string; capsFile: string; configured: number; now: Date; sample: Sample; settings?: Settings }): Decision {
  mkdirSync(o.dir, { recursive: true });
  const d = decide(loadState(o.dir, o.now), o.sample, o.configured, o.now, o.settings);
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

/** More changes than this in a day is worth a line in the digest. */
export const MANY_CHANGES = 20;

const CHUNK = 64_000;

/**
 * How many changes the governor logged today (local time of `now`). Reads changes.log from the end, one chunk at a
 * time, and stops at the first line of an earlier day: the log grows forever. 0 when it cannot be read.
 */
export function changesToday(dir: string, now: Date): number {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, "changes.log"), "r");
    const today = localDay(now);
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let n = 0;
    while (pos > 0) {
      const size = Math.min(CHUNK, pos);
      pos -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, pos);
      const lines = Buffer.concat([chunk, carry]).toString("utf8").split("\n");
      // the first line may be cut at the start of the chunk: it is read again with the next one
      carry = pos > 0 ? Buffer.from(lines.shift()!, "utf8") : Buffer.alloc(0);
      for (let i = lines.length - 1; i >= 0; i--) {
        const at = Date.parse(lines[i]!.slice(0, 24));
        if (!Number.isFinite(at)) continue;
        const day = localDay(new Date(at));
        if (day === today) n++;
        else if (day < today) return n;
      }
    }
    return n;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Take away everything the governor set. */
export function clearGovernor(dir: string, slotsDir: string, capsFile: string) {
  rmSync(join(slotsDir, "cap"), { force: true });
  rmSync(join(dir, "state.json"), { force: true });
  setCap("load", undefined, capsFile);
}
