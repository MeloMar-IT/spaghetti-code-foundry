import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCaps, runLimit } from "../src/ops/caps.js";
import { changesToday, DEFAULTS, HOLD_MS, decide, loadState, runGovernor, type Decision, type GovernorState, type Sample, type Settings } from "../src/ops/governor.js";

const T0 = new Date(2026, 9, 20, 9, 0);
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const s = (load1: number, load5: number, pressure = 1): Sample => ({ load1, load5, pressure });
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
    expect(decide({ calm: 0 }, s(0.5, 0.5, 2), 4, at(0))).toEqual({ state: { calm: 1, cool: 1 } });
    expect(decide({ calm: 0 }, s(1.0, 2.0, 2), 4, at(0)).state.runs).toBeUndefined();
    expect(decide({ calm: 0 }, s(2, 3, 2), 4, at(0)).state.runs).toBe(3);
  });

  it("does not report a step from a number above the configured one", () => {
    expect(decide({ calm: 0, runs: 6 }, s(3, 3), 5, at(0))).toMatchObject({ state: { runs: 4 }, change: "runs at once 5 → 4 (load 3.0 per core over 5 minutes)" });
    expect(decide({ calm: 0, runs: 6 }, band, 5, at(0)).state).toEqual({ calm: 0, cool: 1 });
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

  it("holds the up step for the 15-checks rule as well", () => {
    const set = { ...DEFAULTS, coolChecks: 4 };
    const r = feed({ calm: 0, runs: 3, changedAt: at(0).toISOString() }, Array(12).fill(band), 4, 1, set);
    expect(r.changes).toEqual([10]);
    expect(r.d.state.changedAt).toBe(at(10).toISOString());
  });

  it("moves one step up and resets the counts", () => {
    expect(decide({ calm: 4, cool: 4, runs: 3 }, calm, 6, at(0))).toMatchObject({ state: { calm: 0, runs: 4 }, change: "runs at once 3 → 4 (calm: load 0.5 per core)" });
    // in between: nothing moves, the calm count starts again
    expect(decide({ calm: 3, cool: 3, runs: 4 }, band, 6, at(0)).state).toEqual({ calm: 0, cool: 4, runs: 4 });
  });

  it("leaves no cap at the configured number", () => {
    expect(decide({ calm: 4, runs: 5 }, calm, 5, at(0)).state).toEqual({ calm: 0 });
    expect(decide({ calm: 4 }, calm, 1, at(0)).state).toEqual({ calm: 0 });
  });

  it("does not let a spike hold the way up forever: a hot check resets the counts", () => {
    expect(decide({ calm: 0, cool: 14, runs: 4 }, s(3, 1), 6, at(0)).state).toEqual({ calm: 0, hot: 1, runs: 4 });
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
    expect(loadState(o.dir, at(1))).toEqual({ calm: 0, hot: 2, runs: 3, changedAt: at(0).toISOString() });
  });

  it("ignores values of the wrong shape and loads an old file without them", () => {
    const dir = tmp();
    state(dir, { calm: 1, hot: "x", changedAt: "nonsense", runs: 3, at: at(0).toISOString() });
    expect(loadState(dir, at(0))).toEqual({ calm: 1, runs: 3 });
    state(dir, { calm: 2, cool: 2, runs: 3, at: at(0).toISOString() });
    expect(loadState(dir, at(0))).toEqual({ calm: 2, cool: 2, runs: 3 });
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
  function decideBefore(prev: GovernorState, x: Sample, configured: number): Decision {
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
    for (let i = 0; i < 1440; i++) {
      const hour = i / 60;
      let l1 = hour < 8 || hour >= 20 ? 0.3 + rand() * 0.2 : 0.9 + rand() * 0.5;
      if (hour >= 8 && hour < 20 && i % 23 < 2) l1 = 2.6 + rand() * 0.3;
      if ((hour >= 11 && hour < 11.4) || (hour >= 15 && hour < 15.5)) l1 = 2.9 + rand() * 0.4;
      l5 += (l1 - l5) * (1 - Math.exp(-1 / 5));
      out.push({ load1: l1, load5: l5, pressure: 1 });
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
      morning.push({ load1: l1, load5: l1 === 2.6 || l1 === 2.8 ? 1.4 : 1.0, pressure: 1 });
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

    it("adds the cause to the change line, and leaves the line as it was without one", () => {
      const o = setup();
      const p = setup();
      const cause = "other programs use 6.1 cores (top: Xcode 3.1)";
      runGovernor({ ...o, now: at(0), sample: sus, cause });
      runGovernor({ ...p, now: at(0), sample: sus });
      const withCause = readFileSync(join(o.dir, "changes.log"), "utf8");
      const plain = readFileSync(join(p.dir, "changes.log"), "utf8");
      expect(plain).toMatch(/^\S+ runs at once 2 → 1 \(.*\)\n$/);
      expect(withCause).toBe(`${plain.slice(0, -1)} — ${cause}\n`);
      expect(changesToday(o.dir, at(0))).toBe(1);
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
