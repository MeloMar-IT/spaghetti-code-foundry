import { describe, expect, it } from "vitest";
import type { RunBrief } from "../src/engine/state.js";
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
