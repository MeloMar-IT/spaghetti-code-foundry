import { describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { computeStats, supersededRuns, todayCostByOwner } from "../src/stats.js";

const T0 = { runs: 0, costUsd: 0 };
const run = (runId: string, status: string, startedAt: string, vars: Record<string, string> = {}, extra: { owner?: string; totalCostUsd?: number; source?: string } = {}) =>
  ({ runId, status, startedAt, flow: "f", vars, history: [], totalCostUsd: 0, ...extra }) as unknown as RunSummary;

describe("needs a human", () => {
  it("doesn't count stopped or waiting runs that a newer run on the same issue replaced", () => {
    const runs = [
      run("old-plan", "stopped", "2026-09-29T10:00:00Z", { github_repo: "a/b", issue: "79" }),
      run("built", "succeeded", "2026-09-30T08:00:00Z", { github_repo: "a/b", issue: "79" }),
      run("asks", "stopped", "2026-09-30T09:00:00Z", { github_repo: "a/b", issue: "80" }),
      run("approve", "waiting", "2026-09-30T09:00:00Z", { github_repo: "a/b", issue: "81" }),
      run("local", "stopped", "2026-09-28T09:00:00Z"),
    ];
    expect([...supersededRuns(runs)]).toEqual(["old-plan"]);
    const t = computeStats(runs, 30, new Date("2026-09-30T12:00:00Z")).totals;
    expect(t.stopped).toBe(2); // #80 and the local run, not the replaced #79 plan run
    expect(t.waiting).toBe(1);
  });
});

describe("byUser", () => {
  const NOW = new Date("2026-09-30T12:00:00Z");
  const at = "2026-09-29T10:00:00Z";
  const units = (s: ReturnType<typeof computeStats>) => Math.round(s.byUser.reduce((a, u) => a + u.costUsd * 1e4, 0));

  it("groups by owner, counts runs and sorts highest cost first", () => {
    const s = computeStats([
      run("a1", "succeeded", at, {}, { owner: "ann", totalCostUsd: 0.5 }),
      run("a2", "failed", at, {}, { owner: "ann", totalCostUsd: 0.5 }),
      run("b1", "succeeded", at, {}, { owner: "bob", totalCostUsd: 3 }),
      run("c1", "succeeded", at, {}, { owner: "cy", totalCostUsd: 0.25 }),
    ], 30, NOW);
    expect(s.byUser).toEqual([{ owner: "bob", runs: 1, costUsd: 3, today: T0 }, { owner: "ann", runs: 2, costUsd: 1, today: T0 }, { owner: "cy", runs: 1, costUsd: 0.25, today: T0 }]);
  });

  it("puts runs without an owner on one line with an empty owner", () => {
    const s = computeStats([run("x1", "succeeded", at, {}, { totalCostUsd: 1 }), run("x2", "failed", at, {}, { totalCostUsd: 1 })], 30, NOW);
    expect(s.byUser).toEqual([{ owner: "", runs: 2, costUsd: 2, today: T0 }]);
  });

  it("leaves out runs older than the days asked for", () => {
    const s = computeStats([run("old", "succeeded", "2026-01-01T10:00:00Z", {}, { owner: "ann", totalCostUsd: 9 }), run("new", "succeeded", at, {}, { owner: "bob", totalCostUsd: 1 })], 30, NOW);
    expect(s.byUser).toEqual([{ owner: "bob", runs: 1, costUsd: 1, today: T0 }]);
  });

  it("gives an empty list without runs", () => {
    expect(computeStats([], 30, NOW).byUser).toEqual([]);
  });

  it("adds up to the total when the lines round up", () => {
    const s = computeStats(["a", "b", "c"].map((o) => run(o, "succeeded", at, {}, { owner: o, totalCostUsd: 0.00004 })), 30, NOW);
    expect(s.totals.costUsd).toBe(0.0001);
    expect(units(s)).toBe(1);
    expect(s.byUser.every((u) => u.costUsd >= 0)).toBe(true);
  });

  it("adds up to the total when the lines round down, with no negative line, sorted by the final costs", () => {
    const s = computeStats(["a", "b", "c", "d"].map((o) => run(o, "succeeded", at, {}, { owner: o, totalCostUsd: 0.00006 })), 30, NOW);
    expect(s.totals.costUsd).toBe(0.0002);
    expect(units(s)).toBe(2);
    expect(s.byUser.every((u) => u.costUsd >= 0)).toBe(true);
    const costs = s.byUser.map((u) => u.costUsd);
    expect(costs).toEqual([...costs].sort((x, y) => y - x));
  });
});

describe("today", () => {
  const NOW = new Date(2026, 8, 30, 12);
  const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

  it("counts only runs that started on the local day of now", () => {
    const s = computeStats([
      run("before", "succeeded", local(29, 23, 59), {}, { owner: "ann", totalCostUsd: 1 }),
      run("start", "succeeded", local(30, 0, 0), {}, { owner: "ann", totalCostUsd: 2 }),
      run("noon", "succeeded", local(30, 9), {}, { owner: "ann", totalCostUsd: 0.5 }),
    ], 30, NOW);
    expect(s.byUser).toEqual([{ owner: "ann", runs: 3, costUsd: 3.5, today: { runs: 2, costUsd: 2.5 } }]);
  });

  it("leaves architect runs out of the user's runs today, but not out of the costs or the repository", () => {
    const s = computeStats([
      run("a", "succeeded", local(30, 9), { github_repo: "a/b" }, { owner: "ann", totalCostUsd: 1 }),
      run("r", "succeeded", local(30, 10), { github_repo: "a/b" }, { owner: "ann", totalCostUsd: 0.5, source: "refinement s1" }),
      run("old", "succeeded", local(28, 10), { github_repo: "c/d" }, { owner: "ann", totalCostUsd: 4 }),
    ], 30, NOW);
    expect(s.byUser[0]).toEqual({ owner: "ann", runs: 3, costUsd: 5.5, today: { runs: 1, costUsd: 1.5 } });
    expect(s.byRepo.find((r) => r.repo === "a/b")!.today).toEqual({ runs: 2, costUsd: 1.5 });
    expect(s.byRepo.find((r) => r.repo === "c/d")!.today).toEqual({ runs: 0, costUsd: 0 });
  });

  it("adds today's user costs up to today's total, with no negative line", () => {
    const s = computeStats(["a", "b", "c"].map((o) => run(o, "succeeded", local(30, 9), {}, { owner: o, totalCostUsd: 0.00004 })), 30, NOW);
    expect(Math.round(s.byUser.reduce((a, u) => a + u.today.costUsd * 1e4, 0))).toBe(1);
    expect(s.byUser.every((u) => u.today.costUsd >= 0)).toBe(true);
  });

  it("gives nothing without runs", () => {
    const s = computeStats([], 30, NOW);
    expect(s.byUser).toEqual([]);
    expect(s.byRepo).toEqual([]);
  });

  it("gives the exact cost per owner for today", () => {
    const m = todayCostByOwner([
      run("a", "succeeded", local(30, 9), {}, { owner: "ann", totalCostUsd: 0.99996 }),
      run("b", "succeeded", local(29, 9), {}, { owner: "ann", totalCostUsd: 5 }),
      run("c", "succeeded", local(30, 9), {}, { totalCostUsd: 1 }),
    ], NOW);
    expect(m.get("ann")).toBe(0.99996);
    expect(m.get("")).toBe(1);
  });
});
