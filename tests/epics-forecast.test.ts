import { describe, expect, it } from "vitest";
import {
  forecastEpic, forecastEpics, LEAVES_OUT, MAX_WIDTH, paceDays, splitGrowth, type Forecast, type ForecastInput, type PaceDay,
} from "../src/epics/forecast.js";
import { buildEpics, type EpicStory } from "../src/epics/model.js";
import type { IssueRecord } from "../src/queue/issue-list.js";

const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = new Date("2026-10-14T12:00:00Z");
const pace = (counts: number[]): PaceDay[] => counts.map((done, i) => ({ from: "", to: new Date(NOW.getTime() - (counts.length - 1 - i) * DAY).toISOString(), done }));
const steady = (n: number) => pace(Array(14).fill(n));
const swinging = () => pace([0, 4, 0, 4, 0, 4, 0, 4, 0, 4, 0, 4, 0, 4]);
const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  now: NOW, total: 20, done: 10, leftParts: 0, otherLeft: 10, pace: steady(2), chain: 2, medianStoryMs: HOUR, partsPerStory: 1, ...over,
});
type Range = Extract<Forecast, { kind: "range" }>;
const range = (i: ForecastInput): Range => {
  const f = forecastEpic(i);
  if (f.kind !== "range") throw new Error(`not a range: ${f.kind}`);
  return f;
};
const t = (iso: string) => Date.parse(iso) - NOW.getTime();
const width = (f: Range) => t(f.latest) - t(f.earliest);

describe("forecastEpic", () => {
  it("base case", () => {
    const f = range(base());
    expect(t(f.expected)).toBeCloseTo(10 * DAY, -2);
    expect(t(f.earliest)).toBeCloseTo((10 * DAY) / 1.35, -2);
    expect(t(f.latest)).toBeCloseTo(13.5 * DAY, -2);
    expect(f.drivers).toEqual([{ kind: "pace", left: 10, perDay: 1 }]);
    expect(f.leavesOut).toEqual(["usage-limits", "answers"]);
  });
  it("more left is later, faster pace is earlier", () => {
    const b = range(base()), more = range(base({ total: 30 })), fast = range(base({ pace: steady(4) }));
    for (const k of ["earliest", "expected", "latest"] as const) {
      expect(Date.parse(more[k])).toBeGreaterThan(Date.parse(b[k]));
      expect(Date.parse(fast[k])).toBeLessThan(Date.parse(b[k]));
    }
  });
  it("a longer chain sets a lower bound", () => {
    const f = range(base({ chain: 8, medianStoryMs: 2 * DAY }));
    for (const k of ["earliest", "expected", "latest"] as const) expect(t(f[k])).toBeGreaterThanOrEqual(16 * DAY - 1);
    expect(f.drivers.map((d) => d.kind)).toEqual(["chain", "pace"]);
    expect(range(base({ chain: 3, medianStoryMs: 2 * DAY })).drivers.map((d) => d.kind)).toEqual(["pace", "chain"]);
  });
  it("a dominating chain keeps the uncertainty: swing widens, progress narrows", () => {
    const chain = { chain: 8, medianStoryMs: 2 * DAY };
    const steadyF = range(base(chain));
    expect(width(steadyF)).toBeGreaterThan(0);
    expect(width(range(base({ ...chain, pace: swinging() })))).toBeGreaterThan(width(steadyF));
    expect(width(range(base({ ...chain, done: 19, otherLeft: 0 })))).toBeLessThan(width(steadyF));
  });
  it("too early, no stories, finished", () => {
    expect(forecastEpic(base({ pace: pace([2, ...Array(13).fill(0)]) }))).toEqual({ kind: "too-early", reason: "little-history", leavesOut: LEAVES_OUT });
    expect(forecastEpic(base({ total: 0, done: 0 }))).toMatchObject({ kind: "too-early", reason: "no-stories" });
    expect(forecastEpic(base({ done: 20, pace: [] }))).toEqual({ kind: "finished" });
  });
  it("a swinging pace and little built widen the range; progress narrows it", () => {
    expect(width(range(base({ pace: swinging() })))).toBeGreaterThan(width(range(base())));
    const ratio = (f: Range) => t(f.latest) / t(f.earliest);
    expect(ratio(range(base({ total: 30, done: 0 })))).toBeGreaterThan(ratio(range(base({ total: 60, done: 30 }))));
    expect(width(range(base({ total: 20, done: 15 })))).toBeLessThan(width(range(base({ total: 20, done: 5 }))));
  });
  it("caps the width", () => {
    const f = range(base({ done: 0, pace: pace([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40]) }));
    expect(t(f.earliest)).toBeGreaterThan(0);
    expect(t(f.latest) / t(f.expected)).toBeCloseTo(1 + MAX_WIDTH, 5);
  });
  it("splits grow the work left, but not parts", () => {
    const f = range(base({ partsPerStory: 1.5 }));
    expect(t(f.expected)).toBeCloseTo(15 * DAY, -2);
    expect(f.drivers).toContainEqual({ kind: "splits", partsPerStory: 1.5 });
    expect(t(range(base({ partsPerStory: 1.5, leftParts: 10 })).expected)).toBeCloseTo(10 * DAY, -2);
  });
  it("no median: no floor, no chain driver", () => {
    const f = range(base({ chain: 50, medianStoryMs: undefined }));
    expect(f.drivers.map((d) => d.kind)).toEqual(["pace"]);
    expect(t(f.expected)).toBeCloseTo(10 * DAY, -2);
  });
  it("survives bad numbers", () => {
    expect(forecastEpic(base({ otherLeft: NaN, chain: -3, leftParts: NaN, partsPerStory: NaN, medianStoryMs: NaN })).kind).toBe("range");
  });
});

describe("paceDays", () => {
  it("has 14 windows ending at now and counts from < t <= to", () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const p = paceDays([NOW.toISOString(), ago(DAY), ago(DAY - 1), ago(2 * DAY), ago(14 * DAY), ago(14 * DAY - 1), "nope", ago(-1000)], NOW);
    expect(p).toHaveLength(14);
    expect(p[13]!.to).toBe(NOW.toISOString());
    expect(p[13]!.done).toBe(2); // now, and one day minus 1 ms ago
    expect(p[12]!.done).toBe(1); // exactly one day ago belongs to the window that ends there
    expect(p[11]!.done).toBe(1); // exactly two days ago
    expect(p[0]!.done).toBe(1); // 14 days ago + 1 ms; exactly 14 days ago is out
    expect(p.reduce((a, x) => a + x.done, 0)).toBe(5);
  });
});

const st = (issue: number, state: EpicStory["state"], partOf?: number): EpicStory => ({ issue, title: "", state, createdAt: "2026-01-01T00:00:00Z", ...(partOf ? { partOf } : {}) });

describe("splitGrowth", () => {
  it("nested splits: 10 originals, X into A,B, A into C,D,E", () => {
    const stories = [...Array.from({ length: 9 }, (_, i) => st(i + 1, "waiting")), st(10, "split"), st(11, "split", 10), st(12, "waiting", 10), st(13, "waiting", 11), st(14, "waiting", 11), st(15, "done", 11)];
    const g = splitGrowth(stories);
    expect(g.partsPerStory).toBeCloseTo(1.3, 10);
    expect(g.leftParts).toBe(3);
  });
  it("a partOf that names the epic issue is membership, not a split", () => {
    const g = splitGrowth([st(1, "waiting", 99), st(2, "waiting", 99), st(3, "split", 99), st(4, "waiting", 3), st(5, "waiting", 3)]);
    expect(g.partsPerStory).toBeCloseTo(4 / 3, 10);
    expect(g.leftParts).toBe(2);
    expect(splitGrowth([st(1, "waiting", 99), st(2, "waiting", 99)]).partsPerStory).toBe(1);
  });
  it("ignores dropped stories and is 1 without originals", () => {
    expect(splitGrowth([st(1, "waiting"), st(2, "dropped"), st(3, "dropped", 1)]).partsPerStory).toBe(1);
    expect(splitGrowth([]).partsPerStory).toBe(1);
  });
});

describe("forecastEpics", () => {
  const rec = (number: number, over: Partial<IssueRecord> = {}): IssueRecord => ({
    number, title: `Story ${number}`, state: "open", labels: ["claude-factory"], createdAt: "2026-10-01T12:00:00Z", dependsOn: [], ...over,
  });
  const closed = (daysAgo: number) => ({ state: "closed" as const, closedAt: new Date(NOW.getTime() - daysAgo * DAY + HOUR).toISOString(), stateReason: "completed" });
  const model = (extra: IssueRecord[] = []) => {
    const records = [
      rec(1, { stories: [10] }), rec(2, { stories: [20] }), rec(4, { stories: [30] }),
      ...[10, 11, 12].map((n, i) => rec(n, { epic: 1, ...closed(i + 1) })),
      rec(13, { epic: 1 }), rec(14, { epic: 1, dependsOn: [13] }), rec(15, { epic: 1, dependsOn: [14] }),
      rec(20, { epic: 2, ...closed(1) }), rec(21, { epic: 2 }),
      rec(30, { epic: 4, ...closed(2) }), rec(31, { epic: 4, ...closed(3) }),
      rec(40), rec(41, closed(1)),
      ...extra,
    ];
    return { records, model: buildEpics(records, { labels: ["claude-factory"], now: NOW }) };
  };
  const expected = (x: ReturnType<typeof model>) => (forecastEpics(x.model, x.records, { now: NOW }).forecasts.get("#1") as Range).expected;

  it("counts done stories of epics and 'No epic' in the pace, maps finished epics, uses the chain", () => {
    const { records, model: m } = model();
    const r = forecastEpics(m, records, { now: NOW, medianStoryMs: HOUR });
    expect(r.pace).toHaveLength(14);
    expect(r.pace.reduce((a, p) => a + p.done, 0)).toBe(7);
    expect(r.forecasts.get("#4")).toEqual({ kind: "finished" });
    const f = r.forecasts.get("#1") as Range;
    expect(f.kind).toBe("range");
    expect(f.chain).toBe(3);
  });
  it("stories added to another epic shrink this epic's share, so it ends later", () => {
    const more = model([50, 51, 52, 53, 54].map((n) => rec(n, { epic: 2 })));
    expect(Date.parse(expected(more))).toBeGreaterThan(Date.parse(expected(model())));
  });
});
