import { describe, expect, it } from "vitest";
import { buildHistory, medianRunMs } from "../src/estimate.js";
import type { RunSummary } from "../src/engine/state.js";

const MIN = 60_000;
const sh = (id: string) => ({ id, type: "shell", run: "true" });
const rec = (id: string, min: number) => ({ id, type: "shell", ok: true, visit: 1, output: "", startedAt: "2026-10-01T00:00:00Z", durationMs: min * MIN, logFile: "" });
const run = (flow: string, i: number, b: number, over: Record<string, unknown> = {}) =>
  ({
    runId: `${flow}${i}`, flow, task: "t", status: "succeeded", startedAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-01T01:00:00Z",
    vars: { github_repo: "acme/app" }, repo: "/tmp/x", history: [rec("a", 5), rec("b", b), rec("c", 10)], totalCostUsd: 0,
    state: { next: null, steps: {}, visits: {} }, runDir: "/tmp/none", flowDef: { name: flow, steps: [sh("a"), sh("b"), sh("c")] }, ...over,
  }) as unknown as RunSummary;
// totals 25, 25, 30, 40, 40 min
const five = (flow: string, over: Record<string, unknown> = {}) => [10, 10, 15, 25, 25].map((b, i) => run(flow, i, b, over));

describe("medianRunMs", () => {
  it("is the median of whole story runs", () => {
    expect(medianRunMs(buildHistory(five("issue-gitflow")), "acme/app")).toBe(30 * MIN);
  });
  it("is undefined below MIN_SAMPLES", () => {
    expect(medianRunMs(buildHistory(five("issue-gitflow").slice(0, 2)), "acme/app")).toBeUndefined();
  });
  it("does not pool another repository", () => {
    const other = five("issue-gitflow", { vars: { github_repo: "acme/other" } });
    expect(medianRunMs(buildHistory(other), "acme/app")).toBeUndefined();
  });
  it("counts only story-building flows: planning and question runs change nothing", () => {
    expect(medianRunMs(buildHistory([...five("issue-plan"), ...five("epic-questions")]), "acme/app")).toBeUndefined();
    const mixed = buildHistory([...five("issue-gitflow").slice(0, 2), ...five("issue-plan")]);
    expect(medianRunMs(mixed, "acme/app")).toBeUndefined();
  });
  it("can be asked for one flow", () => {
    const h = buildHistory([...five("issue-gitflow").slice(0, 2), ...five("issue-code-daily")]);
    expect(medianRunMs(h, "acme/app", ["issue-code-daily"])).toBe(30 * MIN);
  });
  it("leaves out succeeded runs that only split the issue", () => {
    const split = [3, 3, 3, 3].map((m, i) => run("issue-gitflow", 10 + i, m, { history: [rec("a", 1), rec("create_split", m)] }));
    expect(medianRunMs(buildHistory([...five("issue-gitflow"), ...split]), "acme/app")).toBe(30 * MIN);
    expect(medianRunMs(buildHistory([...five("issue-gitflow").slice(0, 2), ...split]), "acme/app")).toBeUndefined();
  });
  it("ignores failed runs", () => {
    expect(medianRunMs(buildHistory(five("issue-gitflow", { status: "failed" })), "acme/app")).toBeUndefined();
  });
});
