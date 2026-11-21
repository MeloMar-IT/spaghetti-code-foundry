import { describe, expect, it } from "vitest";
import { computeTotals, medianOf, weekOf } from "../collector/totals.js";
import { DURATION_EDGES_MS, PARTS_EDGES, emptyHistogram, type ShareReport } from "../src/metrics-share/report.js";
import { report } from "./collector-report.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const ids = ["1", "2", "3", "4"].map((c) => c.repeat(32));
const hist = (bucket: number, n: number, sum: number) => {
  const h = emptyHistogram(DURATION_EDGES_MS);
  h.counts[bucket] = n;
  h.sum = sum;
  return h;
};
const three = (f: (i: number) => Partial<ShareReport>, day = "2026-11-20") => [0, 1, 2].map((i) => report({ install: ids[i]!, day, ...f(i) }));
const dayOf = (rs: ShareReport[], day = "2026-11-20") => computeTotals(rs, NOW).days.find((d) => d.day === day);

describe("collector totals (#890)", () => {
  it("sums three installs of a day", () => {
    const d = dayOf(three((i) => ({
      accountsSharing: i + 1,
      changes: { runsStarted: i + 1, runsEnded: { succeeded: 1, failed: i, cancelled: 0 } },
      use: { bySource: {}, byFlow: { "issue-gitflow": 2 }, repositories: 1 },
    })))!;
    expect(d.installs).toBe(3);
    expect(d.accounts).toBe(6);
    expect(d.changes).toEqual({ runsStarted: 6, runsEnded: { succeeded: 3, failed: 3, cancelled: 0 } });
    expect(d.use).toEqual({ byFlow: { "issue-gitflow": 6 }, repositories: 3 });
  });

  it("merges histograms and gives their medians", () => {
    const rs = three((i) => ({ speed: { ...report().speed, runDuration: hist(1, i === 0 ? 2 : 1, 100_000) } }));
    const h = dayOf(rs)!.speed.runDuration as { counts: number[]; sum: number; count: number; median: number };
    expect(h.counts[1]).toBe(4);
    expect(h.count).toBe(4);
    expect(h.sum).toBe(300_000);
    expect(h.median).toBe(35_000);
    expect(medianOf([0, 0, 5, 0, 0, 0, 0, 0, 0, 0], PARTS_EDGES, true)).toBe(3);
    const open = new Array(DURATION_EDGES_MS.length + 1).fill(0);
    open[DURATION_EDGES_MS.length] = 3;
    expect(medianOf(open, DURATION_EDGES_MS, false)).toBe(DURATION_EDGES_MS[DURATION_EDGES_MS.length - 1]);
    expect(medianOf(new Array(13).fill(0), DURATION_EDGES_MS, false)).toBeUndefined();
    expect((dayOf(three(() => ({})))!.speed.queueTime as { median?: number }).median).toBeUndefined();
  });

  it("gives the parts median as a bucket edge", () => {
    const parts = () => {
      const h = emptyHistogram(PARTS_EDGES);
      h.counts[2] = 1;
      h.sum = 3;
      return h;
    };
    const d = dayOf(three(() => ({ splits: { issuesSplit: 1, partsPerSplit: parts() } })))!;
    expect(d.splits).toEqual({ issuesSplit: 3, partsPerSplit: { counts: [0, 0, 3, 0, 0, 0, 0, 0, 0, 0], sum: 9, count: 3, median: 3 } });
  });

  it("gives the quality shares", () => {
    const d = dayOf(three((i) => ({ quality: { firstPassTests: { passed: 1, counted: 2 }, mergeRate: { delivered: 0, counted: 0 }, evidence: { complete: i, counted: 3 } } })))!;
    expect(d.quality.firstPassTests).toEqual({ passed: 3, counted: 6, share: 0.5 });
    expect(d.quality.mergeRate).toEqual({ delivered: 0, counted: 0 });
    expect(d.quality.evidence).toEqual({ complete: 3, counted: 9, share: 0.3333 });
  });

  it("rounds cost and leaves out keys of fewer than 3 installs", () => {
    const d = dayOf(three((i) => ({
      cost: {
        byModel: { opus: { tokensIn: 1, tokensOut: 2, costUsd: 0.1 }, ...(i < 2 ? { haiku: { tokensIn: 1, tokensOut: 1 } } : {}) },
        byStep: {},
        costUsd: 0.1000001,
      },
      splits: i < 2 ? { issuesSplit: 1 } : {},
    })))!;
    expect(d.cost.costUsd).toBe(0.3);
    expect(d.cost.byModel).toEqual({ opus: { tokensIn: 3, tokensOut: 6, costUsd: 0.3 } });
    expect(d.splits).toEqual({});
  });

  it("leaves out a day of 2 installs", () => {
    const m = computeTotals(three(() => ({})).slice(0, 2), NOW);
    expect(m.days).toEqual([]);
    expect(m.weeks).toEqual([]);
    expect(m.sharing).toBeUndefined();
  });

  it("leaves out sums that would overflow", () => {
    const rs = three(() => ({
      cost: { byModel: {}, byStep: {}, costUsd: 1e308, modelFallbacks: Number.MAX_SAFE_INTEGER },
      rework: { repeatedSteps: {}, resumes: 1 },
      speed: { ...report().speed, runDuration: hist(1, 1, 1e308) },
    }));
    const m = computeTotals(rs, NOW);
    const text = JSON.stringify(m);
    expect(text).not.toContain("null");
    expect(text).not.toContain("Infinity");
    const d = m.days[0]!;
    expect(d.cost).toEqual({});
    expect(d.speed.runDuration).toBeUndefined();
    expect(d.rework.resumes).toBe(3);
    // a large but finite sum is kept, and rounding it does not overflow
    const big = computeTotals(three(() => ({ cost: { byModel: {}, byStep: {}, costUsd: 1e307 } })), NOW).days[0]!;
    expect(big.cost.costUsd).toBe(3e307);
  });

  it("groups weeks from Monday", () => {
    expect(weekOf("2026-11-22")).toBe("2026-11-16");
    expect(weekOf("2026-11-23")).toBe("2026-11-23");
    expect(weekOf("2026-11-16")).toBe("2026-11-16");
  });

  it("counts installs once in a week and takes each one's highest accounts", () => {
    const rs = [
      ...three(() => ({ accountsSharing: 1 }), "2026-11-16"),
      ...three((i) => ({ accountsSharing: i === 0 ? 4 : 1 }), "2026-11-17"),
    ];
    const w = computeTotals(rs, NOW).weeks.find((x) => x.week === "2026-11-16")!;
    expect(w.installs).toBe(3);
    expect(w.accounts).toBe(6);
    expect(w.changes.runsStarted).toBe(6);
  });

  it("shows 35 days and keeps older weeks", () => {
    const m = computeTotals(three(() => ({}), "2026-10-11"), NOW);
    expect(m.days).toEqual([]);
    expect(m.weeks.map((w) => w.week)).toEqual(["2026-10-05"]);
  });

  it("counts the installs that share over the last 7 days", () => {
    const rs = [...three((i) => ({ accountsSharing: i + 1 }), "2026-11-14"), report({ install: ids[0]!, day: "2026-11-19", accountsSharing: 5 })];
    expect(computeTotals(rs, NOW).sharing).toEqual({ since: "2026-11-13", installs: 3, accounts: 10 });
    expect(computeTotals(three(() => ({}), "2026-11-12"), NOW).sharing).toBeUndefined();
  });

  it("gives empty lists for no reports", () => {
    const m = computeTotals([], NOW);
    expect(m).toMatchObject({ version: 1, minInstalls: 3, days: [], weeks: [] });
    expect(m.sharing).toBeUndefined();
  });
});
