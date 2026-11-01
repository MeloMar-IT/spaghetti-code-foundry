import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCaps, runLimit } from "../src/ops/caps.js";
import { changesToday, DEFAULTS, HOLD_MS, decide, loadState, runGovernor, type Decision, type GovernorState, type Sample, type Settings } from "../src/ops/governor.js";

const T0 = new Date(2026, 9, 20, 9, 0);
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const s = (load1: number, load5: number, pressure = 1, load15 = load5): Sample => ({ load1, load5, load15, pressure });
const calm = s(0.5, 0.5);
const band = s(1.8, 1.8);

/** Feeds samples one minute apart from minute `start`; returns the last decision and the minutes with a runs change. */
function feed(state: GovernorState, samples: Sample[], configured = 4, start = 0, set: Settings = DEFAULTS) {
  const changes: number[] = [];
  let d: Decision = { state };
  samples.forEach((x, i) => {
    d = decide(d.state, x, configured, at(start + i), set);
    if (d.change?.startsWith("runs at once")) changes.push(start + i);
  });
  return { d, changes };
}

describe("decide: down", () => {
  it("does not lower the cap for a one- or two-minute spike", () => {
    const r = feed({ calm: 0 }, [s(2.6, 1.4), s(2.8, 1.6), calm]);
    expect(r.changes).toEqual([]);
    expect(r.d.state.runs).toBeUndefined();
  });

  it("lowers it after three hot checks in a row, and counts again after a calm one", () => {
    const hot = s(2.8, 1.6);
    const r = feed({ calm: 0 }, [hot, hot, hot]);
    expect(r.changes).toEqual([2]);
    expect(r.d.change).toBe("runs at once 4 → 3 (load 2.8 per core for 3 checks)");
    expect(r.d.state.changedAt).toBe(at(2).toISOString());
    expect(feed({ calm: 0 }, [hot, hot, calm, hot, hot]).changes).toEqual([]);
  });

  it("lowers it at once for a high 5-minute load", () => {
    const d = decide({ calm: 0 }, s(2.0, 2.7), 4, at(0));
    expect(d.state.runs).toBe(3);
    expect(d.change).toBe("runs at once 4 → 3 (load 2.7 per core over 5 minutes)");
  });

  it("acts at once in an emergency, also inside the pause and without hot checks", () => {
    const prev: GovernorState = { calm: 0, runs: 3, changedAt: at(0).toISOString() };
    expect(decide(prev, s(0.5, 0.5, 4), 4, at(1))).toMatchObject({ state: { runs: 2, tests: 1 }, change: "runs at once 3 → 2 (memory pressure critical); test runs at once → 1 (memory pressure critical)" });
    expect(decide(prev, s(4.5, 1.0), 4, at(1)).state).toMatchObject({ runs: 2, tests: 1 });
    // the floor (half of 4) still holds
    expect(decide({ calm: 0, runs: 2 }, s(4.5, 4.5), 4, at(1)).state.runs).toBe(2);
    expect(decide({ calm: 0 }, s(4.5, 4.5), 1, at(1)).state.runs).toBeUndefined();
  });

  it("goes down one step at a time and waits 3 minutes after a change, except in an emergency", () => {
    const sus = s(3, 3);
    const r = feed({ calm: 0 }, [sus, sus, sus, sus, sus, sus], 8);
    expect(r.changes).toEqual([0, 3]);
    expect(r.d.state.runs).toBe(6);
  });

  it("memory pressure warning alone, or with load below the sustained level, is no reason to go down", () => {
    expect(decide({ calm: 0 }, s(0.5, 0.5, 2), 4, at(0))).toEqual({ state: { calm: 1 } });
    expect(decide({ calm: 0 }, s(1.0, 2.0, 2), 4, at(0)).state.runs).toBeUndefined();
    expect(decide({ calm: 0 }, s(2, 3, 2), 4, at(0)).state.runs).toBe(3);
  });

  it("does not report a step from a number above the configured one", () => {
    expect(decide({ calm: 0, runs: 6 }, s(3, 3), 5, at(0))).toMatchObject({ state: { runs: 4 }, change: "runs at once 5 → 4 (load 3.0 per core over 5 minutes)" });
    expect(decide({ calm: 0, runs: 6 }, band, 5, at(0)).state).toEqual({ calm: 0 });
  });

  it("lowers the test cap with the load above testsHigh and lifts it again", () => {
    const d = decide({ calm: 0 }, s(5, 5), 6, at(0));
    expect(d.state).toMatchObject({ runs: 5, tests: 1 });
    expect(decide(d.state, s(3, 4), 6, at(1)).change).toContain("test runs at once: back to normal");
  });
});

describe("decide: up", () => {
  it("goes one up after five calm checks, but not within the settle time after a change", () => {
    const start: GovernorState = { calm: 0, runs: 3, changedAt: at(0).toISOString() };
    const r = feed(start, Array(15).fill(calm), 4, 1);
    expect(r.changes).toEqual([10]);
    expect(r.d.state.runs).toBeUndefined();
    // the cap is gone again at the configured number, and the counts start again
    expect(r.d.state.changedAt).toBe(at(10).toISOString());
  });

  it("moves one step up and resets the counts", () => {
    expect(decide({ calm: 4, runs: 3 }, calm, 6, at(0))).toMatchObject({ state: { calm: 0, runs: 4 }, change: "runs at once 3 → 4 (calm: load 0.5 per core)" });
    // in between: nothing moves, the calm count starts again
    expect(decide({ calm: 3, runs: 4 }, band, 6, at(0)).state).toEqual({ calm: 0, runs: 4 });
  });

  it("never goes up in the band, however many checks pass", () => {
    const r = feed({ calm: 0, runs: 3 }, Array(200).fill(band), 6);
    expect(r.changes).toEqual([]);
    expect(r.d.state).toEqual({ calm: 0, runs: 3 });
  });

  it("holds the last step while the 15-minute load is not below low, and takes it at once after", () => {
    const prev: GovernorState = { calm: 4, runs: 3 };
    const held = decide(prev, s(0.5, 0.5, 1, 1.2), 4, at(0));
    expect(held.state).toEqual({ calm: 5, runs: 3 });
    expect(held.change).toBeUndefined();
    const up = decide(held.state, s(0.5, 0.5, 1, 1.19), 4, at(1));
    expect(up.state.runs).toBeUndefined();
    expect(up.change).toBe("runs at once 3 → 4 (calm: load 0.5 per core)");
  });

  it("ignores the 15-minute load for the steps before the last", () => {
    expect(decide({ calm: 4, runs: 2 }, s(0.5, 0.5, 1, 2), 4, at(0)).state.runs).toBe(3);
    const f0: Settings = { ...DEFAULTS, floor: 0 };
    expect(decide({ calm: 4, runs: 0 }, s(0.5, 0.5, 1, 2), 2, at(0), f0).state.runs).toBe(1);
    expect(decide({ calm: 4, runs: 1 }, s(0.5, 0.5, 1, 2), 2, at(0), f0).state.runs).toBe(1);
  });

  it("waits one more period for each step down of the last hour", () => {
    const base: GovernorState = { calm: 4, runs: 3, changedAt: at(0).toISOString() };
    const one = { ...base, downs: [at(0).toISOString()] };
    expect(decide(one, calm, 6, at(19)).state.runs).toBe(3);
    expect(decide(one, calm, 6, at(20)).state.runs).toBe(4);
    const two = { ...base, downs: [at(-1).toISOString(), at(0).toISOString()] };
    expect(decide(two, calm, 6, at(29)).state.runs).toBe(3);
    expect(decide(two, calm, 6, at(30)).state.runs).toBe(4);
    // a step up keeps the list: the next one waits as well
    expect(decide(two, calm, 6, at(30)).state.downs).toEqual(two.downs);
  });

  it("goes back to the normal wait when the step downs are an hour old, and drops bad times", () => {
    const base: GovernorState = { calm: 4, runs: 3, changedAt: at(0).toISOString() };
    const old = decide({ ...base, downs: [at(-60).toISOString()] }, calm, 6, at(10));
    expect(old.state.runs).toBe(4);
    expect(old.state.downs).toBeUndefined();
    const young = decide({ ...base, downs: [at(-50).toISOString()] }, calm, 6, at(5));
    expect(young.state.downs).toEqual([at(-50).toISOString()]);
    expect(young.state.runs).toBe(3);
    const bad = decide({ ...base, downs: [at(15).toISOString(), "nonsense"] }, calm, 6, at(10));
    expect(bad.state.downs).toBeUndefined();
    expect(bad.state.runs).toBe(4);
  });

  it("keeps changedAt while the longer wait holds", () => {
    const prev: GovernorState = { calm: 0, runs: 3, changedAt: at(0).toISOString(), downs: [at(0).toISOString()] };
    expect(decide(prev, band, 6, at(15)).state.changedAt).toBe(at(0).toISOString());
    expect(decide(prev, band, 6, at(20)).state.changedAt).toBeUndefined();
  });

  it("records step downs, also in an emergency, but not at the floor", () => {
    expect(decide({ calm: 0 }, s(3, 3), 4, at(0)).state.downs).toEqual([at(0).toISOString()]);
    expect(decide({ calm: 0 }, s(0.5, 0.5, 4), 4, at(0)).state.downs).toEqual([at(0).toISOString()]);
    expect(decide({ calm: 0, runs: 2 }, s(3, 3), 4, at(0)).state.downs).toBeUndefined();
  });

  it("leaves no cap at the configured number", () => {
    expect(decide({ calm: 4, runs: 5 }, calm, 5, at(0)).state).toEqual({ calm: 0 });
    expect(decide({ calm: 4 }, calm, 1, at(0)).state).toEqual({ calm: 0 });
  });

  it("does not let a spike hold the way up forever: a hot check resets the count", () => {
    expect(decide({ calm: 3, runs: 4 }, s(3, 1), 6, at(0)).state).toEqual({ calm: 0, hot: 1, runs: 4 });
  });
});

describe("decide: the state", () => {
  it("drops a changedAt older than the pauses, and ignores one in the future", () => {
    expect(decide({ calm: 0, changedAt: at(-11).toISOString() }, band, 4, at(0)).state.changedAt).toBeUndefined();
    const future = decide({ calm: 0, changedAt: at(30).toISOString() }, s(3, 3), 4, at(0));
    expect(future.state.runs).toBe(3);
  });
});

describe("loadState", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "scf-gov-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const state = (dir: string, body: object) => writeFileSync(join(dir, "state.json"), JSON.stringify(body));

  it("reads hot and changedAt back, as runGovernor wrote them", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 4 };
    runGovernor({ ...o, now: at(0), sample: s(3, 3) });
    runGovernor({ ...o, now: at(1), sample: s(3, 3) });
    expect(loadState(o.dir, at(1))).toEqual({ calm: 0, downs: [at(0).toISOString()], hot: 2, runs: 3, changedAt: at(0).toISOString() });
  });

  it("keeps the step-down times between checks, so the wait is 20 minutes", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 4 };
    runGovernor({ ...o, now: at(0), sample: s(3, 3) });
    const moves: number[] = [];
    for (let m = 1; m <= 25; m++) {
      const d = runGovernor({ ...o, now: at(m), sample: calm });
      if (d.change) moves.push(m);
    }
    expect(moves).toEqual([20]);
  });

  it("starts fresh after the hold time, which resets the wait", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 4 };
    runGovernor({ ...o, now: at(0), sample: s(3, 3) });
    expect(loadState(o.dir, new Date(at(0).getTime() + HOLD_MS + 1))).toEqual({ calm: 0 });
  });

  it("ignores a bad downs list and keeps only readable times of the last hour", () => {
    const dir = tmp();
    state(dir, { calm: 1, downs: "x", at: at(0).toISOString() });
    expect(loadState(dir, at(0))).toEqual({ calm: 1 });
    state(dir, { calm: 1, downs: [1, "nonsense", at(-1).toISOString(), at(-60).toISOString()], at: at(0).toISOString() });
    expect(loadState(dir, at(0))).toEqual({ calm: 1, downs: [at(-1).toISOString()] });
  });

  it("ignores values of the wrong shape and loads an old file without them", () => {
    const dir = tmp();
    state(dir, { calm: 1, hot: "x", changedAt: "nonsense", runs: 3, at: at(0).toISOString() });
    expect(loadState(dir, at(0))).toEqual({ calm: 1, runs: 3 });
    state(dir, { calm: 2, cool: 2, runs: 3, at: at(0).toISOString() });
    expect(loadState(dir, at(0))).toEqual({ calm: 2, runs: 3 });
  });
});

describe("changesToday", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "scf-gov-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const line = (d: Date) => `${d.toISOString()} runs at once 4 → 3 (load 3.0 per core)\n`;
  const now = new Date(2026, 9, 20, 15, 0);

  it("is 0 without a log", () => {
    expect(changesToday(tmp(), now)).toBe(0);
  });

  it("counts the lines of the local day of `now` and skips garbage", () => {
    const dir = tmp();
    writeFileSync(join(dir, "changes.log"), line(new Date(2026, 9, 19, 23, 30)) + "garbage\n" + line(new Date(2026, 9, 20, 0, 5)) + line(new Date(2026, 9, 20, 14, 0)));
    expect(changesToday(dir, now)).toBe(2);
  });

  it("counts old and today's lines in a file larger than one read, and today's lines alone beyond 64 kB", () => {
    const dir = tmp();
    const old = line(new Date(2026, 9, 18, 12, 0)).repeat(2000);
    writeFileSync(join(dir, "changes.log"), old);
    for (let i = 0; i < 2500; i++) appendFileSync(join(dir, "changes.log"), line(new Date(2026, 9, 20, 1, 0, i % 60)));
    expect(changesToday(dir, now)).toBe(2500);
    const only = tmp();
    writeFileSync(join(only, "changes.log"), line(new Date(2026, 9, 20, 2, 0)).repeat(3000));
    expect(changesToday(only, now)).toBe(3000);
  });
});

describe("replay of a spiky day", () => {
  /** The rules before #693, frozen for this comparison (old defaults inline). */
  function decideBefore(prevState: GovernorState, x: Sample, configured: number): Decision {
    const prev: GovernorState & { cool?: number } = prevState;
    const set = { high: 2.5, low: 1.5, testsHigh: 4, calmChecks: 5, coolChecks: 15 };
    const floor = Math.min(configured, Math.max(2, Math.ceil(configured / 2)));
    const have = Math.min(prev.runs ?? configured, configured);
    const pressed = x.pressure >= 4 || (x.pressure >= 2 && x.load1 > set.low);
    const hot = x.load1 > set.high || pressed;
    const tests = x.load1 > set.testsHigh || x.pressure >= 4 ? 1 : undefined;
    const notes: string[] = [];
    let runs = have;
    let calmN = 0;
    let cool = 0;
    if (hot) {
      if (have > floor) {
        runs = have - 1;
        notes.push("down");
      }
    } else {
      const isCalm = x.load1 <= set.low && x.load5 <= set.low;
      calmN = isCalm ? prev.calm + 1 : 0;
      cool = (prev.cool ?? 0) + 1;
      const up = calmN >= set.calmChecks || cool >= set.coolChecks;
      if (up && have < configured) {
        runs = have + 1;
        notes.push("up");
      }
      if (up) calmN = cool = 0;
    }
    if (tests !== prev.tests) notes.push("tests");
    return { state: { calm: calmN, ...(cool ? { cool } : {}), ...(runs < configured ? { runs } : {}), ...(tests ? { tests } : {}) }, ...(notes.length ? { change: notes.join("; ") } : {}) };
  }

  /**
   * SYNTHETIC: a deterministic day of one-minute samples, starting at midnight. It is not recorded load: the
   * recorded day the issue asks for is not in the repository (see the issue's acceptance criteria).
   * Quiet nights, a working day with test spikes and two builds.
   */
  function day(): Sample[] {
    let seed = 693;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const out: Sample[] = [];
    let l5 = 1.0;
    let l15 = 1.0;
    for (let i = 0; i < 1440; i++) {
      const hour = i / 60;
      let l1 = hour < 8 || hour >= 20 ? 0.3 + rand() * 0.2 : 0.9 + rand() * 0.5;
      if (hour >= 8 && hour < 20 && i % 23 < 2) l1 = 2.6 + rand() * 0.3;
      if ((hour >= 11 && hour < 11.4) || (hour >= 15 && hour < 15.5)) l1 = 2.9 + rand() * 0.4;
      l5 += (l1 - l5) * (1 - Math.exp(-1 / 5));
      l15 += (l1 - l15) * (1 - Math.exp(-1 / 15));
      out.push({ load1: l1, load5: l5, load15: l15, pressure: 1 });
    }
    return out;
  }
  const MIDNIGHT = new Date(2026, 9, 20, 0, 0);
  const minuteOf = (i: number) => new Date(MIDNIGHT.getTime() + i * 60_000);

  it("makes at most 20 changes on the synthetic day where the rules before made 40 or more", () => {
    let before: Decision = { state: { calm: 0 } };
    let after: Decision = { state: { calm: 0 } };
    let changesBefore = 0;
    let changesAfter = 0;
    day().forEach((x, i) => {
      before = decideBefore(before.state, x, 4);
      after = decide(after.state, x, 4, minuteOf(i));
      if (before.change) changesBefore++;
      if (after.change) changesAfter++;
    });
    expect(changesBefore).toBeGreaterThanOrEqual(40);
    expect(changesAfter).toBeLessThanOrEqual(20);
    // the builds still act
    expect(changesAfter).toBeGreaterThan(0);
  });

  it("keeps the clock times of the issue's morning: the 09:33 spike does not lower the cap, the old rules did", () => {
    // Only the loads the issue gives, at its times: 09:33 2.6, 09:34 2.8, then calm loads (1.0 is assumed between).
    const morning: Sample[] = [];
    for (let m = 9 * 60; m <= 10 * 60 + 15; m++) {
      const l1 = m === 9 * 60 + 33 ? 2.6 : m === 9 * 60 + 34 ? 2.8 : m === 10 * 60 + 6 ? 1.0 : m === 10 * 60 + 11 ? 0.7 : 1.0;
      morning.push({ load1: l1, load5: l1 === 2.6 || l1 === 2.8 ? 1.4 : 1.0, load15: 1.0, pressure: 1 });
    }
    let before: Decision = { state: { calm: 0 } };
    let after: Decision = { state: { calm: 0 } };
    const oldChanges: string[] = [];
    const newChanges: string[] = [];
    morning.forEach((x, i) => {
      const t = new Date(2026, 9, 20, 9, 0).getTime() + i * 60_000;
      before = decideBefore(before.state, x, 4);
      after = decide(after.state, x, 4, new Date(t));
      if (before.change) oldChanges.push(String(i));
      if (after.change) newChanges.push(String(i));
    });
    expect(oldChanges.length).toBeGreaterThan(0);
    expect(newChanges).toEqual([]);
    expect(after.state.runs).toBeUndefined();
  });
});

describe("the floor (governor.floor)", () => {
  const f = (floor?: number): Settings => ({ ...DEFAULTS, floor });
  const sus = s(3, 3);

  it("is not set by default: half of the configured number, at least 2, and at least 1 for one", () => {
    expect(DEFAULTS.floor).toBeUndefined();
    const lowest = (configured: number) => feed({ calm: 0 }, Array.from({ length: 10 }, () => s(5, 5)), configured).d.state.runs ?? configured;
    expect([1, 3, 4, 5].map(lowest)).toEqual([1, 2, 2, 3]);
  });

  it("goes down to 0 one step at a time, and says so", () => {
    const r = feed({ calm: 0 }, [sus, sus, sus, sus, sus, sus, sus], 2, 0, f(0));
    expect(r.changes).toEqual([0, 3]);
    expect(r.d.state.runs).toBe(0);
    expect(feed({ calm: 0 }, [sus, sus, sus, sus], 2, 0, f(0)).d.change).toBe("runs at once 1 → 0 (load 3.0 per core over 5 minutes)");
  });

  it("moves nothing more at 0, and an emergency still limits the test runs", () => {
    const prev: GovernorState = { calm: 0, runs: 0 };
    expect(decide(prev, sus, 2, at(0), f(0)).state.runs).toBe(0);
    expect(decide(prev, sus, 2, at(0), f(0)).change).toBeUndefined();
    expect(decide(prev, s(4.5, 4.5), 2, at(0), f(0)).state).toMatchObject({ runs: 0, tests: 1 });
  });

  it("comes back from 0 after calm checks and the pause", () => {
    expect(decide({ calm: 4, runs: 0 }, calm, 2, at(0), f(0)).state.runs).toBe(1);
    const held = decide({ calm: 4, runs: 0, changedAt: at(0).toISOString() }, calm, 2, at(5), f(0));
    expect(held.state.runs).toBe(0);
    expect(held.change).toBeUndefined();
    expect(decide({ calm: 4, runs: 0, changedAt: at(0).toISOString() }, calm, 2, at(10), f(0)).state.runs).toBe(1);
  });

  it("stops at a floor of 1", () => {
    expect(feed({ calm: 0 }, Array.from({ length: 10 }, () => s(5, 5)), 4, 0, f(1)).d.state.runs).toBe(1);
  });

  it("counts a floor above the configured number as the configured number", () => {
    expect(decide({ calm: 0 }, sus, 4, at(0), f(9)).state.runs).toBeUndefined();
    expect(decide({ calm: 0, runs: 2 }, calm, 4, at(0), f(9)).state.runs).toBeUndefined();
  });

  it("lifts a stored cap below a floor that was raised, without a log line", () => {
    const d = decide({ calm: 0, runs: 0 }, calm, 4, at(0), f(2));
    expect(d.state.runs).toBe(2);
    expect(d.change).toBeUndefined();
  });

  it("sets no cap when nothing is configured", () => {
    expect(decide({ calm: 0 }, sus, 0, at(0), f(0)).state.runs).toBeUndefined();
  });

  describe("runGovernor", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const setup = () => {
      const dir = mkdtempSync(join(tmpdir(), "scf-gov-"));
      dirs.push(dir);
      return { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 2, settings: f(0) };
    };

    it("writes a cap of 0, keeps it while it is renewed, and lets it end by itself", () => {
      const o = setup();
      for (const m of [0, 3]) runGovernor({ ...o, now: at(m), sample: sus });
      expect(loadCaps(o.capsFile).load?.runs).toBe(0);
      expect(runLimit(2, at(3), o.capsFile)).toBe(0);
      expect(loadState(o.dir, at(3)).runs).toBe(0);
      // the next check renews it
      runGovernor({ ...o, now: at(4), sample: sus });
      expect(loadCaps(o.capsFile).load?.until).toBe(new Date(at(4).getTime() + HOLD_MS).toISOString());
      // a governor that stopped: after the hold time the configured number is back, and the state is forgotten
      const later = at(4 + 5);
      expect(runLimit(2, later, o.capsFile)).toBe(2);
      expect(loadState(o.dir, later)).toEqual({ calm: 0 });
    });

    it("takes the cap away when the floor was raised to the configured number", () => {
      const o = setup();
      for (const m of [0, 3]) runGovernor({ ...o, now: at(m), sample: sus });
      runGovernor({ ...o, settings: f(2), now: at(4), sample: sus });
      expect(existsSync(join(o.dir, "caps", "load.json"))).toBe(false);
      expect(runLimit(2, at(4), o.capsFile)).toBe(2);
    });
  });
});

describe("scenarios (SYNTHETIC one-minute samples, no recorded load)", () => {
  /** Runs the samples one minute apart; returns the minutes of changes, the lowest cap and the last cap. */
  function replay(state: GovernorState, samples: Sample[], configured = 4, set: Settings = DEFAULTS) {
    const changes: number[] = [];
    let lowest = state.runs ?? configured;
    let d: Decision = { state };
    samples.forEach((x, i) => {
      d = decide(d.state, x, configured, at(i), set);
      if (d.change?.startsWith("runs at once")) changes.push(i);
      lowest = Math.min(lowest, d.state.runs ?? configured);
    });
    return { changes, lowest, end: d.state.runs ?? configured };
  }
  /** Samples from 1-minute loads, with 5- and 15-minute averages that start at the given values. */
  function withAverages(load1: number[], l5 = load1[0]!, l15 = l5): Sample[] {
    return load1.map((l1) => {
      l5 += (l1 - l5) * (1 - Math.exp(-1 / 5));
      l15 += (l1 - l15) * (1 - Math.exp(-1 / 15));
      return { load1: l1, load5: l5, load15: l15, pressure: 1 };
    });
  }
  const minutes = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

  it("steady load of 2 per core from other programs: the cap stays where it is", () => {
    const steady = minutes(480, (i) => 2 + 0.3 * Math.sin(i / 7)).map((l1, i) => s(l1, 2 + 0.1 * Math.sin(i / 7), 1, 2));
    const r = replay({ calm: 0, runs: 3 }, steady);
    expect([r.changes, r.lowest, r.end]).toEqual([[], 3, 3]);
    const zero = replay({ calm: 0, runs: 0 }, steady, 4, { ...DEFAULTS, floor: 0 });
    expect([zero.changes, zero.lowest, zero.end]).toEqual([[], 0, 0]);
  });

  it("short spikes: no change", () => {
    const spikes = withAverages(minutes(480, (i) => (i % 23 < 2 ? 2.8 : 0.8)), 0.8);
    const r = replay({ calm: 0 }, spikes);
    expect([r.changes, r.end]).toEqual([[], 4]);
  });

  it("a quiet night after a busy evening: back to no cap, in few changes", () => {
    const night = withAverages(minutes(480, () => 0.3), 1.1, 1.6);
    const r = replay({ calm: 0, runs: 2 }, night);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(r.changes.length).toBeLessThanOrEqual(3);
    expect(r.lowest).toBe(2);
    expect(r.end).toBe(4);
  });

  it("critical memory pressure: goes down fast, never below the floor, and comes back", () => {
    const samples = [...Array.from({ length: 5 }, () => s(0.8, 0.8, 4)), ...Array.from({ length: 120 }, () => s(0.5, 0.5))];
    const r = replay({ calm: 0 }, samples);
    expect(r.lowest).toBe(2);
    expect(r.end).toBe(4);
    expect(r.changes.length).toBeLessThanOrEqual(6);
    const one = replay({ calm: 0 }, samples, 4, { ...DEFAULTS, floor: 1 });
    expect(one.lowest).toBe(1);
    expect(one.end).toBe(4);
  });
});
