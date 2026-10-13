import { describe, expect, it } from "vitest";
import { COLUMNS } from "../src/board.js";
import { buildEpics, growthText, NO_EPIC, STATE_WORDS, type EpicsOptions, type RunState } from "../src/epics/model.js";
import type { IssueRecord } from "../src/queue/issue-list.js";
import { statusName } from "../src/words.js";

const rec = (number: number, over: Partial<IssueRecord> = {}): IssueRecord => ({
  number, title: `Story ${number}`, state: "open", labels: ["claude-factory"],
  createdAt: "2026-01-01T12:00:00Z", dependsOn: [], ...over,
});
const opts = (over: Partial<EpicsOptions> = {}): EpicsOptions => ({ labels: ["claude-factory"], now: new Date("2026-01-07T12:00:00Z"), ...over });
const closed = (at: string, reason = "completed") => ({ state: "closed" as const, closedAt: at, stateReason: reason });
const stateOf = (m: ReturnType<typeof buildEpics>, n: number) =>
  [...m.epics.flatMap((e) => e.stories), ...m.noEpic.stories].find((s) => s.issue === n)?.state;

describe("buildEpics", () => {
  it("counts a big epic: done, open, split, re-split, dropped, unlabelled", () => {
    const records = [
      rec(1, { title: "Epic", createdAt: "2026-01-01T10:00:00Z", stories: [10] }),
      rec(2, { epic: 1, ...closed("2026-01-05T09:00:00Z") }),
      rec(3, { epic: 1, ...closed("2026-01-03T09:00:00Z") }),
      rec(4, { parent: 1 }),
      rec(5, { epicLabel: { name: "1", issue: 1 }, createdAt: "2026-01-02T12:00:00Z" }),
      rec(6, { partOf: 3, createdAt: "2026-01-03T12:00:00Z", ...closed("2026-01-04T09:00:00Z") }),
      rec(7, { partOf: 3, createdAt: "2026-01-03T12:00:00Z", ...closed("2026-01-06T09:00:00Z") }),
      rec(8, { partOf: 6, createdAt: "2026-01-04T12:00:00Z" }),
      rec(9, { partOf: 6, createdAt: "2026-01-04T12:00:00Z" }),
      rec(10, { createdAt: "2026-01-02T12:00:00Z", ...closed("2026-01-04T10:00:00Z", "not_planned") }),
      rec(11, { epic: 1, labels: [], createdAt: "2026-01-02T12:00:00Z" }),
      rec(12, { epic: 1, labels: ["factory:done"] }),
      rec(13),
      rec(14, { partOf: 13 }),
    ];
    const states = new Map<number, RunState>([[4, "working"], [8, "your_turn"], [9, "failed"]]);
    const m = buildEpics(records, opts({ doneLabels: ["factory:done"], states }));
    expect(m.epics).toHaveLength(1);
    const e = m.epics[0]!;
    expect(e.key).toBe("#1");
    expect(e.title).toBe("Epic");
    expect(e.counts).toEqual({ done: 3, working: 1, waiting: 2, your_turn: 1, failed: 1, split: 2, dropped: 1 });
    expect(e.total).toBe(8);
    expect(e.notHanded).toBe(1);
    expect(e.stories.map((s) => s.issue)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(stateOf(m, 6)).toBe("split");
    expect(stateOf(m, 11)).toBe("waiting");
    // at the start: the originals of the first day (#2, #3, #4, #12), not later parts
    expect(e.growth).toEqual({ atStart: 4, now: 8, split: 2 });
    expect(growthText(e.growth)).toBe("4 at the start, 8 now (2 were split)");
    expect(e.series.map((p) => [p.day, p.stories, p.done])).toEqual([
      ["2026-01-01", 4, 0], ["2026-01-02", 7, 0], ["2026-01-03", 8, 0], ["2026-01-04", 8, 0],
      ["2026-01-05", 8, 1], ["2026-01-06", 8, 2], ["2026-01-07", 8, 2],
    ]);
    expect(e.doneUndated).toBe(1); // #12 is done by label: counted, but on no day
    expect(e.finished).toBe(false);
    expect(m.noEpic.title).toBe(NO_EPIC);
    expect(m.noEpic.stories.map((s) => s.issue)).toEqual([13, 14]);
    expect(e.stories.length + m.noEpic.stories.length).toBe(m.stories);
    expect(m.stories).toBe(13);
  });

  it("finds epics by label only, by priority, through parts and without cycles", () => {
    const m = buildEpics([
      rec(1, { epicLabel: { name: "Updates" } }),
      rec(2, { epic: 5, parent: 6 }),
      rec(3, { partOf: 5 }),
      rec(4, { partOf: 5 }),
      rec(7, { stories: [8, 9] }),
      rec(8), rec(9, { epic: 8 }),
      rec(20, { partOf: 21 }), rec(21, { partOf: 20 }),
      rec(30, { epic: 31 }), rec(31, { epic: 32 }),
    ], opts());
    const keys = m.epics.map((e) => e.key);
    expect(keys).toEqual(["#5", "#6", "#8", "#31", "#32", "label:updates"]);
    expect(m.epics.find((e) => e.key === "#5")!.stories.map((s) => s.issue)).toEqual([2, 3, 4]);
    expect(m.epics.find((e) => e.key === "#5")!.title).toBe("#5");
    expect(m.epics.find((e) => e.key === "#5")!.startedAt).toBe("2026-01-01T12:00:00Z");
    expect(m.epics.find((e) => e.key === "label:updates")!.issue).toBeUndefined();
    expect(m.epics.find((e) => e.key === "#8")!.stories.map((s) => s.issue)).toEqual([9]);
    // 7 holds a list nobody names: not an epic, just a story; 8 is an epic but 8 itself is no story
    expect(m.noEpic.stories.map((s) => s.issue)).toEqual([7, 20, 21]);
    expect(m.epics.find((e) => e.key === "#31")!.stories.map((s) => s.issue)).toEqual([30]);
    expect(m.epics.reduce((n, e) => n + e.stories.length, 0) + m.noEpic.stories.length).toBe(m.stories);
  });

  it("assigns a story by the epic issue's list and a part of the epic issue to it", () => {
    const m = buildEpics([rec(1, { stories: [2] }), rec(2), rec(3, { epic: 1 }), rec(4, { partOf: 1 })], opts());
    expect(m.epics[0]!.stories.map((s) => s.issue)).toEqual([2, 3, 4]);
  });

  it("knows split, dropped and done in the corner cases", () => {
    const m = buildEpics([
      rec(1),
      rec(2, { epic: 1, ...closed("2026-01-02T00:00:00Z", "not_planned") }),
      rec(3, { partOf: 2 }),
      rec(4, { epic: 1, ...closed("2026-01-02T00:00:00Z", "NOT_PLANNED") }),
      rec(5, { epic: 1 }), rec(6, { partOf: 5 }),
      rec(7, { epic: 1, labels: ["Claude-Factory"] }),
    ], opts());
    expect(stateOf(m, 2)).toBe("split");
    expect(stateOf(m, 3)).toBe("waiting");
    expect(stateOf(m, 4)).toBe("dropped");
    expect(stateOf(m, 5)).toBe("waiting");
    expect(stateOf(m, 7)).toBe("waiting");
    expect(m.epics[0]!.notHanded).toBe(0);
  });

  it("counts unlabelled stories as waiting, whatever the run state", () => {
    const states = new Map<number, RunState>([[2, "working"], [3, "your_turn"], [4, "failed"]]);
    const recs = [rec(1), rec(2, { epic: 1, labels: [] }), rec(3, { epic: 1, labels: ["x"] }), rec(4, { epic: 1, labels: [] }), rec(5, { epic: 1 })];
    const e = buildEpics(recs, opts({ states })).epics[0]!;
    expect(e.stories.slice(0, 3).map((s) => [s.state, s.notHanded])).toEqual([["waiting", true], ["waiting", true], ["waiting", true]]);
    expect(e.notHanded).toBe(3);
    const none = buildEpics(recs, opts({ labels: [], states })).epics[0]!;
    expect(none.notHanded).toBe(0);
    expect(none.counts.working).toBe(1);
    expect(none.counts.failed).toBe(1);
  });

  it("gives when a finished epic finished and how long it took", () => {
    const e = buildEpics([
      rec(1, { createdAt: "2026-01-01T00:00:00Z" }),
      rec(2, { epic: 1, ...closed("2026-01-03T00:00:00Z") }),
      rec(3, { epic: 1, ...closed("2026-01-09T00:00:00Z") }),
      rec(4, { epic: 1, ...closed("2026-01-04T00:00:00Z", "not_planned") }),
    ], opts({ now: new Date("2026-02-01T00:00:00Z") })).epics[0]!;
    expect(e.finished).toBe(true);
    expect(e.finishedAt).toBe("2026-01-09T00:00:00Z");
    expect(e.tookMs).toBe(8 * 86_400_000);
    expect(e.series.at(-1)).toEqual({ day: "2026-01-09", stories: 2, done: 2 });
  });

  it("counts a removal after the last completion in the finish date and the series", () => {
    const e = buildEpics([
      rec(1, { createdAt: "2026-01-01T00:00:00Z" }),
      rec(2, { epic: 1, ...closed("2026-01-03T00:00:00Z") }),
      rec(3, { epic: 1, ...closed("2026-01-09T00:00:00Z", "not_planned") }),
    ], opts({ now: new Date("2026-02-01T00:00:00Z") })).epics[0]!;
    expect(e.finishedAt).toBe("2026-01-09T00:00:00Z");
    expect(e.series.at(-1)).toEqual({ day: "2026-01-09", stories: e.total, done: e.counts.done });
  });

  it("leaves the finish unknown when a done story has no date", () => {
    const e = buildEpics([
      rec(1, { createdAt: "2026-01-01T00:00:00Z" }),
      rec(2, { epic: 1, ...closed("2026-01-03T00:00:00Z") }),
      rec(3, { epic: 1, labels: ["factory:done"], createdAt: "2026-01-05T00:00:00Z" }),
    ], opts({ doneLabels: ["factory:done"] })).epics[0]!;
    expect(e.finished).toBe(true);
    expect(e.finishedAt).toBeUndefined();
    expect(e.tookMs).toBeUndefined();
    expect(e.doneUndated).toBe(1);
    expect(e.series.at(-1)).toEqual({ day: "2026-01-07", stories: 2, done: 1 });
    expect(e.series.find((p) => p.day === "2026-01-05")).toEqual({ day: "2026-01-05", stories: 2, done: 1 });
  });

  it("does not change past days when only now moves (undated completions)", () => {
    const recs = [
      rec(1, { createdAt: "2026-01-01T00:00:00Z" }),
      rec(2, { epic: 1, labels: ["factory:done"] }),
      rec(3, { epic: 1, ...closed("2026-01-02T00:00:00Z") }),
    ];
    const at = (d: string) => buildEpics(recs, opts({ doneLabels: ["factory:done"], now: new Date(d) })).epics[0]!.series;
    const a = at("2026-01-04T12:00:00Z"), b = at("2026-01-05T12:00:00Z");
    expect(b.slice(0, a.length)).toEqual(a);
  });

  it("does not finish before it starts", () => {
    const e = buildEpics([
      rec(1, { createdAt: "2026-01-05T00:00:00Z" }),
      rec(2, { epic: 1, createdAt: "2026-01-01T00:00:00Z", ...closed("2026-01-03T00:00:00Z") }),
    ], opts()).epics[0]!;
    expect(e.finishedAt).toBe("2026-01-05T00:00:00Z");
    expect(e.tookMs).toBe(0);
    expect(e.series).toEqual([{ day: "2026-01-05", stories: 1, done: 1 }]);
  });

  it("is not finished with only dropped stories", () => {
    const e = buildEpics([rec(1), rec(2, { epic: 1, ...closed("2026-01-02T00:00:00Z", "not_planned") })], opts()).epics[0]!;
    expect(e.finished).toBe(false);
    expect(e.total).toBe(0);
  });

  it("keeps the series consistent at the edges", () => {
    const early = buildEpics([
      rec(1, { createdAt: "2026-01-05T00:00:00Z" }),
      rec(2, { epic: 1, createdAt: "2025-12-01T00:00:00Z" }),
    ], opts({ now: new Date("2026-01-06T00:00:00Z") })).epics[0]!;
    expect(early.series[0]).toEqual({ day: "2026-01-05", stories: 1, done: 0 });
    expect(early.growth.atStart).toBe(1);

    // now before the start: the series reaches the later stories so the last point equals the totals
    const before = buildEpics([
      rec(1, { createdAt: "2026-01-05T00:00:00Z" }),
      rec(2, { epic: 1, createdAt: "2026-01-07T00:00:00Z" }),
    ], opts({ now: new Date("2026-01-01T00:00:00Z") })).epics[0]!;
    expect(before.series.map((p) => [p.day, p.stories, p.done])).toEqual([["2026-01-05", 0, 0], ["2026-01-06", 0, 0], ["2026-01-07", 1, 0]]);

    const custom = buildEpics([rec(1), rec(2, { epic: 1 })], opts({ day: () => "2026-03-03" })).epics[0]!;
    expect(custom.series).toEqual([{ day: "2026-03-03", stories: 1, done: 0 }]);
  });

  it("gives nothing for no records", () => {
    const m = buildEpics([], opts());
    expect(m.epics).toEqual([]);
    expect(m.noEpic.stories).toEqual([]);
    expect(m.noEpic.total).toBe(0);
    expect(m.stories).toBe(0);
  });
});

describe("words", () => {
  it("uses the app's words", () => {
    expect(STATE_WORDS.done.toLowerCase()).toBe(statusName("done"));
    expect(STATE_WORDS.failed.toLowerCase()).toBe(statusName("failed"));
    const title = (id: string) => COLUMNS.find((c) => c.id === id)?.title;
    expect(STATE_WORDS.your_turn).toBe(title("your_turn"));
    expect(STATE_WORDS.failed).toBe(title("failed"));
    expect(STATE_WORDS.done).toBe(title("done"));
  });
  it("writes the growth", () => {
    expect(growthText({ atStart: 21, now: 95, split: 16 })).toBe("21 at the start, 95 now (16 were split)");
    expect(growthText({ atStart: 2, now: 3, split: 1 })).toBe("2 at the start, 3 now (1 was split)");
    expect(growthText({ atStart: 2, now: 3, split: 0 })).toBe("2 at the start, 3 now");
  });
});
