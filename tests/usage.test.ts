import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spentTodayBy, type RunBrief } from "../src/engine/state.js";
import { runsStartedToday } from "../src/queue/usage.js";

const NOW = new Date(2026, 9, 7, 12, 0, 0);
const brief = (id: string, over: Partial<RunBrief> = {}): RunBrief =>
  ({ runId: id, flow: "f", status: "succeeded", startedAt: new Date(2026, 9, 7, 8, 0, 0).toISOString(), runDir: "/x", dirName: id, updatedAt: NOW.toISOString(), owner: "ann", ...over }) as RunBrief;

describe("runsStartedToday", () => {
  it("counts the runs of the owner that started on the local day", () => {
    const yesterday = new Date(2026, 9, 6, 23, 59, 0).toISOString();
    expect(runsStartedToday([brief("a"), brief("b"), brief("c", { startedAt: yesterday })], "ann", NOW)).toBe(2);
  });
  it("leaves out other owners and architect runs", () => {
    const list = [brief("a"), brief("b", { owner: "bob" }), brief("c", { source: "refinement 7d2b0c1e-0000-4000-8000-000000000000" }), brief("d", { owner: undefined })];
    expect(runsStartedToday(list, "ann", NOW)).toBe(1);
  });
  it("skips a run with an invalid start time", () => {
    expect(runsStartedToday([brief("a", { startedAt: "nonsense" }), brief("b")], "ann", NOW)).toBe(1);
  });
});

describe("spentTodayBy", () => {
  const put = (dir: string, id: string, over: Record<string, unknown>) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "run.json"), JSON.stringify({ runId: id, startedAt: new Date(2026, 9, 7, 8, 0, 0).toISOString(), totalCostUsd: 1, owner: "ann", ...over }));
  };
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "factory-spent-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("sums only the owner's runs of today", () => withDir((dir) => {
    put(dir, "20261007-080000-0001", {});
    put(dir, "20261007-080000-0002", { totalCostUsd: 0.5 });
    put(dir, "20261007-080000-0003", { owner: "bob", totalCostUsd: 7 });
    put(dir, "20261007-080000-0004", { owner: undefined, totalCostUsd: 7 });
    put(dir, "20261005-080000-0005", { startedAt: new Date(2026, 9, 5, 8, 0, 0).toISOString(), totalCostUsd: 7 });
    expect(spentTodayBy(dir, "ann", NOW)).toBeCloseTo(1.5);
    expect(spentTodayBy(dir, "bob", NOW)).toBe(7);
    expect(spentTodayBy(dir, "nobody", NOW)).toBe(0);
  }));

  it("skips a broken run.json and a cost that is not a number", () => withDir((dir) => {
    put(dir, "20261007-080000-0001", {});
    mkdirSync(join(dir, "20261007-080000-0002"));
    writeFileSync(join(dir, "20261007-080000-0002", "run.json"), "{ not json");
    put(dir, "20261007-080000-0003", { totalCostUsd: "x" });
    expect(spentTodayBy(dir, "ann", NOW)).toBe(1);
  }));

  it("stops at a run older than two days, like spentToday", () => withDir((dir) => {
    put(dir, "20261007-080000-0001", {});
    put(dir, "20261001-080000-0002", { startedAt: new Date(2026, 9, 1, 8, 0, 0).toISOString() });
    // listed after the old one, so never reached
    put(dir, "20260930-080000-0003", {});
    expect(spentTodayBy(dir, "ann", NOW)).toBe(1);
  }));

  it("ignores a missing folder", () => {
    expect(spentTodayBy(join(tmpdir(), "factory-no-such-dir"), "ann", NOW)).toBe(0);
  });
});
