import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let list: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/work.js" as string);
  list = await import("../ui/work-list.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).location;
  (document as any).activeElement = null;
});

const flush = () => vi.advanceTimersByTimeAsync(0);

const COLS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];
const TITLES = ["Your turn", "Waiting for another story", "Queued", "Planning", "Coding", "Reviewing", "Merging", "Done", "Failed"];
const NOW = new Date("2026-10-08T12:00:00Z");

const card = (over: Record<string, unknown> = {}) => {
  const next = (over.next as any) ?? nextStep("dependency", { repo: "acme/app", issue: 89, title: "Eighty-nine", runId: "r89" }, { watched: true, blockers: [{ issue: 88 }] });
  return {
    key: "acme/app#89", issue: 89, title: "Eighty-nine", column: "waiting", next, runId: "r89", after: [88], chain: [88], watcher: "w1",
    since: "2026-10-05T12:00:00Z", owner: "u1", ownerName: "Ann", ...over,
  };
};
const board = (cards: any[] = [card()], repo = "acme/app", more: Record<string, any[]> = {}) => ({
  repos: Object.entries({ [repo]: cards, ...more }).map(([r, cs]) => ({ repo: r, columns: COLS.map((id, i) => ({ id, title: TITLES[i], cards: cs.filter((c) => c.column === id) })) })),
});
const handlers = () => ({ onChange: vi.fn(), onText: vi.fn(), onClear: vi.fn(), onLeave: vi.fn(), now: NOW });
const prefs = (over: Record<string, unknown> = {}) => ({ layout: "list", repo: "", owner: "", status: [], who: "", text: "", group: "status", order: "issue", props: ["repo", "next", "blockers", "owner", "age", "step"], compact: false, ...over });
const view = (d: unknown, p = prefs(), h: any = handlers()) => {
  const root = new FakeElement("div");
  root.append(...(ui.workView(d, p, h) as unknown[]).filter(Boolean) as FakeElement[]);
  return root;
};
const rows = (root: FakeElement) => root.all("tr").filter((r) => r.attrs["data-focus"]);
const focus = (root: FakeElement, name: string) => root.querySelectorAll("[data-focus]").find((e) => e.attrs["data-focus"] === name)!;
const heads = (root: FakeElement) => root.all("h3").map((e) => e.textContent);
const mem = () => {
  const data: Record<string, string> = {};
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};

describe("listView", () => {
  it("shows the story, status, next move, owner and age in a row", () => {
    const c = card();
    const text = rows(view(board()))[0]!.textContent;
    for (const s of ["#89", "Eighty-nine", c.next.text, c.next.status, c.next.who, "#88", "Ann", "3 d"]) expect(text, s).toContain(s);
    if (c.next.action) expect(text).toContain(c.next.action);
  });

  it("links issues and blockers to GitHub, and shows plain text for a name that is not GitHub's", () => {
    const root = view(board());
    const links = root.all("a").filter((a) => a.attrs.href?.startsWith("https://github.com/acme/app/issues/"));
    expect(links.map((a) => a.attrs.href)).toEqual(expect.arrayContaining(["https://github.com/acme/app/issues/89", "https://github.com/acme/app/issues/88"]));
    for (const a of links) expect(a.attrs.target).toBe("_blank");
    const odd = view(board([card()], "not a repo"));
    expect(odd.all("a").some((a) => a.attrs.href?.includes("/issues/"))).toBe(false);
    expect(rows(odd)[0]!.textContent).toContain("#89");
  });

  it("shows the server's status, not the column title, and gives every table its own header", () => {
    const d = board([card(), card({ issue: 5, title: "Five", column: "coding", key: "acme/app#5" })]);
    const root = view(d);
    expect(card().next.status).toBeTruthy();
    expect(rows(root)[0]!.textContent).toContain(card().next.status);
    const tables = root.all("table");
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(t.all("th").map((x) => x.textContent).slice(0, 1)).toEqual(["Story"]);
    expect(tables[0]!.all("th")[0]).not.toBe(tables[1]!.all("th")[0]);
  });

  it("shows the Repository column when ticked, also with one repository, and the step and next sentence only when ticked", () => {
    expect(view(board()).all("th").map((t) => t.textContent)).toContain("Repository");
    expect(view(board(), prefs({ props: [] })).all("th").map((t) => t.textContent)).not.toContain("Repository");
    const withStep = board([card({ step: "Step 2 of 3" })]);
    expect(view(withStep).textContent).toContain("Step 2 of 3");
    expect(view(withStep, prefs({ props: ["next"] })).textContent).not.toContain("Step 2 of 3");
    expect(view(withStep, prefs({ props: ["step"] })).textContent).not.toContain(card().next.text);
    expect(view(withStep, prefs({ props: ["next"] })).textContent).toContain(card().next.text);
    expect(view(board(), prefs({ compact: true })).all("table")[0]!.attrs.class).toContain("compact");
    const two = view(board([card()], "acme/app", { "acme/lib": [card({ issue: 3, title: "Lib", column: "queued" })] }));
    expect(two.all("th").map((t) => t.textContent)).toContain("Repository");
    expect(two.textContent).toContain("acme/lib");
  });

  it("hides a column whose name is not in props", () => {
    const root = view(board(), prefs({ props: ["age"] }));
    const t = root.all("th").map((x) => x.textContent);
    expect(t).toEqual(["Story", "Status", "Age"]);
    expect(rows(root)[0]!.textContent).not.toContain("Ann");
  });

  it("opens the run on click and Enter, but not for Enter on an inner link", () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    const el = rows(view(board()))[0]!;
    expect(el.attrs).toMatchObject({ class: "link", role: "link", tabindex: "0" });
    el.listeners.click![0]!();
    expect(loc.hash).toBe("#/runs/r89");
    loc.hash = "";
    for (const target of el.all("a")) el.listeners.keydown![0]!({ key: "Enter", target, currentTarget: el });
    expect(loc.hash).toBe("");
    el.listeners.keydown![0]!({ key: "Enter", target: el, currentTarget: el });
    expect(loc.hash).toBe("#/runs/r89");
  });

  it("is not a link without a run", () => {
    const el = rows(view(board([card({ runId: undefined })])))[0]!;
    expect(el.attrs.role).toBeUndefined();
    expect(el.listeners.click).toBeUndefined();
  });

  it("tells the page when a GitHub link is opened, and does not open the run", () => {
    const h = handlers();
    const root = view(board(), prefs(), h);
    const stop = vi.fn();
    root.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/88")!.listeners.click![0]!({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalledWith(expect.objectContaining({ issue: 89, watcher: "w1" }));
  });

  it("tells the page when the action link of the next move opens GitHub", () => {
    const next = { ...card().next, where: { label: "Open the issue", url: "https://github.com/acme/app/issues/89" } };
    const h = handlers();
    const root = view(board([card({ next })]), prefs(), h);
    const span = rows(root)[0]!.all("span").find((s) => s.listeners.click && s.all("a").length)!;
    const stop = vi.fn();
    span.listeners.click![0]!({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalledWith(expect.objectContaining({ issue: 89 }));
    const internal = { ...card().next, where: { label: "Open", url: "#/runs/r5" } };
    const h2 = handlers();
    rows(view(board([card({ next: internal })]), prefs(), h2))[0]!.all("span").find((s) => s.listeners.click && s.all("a").length)!.listeners.click![0]!({ stopPropagation: stop });
    expect(h2.onLeave).not.toHaveBeenCalled();
  });

  it("leaves out the link to the card's own run page", () => {
    const own = nextStep("running", { repo: "acme/app", issue: 89, title: "x", runId: "r89" }, { watched: false });
    expect(own.where.url).toBe("#/runs/r89");
    const root = view(board([card({ next: own, column: "coding", after: [] })]));
    expect(root.all("a").filter((a) => (a.attrs.class ?? "").includes("hold-link"))).toEqual([]);
  });

  it("brings the age cells up to date without drawing again", () => {
    const root = view(board());
    list.refreshAges(root, new Date("2026-10-08T12:00:00Z"));
    expect(rows(root)[0]!.textContent).toContain("3 d");
    list.refreshAges(root, new Date("2026-10-09T12:00:00Z"));
    expect(rows(root)[0]!.textContent).toContain("4 d");
    expect(rows(root)[0]!.textContent).not.toContain("3 d");
  });
});

describe("counts and empty states", () => {
  const two = board([card(), card({ issue: 5, title: "Five", column: "coding", key: "acme/app#5" })]);

  it("puts the count next to each heading", () => {
    expect(heads(view(two))).toEqual(TITLES.map((t) => `${t} ${t === "Coding" || t === "Waiting for another story" ? 1 : 0}`));
  });
  it("says 'N of M stories' only when a filter hides something", () => {
    expect(view(two).textContent).not.toContain("stories");
    expect(view(two, prefs({ status: ["coding"] })).textContent).toContain("1 of 2 stories");
  });
  it("offers Clear filters when nothing matches, and the button works", () => {
    const h = handlers();
    const root = view(two, prefs({ text: "zzz" }), h);
    expect(root.textContent).toContain("No story matches the filters.");
    expect(root.all("h3")).toHaveLength(0);
    focus(root, "work-clear").listeners.click![0]!();
    expect(h.onClear).toHaveBeenCalled();
  });
  it("shows the server's text and no filters when there is no story", () => {
    const root = view({ repos: [], empty: "No stories yet." });
    expect(root.textContent).toContain("No stories yet.");
    expect(root.all("select")).toHaveLength(0);
  });
  it("shows the server's text when repositories exist but no story", () => {
    const root = view({ ...board([]), empty: "No stories yet." });
    expect(root.textContent).toContain("No stories yet.");
    expect(root.all("h3")).toHaveLength(0);
  });
});

describe("toolbar", () => {
  const d = board([card(), card({ issue: 5, title: "Five", column: "coding", key: "acme/app#5", owner: undefined, ownerName: undefined })], "acme/app", { "acme/empty": [] });

  it("offers repositories (empty ones too), owners and next moves with counts", () => {
    const root = view(d);
    const opts = (name: string) => focus(root, name).all("option").map((o) => o.textContent);
    expect(opts("work-repo")).toEqual(["All repositories", "acme/app (2)", "acme/empty (0)"]);
    expect(opts("work-owner")).toEqual(["All owners", "Ann (1)"]);
    expect(opts("work-who")[0]).toBe("Any next move");
    expect(opts("work-who").length).toBeGreaterThan(1);
  });

  it("calls onChange for each select and toggle", () => {
    const h = handlers();
    const root = view(d, prefs({ status: ["coding"] }), h);
    const change = (name: string, value: string) => focus(root, name).listeners.change![0]!({ target: { value } });
    change("work-repo", "acme/app");
    change("work-owner", "u1");
    change("work-who", "Foundry");
    change("work-group", "repo");
    change("work-order", "title");
    expect(h.onChange.mock.calls.map((c: any[]) => c[0])).toEqual([{ repo: "acme/app" }, { owner: "u1" }, { who: "Foundry" }, { group: "repo" }, { order: "title" }]);
    focus(root, "work-status-queued").listeners.click![0]!();
    expect(h.onChange).toHaveBeenLastCalledWith({ status: ["queued", "coding"].sort((a, b) => COLS.indexOf(a) - COLS.indexOf(b)) });
    focus(root, "work-status-coding").listeners.click![0]!();
    expect(h.onChange).toHaveBeenLastCalledWith({ status: [] });
    expect(focus(root, "work-status-coding").attrs["aria-pressed"]).toBe("true");
    expect(focus(root, "work-status-queued").attrs["aria-pressed"]).toBe("false");
  });

  it("sends the text of the box", () => {
    const h = handlers();
    focus(view(d, prefs(), h), "work-text").listeners.input![0]!({ target: { value: "fi" } });
    expect(h.onText).toHaveBeenCalledWith("fi");
  });
});

describe("renderWork", () => {
  const main = () => new FakeElement("main");
  const open = async (d: unknown, wanted?: string, store: any = mem(), user = "u1") => {
    if (!store.data["scf.work.u1"]) store.data["scf.work.u1"] = JSON.stringify({ layout: "list" });
    const m = main();
    const cleanup = ui.renderWork(m, wanted, { user, store, now: () => NOW });
    calls.shift()!.answer(d);
    await flush();
    return { m, cleanup, store };
  };
  const pickValue = (m: FakeElement, name: string, value: string) => focus(m, name).listeners.change![0]!({ target: { value } });
  const selected = (m: FakeElement, name: string) => focus(m, name).all("option").find((o) => "selected" in o.attrs)?.value;

  it("returns a function at once and shows Loading…", () => {
    const m = main();
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store: mem() });
    expect(typeof cleanup).toBe("function");
    expect(m.textContent).toContain("Loading…");
    cleanup();
  });

  it("asks again after 5 seconds and redraws only on change", async () => {
    const { m, cleanup } = await open(board());
    expect(m.textContent).toContain("Eighty-nine");
    const first = m.children;
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board());
    await flush();
    expect(m.children).toBe(first);
    cleanup();
  });

  it("never has two requests in flight", async () => {
    const m = main();
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store: mem() });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);
    cleanup();
  });

  it("ignores an answer after close, and asks no more", async () => {
    const m = main();
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store: mem() });
    cleanup();
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("Loading…");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it("shows an error with a Retry button, and keeps the rows after a later error", async () => {
    const m = main();
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store: mem() });
    calls.shift()!.answer({ error: "boom" }, false);
    await flush();
    expect(m.all("div").find((e) => e.attrs.class === "errors")!.textContent).toBe("boom");
    focus(m, "work-retry").listeners.click![0]!();
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/board" });
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("Eighty-nine");
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer({ error: "later" }, false);
    await flush();
    expect(m.textContent).toContain("Eighty-nine");
    expect(m.textContent).not.toContain("later");
    cleanup();
  });

  it("checks the watcher and reloads after a GitHub link and a return to the tab; none without a watcher", async () => {
    const { m, cleanup } = await open(board());
    const vis = () => (document as any).listeners.visibilitychange![0]();
    vis();
    await flush();
    expect(calls).toHaveLength(0);
    m.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/89")!.listeners.click![0]!();
    vis();
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/watchers/w1/tick" });
    calls[0]!.answer({});
    await flush();
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/board" });
    cleanup();
  });

  it("does not check a watcher for a card without one", async () => {
    const none = await open(board([card({ watcher: undefined })]));
    none.m.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/89")!.listeners.click![0]!();
    (document as any).listeners.visibilitychange![0]();
    await flush();
    expect(calls).toHaveLength(0);
    none.cleanup();
  });

  it("starts no board request when the page is closed while the watcher is checked", async () => {
    const { m, cleanup } = await open(board());
    m.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/89")!.listeners.click![0]!();
    (document as any).listeners.visibilitychange![0]();
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST" });
    cleanup();
    calls[0]!.answer({});
    await flush();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("keeps the filters across a refresh with changed data, and saves them per account", async () => {
    const { m, cleanup, store } = await open(board([card(), card({ issue: 5, title: "Five", column: "coding", key: "acme/app#5" })]));
    pickValue(m, "work-group", "none");
    focus(m, "work-text").listeners.input![0]!({ target: { value: "five" } });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(store.data["scf.work.u1"])).toMatchObject({ group: "none", text: "five" });
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([card(), card({ issue: 5, title: "Five", column: "coding", key: "acme/app#5" }), card({ issue: 6, title: "Six", key: "acme/app#6" })]));
    await flush();
    expect(selected(m, "work-group")).toBe("none");
    expect(m.textContent).toContain("1 of 3 stories");
    cleanup();
  });

  it("replaces only the body while typing", async () => {
    const { m, cleanup } = await open(board());
    const input = focus(m, "work-text");
    input.listeners.input![0]!({ target: { value: "eight" } });
    expect(focus(m, "work-text")).toBe(input);
    input.listeners.input![0]!({ target: { value: "zzz" } });
    expect(m.textContent).toContain("No story matches the filters.");
    cleanup();
  });

  it("Clear filters brings the rows back, keeps group and order, and saves", async () => {
    const { m, cleanup, store } = await open(board());
    pickValue(m, "work-order", "title");
    focus(m, "work-text").listeners.input![0]!({ target: { value: "zzz" } });
    focus(m, "work-clear").listeners.click![0]!();
    expect(rows(m)).toHaveLength(1);
    expect(JSON.parse(store.data["scf.work.u1"])).toMatchObject({ text: "", order: "title" });
    cleanup();
  });

  it("changes headings and row order with group and order", async () => {
    const d = board([card({ issue: 2, title: "Zed", column: "coding", key: "a#2" }), card({ issue: 3, title: "Alpha", column: "coding", key: "a#3" })], "acme/app", { "acme/lib": [card({ issue: 1, title: "Lib", column: "queued", key: "l#1" })] });
    const { m, cleanup } = await open(d);
    pickValue(m, "work-group", "repo");
    expect(heads(m)).toEqual(["acme/app 2", "acme/lib 1"]);
    expect(rows(m).map((r) => r.attrs["data-focus"])).toEqual(["row-acme/app#2", "row-acme/app#3", "row-acme/lib#1"]);
    pickValue(m, "work-order", "title");
    expect(rows(m).map((r) => r.attrs["data-focus"])).toEqual(["row-acme/app#3", "row-acme/app#2", "row-acme/lib#1"]);
    cleanup();
  });

  it("uses the repository of the address, and All for an unknown one", async () => {
    const d = board([card()], "acme/app", { "acme/lib": [] });
    const a = await open(d, "acme/lib");
    expect(selected(a.m, "work-repo")).toBe("acme/lib");
    a.cleanup();
    const b = await open(d, "unknown/repo");
    expect(selected(b.m, "work-repo")).toBe("");
    expect(b.m.textContent).toContain("Eighty-nine");
    b.cleanup();
  });

  it("applies the saved choices of the account only", async () => {
    const store = mem();
    store.data["scf.work.u1"] = JSON.stringify({ group: "repo" });
    const a = await open(board(), undefined, store, "u1");
    expect(selected(a.m, "work-group")).toBe("repo");
    a.cleanup();
    const b = await open(board(), undefined, store, "u2");
    expect(selected(b.m, "work-group")).toBe("status");
    b.cleanup();
  });

  it("drops a saved owner that is gone without writing storage", async () => {
    const store = mem();
    store.data["scf.work.u1"] = JSON.stringify({ owner: "gone", layout: "list" });
    const before = store.data["scf.work.u1"];
    const { m, cleanup } = await open(board(), undefined, store);
    expect(selected(m, "work-owner")).toBe("");
    expect(rows(m)).toHaveLength(1);
    expect(store.data["scf.work.u1"]).toBe(before);
    cleanup();
  });

  it("keeps the focus on the same control after a redraw", async () => {
    const { m, cleanup } = await open(board());
    focus(m, "work-group").focus();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([card({ title: "Changed" })]));
    await flush();
    expect((document as any).activeElement).toBe(focus(m, "work-group"));
    cleanup();
  });

  it("brings the ages up to date on a clock, without drawing again", async () => {
    let t = NOW.getTime();
    const m = main();
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store: mem(), now: () => new Date(t) });
    calls.shift()!.answer(board([card({ since: new Date(t - 59 * 60_000).toISOString() })]));
    await flush();
    expect(m.textContent).toContain("59 min");
    const first = m.children;
    t += 2 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    calls.length = 0;
    expect(m.textContent).toContain("1 h");
    expect(m.children).toBe(first);
    cleanup();
  });
});

describe("source", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("switches the board route on the setting", () => {
    expect(read("ui/app.js")).toContain("S.info.redesign ? renderWork(main, arg, { user: S.me }) : renderBoard(main, arg, { query: to.query, go })");
  });
  it("uses no inline style", () => {
    for (const f of ["ui/work.js", "ui/work-list.js", "ui/work-model.js", "ui/work-prefs.js", "ui/work-board.js", "ui/work-display.js"]) expect(read(f), f).not.toMatch(/style\s*:/);
  });
});
