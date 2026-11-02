import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { setCap } from "./caps.js";
import { localDay } from "./digest.js";

/** What the governor measures each minute. */
export interface Sample {
  /** Load average over 1, 5 and 15 minutes, divided by the number of cores. */
  load1: number;
  load5: number;
  load15: number;
  /** macOS memory pressure: 1 normal, 2 warning, 4 critical. 1 where it cannot be read. */
  pressure: number;
  /** What the usage check measured (part 4). Absent: no figures, and the rules of part 3 apply. */
  measured?: Measured;
  /** Cores of the machine. Absent: no worker number is decided */
  cores?: number;
}

/** The figures the target is worked out from. */
export interface Measured {
  /** Cores of the machine. */
  cores: number;
  /** Cores other programs use now. */
  other: number;
  /** Cores one run uses (see `coresPerRun`). */
  perRun: number;
}

export interface GovernorState {
  /** Runs allowed at once now; undefined: no cap (the configured number applies). */
  runs?: number;
  tests?: number;
  /** Workers per test run now; undefined: no limit. */
  workers?: number;
  /** Checks in a row in which the machine was calm. */
  calm: number;
  /** Checks in a row in which the 1-minute load was above `high`. Absent: 0. */
  hot?: number;
  /** Checks in a row in which the 1-minute load was above `testsHigh`. Absent: 0. */
  severe?: number;
  /** When test runs beyond the first were paused (ISO time); absent: none is paused. */
  paused?: string;
  /** Checks in a row in which the cap was above the runs that fit (with a measurement). Absent: 0. */
  over?: number;
  /** When the cap on runs last moved (ISO time). Kept only while a pause after a change can still hold. */
  changedAt?: string;
  /** When the cap on runs went down in the last hour (ISO times). */
  downs?: string[];
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
  /** The cap never goes below this (0 is allowed: nothing new starts); not set: half of the configured number (at least 2). Above the configured number it counts as that number. */
  floor?: number;
  /** Checks in a row with the 1-minute load above `high` before the cap goes down (a spike is shorter). */
  hotChecks: number;
  /** Minutes after the cap moved before it may go up; one more period for each step down in the last hour. */
  settleMinutes: number;
  /** Minutes after the cap moved before it may go further down. */
  downPauseMinutes: number;
  /** Cores kept free for other programs when the runs that fit are worked out. */
  reserveCores: number;
}

/** The file in the slots folder that tells tools/test-slot to pause the test runs beyond the first. */
export const PAUSE_FILE = "pause";

export const DEFAULTS: Settings = { high: 2.5, low: 1.2, testsHigh: 4, calmChecks: 5, hotChecks: 3, settleMinutes: 10, downPauseMinutes: 3, reserveCores: 2 };

/** With a measurement the cap goes down only when its runs use more than the free cores by this much (a figure that wobbles moves nothing). */
export const SLACK_CORES = 0.5;

/** Workers for a test run on a busy machine: half of vitest's default (half the cores), at least 2. */
export const testWorkers = (cores: number): number => Math.max(2, Math.floor(cores / 4));

const freeCores = (m: Measured, reserve: number) => Math.max(0, m.cores - m.other - reserve);

/** Runs that fit next to the other programs: free cores (cores − other programs − reserve) divided by what one run uses, rounded down. */
export function runsFit(m: Measured, reserve: number): number {
  return Math.max(0, Math.floor(freeCores(m, reserve) / m.perRun));
}

export const fitsText = (n: number): string => `${n} run${n === 1 ? " fits" : "s fit"}`;

/** How long a step down makes the next step up wait longer. */
export const DOWN_WINDOW_MS = 60 * 60_000;

/** The readable step-down times of the last hour. */
function recentDowns(list: unknown, t: number): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is string => {
    const at = typeof d === "string" ? Date.parse(d) : NaN;
    return at <= t && t - at < DOWN_WINDOW_MS;
  });
}

export interface Decision { state: GovernorState; change?: string }

/**
 * One step at a time. With a measurement (`s.measured`) the cap moves towards the runs that fit (`runsFit`): one run
 * fewer when it is above that number (and its runs use more than the free cores plus `SLACK_CORES`) for `hotChecks`
 * checks in a row, one more when it is below and the machine has been calm for `calmChecks` checks; the load alone does
 * not lower it then. Without a measurement: sustained load (5-minute load above `high`, or the 1-minute load above `high` for
 * `hotChecks` checks in a row): one run fewer (running work is never stopped, only new starts wait). A spike of
 * a minute or two moves nothing. An emergency (memory pressure critical, 1-minute load above `testsHigh`) acts at
 * once. After the cap moved there is no step down for `downPauseMinutes` and no step up for `settleMinutes`,
 * except for an emergency. Calm for a while: one run more, until the configured number is back and the cap goes
 * away. The 1- and 5-minute load must be at or below `low` for that; in between (load between `low` and `high`) the
 * cap never goes up. The last step back to the configured number also needs the 15-minute load below `low`. The
 * wait before a step up is `settleMinutes` plus one more period for each step down in the last hour. Memory pressure "warning" alone is no reason
 * to go down (macOS reports it for hours on a full but idle machine). Very high load: one test run at a time,
 * because tests are what loads the machine most. The cap goes down to the floor (`set.floor`, which may be 0: then
 * nothing new starts until the machine is calmer; not set: half of the configured number, at least 2). `now` is the time of the check.
 * Test workers: while the machine is loaded (1- or 5-minute load above `high`, or an emergency) each test run gets
 * `testWorkers(cores)` workers; the number stays while the load is between `low` and `high` and goes when the 1- and
 * 5-minute load are both at or below `low`. Without the cores (`s.cores`) none is decided.
 * Test runs beyond the first are paused (`state.paused`) when memory pressure is critical, or when the 1-minute load is above
 * `testsHigh` for `hotChecks` checks in a row. The pause ends when the pressure is not critical and the load is at or below
 * `high`; while it holds, only one test run may work at a time.
 */
export function decide(prev: GovernorState, s: Sample, configured: number, now: Date, set: Settings = DEFAULTS): Decision {
  const floor = Math.min(configured, set.floor ?? Math.max(2, Math.ceil(configured / 2)));
  // a stored cap above the configured number is no cap: the number was lowered in the settings meanwhile.
  // Below the floor is none either: the floor was raised meanwhile (silent, like the clamp above).
  const have = Math.max(floor, Math.min(prev.runs ?? configured, configured));
  const critical = s.pressure >= 4;
  const emergency = critical || s.load1 > set.testsHigh;
  const m = s.measured;
  const fit = m ? runsFit(m, set.reserveCores) : undefined;
  // with no free cores at all the slack does not apply: a run of any size is then over the target
  const overFree = m ? freeCores(m, set.reserveCores) : 0;
  const over = m && have > fit! && (overFree === 0 || have * m.perRun > overFree + SLACK_CORES) ? (prev.over ?? 0) + 1 : 0;
  const hot = s.load1 > set.high ? (prev.hot ?? 0) + 1 : 0;
  const sustained = s.load5 > set.high || hot >= set.hotChecks;
  const loaded = emergency || s.load1 > set.high || s.load5 > set.high;
  const changed = Date.parse(prev.changedAt ?? "");
  const t = now.getTime();
  let downs = recentDowns(prev.downs, t);
  const upWait = set.settleMinutes * 60_000 * (1 + downs.length);
  // no time, an unreadable time or one in the future (the clock moved back): no pause
  const age = Number.isFinite(changed) && changed <= t ? t - changed : Infinity;
  const severe = s.load1 > set.testsHigh ? (prev.severe ?? 0) + 1 : 0;
  const calmer = !critical && s.load1 <= set.high;
  const wasPaused = Boolean(prev.paused);
  const paused = prev.paused ? (calmer ? undefined : prev.paused) : critical || severe >= set.hotChecks ? now.toISOString() : undefined;
  const tests = emergency || paused ? 1 : undefined;
  const why = critical ? "memory pressure critical" : s.load1 > set.testsHigh ? `load ${s.load1.toFixed(1)} per core` : fit !== undefined ? fitsText(fit) : s.load5 > set.high ? `load ${s.load5.toFixed(1)} per core over 5 minutes` : `load ${s.load1.toFixed(1)} per core for ${hot} checks`;
  const notes: string[] = [];
  let runs = have;
  let calm = 0;
  let moved = false;
  const wantDown = m ? over >= set.hotChecks : sustained;
  if (have > floor && (emergency || (wantDown && age >= set.downPauseMinutes * 60_000))) {
    runs = have - 1;
    moved = true;
    downs = [...downs, now.toISOString()];
    notes.push(`runs at once ${have} → ${runs} (${why})`);
  } else if (!loaded) {
    calm = s.load1 <= set.low && s.load5 <= set.low && (fit === undefined || fit > have) ? prev.calm + 1 : 0;
    if (calm >= set.calmChecks) {
      if (have >= configured) calm = 0;
      else if (age >= upWait && (have + 1 < configured || s.load15 < set.low)) {
        runs = have + 1;
        moved = true;
        notes.push(`runs at once ${have} → ${runs} (calm: load ${s.load5.toFixed(1)} per core)`);
        calm = 0;
      }
      // held by the wait or the 15-minute load: the count goes on, and the step comes when they are over
    }
  }
  const cores = s.cores;
  const workers = cores === undefined ? undefined : loaded ? testWorkers(cores) : s.load1 <= set.low && s.load5 <= set.low ? undefined : prev.workers;
  if (workers !== prev.workers) notes.push(workers ? `test workers → ${workers} (${critical ? "memory pressure critical" : `load ${Math.max(s.load1, s.load5).toFixed(1)} per core`})` : "test workers: back to normal");
  if (tests !== prev.tests) notes.push(tests ? `test runs at once → 1 (${critical ? "memory pressure critical" : `load ${s.load1.toFixed(1)} per core`})` : "test runs at once: back to normal");
  if (paused && !wasPaused) notes.push(`test runs beyond the first paused (${critical ? "memory pressure critical" : `load ${s.load1.toFixed(1)} per core for ${severe} checks`})`);
  if (!paused && wasPaused) notes.push(`paused test runs go on (load ${s.load1.toFixed(1)} per core)`);
  const keep = Number.isFinite(changed) && age < Math.max(upWait, set.downPauseMinutes * 60_000) ? changed : undefined;
  const stamp = moved ? t : keep;
  const state: GovernorState = {
    calm,
    ...(downs.length ? { downs } : {}),
    ...(hot ? { hot } : {}),
    ...(severe ? { severe } : {}),
    ...(paused ? { paused } : {}),
    ...(over ? { over } : {}),
    ...(runs < configured ? { runs } : {}),
    ...(tests ? { tests } : {}),
    ...(workers ? { workers } : {}),
    ...(stamp !== undefined ? { changedAt: new Date(stamp).toISOString() } : {}),
  };
  return { state, ...(notes.length ? { change: notes.join("; ") } : {}) };
}

export function sample(): Sample {
  const cores = availableParallelism();
  const [l1, l5, l15] = loadavg();
  let pressure = 1;
  try {
    pressure = Number(execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || 1;
  } catch {
    // not macOS
  }
  return { load1: l1! / cores, load5: l5! / cores, load15: l15! / cores, pressure, cores };
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
    const downs = recentDowns(s.downs, now.getTime());
    return { calm: Number(s.calm) || 0, ...(downs.length ? { downs } : {}),...(Number(s.hot) > 0 ? { hot: Number(s.hot) } : {}), ...(Number(s.over) > 0 ? { over: Number(s.over) } : {}),...(Number(s.severe) > 0 ? { severe: Number(s.severe) } : {}),...(typeof s.paused === "string" && Number.isFinite(Date.parse(s.paused)) ? { paused: s.paused } : {}),...(Number.isInteger(s.runs) ? { runs: s.runs } : {}), ...(s.tests ? { tests: 1 } : {}), ...(Number.isInteger(s.workers) && s.workers! >= 1 ? { workers: s.workers } : {}), ...(typeof s.changedAt === "string" && Number.isFinite(Date.parse(s.changedAt)) ? { changedAt: s.changedAt } : {}) };
  } catch {
    return { calm: 0 };
  }
}

/** One check: measure, decide, write the caps, log a change. `dir` is <data folder>/governor. */
export function runGovernor(o: { dir: string; slotsDir: string; capsFile: string; configured: number; now: Date; sample: Sample; settings?: Settings; cause?: string }): Decision {
  mkdirSync(o.dir, { recursive: true });
  const d = decide(loadState(o.dir, o.now), o.sample, o.configured, o.now, o.settings);
  writeFileSync(join(o.dir, "state.json"), JSON.stringify({ ...d.state, at: o.now.toISOString() }));
  try {
    setCap("load", d.state.runs !== undefined ? { runs: d.state.runs, until: new Date(o.now.getTime() + HOLD_MS).toISOString(), why: "machine load" } : undefined, o.capsFile);
  } finally {
    // also when the cap on runs could not be written. Written again at every check while it holds: test-slot
    // ignores a cap file that was not touched for the hold time, so a governor that stopped cannot hold tests down.
    const capFile = join(o.slotsDir, "cap");
    if (d.state.tests) {
      mkdirSync(o.slotsDir, { recursive: true });
      writeFileSync(capFile, String(d.state.tests));
    } else rmSync(capFile, { force: true });
    const workersFile = join(o.slotsDir, "workers");
    if (d.state.workers) {
      mkdirSync(o.slotsDir, { recursive: true });
      writeFileSync(workersFile, String(d.state.workers));
    } else rmSync(workersFile, { force: true });
    // the pause is told the same way: rewritten at every check while it holds, so it goes stale when the governor stops
    const pauseFile = join(o.slotsDir, PAUSE_FILE);
    if (d.state.paused) {
      mkdirSync(o.slotsDir, { recursive: true });
      writeFileSync(pauseFile, `${d.state.paused}\n`);
    } else rmSync(pauseFile, { force: true });
    if (d.change) appendFileSync(join(o.dir, "changes.log"), `${o.now.toISOString()} ${d.change}${o.cause ? ` — ${o.cause}` : ""}\n`);
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
  rmSync(join(slotsDir, "workers"), { force: true });
  rmSync(join(slotsDir, PAUSE_FILE), { force: true });
  rmSync(join(dir, "state.json"), { force: true });
  setCap("load", undefined, capsFile);
}
