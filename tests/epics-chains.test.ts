import { describe, expect, it } from "vitest";
import { buildChains, CYCLE_WORDS } from "../src/epics/chains.js";
import { buildEpics, type EpicStory, type StoryState } from "../src/epics/model.js";
import type { IssueRecord } from "../src/queue/issue-list.js";

const rec = (number: number, over: Partial<IssueRecord> = {}): IssueRecord => ({
  number, title: `Story ${number}`, state: "open", labels: ["claude-factory"],
  createdAt: "2026-01-01T12:00:00Z", dependsOn: [], ...over,
});
const story = (issue: number, state: StoryState = "waiting", over: Partial<EpicStory> = {}): EpicStory =>
  ({ issue, title: `Story ${issue}`, state, createdAt: "2026-01-01T12:00:00Z", ...over });
type Full = [number[], StoryState?, Partial<IssueRecord>?];
type Def = number[] | Full;
/** `defs`: story number → its depends-on numbers, or [depends-on numbers, state, record overrides]. */
function chains(defs: Record<number, Def>, extra: IssueRecord[] = []) {
  const nums = Object.keys(defs).map(Number);
  const full = (n: number): Full => {
    const d = defs[n]!;
    return Array.isArray(d[0]) ? (d as Full) : [d as number[]];
  };
  const stories = nums.map((n) => story(n, full(n)[1] ?? "waiting"));
  const records = [...nums.map((n) => rec(n, { dependsOn: full(n)[0], ...(full(n)[2] ?? {}) })), ...extra];
  return { stories, records, result: buildChains(stories, records) };
}

describe("buildChains", () => {
  it("has no dependencies: order by issue number", () => {
    const { result: r } = chains({ 3: [], 1: [], 2: [] });
    expect(r.order).toEqual([1, 2, 3]);
    expect(r.edges).toEqual([]);
    expect(r.nodes.map((n) => n.level)).toEqual([0, 0, 0]);
    expect(r.criticalPath).toEqual({ stories: [1], remaining: 1, at: 1 });
  });

  it("follows one chain", () => {
    const { result: r } = chains({ 1: [], 2: [1], 3: [2] });
    expect(r.order).toEqual([1, 2, 3]);
    expect(r.nodes.map((n) => n.level)).toEqual([0, 1, 2]);
    expect(r.edges).toEqual([{ from: 2, to: 1, critical: true }, { from: 3, to: 2, critical: true }]);
    expect(r.criticalPath).toEqual({ stories: [1, 2, 3], remaining: 3, at: 1 });
  });

  it("breaks ties by issue number", () => {
    const { result: r } = chains({ 1: [5], 2: [], 3: [], 5: [] });
    expect(r.order).toEqual([2, 3, 5, 1]);
  });

  it("handles a diamond", () => {
    const { result: r } = chains({ 1: [], 2: [1], 3: [1], 4: [2, 3] });
    expect(r.order).toEqual([1, 2, 3, 4]);
    expect(r.edges).toHaveLength(4);
    expect(r.criticalPath).toEqual({ stories: [1, 2, 4], remaining: 3, at: 1 });
    expect(r.edges.find((e) => e.from === 4 && e.to === 3)?.critical).toBeUndefined();
    expect(r.nodes.find((n) => n.issue === 3)?.critical).toBeUndefined();
  });

  it("picks the lowest chain of two of equal length", () => {
    const { result: r } = chains({ 1: [], 2: [1], 3: [], 4: [3] });
    expect(r.order).toEqual([1, 2, 3, 4]);
    expect(r.criticalPath.stories).toEqual([1, 2]);
  });

  it("keeps a done story in the middle on the path", () => {
    const { result: r } = chains({ 1: [], 2: [1, ], 3: [2] });
    expect(r.criticalPath.stories).toEqual([1, 2, 3]);
    const m = chains({ 1: [], 2: [1], 3: [2] }).stories.map((s) => (s.issue === 2 ? { ...s, state: "done" as const } : s));
    const { records } = chains({ 1: [], 2: [1], 3: [2] });
    const r2 = buildChains(m, records);
    expect(r2.criticalPath).toEqual({ stories: [1, 2, 3], remaining: 2, at: 1 });
  });

  it("cuts done stories before the first not-done one", () => {
    const { result: r } = chains({ 1: [[], "done"], 2: [[1]], 3: [[2]] } as never);
    expect(r.criticalPath).toEqual({ stories: [2, 3], remaining: 2, at: 2 });
  });

  it("prefers more not-done stories over a longer chain of done ones", () => {
    const { result: r } = chains({
      1: [[], "done"], 2: [[1], "done"], 3: [[2]],
      4: [[]], 5: [[4]],
    } as never);
    expect(r.criticalPath.stories).toEqual([4, 5]);
  });

  it("has an empty path when all is done", () => {
    const { result: r } = chains({ 1: [[], "done"], 2: [[1], "done"] } as never);
    expect(r.criticalPath).toEqual({ stories: [], remaining: 0 });
    expect(r.order).toEqual([1, 2]);
  });

  it("reports a cycle once", () => {
    const { result: r } = chains({ 1: [2], 2: [3], 3: [1], 4: [1] });
    expect(r.cycles).toEqual([[1, 2, 3]]);
    expect(r.nodes.filter((n) => n.cycle === 0).map((n) => n.issue)).toEqual([1, 2, 3]);
    expect(new Set(r.nodes.filter((n) => n.cycle === 0).map((n) => n.level)).size).toBe(1);
    expect(r.order).toEqual([1, 2, 3, 4]);
    expect(r.criticalPath).toEqual({ stories: [1, 2, 3, 4], remaining: 4, at: 1 });
  });

  it("counts only the not-done story of a cycle", () => {
    const { result: r } = chains({ 1: [[2], "done"], 2: [[1]] } as never);
    expect(r.cycles).toEqual([[1, 2]]);
    expect(r.criticalPath).toEqual({ stories: [1, 2], remaining: 1, at: 2 });
  });

  it("follows a split original to its parts, also a part of a part", () => {
    const { result: r } = chains({ 2: [[], "split"], 3: [[], "waiting", { partOf: 2 }], 4: [[], "split", { partOf: 2 }], 5: [[2]] } as never, [
      rec(6, { partOf: 4 }), rec(7, { partOf: 4 }),
    ]);
    expect(r.nodes.find((n) => n.issue === 2)).toBeUndefined();
    expect(r.nodes.find((n) => n.issue === 5)?.dependsOn).toEqual([3]);
    const full = chains({
      2: [[], "split"], 3: [[], "waiting", { partOf: 2 }], 4: [[], "split", { partOf: 2 }],
      5: [[2]], 6: [[], "waiting", { partOf: 4 }], 7: [[], "waiting", { partOf: 4 }],
    } as never).result;
    expect(full.nodes.find((n) => n.issue === 5)?.dependsOn).toEqual([3, 6, 7]);
    expect(full.edges.filter((e) => e.from === 5).map((e) => e.to)).toEqual([3, 6, 7]);
  });

  it("does not make a part wait for its own split original", () => {
    const { result: r } = chains({
      2: [[], "split"], 3: [[2], "waiting", { partOf: 2 }], 4: [[], "waiting", { partOf: 2 }],
    } as never);
    expect(r.edges).toEqual([]);
    expect(r.cycles).toEqual([]);
  });

  it("survives a partOf loop in the records", () => {
    const { result: r } = chains({
      1: [[2]], 2: [[], "split", { partOf: 3 }], 3: [[], "split", { partOf: 2 }],
    } as never);
    expect(r.order).toEqual([1]);
  });

  it("names outside dependencies without following them", () => {
    const { result: r } = chains({ 1: [], 2: [[99, 500]] } as never, [rec(99, { dependsOn: [98] })]);
    expect(r.nodes.find((n) => n.issue === 2)?.outside).toEqual([99, 500]);
    expect(r.outside).toEqual([{ issue: 99, title: "Story 99" }, { issue: 500 }]);
    expect(r.edges).toEqual([]);
  });

  it("ignores a dropped dependency", () => {
    const { result: r } = chains({ 1: [[], "dropped"], 2: [[1]] } as never);
    expect(r.edges).toEqual([]);
    expect(r.outside).toEqual([]);
  });

  it("keeps a dependency on an open original (from buildEpics)", () => {
    const records = [
      rec(10, { stories: [5] }),
      rec(5, { epic: 10 }),
      rec(1, { epic: 10, partOf: 5, dependsOn: [5] }),
    ];
    const epic = buildEpics(records, { labels: ["claude-factory"], now: new Date("2026-01-07T12:00:00Z") }).epics[0]!;
    const r = buildChains(epic.stories, records);
    expect(r.nodes.find((n) => n.issue === 1)?.dependsOn).toEqual([5]);
    expect(r.order).toEqual([5, 1]);
  });

  it("keeps an outside ancestor as an outside dependency (from buildEpics)", () => {
    const records = [
      rec(10, { stories: [1] }),
      rec(1, { epic: 10, partOf: 50, dependsOn: [50] }),
      rec(50),
    ];
    const epic = buildEpics(records, { labels: ["claude-factory"], now: new Date("2026-01-07T12:00:00Z") }).epics[0]!;
    const r = buildChains(epic.stories, records);
    expect(r.nodes.find((n) => n.issue === 1)?.outside).toEqual([50]);
    expect(r.outside).toEqual([{ issue: 50, title: "Story 50" }]);
  });

  it("names a part of a split original that belongs to another epic (from buildEpics)", () => {
    const records = [
      rec(10, { stories: [5, 2] }),
      rec(20, { stories: [3] }),
      rec(2, { epic: 10, state: "closed" }),
      rec(3, { epic: 20, partOf: 2 }),
      rec(5, { epic: 10, dependsOn: [2] }),
    ];
    const epic = buildEpics(records, { labels: ["claude-factory"], now: new Date("2026-01-07T12:00:00Z") }).epics[0]!;
    const r = buildChains(epic.stories, records);
    const node = r.nodes.find((n) => n.issue === 5)!;
    expect(node.dependsOn).toEqual([]);
    expect(node.outside).toEqual([3]);
    expect(r.outside).toEqual([{ issue: 3, title: "Story 3" }]);
  });

  it("gives the same result for any input order", () => {
    const a = chains({ 1: [], 2: [1], 3: [1], 4: [2, 3], 5: [6], 6: [5] });
    const b = buildChains([...a.stories].reverse(), [...a.records].reverse());
    expect(b).toEqual(a.result);
  });

  it("handles a long chain without a stack error", () => {
    const n = 3000;
    const stories = Array.from({ length: n }, (_, i) => story(i + 1));
    const records = Array.from({ length: n }, (_, i) => rec(i + 1, { dependsOn: i === 0 ? [] : [i] }));
    const r = buildChains(stories, records);
    expect(r.order).toHaveLength(n);
    expect(r.criticalPath.remaining).toBe(n);
  });

  it("handles empty input", () => {
    expect(buildChains([], [])).toEqual({
      order: [], nodes: [], edges: [], outside: [], cycles: [], criticalPath: { stories: [], remaining: 0 },
    });
  });

  it("has the words for a cycle", () => {
    expect(CYCLE_WORDS).toBe("depend on each other");
  });
});
