import { describe, expect, it, vi } from "vitest";
import type { Limits } from "../src/auth/limits.js";
import { userUsage, type UsageInput } from "../src/server/usage-view.js";

const T0 = { runs: 0, costUsd: 0 };
const input = (over: Partial<UsageInput> = {}): UsageInput => ({
  names: new Map([["ann", "Ann"]]),
  active: new Map(),
  runsToday: new Map(),
  costToday: new Map(),
  limitsOf: () => ({}),
  deletedName: "deleted account",
  ...over,
});
const line = (owner: string) => ({ owner, runs: 1, costUsd: 1, today: T0 });

describe("userUsage", () => {
  it("names accounts, keeps the order and does not ask for limits of gone or no accounts", () => {
    const limitsOf = vi.fn((): Limits => ({ maxRunsPerDay: 1 }));
    const out = userUsage([line("ghost"), line(""), line("ann")], input({ limitsOf, runsToday: new Map([["ghost", 9], ["", 9]]) }));
    expect(out.map((u) => u.name)).toEqual(["deleted account", "no owner", "Ann"]);
    expect(out.map((u) => u.owner)).toEqual(["ghost", "", "ann"]);
    expect(limitsOf).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ limits: {}, atLimit: [] });
    expect(out[1]).toMatchObject({ limits: {}, atLimit: [] });
    expect(out[2]!.limits).toEqual({ maxRunsPerDay: 1 });
  });

  it("marks each limit at exactly the limit, not below, and lists all in order", () => {
    const limits: Limits = { maxConcurrent: 2, maxRunsPerDay: 3, dailyBudgetUsd: 1 };
    const at = (active: number, runs: number, cost: number) =>
      userUsage([line("ann")], input({ limitsOf: () => limits, active: new Map([["ann", active]]), runsToday: new Map([["ann", runs]]), costToday: new Map([["ann", cost]]) }))[0]!.atLimit;
    expect(at(2, 0, 0)).toEqual(["maxConcurrent"]);
    expect(at(0, 3, 0)).toEqual(["maxRunsPerDay"]);
    expect(at(0, 0, 1)).toEqual(["dailyBudgetUsd"]);
    expect(at(1, 2, 0.5)).toEqual([]);
    expect(at(2, 3, 1)).toEqual(["maxConcurrent", "maxRunsPerDay", "dailyBudgetUsd"]);
  });

  it("compares the budget with the exact cost, not the rounded one", () => {
    const base = { limitsOf: () => ({ dailyBudgetUsd: 1 }) };
    const below = userUsage([{ ...line("ann"), today: { runs: 0, costUsd: 1 } }], input({ ...base, costToday: new Map([["ann", 0.99996]]) }))[0]!;
    expect(below.atLimit).toEqual([]);
    expect(below.today.costUsd).toBe(1);
    const above = userUsage([line("ann")], input({ ...base, costToday: new Map([["ann", 1.00004]]) }))[0]!;
    expect(above.atLimit).toEqual(["dailyBudgetUsd"]);
    const tiny = userUsage([line("ann")], input({ limitsOf: () => ({ dailyBudgetUsd: 0.00001 }), costToday: new Map([["ann", 0.00002]]) }))[0]!;
    expect(tiny.atLimit).toEqual(["dailyBudgetUsd"]);
  });

  it("takes runs today and active from the maps, with 0 for a missing key", () => {
    const out = userUsage([line("ann"), line("")], input({ active: new Map([["", 2]]), runsToday: new Map([["ann", 4]]) }));
    expect(out[0]).toMatchObject({ active: 0, today: { runs: 4 } });
    expect(out[1]).toMatchObject({ active: 2, today: { runs: 0 } });
  });

  it("adds accounts with limits or active runs but no line, after the lines with runs, sorted by name", () => {
    const names = new Map([["a1", "Zed"], ["a2", "Amy"], ["a3", "Nobody"], ["a4", "Busy"], ["a5", "Ran"]]);
    const out = userUsage([line("a5")], input({
      names,
      limitsOf: (id) => (id === "a1" || id === "a2" ? { maxRunsPerDay: 2 } : {}),
      active: new Map([["a4", 1]]),
    }));
    expect(out.map((u) => u.name)).toEqual(["Ran", "Amy", "Busy", "Zed"]);
    expect(out[1]).toEqual({ owner: "a2", name: "Amy", runs: 0, costUsd: 0, today: T0, active: 0, limits: { maxRunsPerDay: 2 }, atLimit: [] });
    expect(out[2]!.active).toBe(1);
  });
});
