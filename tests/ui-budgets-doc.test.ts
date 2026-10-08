import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUDGETS, POLL_TICK_MS, median, overBudget, show, timeBudget } from "./browser/budgets.js";

const NAMES = [
  "RENDER_HOME_MS", "RENDER_RUNS_MS", "RENDER_BOARD_MS", "INTERACTION_MS", "CLS_LOAD", "CLS_POLL", "LARGE_RUNS_MS",
  "LARGE_LOG_MS", "LARGE_DIFF_MS", "LARGE_RUNS_ROWS", "POLL_HOME_MS", "POLL_RUNS_MS", "POLL_REQUESTS",
];

describe("the budget helpers", () => {
  it("takes the median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it("sets a time limit at three times the median, in 500 ms steps, up to the cap", () => {
    expect(timeBudget(100, 2000)).toBe(500);
    expect(timeBudget(400, 2000)).toBe(1500);
    expect(timeBudget(900, 2000)).toBe(2000);
  });

  it("shows a value in its unit", () => {
    expect(show({ ...BUDGETS.RENDER_HOME_MS }, 612)).toBe("612 ms");
    expect(show(BUDGETS.CLS_LOAD, 0.0123)).toBe("0.012");
    expect(show(BUDGETS.LARGE_RUNS_ROWS, 200)).toBe("200");
  });

  it("reports only values over the limit", () => {
    const b = BUDGETS.RENDER_HOME_MS;
    expect(overBudget(b, b.limit)).toBeNull();
    const msg = overBudget(b, b.limit + 1)!;
    expect(msg).toContain(b.measure);
    expect(msg).toContain(show(b, b.limit + 1));
    expect(msg).toContain(show(b, b.limit));
  });
});

describe("the budgets", () => {
  it("are the 13 named ones, each with a reason, a unit and a limit", () => {
    expect(Object.keys(BUDGETS).sort()).toEqual([...NAMES].sort());
    for (const [name, b] of Object.entries(BUDGETS)) {
      expect(b.reason.trim(), name).not.toBe("");
      expect(["ms", "score", "count"], name).toContain(b.unit);
      expect(b.limit, name).toBeGreaterThan(0);
    }
  });

  it("are all used by the performance spec", () => {
    const spec = readFileSync("tests/browser/performance.spec.ts", "utf8");
    for (const n of NAMES) expect(spec, n).toContain(n);
  });

  it("measure a tick as long as the timers of Home and Runs", () => {
    expect(readFileSync("ui/runs.js", "utf8")).toContain("REFRESH_MS = 30_000");
    expect(readFileSync("ui/home-admin.js", "utf8")).toContain("REFRESH_MS = 30_000");
    expect(POLL_TICK_MS).toBe(30_000);
  });

  it("are measured without the Performance entry list that the fake clock could change", () => {
    expect(readFileSync("tests/browser/perf.ts", "utf8")).not.toContain("getEntriesByType");
  });
});
