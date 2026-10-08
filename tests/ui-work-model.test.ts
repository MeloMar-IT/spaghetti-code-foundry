import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/work-model.js" as string);
});
afterAll(() => restore());

const COLS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];
const TITLES = ["Your turn", "Waiting for another story", "Queued", "Planning", "Coding", "Reviewing", "Merging", "Done", "Failed"];
const card = (over: Record<string, unknown> = {}) => ({
  key: "k", issue: 1, title: "One", column: "coding", next: { who: "Foundry", text: "t", action: "a" }, after: [], chain: [], since: "2026-10-01T10:00:00Z", ...over,
});
const board = (byRepo: Record<string, any[]>) => ({
  repos: Object.entries(byRepo).map(([repo, cards]) => ({ repo, columns: COLS.map((id, i) => ({ id, title: TITLES[i], cards: cards.filter((c) => c.column === id) })) })),
});
const D = () => ({ ...m.DEFAULTS, status: [] as string[] });

const data = board({
  "acme/app": [
    card({ issue: 123, title: "Fix the Login", column: "coding", owner: "u1", ownerName: "Ann" }),
    card({ issue: 5, title: "Add search", column: "your_turn", next: { who: "You" } }),
    card({ issue: 7, title: "Old thing", column: "done", since: "2026-09-01T00:00:00Z", owner: "u2", ownerName: "deleted account" }),
    card({ issue: 8, title: "New thing", column: "done", since: "2026-10-05T00:00:00Z" }),
    card({ issue: 9, title: "No date", column: "done", since: undefined }),
  ],
  "acme/lib": [card({ issue: 2, title: "Library", column: "queued", next: { who: "Another story" }, owner: "u1", ownerName: "Ann" })],
  "acme/empty": [],
});
const items = () => m.workItems(data);
const ids = (list: any[]) => list.map((i) => `${i.repo.split("/")[1]}#${i.issue}`);

describe("workItems", () => {
  it("flattens and adds the repository and the column title", () => {
    const list = items();
    expect(list).toHaveLength(6);
    expect(list.find((i: any) => i.issue === 123)).toMatchObject({ repo: "acme/app", columnTitle: "Coding" });
  });
  it("gives [] for nothing", () => {
    for (const d of [undefined, {}, { repos: [] }]) expect(m.workItems(d)).toEqual([]);
  });
});

describe("applyFilters", () => {
  const run = (over: Record<string, unknown>) => ids(m.applyFilters(items(), { ...D(), ...over }));
  it("keeps everything with the defaults", () => expect(run({})).toHaveLength(6));
  it("filters by repository", () => expect(run({ repo: "acme/lib" })).toEqual(["lib#2"]));
  it("filters by owner and hides cards without one", () => expect(run({ owner: "u1" }).sort()).toEqual(["app#123", "lib#2"]));
  it("filters by one or two columns, and the empty set means all", () => {
    expect(run({ status: ["queued"] })).toEqual(["lib#2"]);
    expect(run({ status: ["queued", "your_turn"] }).sort()).toEqual(["app#5", "lib#2"]);
    expect(run({ status: [] })).toHaveLength(6);
  });
  it("filters by who has the next move", () => expect(run({ who: "You" })).toEqual(["app#5"]));
  it("matches the title, ignoring case and spaces around", () => {
    expect(run({ text: "  LOGIN " })).toEqual(["app#123"]);
    expect(run({ text: "zzz" })).toEqual([]);
  });
  it("matches the issue number with or without #", () => {
    expect(run({ text: "#12" })).toEqual(["app#123"]);
    expect(run({ text: "12" })).toEqual(["app#123"]);
  });
  it("combines filters", () => {
    expect(run({ repo: "acme/app", who: "Foundry", status: ["coding"] })).toEqual(["app#123"]);
    expect(run({ repo: "acme/lib", who: "You" })).toEqual([]);
  });
});

describe("groupItems", () => {
  const group = (over: Record<string, unknown>) => m.groupItems(items(), { ...D(), ...over }, m.columnsOf(data));
  it("has the nine columns in server order, empty ones too", () => {
    const g = group({});
    expect(g.map((x: any) => x.title)).toEqual(TITLES);
    expect(g.find((x: any) => x.id === "merging").items).toEqual([]);
  });
  it("shows only the chosen columns", () => expect(group({ status: ["coding"] }).map((x: any) => x.id)).toEqual(["coding"]));
  it("groups by repository, sorted", () => expect(group({ group: "repo" }).map((x: any) => x.title)).toEqual(["acme/app", "acme/lib"]));
  it("groups by owner with the label for a gone account, and No owner last", () => {
    expect(group({ group: "owner" }).map((x: any) => x.title)).toEqual(["Ann", "deleted user", "No owner"]);
  });
  it("groups by next move with You first", () => {
    expect(group({ group: "next" }).map((x: any) => x.title)).toEqual(["You", "Foundry", "Another story"]);
  });
  it("can leave out grouping", () => {
    const g = group({ group: "none" });
    expect(g).toHaveLength(1);
    expect(g[0].title).toBe("");
    expect(g[0].items).toHaveLength(6);
  });
});

describe("orderItems", () => {
  const list = [card({ issue: 3, title: "b", repo: "x/b" }), card({ issue: 1, title: "c", repo: "x/b" }), card({ issue: 1, title: "a", repo: "x/a" })];
  it("orders by issue, ties by repository, and leaves the input alone", () => {
    const copy = [...list];
    expect(m.orderItems(list, "issue").map((i: any) => `${i.repo}#${i.issue}`)).toEqual(["x/a#1", "x/b#1", "x/b#3"]);
    expect(list).toEqual(copy);
  });
  it("orders Done newest first, missing dates last", () => {
    const done = items().filter((i: any) => i.column === "done");
    expect(m.orderItems(done, "issue", "done").map((i: any) => i.issue)).toEqual([8, 7, 9]);
    expect(m.orderItems(done, "issue", "coding").map((i: any) => i.issue)).toEqual([7, 8, 9]);
  });
  it("orders Done by title when asked", () => {
    const done = items().filter((i: any) => i.column === "done");
    expect(m.orderItems(done, "title", "done").map((i: any) => i.title)).toEqual(["New thing", "No date", "Old thing"]);
  });
  it("orders by age, oldest first, missing last", () => {
    const done = items().filter((i: any) => i.column === "done");
    expect(m.orderItems(done, "age").map((i: any) => i.issue)).toEqual([7, 8, 9]);
  });
  it("orders by title, ties by repository then issue", () => {
    const same = [card({ issue: 2, title: "t", repo: "x/b" }), card({ issue: 9, title: "t", repo: "x/a" }), card({ issue: 1, title: "t", repo: "x/a" })];
    expect(m.orderItems(same, "title").map((i: any) => `${i.repo}#${i.issue}`)).toEqual(["x/a#1", "x/a#9", "x/b#2"]);
  });
});

describe("ageText", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const cases: [string, number, string][] = [
    ["59 s", 59_000, "0 min"], ["12 min", 12 * MIN, "12 min"], ["59 min", 59 * MIN, "59 min"], ["1 h", 60 * MIN, "1 h"],
    ["23 h 59 min", 1439 * MIN, "23 h"], ["24 h", 1440 * MIN, "1 d"], ["3 d", 3 * 1440 * MIN, "3 d"],
  ];
  for (const [name, ms, text] of cases) it(`${name} → ${text}`, () => expect(m.ageText(ago(ms), now)).toBe(text));
  it("is empty for a missing, garbage or future time", () => {
    expect(m.ageText(undefined, now)).toBe("");
    expect(m.ageText("garbage", now)).toBe("");
    expect(m.ageText(ago(-5 * MIN), now)).toBe("");
  });
});

describe("facets", () => {
  it("counts repositories, owners and next moves", () => {
    const f = m.facets(items(), data);
    expect(f.repos).toEqual([{ id: "acme/app", name: "acme/app", count: 5 }, { id: "acme/empty", name: "acme/empty", count: 0 }, { id: "acme/lib", name: "acme/lib", count: 1 }]);
    expect(f.owners).toEqual([{ id: "u1", name: "Ann", count: 2 }, { id: "u2", name: "deleted user", count: 1 }]);
    expect(f.who.map((x: any) => [x.id, x.count])).toEqual([["You", 1], ["Foundry", 4], ["Another story", 1]]);
  });
  it("offers only repositories of the items without the answer", () => {
    expect(m.facets(items()).repos.map((r: any) => r.id)).toEqual(["acme/app", "acme/lib"]);
  });
});

describe("isFiltered", () => {
  it("is false for the defaults and for a different group or order", () => {
    expect(m.isFiltered(D())).toBe(false);
    expect(m.isFiltered({ ...D(), group: "repo", order: "title" })).toBe(false);
  });
  it("is true for each single filter", () => {
    for (const over of [{ repo: "a/b" }, { owner: "u" }, { status: ["done"] }, { who: "You" }, { text: "x" }]) expect(m.isFiltered({ ...D(), ...over })).toBe(true);
  });
});
