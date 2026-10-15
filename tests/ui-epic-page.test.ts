import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ep: any;
let dom: any;
let graph: any;
beforeAll(async () => {
  restore = installFakeDom();
  dom = await import("../ui/dom.js" as string);
  ep = await import("../ui/epic-page.js" as string);
  graph = await import("../ui/graph.js" as string);
});
afterAll(() => restore());

const now = new Date("2026-10-14T09:00:00Z");
const timeZone = "Europe/Amsterdam";
const counts = (c: Record<string, number>) => ({ done: 0, working: 0, waiting: 0, your_turn: 0, failed: 0, split: 0, dropped: 0, ...c });
const fresh = { state: "fresh", readAt: "2026-10-14T08:48:00Z", cut: false, ageMs: 12 * 60_000 };
const epicRow = (over: any = {}) => ({
  id: "12", key: "#12", issue: 12, title: "Payments", counts: counts({ done: 1, working: 1, waiting: 1 }), total: 3, notHanded: 0,
  growth: { atStart: 3, now: 3, split: 0 }, growthText: "3 at the start, 3 now", finished: false,
  forecast: { kind: "range", earliest: "2026-10-12T10:00:00Z", expected: "2026-10-13T10:00:00Z", latest: "2026-10-14T10:00:00Z", drivers: [], text: "2 stories left at about 1 a day", leavesOut: ["usage limits", "a person's answer"] },
  holdUps: [], ...over,
});
const storiesOf = () => [
  { issue: 20, title: "Schema", state: "done", words: "Done", createdAt: "2026-10-01T00:00:00Z" },
  { issue: 21, title: "Login", state: "working", words: "Working", createdAt: "2026-10-01T00:00:00Z", status: "reviewing", partOf: 12 },
  { issue: 22, title: "Payments API with a very long title that keeps going", state: "waiting", words: "Waiting", createdAt: "2026-10-01T00:00:00Z" },
];
const node = (issue: number, title: string, state: string, level: number, over: any = {}) => ({ issue, title, state, done: state === "done", order: level, level, dependsOn: [], outside: [], ...over });
const chainsOf = () => ({
  order: [20, 21, 22],
  nodes: [node(20, "Schema", "done", 0, { critical: true }), node(21, "Login", "working", 1, { dependsOn: [20], critical: true }), node(22, "Payments API with a very long title that keeps going", "waiting", 1, { dependsOn: [20], outside: [77] })],
  edges: [{ from: 21, to: 20, critical: true }, { from: 22, to: 20 }],
  outside: [{ issue: 77, title: "Other" }], cycles: [],
  criticalPath: { stories: [20, 21], remaining: 1, at: 21 },
});
const detail = (over: any = {}) => ({
  repo: "acme/app", data: fresh, epic: epicRow(), stories: storiesOf(), chains: chainsOf(),
  series: [{ day: "2026-10-12", stories: 3, done: 0 }, { day: "2026-10-13", stories: 3, done: 1 }],
  pace: { perDay: 1.4, days: Array.from({ length: 14 }, (_, i) => ({ from: `f${i}`, to: `t${i}`, done: i === 13 ? 2 : 0 })) },
  medianStoryMs: 130 * 60_000,
  history: [{ day: "2026-10-11", at: "2026-10-11T08:00:00Z", kind: "range", earliest: "2026-10-11T08:00:00Z", expected: "2026-10-11T10:00:00Z", latest: "2026-10-11T12:00:00Z" },
    { day: "2026-10-13", at: "2026-10-13T08:00:00Z", kind: "range", earliest: "2026-10-13T08:00:00Z", expected: "2026-10-13T10:00:00Z", latest: "2026-10-13T12:00:00Z" }],
  ...over,
});
const status = (code: number) => Object.assign(new Error("boom"), { status: code });
const repoRows = [{ id: "r1", github: "acme/app", owner: "me" }];
const api = (over: any = {}) => ({ repos: vi.fn(async () => repoRows), allRepos: vi.fn(async () => repoRows), epic: vi.fn(async () => detail()), ...over });
const tick = () => new Promise((r) => setTimeout(r, 0));
const box = () => dom.h("div", {}) as FakeElement;
const render = (b: FakeElement, a: any, extra: any = {}) => ep.renderEpic(b, { id: "12", timeZone, now: () => now, a, query: { repo: "acme/app" }, ...extra });
const button = (b: FakeElement, label: string) => b.all("button").find((x) => x.textContent === label)!;

describe("chainLayout", () => {
  it("puts levels in columns and nodes of one level in rows", () => {
    const l = graph.chainLayout(chainsOf());
    const at = (n: number) => l.nodes.find((x: any) => x.issue === n);
    expect(at(21).x).toBeGreaterThan(at(20).x);
    expect(at(22).x).toBe(at(21).x);
    expect(at(22).y).toBeGreaterThan(at(21).y);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(at(22).y);
  });

  it("marks critical edges and cycle edges", () => {
    const c = chainsOf();
    c.nodes[2] = node(22, "B", "waiting", 1, { dependsOn: [21], cycle: 0 });
    c.nodes[1] = node(21, "A", "working", 1, { dependsOn: [22], cycle: 0 });
    c.edges = [{ from: 21, to: 20, critical: true } as any, { from: 21, to: 22 } as any];
    const l = graph.chainLayout(c);
    expect(l.edges[0]).toMatchObject({ critical: true, cycle: false });
    expect(l.edges[1]).toMatchObject({ critical: false, cycle: true });
  });

  it("routes an edge that skips a level along a lane under the boxes", () => {
    const c = {
      nodes: [node(1, "A", "done", 0), node(2, "B", "waiting", 1, { dependsOn: [1] }), node(3, "C", "waiting", 2, { dependsOn: [1, 2] })],
      edges: [{ from: 2, to: 1 }, { from: 3, to: 2 }, { from: 3, to: 1 }],
    };
    const l = graph.chainLayout(c);
    const [short1, short2, long] = l.edges;
    expect(short1.lane).toBeUndefined();
    expect(short2.lane).toBeUndefined();
    expect(long.lane).toBe(true);
    const bottom = Math.max(...l.nodes.map((n: any) => n.y)) + 44;
    const laneY = Number(/V(\d+(?:\.\d+)?) H/.exec(long.d)![1]);
    expect(laneY).toBeGreaterThan(bottom);
    expect(l.height).toBeGreaterThan(laneY);
    // two skipping edges get different lanes
    const two = graph.chainLayout({ ...c, edges: [...c.edges, { from: 3, to: 1 }] });
    expect(two.edges[2].d).not.toBe(two.edges[3].d);
  });

  it("is null without nodes", () => {
    expect(graph.chainLayout({ nodes: [], edges: [] })).toBeNull();
    expect(graph.chainLayout(null)).toBeNull();
  });
});

describe("chainGraph", () => {
  it("draws one link per story with its words, and marks the critical path", () => {
    const g = graph.chainGraph(chainsOf(), { hrefOf: (n: number) => `https://github.com/acme/app/issues/${n}`, wordsOf: (n: number) => ({ 20: "Done", 21: "Working", 22: "Waiting" } as any)[n] });
    const links = g.all("a");
    expect(links).toHaveLength(3);
    expect(links[1]!.getAttribute("href")).toBe("https://github.com/acme/app/issues/21");
    expect(links[1]!.getAttribute("aria-label")).toBe("#21 Login, Working");
    const rects = g.all("rect");
    expect(rects.map((r: FakeElement) => r.classList.contains("critical"))).toEqual([true, true, false]);
    expect(g.all("svg")[0]!.getAttribute("role")).toBe("group");
    expect(g.textContent).toContain("critical path");
  });

  it("says no chains without nodes", () => {
    expect(graph.chainGraph({ nodes: [], edges: [] }).textContent).toBe("No chains");
  });
});

describe("renderEpic", () => {
  it("draws the sections in order, from the one answer", async () => {
    const b = box();
    const a = api();
    const onName = vi.fn();
    await render(b, a, { onName });
    expect(a.epic).toHaveBeenCalledWith("r1", "12");
    expect(onName).toHaveBeenCalledWith("#12 Payments");
    expect(b.all("h2").map((x) => x.textContent)).toEqual(["Expected finish", "Critical path", "Stories in build order", "Dependency chains", "Stories over time", "Pace"]);
    const t = b.textContent;
    expect(t).toContain("Mon 12 – Wed 14 Oct (most likely Tue 13 Oct)");
    expect(t).not.toContain("(Sun 11 Oct)");
    expect(t).toContain("Leaves out: usage limits, a person's answer");
    expect(t).toContain("It cannot know when a usage limit stops work or when a person will answer.");
    expect(t).toContain("3 days ago: Sun 11 Oct");
    expect(t).toContain("Yesterday: Tue 13 Oct");
    expect(t).toContain("2 days later");
    expect(t).toContain("The longest chain still to do has 1 story left.");
    expect(t).toContain("Now at #21 Login: Working — reviewing");
    expect(t).toContain("About 1.4 stories a day over the last 14 days (all epics of this repository).");
    expect(t).toContain("2 h 10 min");
  });

  it("lists the stories in build order with links and words", async () => {
    const b = box();
    await render(b, api());
    const items = b.all("ol")[0]!.all("li");
    expect(items.map((li) => li.all("a")[0]!.textContent)).toEqual(["#20 Schema", "#21 Login", "#22 Payments API with a very long title that keeps going"]);
    expect(items[0]!.all("a")[0]!.getAttribute("href")).toBe("https://github.com/acme/app/issues/20");
    expect(items[1]!.textContent).toContain("Working");
    expect(items[1]!.textContent).toContain("part of #12");
    expect(items[2]!.textContent).toContain("also waits for #77 (outside this epic)");
    expect(b.textContent).toContain("Stories outside this epic that stories here wait for: #77 Other");
  });

  it("draws the chart with a table of every row, and the pace table", async () => {
    const b = box();
    await render(b, api());
    const chart = b.all("svg").find((s) => s.getAttribute("role") === "img")!;
    expect(chart.getAttribute("aria-label")).toBe("Stories in the epic and stories done, per day");
    expect(chart.all("path").map((p) => p.getAttribute("class"))).toEqual(["line-stories", "line-done"]);
    const tables = b.all("table");
    expect(tables).toHaveLength(2);
    const rows = tables[0]!.all("tbody")[0]!.all("tr");
    expect(rows.map((r) => r.all("td").map((c) => c.textContent))).toEqual([["Mon 12 Oct", "3", "0"], ["Tue 13 Oct", "3", "1"]]);
    expect(tables[1]!.all("tbody")[0]!.all("tr")).toHaveLength(14);
    expect(b.all("summary").map((s) => s.textContent)).toEqual(expect.arrayContaining(["Show as table", "Show per day"]));
  });

  it("backs to the Epics page with the repository, and names the page", async () => {
    const b = box();
    await render(b, api());
    expect(b.all("a").some((x) => x.getAttribute("href") === "#/epics?repo=acme%2Fapp")).toBe(true);
    expect(b.all("h1")[0]?.textContent ?? b.textContent).toContain("#12 Payments");
  });

  it("shows the loading skeleton first", async () => {
    const b = box();
    let release: (v: any) => void = () => {};
    const a = api({ epic: vi.fn(() => new Promise((r) => { release = r; })) });
    const p = render(b, a);
    await tick();
    expect(b.all("div").some((d) => (d.getAttribute("class") ?? "").includes("skeleton"))).toBe(true);
    release(detail());
    await p;
    expect(b.textContent).toContain("Expected finish");
  });

  it("says no permission for 403 and 404 of the epic, and 403 of the repositories", async () => {
    for (const a of [api({ epic: vi.fn(async () => { throw status(404); }) }), api({ epic: vi.fn(async () => { throw status(403); }) }), api({ repos: vi.fn(async () => { throw status(403); }) })]) {
      const b = box();
      await render(b, a);
      expect(b.textContent).toContain("This epic is not there, or you cannot see it.");
    }
  });

  it("does not ask for an epic of a repository that is not the person's", async () => {
    const b = box();
    const a = api();
    await render(b, a, { query: { repo: "other/thing" } });
    expect(a.epic).not.toHaveBeenCalled();
    expect(b.textContent).toContain("This epic is not there, or you cannot see it.");
  });

  it("asks to open the epic from the Epics page when several repositories and none is named", async () => {
    const b = box();
    const a = api({ repos: vi.fn(async () => [...repoRows, { id: "r2", github: "acme/other", owner: "me" }]) });
    await render(b, a, { query: {} });
    expect(a.epic).not.toHaveBeenCalled();
    expect(b.textContent).toContain("Open this epic from the Epics page");
    expect(b.all("a").some((x) => x.getAttribute("href") === "#/epics" && x.textContent === "Go to Epics")).toBe(true);
  });

  it("uses the only repository when none is named", async () => {
    const b = box();
    const a = api();
    await render(b, a, { query: {} });
    expect(a.epic).toHaveBeenCalledWith("r1", "12");
  });

  it("uses the admin list for an admin", async () => {
    const a = api();
    await render(box(), a, { admin: true });
    expect(a.allRepos).toHaveBeenCalled();
    expect(a.repos).not.toHaveBeenCalled();
  });

  it("shows the server's text when there is no data", async () => {
    const b = box();
    await render(b, api({ epic: vi.fn(async () => detail({ data: { state: "no-data", why: "no-watcher", text: "No data: no watcher checks the issues of this repository" }, epic: null })) }));
    expect(b.textContent).toContain("No data: no watcher checks the issues of this repository");
    expect(b.all("h2")).toHaveLength(0);
  });

  it("says an epic without stories has none, and draws no chain section", async () => {
    const b = box();
    await render(b, api({ epic: vi.fn(async () => detail({ stories: [], chains: { order: [], nodes: [], edges: [], outside: [], cycles: [], criticalPath: { stories: [], remaining: 0 } }, series: [], history: [], medianStoryMs: undefined })) }));
    expect(b.textContent).toContain("This epic has no stories yet.");
    expect(b.textContent).toContain("No history yet.");
    expect(b.textContent).toContain("No forecast saved yet.");
    expect(b.textContent).toContain("Not enough finished stories yet to say how long one takes.");
    expect(b.all("h2").map((x) => x.textContent)).not.toContain("Dependency chains");
  });

  it("works with no chains at all", async () => {
    const b = box();
    await render(b, api({ epic: vi.fn(async () => detail({ chains: null })) }));
    expect(b.all("h2").map((x) => x.textContent)).not.toContain("Dependency chains");
  });

  it("folds the history after seven lines", async () => {
    const history = Array.from({ length: 9 }, (_, i) => ({ day: `2026-10-0${i + 1}`, at: `2026-10-0${i + 1}T08:00:00Z`, kind: "too-early" }));
    const b = box();
    await render(b, api({ epic: vi.fn(async () => detail({ history })) }));
    expect(b.all("summary").map((s) => s.textContent)).toContain("Earlier (2)");
    expect(b.all("ul").filter((u) => u.getAttribute("class") === "epic-history").map((u) => u.all("li").length)).toEqual([7, 2]);
  });

  it("shows an error with Retry, and Retry loads again", async () => {
    const b = box();
    const epic = vi.fn().mockRejectedValueOnce(status(500)).mockResolvedValue(detail());
    await render(b, api({ epic }));
    expect(b.all("button").some((x) => x.textContent === "Retry")).toBe(true);
    button(b, "Retry").click();
    await tick();
    await tick();
    expect(epic).toHaveBeenCalledTimes(2);
    expect(b.textContent).toContain("Expected finish");
  });

  it("keeps the page and shows the stale note when a refresh fails", async () => {
    const b = box();
    const epic = vi.fn().mockResolvedValueOnce(detail()).mockRejectedValue(status(500));
    await render(b, api({ epic }));
    button(b, "↻ Refresh").click();
    await tick();
    await tick();
    expect(b.textContent).toContain("Could not refresh.");
    expect(b.textContent).toContain("Expected finish");
  });

  it("draws nothing after the cleanup, when a refresh answer arrives late", async () => {
    const b = box();
    let release: (v: any) => void = () => {};
    const epic = vi.fn().mockResolvedValueOnce(detail()).mockImplementation(() => new Promise((r) => { release = r; }));
    const close = await render(b, api({ epic }));
    button(b, "↻ Refresh").click();
    close();
    const before = b.textContent;
    release(detail({ epic: epicRow({ title: "Changed" }) }));
    await tick();
    expect(b.textContent).toBe(before);
  });
});
