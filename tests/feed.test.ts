import { describe, expect, it } from "vitest";
import {
  diffFeed, emptyFeed, FEED_KEEP_COUNT, FEED_MAX, feedAnswer, FeedQueryError, parseFeed, parseFeedQuery, pruneFeed, visible,
  type FeedEntry, type FeedKind, type FeedReader, type FeedRecord, type FeedState,
} from "../src/feed.js";

// The change feed without a server: the diff, the limits, the answer and who may see what (#868).

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const all = new Set<FeedKind>(["turn", "run", "repo", "change"]);
const snap = (entries: Record<string, FeedEntry>) => new Map(Object.entries(entries));
const user = (id: string, workspaces: string[] = ["default"], kinds?: FeedKind[]): FeedReader => ({ id, admin: false, workspaces: new Set(workspaces), ...(kinds ? { kinds: new Set(kinds) } : {}) });
const admin: FeedReader = { id: "adm", admin: true, workspaces: undefined };
const rec = (s: number, over: Partial<FeedRecord> = {}): FeedRecord => ({ s, k: "run", i: `r${s}`, at: NOW, see: [{ o: "ann", w: "default" }], ...over });
const stateWith = (changes: FeedRecord[], over: Partial<FeedState> = {}): FeedState => ({ ...emptyFeed(NOW), seq: changes.at(-1)?.s ?? 0, floor: 0, changes, ...over });

describe("diffFeed", () => {
  it("records an added, a changed and a gone entry, one each, with rising sequence numbers", () => {
    const st = emptyFeed(1000);
    expect(diffFeed(st, all, snap({ "run:a": { f: "1", o: "ann", w: "default" } }), NOW)).toBe(1);
    expect(diffFeed(st, all, snap({ "run:a": { f: "2", o: "ann", w: "default" } }), NOW)).toBe(1);
    expect(diffFeed(st, all, snap({}), NOW)).toBe(1);
    expect(st.changes.map((c) => [c.s, c.k, c.i])).toEqual([[1001, "run", "a"], [1002, "run", "a"], [1003, "run", "a"]]);
    expect(st.snapshot).toEqual({});
  });

  it("records nothing for an unchanged entry, and keeps the entries of a kind that was not read", () => {
    const st = emptyFeed(1000);
    diffFeed(st, all, snap({ "run:a": { f: "1" }, "repo:b": { f: "1" } }), NOW);
    expect(diffFeed(st, all, snap({ "run:a": { f: "1" }, "repo:b": { f: "1" } }), NOW)).toBe(0);
    expect(diffFeed(st, new Set<FeedKind>(["run"]), snap({ "run:a": { f: "1" } }), NOW)).toBe(0);
    expect(st.snapshot["repo:b"]).toBeDefined();
  });

  it("holds the sides before and after, so a move is seen from both ends", () => {
    const st = emptyFeed(1000);
    diffFeed(st, all, snap({ "repo:b": { f: "1", o: "ann", w: "a" } }), NOW);
    diffFeed(st, all, snap({ "repo:b": { f: "2", o: "bob", w: "b" } }), NOW);
    expect(st.changes[1]!.see).toEqual([{ o: "ann", w: "a", a: undefined }, { o: "bob", w: "b", a: undefined }]);
  });

  it("takes a snapshot without records when silent", () => {
    const st = emptyFeed(1000);
    expect(diffFeed(st, all, snap({ "run:a": { f: "1" } }), NOW, true)).toBe(0);
    expect(st.seq).toBe(1000);
    expect(st.snapshot["run:a"]).toBeDefined();
  });
});

describe("pruneFeed", () => {
  const many = (n: number, at: (i: number) => number) => Array.from({ length: n }, (_, i) => rec(i + 1, { at: at(i) }));

  it("keeps every change younger than 24 h, up to the hard cap", () => {
    const st = stateWith(many(FEED_KEEP_COUNT + 500, () => NOW - HOUR));
    expect(pruneFeed(st, NOW)).toBe(false);
    expect(st.changes).toHaveLength(FEED_KEEP_COUNT + 500);
    const big = stateWith(many(FEED_MAX + 5, () => NOW));
    expect(pruneFeed(big, NOW)).toBe(true);
    expect(big.changes).toHaveLength(FEED_MAX);
    expect(big.floor).toBe(5);
  });

  it("drops old changes beyond the newest 10,000 and raises the floor", () => {
    const st = stateWith(many(FEED_KEEP_COUNT + 3, () => NOW - 48 * HOUR));
    expect(pruneFeed(st, NOW)).toBe(true);
    expect(st.changes).toHaveLength(FEED_KEEP_COUNT);
    expect(st.floor).toBe(3);
    expect(feedAnswer(st, 2, admin).reset).toBe(true);
    expect(feedAnswer(st, 3, admin).reset).toBeUndefined();
  });
});

describe("feedAnswer", () => {
  const st = stateWith([rec(5, { i: "a", at: NOW - 2000 }), rec(6, { i: "a", at: NOW - 1000 }), rec(7, { i: "b" })], { floor: 4 });

  it("is reset for a missing cursor, one below the floor and one above seq", () => {
    for (const since of [undefined, 3, 8]) expect(feedAnswer(st, since, admin)).toEqual({ seq: 7, reset: true, changes: [] });
  });

  it("answers from the floor on, one entry per object with the newest time", () => {
    const a = feedAnswer(st, 4, admin);
    expect(a.reset).toBeUndefined();
    expect(a.changes).toEqual([
      { kind: "run", id: "a", at: new Date(NOW - 1000).toISOString() },
      { kind: "run", id: "b", at: new Date(NOW).toISOString() },
    ]);
    expect(feedAnswer(st, 7, admin)).toEqual({ seq: 7, changes: [] });
  });

  it("tells the owner of a Your-turn item that it left their list, though the item still exists", () => {
    const left = stateWith([rec(7, { k: "turn", i: "m-1", see: [{ o: "ann", w: "default" }, { w: "default" }] })]);
    const current = { "turn:m-1": { f: "acted", w: "default" } };
    expect(feedAnswer(left, 0, user("ann"), current).changes.map((c) => c.id)).toEqual(["m-1"]);
    expect(feedAnswer(left, 0, user("bob"), current).changes).toEqual([]);
  });

  it("shows an object that still exists only when it is readable now", () => {
    const moved = { "run:a": { f: "x", o: "bob", w: "default" }, "run:b": { f: "x", o: "ann", w: "default" } };
    expect(feedAnswer(st, 4, user("ann"), moved).changes.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("visible", () => {
  const run = rec(1);
  const change = (over: Partial<FeedRecord["see"][0]> = {}): FeedRecord => rec(1, { k: "change", see: [{ o: "ann", w: "default", a: "default", ...over }] });

  it("gives an admin every run and repository, and only their own change requests", () => {
    expect(visible(run, admin)).toBe(true);
    expect(visible(change(), admin)).toBe(false);
    expect(visible(change({ o: "adm" }), admin)).toBe(true);
  });

  it("gives a user only their own objects in their workspaces", () => {
    expect(visible(run, user("ann"))).toBe(true);
    expect(visible(run, user("bob"))).toBe(false);
    expect(visible(run, user("ann", ["team"]))).toBe(false);
    expect(visible(rec(1, { see: [{ o: "ann" }] }), user("ann"))).toBe(true);
  });

  it("needs the workspace of the architect run too for a change request", () => {
    expect(visible(change(), user("ann"))).toBe(true);
    expect(visible(change({ a: "team" }), user("ann"))).toBe(false);
    expect(visible(change({ w: "team" }), user("ann"))).toBe(false);
    expect(visible(change({ w: undefined }), user("ann"))).toBe(true);
  });

  it("limits a service account to the kinds in its scope", () => {
    expect(visible(run, user("ann", ["default"], ["repo"]))).toBe(false);
    expect(visible(run, user("ann", ["default"], ["run"]))).toBe(true);
  });

  it("shows a deletion or a move to someone who could see either side", () => {
    const moved = rec(1, { see: [{ o: "ann", w: "default" }, { o: "bob", w: "default" }] });
    expect(visible(moved, user("ann"))).toBe(true);
    expect(visible(moved, user("bob"))).toBe(true);
    expect(visible(moved, user("cy"))).toBe(false);
  });
});

describe("parseFeed and parseFeedQuery", () => {
  it("round-trips a state, and reads a broken file as undefined and a newer one as newer", () => {
    const st = stateWith([rec(1)], { snapshot: { "run:a": { f: "1", o: "ann" } } });
    expect(parseFeed(JSON.stringify(st))).toEqual(st);
    for (const bad of ["", "{", "[]", JSON.stringify({ version: 1 }), JSON.stringify({ ...st, changes: [{ s: 1 }] })]) expect(parseFeed(bad), bad).toBeUndefined();
    expect(parseFeed(JSON.stringify({ ...st, version: 2 }))).toBe("newer");
  });

  it("takes since and wait, and refuses bad values", () => {
    const q = (s: string) => parseFeedQuery(new URLSearchParams(s));
    expect(q("")).toEqual({ wait: 0 });
    expect(q("since=12&wait=30")).toEqual({ since: 12, wait: 30 });
    for (const bad of ["wait=31", "wait=-1", "wait=1.5", "wait=x", "since=-3", "since=1.5", "since="]) expect(() => q(bad), bad).toThrow(FeedQueryError);
  });
});
