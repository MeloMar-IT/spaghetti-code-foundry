import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/epic-page-model.js" as string);
});
afterAll(() => restore());

const now = new Date("2026-10-14T09:00:00Z");
const timeZone = "Europe/Amsterdam";
const pts = (stories: number[], done: number[] = stories.map(() => 0)) =>
  stories.map((s, i) => ({ day: `2026-10-${String(10 + i).padStart(2, "0")}`, stories: s, done: done[i] }));

describe("epicHref", () => {
  it("puts the id in the path and the repository in the query", () => {
    expect(m.epicHref("acme/app", "12")).toBe("#/epics/12?repo=acme%2Fapp");
    expect(m.epicHref("acme/app", "l-bGFiZWw6eA")).toBe("#/epics/l-bGFiZWw6eA?repo=acme%2Fapp");
    expect(m.epicHref("acme/app", undefined)).toBe("#/epics");
  });
});

describe("chartPoints", () => {
  it("scales to a nice maximum and puts the first and last point on the edges", () => {
    const c = m.chartPoints(pts([2, 4, 7], [0, 1, 3]), { now });
    expect(c.max).toBe(10);
    expect(c.stories[0].x).toBe(c.left);
    expect(c.stories[2].x).toBe(c.width);
    expect(c.ticks.map((t: any) => t.value)).toEqual([0, 5, 10]);
    expect(c.ticks[0].y).toBe(c.height - c.bottom);
    expect(c.ticks[2].y).toBe(c.top);
    expect(c.paths.stories.startsWith("M")).toBe(true);
    expect(c.paths.done.startsWith("M")).toBe(true);
    expect(c.done[1].value).toBe(1);
  });

  it("puts a single point in the middle", () => {
    const c = m.chartPoints(pts([3]), { now });
    expect(c.stories[0].x).toBe(c.left + (c.width - c.left) / 2);
    expect(c.labels).toHaveLength(1);
  });

  it("is null for an empty or missing series", () => {
    expect(m.chartPoints([], { now })).toBeNull();
    expect(m.chartPoints(undefined, { now })).toBeNull();
    expect(m.chartPoints([{ day: "x" }], { now })).toBeNull();
  });

  it("has at most seven labels, the last one included, anchored at the ends", () => {
    const c = m.chartPoints(pts(Array.from({ length: 30 }, (_, i) => i)).map((p: any, i: number) => ({ ...p, day: `2026-09-${String(i + 1).padStart(2, "0")}` })), { now });
    expect(c.labels.length).toBeLessThanOrEqual(7);
    expect(c.labels[c.labels.length - 1].x).toBe(c.width);
    expect(c.labels[0].anchor).toBe("start");
    expect(c.labels[c.labels.length - 1].anchor).toBe("end");
  });

  it("rounds the maximum up to 1, 2 or 5 times a power of ten", () => {
    expect(m.niceMax(1)).toBe(1);
    expect(m.niceMax(0)).toBe(1);
    expect(m.niceMax(3)).toBe(5);
    expect(m.niceMax(12)).toBe(20);
    expect(m.niceMax(101)).toBe(200);
  });
});

describe("chartRows", () => {
  it("names the day as the server's UTC day, oldest first", () => {
    expect(m.chartRows([{ day: "2026-10-12", stories: 4, done: 1 }, { day: "2026-10-13", stories: 5, done: 2 }], { now })).toEqual([
      { day: "Mon 12 Oct", stories: 4, done: 1 }, { day: "Tue 13 Oct", stories: 5, done: 2 },
    ]);
    expect(m.chartRows(undefined, { now })).toEqual([]);
  });
});

describe("historyLines", () => {
  const range = (at: string, expected: string, over: any = {}) => ({ day: at.slice(0, 10), at, kind: "range", expected, earliest: expected, latest: expected, ...over });
  it("says how long ago, newest first, with the change against the forecast before", () => {
    const lines = m.historyLines([
      range("2026-10-11T08:00:00Z", "2026-10-11T10:00:00Z"),
      range("2026-10-13T08:00:00Z", "2026-10-13T10:00:00Z"),
      range("2026-10-14T07:00:00Z", "2026-10-12T10:00:00Z"),
    ], { timeZone, now });
    expect(lines.map((l: any) => l.text)).toEqual(["Today: Mon 12 Oct", "Yesterday: Tue 13 Oct", "3 days ago: Sun 11 Oct"]);
    expect(lines.map((l: any) => l.change)).toEqual(["1 day earlier", "2 days later", ""]);
    expect(lines[2].range).toBe("Sun 11 Oct");
  });

  it("shows no change when the day is the same", () => {
    const lines = m.historyLines([range("2026-10-12T08:00:00Z", "2026-10-13T10:00:00Z"), range("2026-10-13T08:00:00Z", "2026-10-13T12:00:00Z")], { timeZone, now });
    expect(lines.map((l: any) => l.change)).toEqual(["", ""]);
  });

  it("says too early to say, and compares only with range entries", () => {
    const lines = m.historyLines([range("2026-10-12T08:00:00Z", "2026-10-13T10:00:00Z"), { day: "2026-10-13", at: "2026-10-13T08:00:00Z", kind: "too-early" },
      range("2026-10-14T08:00:00Z", "2026-10-15T10:00:00Z"), { day: "x", at: "2026-10-14T08:30:00Z", kind: "too-early" }], { timeZone, now });
    expect(lines[0]).toMatchObject({ text: "Today: too early to say", range: "", change: "", kind: "too-early" });
    expect(lines[1].change).toBe("2 days later");
    expect(lines[2].text).toBe("Yesterday: too early to say");
  });

  it("counts the day in the person's time zone", () => {
    const lines = m.historyLines([range("2026-10-13T23:30:00Z", "2026-10-15T10:00:00Z")], { timeZone, now });
    expect(lines[0].text.startsWith("Today:")).toBe(true);
    const utc = m.historyLines([range("2026-10-13T23:30:00Z", "2026-10-15T10:00:00Z")], { timeZone: "UTC", now });
    expect(utc[0].text.startsWith("Yesterday:")).toBe(true);
  });

  it("skips entries with an invalid time, and takes missing history", () => {
    expect(m.historyLines([{ day: "x", at: "nope", kind: "range" }], { timeZone, now })).toEqual([]);
    expect(m.historyLines(undefined, { timeZone, now })).toEqual([]);
  });
});

describe("criticalPathView", () => {
  const stories = [
    { issue: 12, title: "Schema", state: "done", words: "Done" },
    { issue: 13, title: "API", state: "done", words: "Done" },
    { issue: 14, title: "Login", state: "working", words: "Working", status: "reviewing" },
    { issue: 15, title: "UI", state: "waiting", words: "Waiting" },
  ];
  const nodes = stories.map((s, i) => ({ issue: s.issue, title: s.title, state: s.state, done: s.state === "done", order: i, level: i, dependsOn: [], outside: [] }));
  const chains = (cp: any) => ({ order: [12, 13, 14, 15], nodes, edges: [], outside: [], cycles: [], criticalPath: cp });

  it("says how many are left, the chain and where it is now", () => {
    const v = m.criticalPathView(chains({ stories: [12, 13, 14, 15], remaining: 2, at: 14 }), stories);
    expect(v.summary).toBe("The longest chain still to do has 2 stories left.");
    expect(v.path).toBe("#12 (done) → #13 (done) → #14 → #15");
    expect(v.now).toBe("Now at #14 Login: Working — reviewing");
  });

  it("says story for one", () => {
    expect(m.criticalPathView(chains({ stories: [15], remaining: 1, at: 15 }), stories).summary).toContain("has 1 story left");
  });

  it("tells every story done from done plus split", () => {
    const done = [{ issue: 1, title: "A", state: "done", words: "Done" }];
    const c = { nodes: [{ issue: 1, title: "A", state: "done", done: true, order: 0, level: 0, dependsOn: [], outside: [] }], edges: [], outside: [], cycles: [], order: [1], criticalPath: { stories: [], remaining: 0 } };
    expect(m.criticalPathView(c, done).summary).toBe("Nothing left on any chain: every story is done.");
    const mixed = [...done, { issue: 2, title: "B", state: "split", words: "Split" }];
    expect(m.criticalPathView(c, mixed).summary).not.toContain("every story is done");
  });

  it("tells an empty epic from one whose stories were all split or dropped", () => {
    expect(m.criticalPathView(null, []).summary).toBe("No stories yet.");
    expect(m.criticalPathView({ nodes: [], edges: [], outside: [], cycles: [], order: [], criticalPath: { stories: [], remaining: 0 } }, []).summary).toBe("No stories yet.");
    for (const state of ["split", "dropped"]) {
      const v = m.criticalPathView(null, [{ issue: 1, title: "A", state, words: state }]);
      expect(v.summary).not.toBe("No stories yet.");
      expect(v.summary).toContain("split or dropped");
    }
  });
});

describe("storyItems", () => {
  it("keeps the order and gives the link, the words and the notes", () => {
    const stories = [
      { issue: 12, title: "A", state: "done", words: "Done" },
      { issue: 14, title: "B", state: "waiting", words: "Waiting", partOf: 9, status: "waiting for you", help: "Answer on the issue." },
    ];
    const chains = { nodes: [{ issue: 12, dependsOn: [], outside: [] }, { issue: 14, dependsOn: [12, 13], outside: [77] }] };
    const items = m.storyItems(stories, chains, "acme/app");
    expect(items.map((i: any) => i.issue)).toEqual([12, 14]);
    expect(items[0]).toMatchObject({ href: "https://github.com/acme/app/issues/12", words: "Done", notes: [] });
    expect(items[1].notes).toEqual(["part of #9", "after #12 and #13", "also waits for #77 (outside this epic)"]);
    expect(items[1]).toMatchObject({ status: "waiting for you", help: "Answer on the issue." });
  });
});

describe("chainNotes", () => {
  it("names cycles without promising how they are built, and the stories outside", () => {
    const notes = m.chainNotes({ cycles: [[3, 4]], outside: [{ issue: 77, title: "Other" }, { issue: 80 }] });
    expect(notes).toEqual(["#3 and #4 depend on each other, so none of them can start first", "Stories outside this epic that stories here wait for: #77 Other, #80"]);
    expect(notes[0]).not.toMatch(/together|same time/);
    expect(m.chainNotes(null)).toEqual([]);
  });
});

describe("paceView", () => {
  const days = (done: number[]) => done.map((d, i) => ({ from: `f${i}`, to: `t${i}`, done: d }));
  it("says about how many a day, over how many days", () => {
    const v = m.paceView({ perDay: 1.4, days: days([0, 0, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15]) }, undefined);
    expect(v.perDay).toBe("About 1.4 stories a day over the last 14 days (all epics of this repository).");
    expect(v.rows).toHaveLength(14);
    expect(v.rows[0]).toEqual({ label: "Last 24 hours", done: 15 });
    expect(v.rows[1].label).toBe("1–2 days ago");
    expect(v.rows[10].done).toBe(3);
  });

  it("says when nothing was finished", () => {
    expect(m.paceView({ perDay: 0, days: days([0, 0]) }, undefined).perDay).toBe("No story was finished in the last 2 days.");
    expect(m.paceView(undefined, undefined).perDay).toBe("No story was finished in the last 14 days.");
  });

  it("says the median story time, or that there is not enough history", () => {
    expect(m.paceView({ perDay: 1, days: days([1]) }, (2 * 60 + 10) * 60_000).median).toBe("A story takes about 2 h 10 min from the start of its run to done (the median of the finished runs).");
    expect(m.paceView({ perDay: 1, days: days([1]) }, undefined).median).toBe("Not enough finished stories yet to say how long one takes.");
  });
});

describe("forecastView", () => {
  const f = (over: any) => ({ finished: false, forecast: over });
  it("adds what the forecast leaves out, for a range and for too early", () => {
    const r = m.forecastView(f({ kind: "range", earliest: "2026-10-12T10:00:00Z", expected: "2026-10-13T10:00:00Z", latest: "2026-10-14T10:00:00Z", text: "x", leavesOut: ["usage limits", "a person's answer"] }), { timeZone, now });
    expect(r.kind).toBe("range");
    expect(r.leavesOut).toBe("Leaves out: usage limits, a person's answer");
    const e = m.forecastView(f({ kind: "too-early", text: "Too early to say: little", leavesOut: ["usage limits"] }), { timeZone, now });
    expect(e.leavesOut).toBe("Leaves out: usage limits");
  });

  it("has nothing for a finished epic", () => {
    expect(m.forecastView({ finished: true, forecast: { kind: "finished", leavesOut: ["x"] } }, { timeZone, now }).leavesOut).toBe("");
  });
});
