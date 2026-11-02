import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, MANY_CHANGES, decide, fitsText, loadState, runsFit, type Decision, type GovernorState, type Measured, type Sample, type Settings } from "../src/ops/governor.js";
import { MIN_RUN_CORES, coresPerRun, measurement, queuedRuns, runRepos, runningRuns } from "../src/ops/usage.js";
import { gameDay, minutes, withAverages } from "./fixtures/governor-days.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "scf-target-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MIDNIGHT = new Date(2026, 9, 20, 0, 0);
const at = (min: number) => new Date(MIDNIGHT.getTime() + min * 60_000);
const s = (load1: number, load5 = load1, pressure = 1, load15 = load5): Sample => ({ load1, load5, load15, pressure });
const calm = s(0.5);
/** 16 cores, one run uses 2: `other` cores of other programs leave (14 − other) / 2 runs. */
const m = (other: number, perRun = 2): Measured => ({ cores: 16, other, perRun });
const withM = (x: Sample, measured: Measured): Sample => ({ ...x, measured });
const without = (x: Sample): Sample => {
  const { measured: _m, ...rest } = x;
  return rest;
};

/** Feeds samples one minute apart from minute `start`; gives the last decision, the minutes of runs changes and the caps. */
function feed(state: GovernorState, samples: Sample[], configured: number, set: Settings = DEFAULTS, start = 0) {
  const changes: number[] = [];
  const caps: number[] = [];
  let d: Decision = { state };
  samples.forEach((x, i) => {
    d = decide(d.state, x, configured, at(start + i), set);
    if (d.change?.startsWith("runs at once")) changes.push(start + i);
    caps.push(d.state.runs ?? configured);
  });
  return { d, changes, caps };
}

describe("runsFit and fitsText", () => {
  it("is the free cores divided by what a run uses, rounded down", () => {
    expect(runsFit({ cores: 16, other: 6.1, perRun: 1.9 }, 2)).toBe(4);
  });
  it("says 0 when the free cores do not hold one run, and when there are none", () => {
    expect(runsFit({ cores: 8, other: 1, perRun: 6 }, 2)).toBe(0);
    expect(runsFit({ cores: 8, other: 6.5, perRun: 1 }, 2)).toBe(0);
    expect(runsFit({ cores: 8, other: 0, perRun: 1 }, 100)).toBe(0);
  });
  it("words the number", () => {
    expect([0, 1, 4].map(fitsText)).toEqual(["0 runs fit", "1 run fits", "4 runs fit"]);
  });
});

describe("decide with a measurement: down", () => {
  const floor0: Settings = { ...DEFAULTS, floor: 0 };

  it("goes one down after three checks over the target, and says how many fit", () => {
    const x = withM(calm, { cores: 16, other: 6.1, perRun: 1.9 });
    const r = feed({ calm: 0 }, [x, x, x], 7, floor0);
    expect(r.changes).toEqual([2]);
    expect(r.d.change).toBe("runs at once 7 → 6 (4 runs fit)");
    expect(r.d.state.over).toBe(3);
  });

  it("counts again when one check is not over the target", () => {
    const over = withM(calm, m(6));
    const r = feed({ calm: 0 }, [over, over, withM(calm, m(0.5)), over, over], 7, floor0);
    expect(r.changes).toEqual([]);
  });

  it("steps 3 minutes apart on a spiky day, down to the floor", () => {
    const spiky = withAverages(minutes(60, (i) => (i % 23 < 2 ? 2.8 : 0.8)), 0.8).map((x) => withM(x, m(6)));
    const r = feed({ calm: 0 }, spiky, 7);
    expect(r.changes).toEqual([2, 5, 8]);
    expect(r.caps.at(-1)).toBe(4);
  });

  it("stays at 1 when one run fits and the floor is 0", () => {
    const r = feed({ calm: 0, runs: 1 }, minutes(30, () => withM(calm, m(12))), 7, floor0);
    expect(r.changes).toEqual([]);
    expect(r.caps.at(-1)).toBe(1);
  });

  it("reaches 0 with no free cores even when a run uses less than the slack", () => {
    // 16 cores, other programs take 14 and 2 are reserved: no core is free, and a run of 0.25 cores is still over
    const full: Measured = { cores: 16, other: 14, perRun: 0.25 };
    const r = feed({ calm: 0, runs: 2 }, minutes(12, () => withM(calm, full)), 7, floor0);
    expect(r.caps.at(-1)).toBe(0);
  });

  it("goes to 0 when no run fits and the floor is 0, never when the floor is higher", () => {
    const x = withM(calm, m(13.5));
    expect(feed({ calm: 0, runs: 1 }, [x, x, x], 7, floor0).caps.at(-1)).toBe(0);
    expect(feed({ calm: 0, runs: 3 }, minutes(60, () => x), 7, { ...DEFAULTS, floor: 3 }).caps.at(-1)).toBe(3);
  });

  it("does not lower the cap for a sustained load when there is room, but does without a measurement", () => {
    const sus = s(3, 3);
    expect(feed({ calm: 0 }, minutes(10, () => withM(sus, m(0.5))), 7).changes).toEqual([]);
    expect(feed({ calm: 0 }, minutes(10, () => sus), 7).changes).toEqual([0, 3, 6]);
  });

  it("does not move for a figure that wobbles around a whole number", () => {
    // 8 cores for 4 runs of 2; free is 8 or 7.5: three runs fit, but four use no more than free + 0.5
    const wobble = minutes(480, (i) => withM(calm, m(i % 2 ? 6.5 : 6)));
    const r = feed({ calm: 0, runs: 4 }, wobble, 7, floor0);
    expect(r.changes).toEqual([]);
    expect(r.caps.at(-1)).toBe(4);
  });
});

describe("decide with a measurement: up", () => {
  // 16 cores, nothing else running: 7 runs fit
  const room = withM(calm, m(0));

  it("goes one up after calm checks with room, and counts nothing without room", () => {
    const r = feed({ calm: 0, runs: 5 }, minutes(5, () => room), 7);
    expect(r.changes).toEqual([4]);
    expect(r.d.change).toBe("runs at once 5 → 6 (calm: load 0.5 per core)");
    const full = feed({ calm: 0, runs: 5 }, minutes(20, () => withM(calm, m(4))), 7);
    expect(full.d.state.calm).toBe(0);
    expect(full.changes).toEqual([]);
  });

  it("never goes up with the load between low and high, even when the target is higher", () => {
    const band = withM(s(1.8), m(0));
    const r = feed({ calm: 0, runs: 5 }, minutes(480, () => band), 7);
    expect(r.changes).toEqual([]);
    expect(r.d.state.calm).toBe(0);
  });

  it("holds the last step until the 15-minute load is low", () => {
    const high15 = withM(s(0.5, 0.5, 1, 1.5), m(0));
    const r = feed({ calm: 0, runs: 6 }, minutes(20, () => high15), 7);
    expect(r.changes).toEqual([]);
    expect(r.d.state.calm).toBeGreaterThanOrEqual(5);
    expect(feed(r.d.state, [room], 7, DEFAULTS, 20).changes).toEqual([20]);
  });

  it("waits the settle time after a change", () => {
    const r = feed({ calm: 0, runs: 5, changedAt: at(0).toISOString() }, minutes(15, () => room), 7, DEFAULTS, 1);
    expect(r.changes).toEqual([10]);
  });
});

describe("decide with a measurement: emergencies", () => {
  it("acts inside a pause, one step per check, below the target but not below the floor, and climbs back", () => {
    const quiet = withM(calm, m(0));
    const crit = withM(s(0.8, 0.8, 4), m(0));
    const r = feed({ calm: 0 }, [crit, crit, crit, crit, crit, ...minutes(200, () => quiet)], 7, { ...DEFAULTS, floor: 5 });
    expect(r.caps.slice(0, 5)).toEqual([6, 5, 5, 5, 5]);
    expect(Math.min(...r.caps)).toBe(5);
    expect(r.caps.at(-1)).toBe(7);
    const load = withM(s(4.5, 1), m(0));
    expect(feed({ calm: 0, runs: 6, changedAt: at(0).toISOString() }, [load], 7, DEFAULTS, 1).caps).toEqual([5]);
  });
});

describe("decide: the game day", () => {
  const replay = (samples: Sample[], configured: number, set: Settings) => {
    let d: Decision = { state: { calm: 0 } };
    const caps: number[] = [];
    let changes = 0;
    samples.forEach((x, i) => {
      d = decide(d.state, x, configured, at(i), set);
      // the pause of test runs has its own notes (see "decide: pausing test runs"); this counts the changes of the caps
      if (d.change?.split("; ").some((n) => !/^(test runs beyond the first paused|paused test runs go on)/.test(n))) changes++;
      caps.push(d.state.runs ?? configured);
    });
    return { caps, changes };
  };

  it("makes fewer changes than the digest warns about, reaches the floor by 09:10 and is back at the end", () => {
    const r = replay(gameDay(), 7, DEFAULTS);
    expect(r.changes).toBeLessThan(MANY_CHANGES);
    expect(r.caps[9 * 60 + 10]).toBe(4);
    expect(r.caps.at(-1)).toBe(7);
  });

  it("makes at least that many without the measurement", () => {
    expect(replay(gameDay().map(without), 7, DEFAULTS).changes).toBeGreaterThanOrEqual(MANY_CHANGES);
  });

  it("never goes below the floor and never moves more than one step between two checks", () => {
    for (const floor of [0, 1, 2, 6]) {
      const caps = replay(gameDay(), 7, { ...DEFAULTS, floor }).caps;
      expect(Math.min(...caps), `floor ${floor}`).toBeGreaterThanOrEqual(Math.min(7, floor));
      for (let i = 1; i < caps.length; i++) expect(Math.abs(caps[i]! - caps[i - 1]!), `floor ${floor}, check ${i}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("decide: no measurement", () => {
  it("keeps the rules of part 3 after a measured stretch: over is dropped", () => {
    const over = withM(calm, m(6));
    const r = feed({ calm: 0 }, minutes(2, () => over), 7, { ...DEFAULTS, floor: 0 });
    expect(r.d.state.over).toBe(2);
    const next = decide(r.d.state, calm, 7, at(2), { ...DEFAULTS, floor: 0 });
    expect(next).toEqual({ state: { calm: 1 } });
    const hot = feed(r.d.state, [s(3, 3)], 7, DEFAULTS, 2);
    expect(hot.d.change).toBe("runs at once 7 → 6 (load 3.0 per core over 5 minutes)");
    expect(hot.d.state.over).toBeUndefined();
  });

  it("goes down for a sustained load, as before", () => {
    const d = decide({ calm: 0 }, s(2.0, 2.7), 4, at(0));
    expect(d).toMatchObject({ state: { runs: 3 }, change: "runs at once 4 → 3 (load 2.7 per core over 5 minutes)" });
  });
});

describe("loadState: over", () => {
  it("reads it back, and ignores a value that is not a number", () => {
    const dir = tmp();
    const now = new Date();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, over: 2, at: now.toISOString() }));
    expect(loadState(dir, now).over).toBe(2);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, over: "x", at: now.toISOString() }));
    expect(loadState(dir, now)).toEqual({ calm: 0 });
  });
});

describe("coresPerRun", () => {
  it("weighs a repository by its runs", () => {
    expect(coresPerRun(["a", "a", "a", "b"], { a: 2, b: 0.5 })).toBe(1.625);
  });
  it("counts an unknown repository as the mean of the learned values", () => {
    expect(coresPerRun(["a", "c"], { a: 2, b: 4 })).toBe(2.5);
  });
  it("uses the mean when there are no runs, and gives undefined when nothing was learned", () => {
    expect(coresPerRun([], { a: 2, b: 4 })).toBe(3);
    expect(coresPerRun(["a"], {})).toBeUndefined();
  });
  it("lifts a learned 0 to the least a run uses", () => {
    expect(coresPerRun(["a"], { a: 0 })).toBe(MIN_RUN_CORES);
  });
  it("does not look a repository up on the prototype", () => {
    expect(coresPerRun(["constructor", "toString"], { a: 2 })).toBe(2);
  });
});

describe("runs of the Foundry", () => {
  const runJson = (runsDir: string, id: string, run: Record<string, unknown>) => {
    mkdirSync(join(runsDir, id), { recursive: true });
    writeFileSync(join(runsDir, id, "run.json"), JSON.stringify(run));
  };
  const queue = (file: string, jobs: unknown) => writeFileSync(file, JSON.stringify(jobs));

  it("lists a queued run with its repository, from the variable or the job", () => {
    const d = tmp();
    const file = join(d, "queue.json");
    queue(file, [
      { runId: "r1", job: { kind: "run", repo: "/work/x", vars: { github_repo: "acme/app" } } },
      { runId: "r2", job: { kind: "run", repo: "/work/y", vars: {} } },
    ]);
    expect(queuedRuns(file, join(d, "runs"))).toEqual([{ runId: "r1", repo: "acme/app" }, { runId: "r2", repo: "/work/y" }]);
  });

  it("finds the repository of a queued resume through its run.json, and skips an unknown run and a job of the wrong shape", () => {
    const d = tmp();
    const runs = join(d, "runs");
    runJson(runs, "r3", { status: "paused", repo: "/work/z", vars: { github_repo: "acme/lib" } });
    const file = join(d, "queue.json");
    queue(file, [{ runId: "r3", job: { kind: "resume", runId: "r3" } }, { runId: "r4", job: { kind: "resume", runId: "r4" } }, null, { runId: 5 }, { runId: "r6", job: "x" }]);
    expect(queuedRuns(file, runs)).toEqual([{ runId: "r3", repo: "acme/lib" }]);
  });

  it("gives nothing for a missing file, broken JSON or a file that is not a list", () => {
    const d = tmp();
    const file = join(d, "queue.json");
    expect(queuedRuns(file, d)).toEqual([]);
    writeFileSync(file, "{nope");
    expect(queuedRuns(file, d)).toEqual([]);
    queue(file, { runId: "r" });
    expect(queuedRuns(file, d)).toEqual([]);
  });

  it("lists a running run without a step marker, and no finished or dead one", () => {
    const d = tmp();
    const runs = join(d, "runs");
    runJson(runs, "a1", { status: "running", pid: process.pid, repo: "/w/a", vars: { github_repo: "acme/app" } });
    runJson(runs, "a2", { status: "done", pid: process.pid, repo: "/w/b" });
    runJson(runs, "a3", { status: "running", pid: 2 ** 22 + 12345, repo: "/w/c" });
    expect(runningRuns(runs)).toEqual([{ runId: "a1", repo: "acme/app" }]);
    expect(runningRuns(join(d, "none"))).toEqual([]);
  });

  it("finds an old running run that was resumed, among 300 newer finished runs", () => {
    const d = tmp();
    const runs = join(d, "runs");
    runJson(runs, "0000-resumed", { status: "running", pid: process.pid, repo: "acme/old" });
    for (let i = 1; i <= 300; i++) runJson(runs, `run-${String(i).padStart(4, "0")}`, { status: "done", pid: process.pid, repo: "acme/new" });
    expect(runningRuns(runs)).toEqual([{ runId: "0000-resumed", repo: "acme/old" }]);
  });

  it("counts a run once when it is both running and queued", () => {
    const d = tmp();
    const runs = join(d, "runs");
    runJson(runs, "b1", { status: "running", pid: process.pid, repo: "acme/app" });
    const file = join(d, "queue.json");
    queue(file, [{ runId: "b1", job: { kind: "resume", runId: "b1" } }, { runId: "b2", job: { kind: "run", repo: "acme/lib", vars: {} } }]);
    expect(runRepos(file, runs).sort()).toEqual(["acme/app", "acme/lib"]);
  });

  it("measurement: none without learned figures or cores, otherwise the figures", () => {
    const u = { other: { cores: 6.1, top: [] }, perRun: { "acme/app": 2 } };
    expect(measurement({ ...u, perRun: {} }, ["acme/app"], 16)).toBeUndefined();
    expect(measurement(u, ["acme/app"], 0)).toBeUndefined();
    expect(measurement(u, ["acme/app", "acme/other"], 16)).toEqual({ cores: 16, other: 6.1, perRun: 2 });
  });
});
