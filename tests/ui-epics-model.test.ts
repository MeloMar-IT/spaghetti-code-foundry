import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { growthText, STATE_WORDS } from "../src/epics/model.js";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/epics-model.js" as string);
});
afterAll(() => restore());

const AMS = "Europe/Amsterdam";
const now = new Date("2026-10-14T09:00:00Z");
const opts = { timeZone: AMS, now };

describe("dayText and rangeText", () => {
  it("writes a day in the time zone of the person", () => {
    expect(m.dayText("2026-10-12T10:00:00Z", opts)).toBe("Mon 12 Oct");
    expect(m.dayText("2026-10-12T23:30:00Z", opts)).toBe("Tue 13 Oct");
    expect(m.dayText("2026-10-12T23:30:00Z", { timeZone: "America/New_York", now })).toBe("Mon 12 Oct");
  });
  it("adds the year when it is not this year, and gives nothing for a bad time", () => {
    expect(m.dayText("2027-01-04T10:00:00Z", opts)).toBe("Mon 4 Jan 2027");
    expect(m.dayText("nope", opts)).toBe("");
    expect(m.dayText(undefined, opts)).toBe("");
  });
  it("writes a range", () => {
    expect(m.rangeText("2026-10-12T10:00:00Z", "2026-10-13T10:00:00Z", opts)).toBe("Mon 12 – Tue 13 Oct");
    expect(m.rangeText("2026-10-12T10:00:00Z", "2026-10-12T15:00:00Z", opts)).toBe("Mon 12 Oct");
    expect(m.rangeText("2026-10-30T10:00:00Z", "2026-11-02T10:00:00Z", opts)).toBe("Fri 30 Oct – Mon 2 Nov");
    expect(m.rangeText("2026-12-28T10:00:00Z", "2027-01-05T10:00:00Z", opts)).toBe("Mon 28 Dec 2026 – Tue 5 Jan 2027");
    expect(m.rangeText("x", "2026-10-13T10:00:00Z", opts)).toBe("");
  });
});

describe("tookText", () => {
  const H = 3_600_000;
  it("rounds to the unit that reads best", () => {
    expect(m.tookText(59 * 60_000)).toBe("less than an hour");
    expect(m.tookText(H)).toBe("1 hour");
    expect(m.tookText(47 * H)).toBe("47 hours");
    expect(m.tookText(48 * H)).toBe("2 days");
    expect(m.tookText(13 * 24 * H)).toBe("13 days");
    expect(m.tookText(14 * 24 * H)).toBe("2 weeks");
    expect(m.tookText(21 * 24 * H)).toBe("3 weeks");
  });
  it("gives nothing for a missing or negative time", () => {
    expect(m.tookText(-1)).toBe("");
    expect(m.tookText(undefined)).toBe("");
  });
});

describe("finishView", () => {
  const range = { finished: false, forecast: { kind: "range", earliest: "2026-10-12T10:00:00Z", expected: "2026-10-13T10:00:00Z", latest: "2026-10-14T10:00:00Z", text: "5 stories left at about 1 a day", leavesOut: [] } };
  it("shows a range with the likely day, the reason and what it leaves out", () => {
    expect(m.finishView(range, opts)).toEqual({ kind: "range", text: "Mon 12 – Wed 14 Oct", reason: "5 stories left at about 1 a day", likely: "Tue 13 Oct" });
    const out = m.finishView({ ...range, forecast: { ...range.forecast, leavesOut: ["stories not handed over", "review time"] } }, opts);
    expect(out.note).toBe("Leaves out: stories not handed over, review time");
  });
  it("says too early to say and keeps the reason without its prefix", () => {
    const row = { finished: false, forecast: { kind: "too-early", reason: "no-stories", text: "Too early to say: the epic has no stories yet", leavesOut: [] } };
    expect(m.finishView(row, opts)).toEqual({ kind: "too-early", text: "Too early to say", reason: "The epic has no stories yet" });
  });
  it("shows when a finished epic finished and how long it took", () => {
    const row = { finished: true, finishedAt: "2026-10-12T10:00:00Z", tookMs: 21 * 24 * 3_600_000, forecast: { kind: "finished" } };
    expect(m.finishView(row, opts)).toEqual({ kind: "finished", text: "Finished Mon 12 Oct", reason: "Took 3 weeks" });
    expect(m.finishView({ finished: true, forecast: { kind: "finished" } }, opts)).toEqual({ kind: "finished", text: "Finished", reason: "" });
  });
  it("shows a dash for anything else", () => {
    expect(m.finishView({}, opts)).toEqual({ kind: "none", text: "—", reason: "" });
    expect(m.finishView({ forecast: { kind: "range", earliest: "x", latest: "y" } }, opts).kind).toBe("none");
  });
});

describe("progress", () => {
  const counts = { done: 3, working: 2, waiting: 4, your_turn: 0, failed: 1, split: 0, dropped: 0 };
  it("writes the text alternative", () => {
    expect(m.progressText(counts, 10)).toBe("3 of 10 done; Working 2, Waiting 4, Failed 1");
    expect(m.progressText({ done: 5 }, 5)).toBe("5 of 5 done");
    expect(m.progressText({}, 0)).toBe("No stories yet");
  });
  it("cuts the bar into parts that add up to 100", () => {
    const parts = m.barSegments(counts, 10);
    expect(parts.map((p: any) => p.id)).toEqual(["done", "working", "waiting", "failed"]);
    expect(parts[1]).toMatchObject({ x: 30, width: 20 });
    expect(parts.reduce((s: number, p: any) => s + p.width, 0)).toBeCloseTo(100);
    expect(m.barSegments({ done: 2 }, 2)).toEqual([{ id: "done", word: "Done", count: 2, x: 0, width: 100 }]);
    expect(m.barSegments({}, 0)).toEqual([]);
  });
  it("uses the words of the server", () => {
    for (const s of m.SEGMENTS) expect(s.word).toBe((STATE_WORDS as any)[s.id]);
  });
});

describe("growthSentence", () => {
  it("follows the server's growthText for no, one and many splits", () => {
    for (const split of [0, 1, 16]) {
      const growth = { atStart: 21, now: 95, split };
      expect(m.growthSentence({ growth, growthText: growthText(growth) })).toBe(`Stories: ${growthText(growth)}`);
      expect(m.growthSentence({ growth })).toBe(`Stories: ${growthText(growth)}`);
    }
  });
  it("is empty without data", () => {
    expect(m.growthSentence({})).toBe("");
  });
});

describe("holds", () => {
  it("lists issues", () => {
    expect(m.issueList([12])).toBe("#12");
    expect(m.issueList([12, 14])).toBe("#12 and #14");
    expect(m.issueList([1, 2, 3])).toBe("#1, #2 and #3");
    expect(m.issueList([1, 2, 3, 4, 5, 6, 7, 8])).toBe("#1, #2, #3, #4, #5 and 3 more");
    expect(m.issueList([])).toBe("");
  });
  it("writes a hold-up with its help and the stories that wait for it", () => {
    const out = m.blockTexts([
      { kind: "person", issues: [12, 14], status: "waiting for you — questions", help: "Answer on the issue." },
      { kind: "failed", issues: [3], status: "failed", help: "Look at the run.", waiting: [4] },
      { kind: "limit", issues: [5], status: "a time limit", help: "", waiting: [6, 7] },
    ]);
    expect(out[0]).toEqual({ kind: "person", text: "Waiting for you — questions: #12 and #14", help: "Answer on the issue." });
    expect(out[1].text).toBe("Failed: #3; 1 more story waits for it");
    expect(out[2].text).toBe("A time limit: #5; 2 more stories wait for them");
    expect(m.blockTexts(undefined)).toEqual([]);
  });
});

describe("sortRows", () => {
  const open = (id: string, expected: string) => ({ id, forecast: { kind: "range", expected } });
  const early = (id: string) => ({ id, forecast: { kind: "too-early" } });
  const done = (id: string, finishedAt: string) => ({ id, finished: true, finishedAt, forecast: { kind: "finished" } });
  it("orders by expected finish, then too early, then finished (newest first)", () => {
    const rows = [done("d1", "2026-10-01T00:00:00Z"), early("e1"), open("o2", "2026-10-20T00:00:00Z"), done("d2", "2026-10-05T00:00:00Z"), open("o1", "2026-10-15T00:00:00Z"), early("e2")];
    expect(m.sortRows(rows).map((r: any) => r.id)).toEqual(["o1", "o2", "e1", "e2", "d2", "d1"]);
  });
  it("is stable on ties and leaves the input alone", () => {
    const rows = [open("a", "2026-10-15T00:00:00Z"), open("b", "2026-10-15T00:00:00Z"), open("c", "2026-10-14T00:00:00Z")];
    const copy = [...rows];
    expect(m.sortRows(rows).map((r: any) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows).toEqual(copy);
  });
});

describe("freshText", () => {
  const data = (ageMs: number, cut = false) => ({ state: "fresh", readAt: new Date(now.getTime() - ageMs).toISOString(), cut, ageMs });
  it("says how old the issue data is", () => {
    expect(m.freshText(data(10_000))).toBe("Issues read just now");
    expect(m.freshText(data(12 * 60_000))).toBe("Issues read 12 min ago");
  });
  it("warns when not every issue was read", () => {
    expect(m.freshText(data(10_000, true))).toBe("Issues read just now. Not every issue was read, so the counts can be too low");
  });
  it("says nothing without data", () => {
    expect(m.freshText({ state: "no-data", why: "no-watcher", text: "x" })).toBe("");
    expect(m.freshText(undefined)).toBe("");
  });
});

describe("repoChoices and pickRepo", () => {
  const rows = [
    { id: "r1", github: "Acme/App", owner: "u1" },
    { id: "r2", github: "acme/app", owner: "me" },
    { id: "r3", github: "acme/api", owner: "u1" },
    { id: "r4", owner: "u1" },
    { id: "r5", github: "bad name" },
  ];
  it("drops rows without a repository, removes doubles and sorts", () => {
    expect(m.repoChoices(rows).map((c: any) => c.id)).toEqual(["r3", "r1"]);
  });
  it("prefers the record of an admin", () => {
    expect(m.repoChoices(rows, { admin: true, meId: "me" })).toEqual([{ name: "acme/api", id: "r3" }, { name: "acme/app", id: "r2" }]);
    expect(m.repoChoices(null)).toEqual([]);
  });
  it("picks the repository asked for, the only one, or says why not", () => {
    const two = m.repoChoices(rows);
    expect(m.pickRepo(two, "ACME/api")).toEqual({ choice: { name: "acme/api", id: "r3" } });
    expect(m.pickRepo(two, "x/y")).toEqual({ gone: true });
    expect(m.pickRepo(two, "")).toEqual({ none: true });
    expect(m.pickRepo([two[0]], "")).toEqual({ choice: two[0] });
    expect(m.pickRepo([], "")).toEqual({ none: true });
  });
});
