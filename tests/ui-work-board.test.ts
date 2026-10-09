import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let b: any;
let d: any;
let model: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/work.js" as string);
  b = await import("../ui/work-board.js" as string);
  d = await import("../ui/work-display.js" as string);
  model = await import("../ui/work-model.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown) => void }
let calls: Call[];
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body) => resolve({ ok: true, status: 200, statusText: "x", json: async () => body }) });
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
const card = (over: Record<string, unknown> = {}) => ({
  key: "acme/app#89", repo: "acme/app", issue: 89, title: "Eighty-nine", column: "waiting", runId: "r89", after: [88, 87], step: "Step 2 of 3",
  next: nextStep("dependency", { repo: "acme/app", issue: 89, title: "Eighty-nine", runId: "r89" }, { watched: true, blockers: [{ issue: 88 }] }),
  since: "2026-10-05T12:00:00Z", owner: "u1", ownerName: "Ann", ...over,
});
const board = (cards: any[] = [card()], repo = "acme/app") => ({
  repos: [{ repo, columns: COLS.map((id, i) => ({ id, title: TITLES[i], cards: cards.filter((c) => c.column === id) })) }],
});
const ALL = ["repo", "next", "blockers", "owner", "age", "step"];
const prefs = (over: Record<string, unknown> = {}) => ({ layout: "board", repo: "", owner: "", status: [], who: "", text: "", group: "status", order: "issue", props: ALL, compact: false, ...over });
const handlers = () => ({ onChange: vi.fn(), onText: vi.fn(), onClear: vi.fn(), onLeave: vi.fn(), now: NOW, stops: new Map() });
const mem = () => {
  const data: Record<string, string> = {};
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};
const focus = (root: FakeElement, name: string) => root.querySelectorAll("[data-focus]").find((e) => e.attrs["data-focus"] === name)!;
const cardsOf = (root: FakeElement) => root.querySelectorAll("[data-card]");
const groupsOf = (list: any[], p = prefs(), cols = model.columnsOf(board())) => model.groupItems(list, p, cols);
const many = () => [
  card(), card({ issue: 5, key: "acme/app#5", title: "Five", column: "coding", after: [], runId: undefined }),
  card({ issue: 6, key: "acme/app#6", title: "Six", column: "coding", after: [], owner: "u2", ownerName: "Bob", since: "2026-10-07T12:00:00Z" }),
  card({ issue: 7, key: "acme/app#7", title: "Seven", column: "your_turn", after: [], next: nextStep("running", { repo: "acme/app", issue: 7, title: "x", runId: "r7" }, { watched: false }) }),
];

describe("moveFocus", () => {
  const grid = [2, 0, 3, 0];
  const cases: [string, any, string, any][] = [
    ["down mid column", { col: 2, row: 0 }, "ArrowDown", { col: 2, row: 1 }],
    ["down at the last row", { col: 2, row: 2 }, "ArrowDown", null],
    ["up at row 0", { col: 0, row: 0 }, "ArrowUp", null],
    ["up", { col: 2, row: 2 }, "ArrowUp", { col: 2, row: 1 }],
    ["right skips an empty column", { col: 0, row: 1 }, "ArrowRight", { col: 2, row: 1 }],
    ["right with only empty columns after", { col: 2, row: 0 }, "ArrowRight", null],
    ["left clamps the row", { col: 2, row: 2 }, "ArrowLeft", { col: 0, row: 1 }],
    ["left from the first column", { col: 0, row: 0 }, "ArrowLeft", null],
    ["home", { col: 2, row: 2 }, "Home", { col: 2, row: 0 }],
    ["home at row 0", { col: 2, row: 0 }, "Home", null],
    ["end", { col: 2, row: 0 }, "End", { col: 2, row: 2 }],
    ["end at the last row", { col: 2, row: 2 }, "End", null],
    ["an unknown key", { col: 2, row: 0 }, "x", null],
    ["an empty column", { col: 1, row: 0 }, "ArrowDown", null],
    ["a row out of range", { col: 0, row: 5 }, "ArrowUp", null],
    ["a missing position", undefined, "ArrowUp", null],
  ];
  it.each(cases)("%s", (_n, at, key, want) => expect(b.moveFocus(grid, at, key)).toEqual(want));
  it("gives null for no columns", () => expect(b.moveFocus([], { col: 0, row: 0 }, "ArrowDown")).toBeNull());
});

describe("workCard", () => {
  const text = (p = prefs(), c = card()) => b.workCard(c, p, handlers());
  it("shows each part and the sentence as the title", () => {
    const c = card();
    const el = text();
    for (const s of ["#89", "Eighty-nine", c.next.who, "Blocked by #88, #87", "acme/app", "Ann", "3 d", "Step 2 of 3"]) expect(el.textContent, s).toContain(s);
    if (c.next.action) expect(el.textContent).toContain(c.next.action);
    expect(el.attrs.title).toBe(c.next.text);
    expect(el.children.length).toBeLessThanOrEqual(4);
    const hrefs = el.all("a").map((a: any) => a.attrs.href);
    expect(hrefs).toEqual(expect.arrayContaining(["https://github.com/acme/app/issues/89", "https://github.com/acme/app/issues/88", "https://github.com/acme/app/issues/87"]));
  });
  it("hides only the part whose property is off", () => {
    const hide: Record<string, string> = { repo: "acme/app", blockers: "Blocked by", owner: "Ann", age: "3 d", step: "Step 2 of 3", next: card().next.who };
    for (const [prop, s] of Object.entries(hide)) {
      const el = text(prefs({ props: ALL.filter((x) => x !== prop) }));
      expect(el.textContent, prop).not.toContain(s);
      for (const [other, t] of Object.entries(hide)) if (other !== prop) expect(el.textContent, `${prop}/${other}`).toContain(t);
    }
    const bare = text(prefs({ props: [] }));
    expect(bare.children).toHaveLength(1);
    expect(bare.textContent).toContain("Eighty-nine");
  });
  it("has no blocker line without blockers, and plain text for a name that is not GitHub's", () => {
    const el = text(prefs(), card({ after: [] }));
    expect(el.textContent).not.toContain("Blocked");
    const odd = b.workCard(card({ repo: "not a repo" }), prefs(), handlers());
    expect(odd.all("a")).toHaveLength(0);
    expect(odd.textContent).toContain("#89");
  });
  it("shows goes first", () => {
    expect(text(prefs(), card({ goesFirst: true })).textContent).toContain("goes first");
    expect(text().textContent).not.toContain("goes first");
  });
  it("marks your turn and blocked cards, also with blockers off", () => {
    const yours = text(prefs(), card({ column: "your_turn", after: [] }));
    expect(yours.attrs.class).toContain("yours");
    expect(yours.textContent).toContain("Your turn");
    const other = text();
    expect(other.attrs.class).not.toContain("yours");
    expect(other.textContent).not.toContain("Your turn");
    expect(other.textContent).toContain("Blocked");
    expect(text(prefs({ props: [] })).textContent).toContain("Blocked");
    expect(yours.textContent).not.toContain("Blocked");
  });
  it("opens the run on click, not on a GitHub link, and is no link without a run", () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    const h = handlers();
    const el = b.workCard(card(), prefs(), h);
    expect(el.attrs.role).toBe("link");
    el.listeners.click![0]!();
    expect(loc.hash).toBe("#/runs/r89");
    loc.hash = "";
    const stop = vi.fn();
    el.all("a")[0].listeners.click![0]!({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalled();
    expect(loc.hash).toBe("");
    const none = b.workCard(card({ runId: undefined }), prefs(), handlers());
    expect(none.attrs.role).toBeUndefined();
    expect(none.listeners.click).toBeUndefined();
  });
});

describe("workBoard", () => {
  const build = (list = many(), p = prefs(), h: any = handlers()) => {
    const box = b.workBoard(groupsOf(list, p), p, h);
    const root = new FakeElement("div");
    root.append(box);
    return { box, root, h };
  };
  const key = (name: string) => ({ key: name, target: undefined as any, currentTarget: undefined as any, preventDefault: vi.fn() });
  const press = (box: FakeElement, target: any, k: string) => {
    const e = { ...key(k), target, currentTarget: box };
    box.listeners.keydown![0]!(e);
    return e;
  };

  it("draws nine columns with title and count, and the compact class", () => {
    const { box } = build();
    const sections = box.all("section");
    expect(sections).toHaveLength(9);
    expect(sections.map((s: any) => s.all("h3")[0].textContent)).toContain("Coding 2");
    expect(box.attrs.class).toBe("work-board");
    expect(build(many(), prefs({ compact: true })).box.attrs.class).toBe("work-board compact");
    expect(build([card()]).box.all("section")).toHaveLength(9);
  });
  it("gives each non-empty column one Tab stop, the first card", () => {
    const { root } = build();
    const cols = root.all("section");
    for (const c of cols) {
      const cards = c.querySelectorAll("[data-card]");
      if (!cards.length) continue;
      expect(cards.filter((x: any) => x.attrs.tabindex === "0")).toHaveLength(1);
      expect(cards[0].attrs.tabindex).toBe("0");
    }
  });
  it("moves the Tab stop and the focus with the arrows, and keeps it in `stops`", () => {
    const { box, root, h } = build();
    const coding = root.all("section")[4]!.querySelectorAll("[data-card]");
    const e = press(box, coding[0], "ArrowDown");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(coding[1].attrs.tabindex).toBe("0");
    expect(coding[0].attrs.tabindex).toBe("-1");
    expect((document as any).activeElement).toBe(coding[1]);
    expect(h.stops.get("coding")).toBe("acme/app#6");
    const again = build(many(), prefs(), h);
    expect(again.root.all("section")[4]!.querySelectorAll("[data-card]")[1]!.attrs.tabindex).toBe("0");
  });
  it("moves sideways to the next non-empty column and keeps each column's own Tab stop", () => {
    const { box, root } = build();
    const secs = root.all("section");
    const yours = secs[0]!.querySelectorAll("[data-card]")[0];
    press(box, yours, "ArrowRight");
    const waiting = secs[1]!.querySelectorAll("[data-card]")[0];
    expect((document as any).activeElement).toBe(waiting);
    expect(yours.attrs.tabindex).toBe("0");
  });
  it("leaves one Tab stop in the column the focus moves into, between multi-row columns", () => {
    const list = [
      card({ issue: 1, key: "a#1", column: "queued", after: [] }), card({ issue: 2, key: "a#2", column: "queued", after: [] }),
      card({ issue: 3, key: "a#3", column: "coding", after: [] }), card({ issue: 4, key: "a#4", column: "coding", after: [] }),
    ];
    const { box, root } = build(list);
    const secs = root.all("section");
    const queued = secs[2]!.querySelectorAll("[data-card]");
    const coding = secs[4]!.querySelectorAll("[data-card]");
    press(box, queued[0], "ArrowDown");
    press(box, queued[1], "ArrowRight");
    expect(coding.map((c: any) => c.attrs.tabindex)).toEqual(["-1", "0"]);
    expect(queued.map((c: any) => c.attrs.tabindex)).toEqual(["-1", "0"]);
  });
  it("swallows a navigation key at an edge, and leaves keys of inner links alone", () => {
    const { box, root } = build();
    const coding = root.all("section")[4]!.querySelectorAll("[data-card]");
    for (const k of ["ArrowUp", "Home"]) expect(press(box, coding[0], k).preventDefault, k).toHaveBeenCalled();
    for (const k of ["ArrowDown", "End"]) expect(press(box, coding[1], k).preventDefault, k).toHaveBeenCalled();
    const link = coding[0].all("a")[0];
    expect(press(box, link, "ArrowDown").preventDefault).not.toHaveBeenCalled();
    expect(coding[0].attrs.tabindex).toBe("0");
  });
  it("opens the run on Enter, and does nothing for a card without a run", () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    const { box, root } = build();
    const coding = root.all("section")[4]!.querySelectorAll("[data-card]");
    press(box, coding[0], "Enter"); // #5 has no run
    expect(loc.hash).toBe("");
    press(box, coding[1], "Enter");
    expect(loc.hash).toBe("#/runs/r89");
    press(box, coding[1].all("a")[0], "Enter");
  });
});

describe("keys across both layouts", () => {
  const keysIn = (root: FakeElement, attr: string) => root.querySelectorAll(`[${attr}]`).map((e: any) => e.attrs["data-focus"].replace(/^(card:|row-)/, "")).sort();
  const draw = (data: any, p: any) => {
    const root = new FakeElement("div");
    root.append(...(ui.workView(data, p, handlers()) as any[]).filter(Boolean));
    return root;
  };
  const list = many();
  const filters: Record<string, any> = { none: {}, repo: { repo: "acme/app" }, owner: { owner: "u2" }, status: { status: ["coding"] }, who: { who: "You" }, text: { text: "five" } };
  for (const [name, over] of Object.entries(filters)) {
    it(`shows the same stories and headings in both layouts: ${name}`, () => {
      const data = board(list);
      for (const group of ["status", "repo", "owner", "next"]) {
        const a = draw(data, prefs({ ...over, group }));
        const l = draw(data, prefs({ ...over, group, layout: "list" }));
        const rows = l.all("tr").filter((r: any) => r.attrs["data-focus"]).map((r: any) => r.attrs["data-focus"].replace("row-", "").replace(/^[^#]*\//, "")).sort();
        const cards = keysIn(a, "data-card").map((k: string) => k.replace(/^[^#]*\//, ""));
        expect(cards, group).toEqual(rows);
        expect(a.all("h3").map((h: any) => h.textContent), group).toEqual(l.all("h3").map((h: any) => h.textContent));
      }
    });
  }
  it("keeps the order of the cards in each group", () => {
    const data = board(list);
    for (const order of ["issue", "age", "title"]) {
      const a = draw(data, prefs({ order }));
      const l = draw(data, prefs({ order, layout: "list" }));
      const seq = (r: FakeElement, attr: string) => r.all("section").length
        ? r.all("section").map((s: any) => s.querySelectorAll("[data-card]").map((e: any) => e.attrs["data-card"]))
        : r.all("table").map((t: any) => t.all("tr").filter((x: any) => x.attrs[attr]).map((x: any) => x.attrs[attr]));
      const norm = (x: string[][]) => x.filter((g) => g.length).map((g) => g.map((k) => k.replace(/^.*#/, "")));
      expect(norm(seq(a, "")), order).toEqual(norm(seq(l, "data-focus")));
    }
  });
  it("shows nine status columns for no grouping on the board, one group in the list, and the note", () => {
    const data = board(list);
    const a = draw(data, prefs({ group: "none" }));
    expect(a.all("section")).toHaveLength(9);
    expect(a.textContent).toContain("The board groups by status");
    const l = draw(data, prefs({ group: "none", layout: "list" }));
    expect(l.all("h3")).toHaveLength(0);
    expect(l.textContent).not.toContain("The board groups by status");
  });
});

describe("renderWork", () => {
  const open = async (data: unknown, store: any = mem()) => {
    const m = new FakeElement("main");
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store, now: () => NOW });
    calls.shift()!.answer(data);
    await flush();
    return { m, cleanup, store };
  };
  it("draws the board with Board pressed when nothing is saved", async () => {
    const { m, cleanup } = await open(board(many()));
    expect(cardsOf(m).length).toBe(4);
    expect(focus(m, "work-layout-board").attrs["aria-pressed"]).toBe("true");
    expect(focus(m, "work-layout-list").attrs["aria-pressed"]).toBe("false");
    cleanup();
  });
  it("switches the layout without a request, keeping the filters", async () => {
    const store = mem();
    store.data["scf.work.u1"] = JSON.stringify({ repo: "acme/app", text: "e", status: ["coding"] });
    const { m, cleanup } = await open(board(many()), store);
    focus(m, "work-layout-list").listeners.click![0]!();
    expect(calls).toHaveLength(0);
    expect(JSON.parse(store.data["scf.work.u1"])).toMatchObject({ layout: "list", repo: "acme/app", text: "e", status: ["coding"] });
    expect(focus(m, "work-layout-list").attrs["aria-pressed"]).toBe("true");
    expect(cardsOf(m)).toHaveLength(0);
    expect(m.all("tr").filter((r: any) => r.attrs["data-focus"]).length).toBe(1);
    cleanup();
  });
  it("does nothing when the chosen layout is clicked again", async () => {
    const store = mem();
    const { m, cleanup } = await open(board(many()), store);
    const first = m.children;
    focus(m, "work-layout-board").listeners.click![0]!();
    expect(m.children).toBe(first);
    expect(store.data["scf.work.u1"]).toBeUndefined();
    cleanup();
  });
  it("keeps the focus on a card across a refresh", async () => {
    const { m, cleanup } = await open(board(many()));
    const el = focus(m, "card:acme/app#6");
    (document as any).activeElement = el;
    el.focus?.();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board(many().map((c) => (c.issue === 6 ? { ...c, title: "Six changed" } : c))));
    await flush();
    const now = focus(m, "card:acme/app#6");
    expect(now).not.toBe(el);
    expect(now.textContent).toContain("Six changed");
    expect((document as any).activeElement).toBe(now);
    cleanup();
  });
  it("draws 200 cards once, and not again for an identical answer", async () => {
    const list = Array.from({ length: 200 }, (_, i) => card({ issue: i + 1, key: `acme/app#${i + 1}`, column: "coding", after: [], runId: undefined }));
    const { m, cleanup } = await open(board(list));
    const first = m.children;
    const coding = m.all("section").find((s: any) => s.all("h3")[0].textContent.startsWith("Coding"))!;
    expect(coding.all("h3")[0].textContent).toBe("Coding 200");
    expect(coding.querySelectorAll("[data-card]")).toHaveLength(200);
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board(list));
    await flush();
    expect(m.children).toBe(first);
    cleanup();
  });
  it("keeps the Display menu open across a redraw", async () => {
    const { m, cleanup } = await open(board(many()));
    const details = m.all("details")[0]!;
    details.listeners.toggle![0]!({ target: { open: true } });
    focus(m, "work-prop-owner").listeners.change![0]!({ target: { checked: false } });
    expect(m.all("details")[0]!.attrs.open).toBeDefined();
    expect(cardsOf(m)[0]!.textContent).not.toContain("Ann");
    cleanup();
  });
  it("updates the age of a card without drawing again", async () => {
    const { m, cleanup } = await open(board(many()));
    const list = await import("../ui/work-list.js" as string);
    list.refreshAges(m, new Date("2026-10-09T12:00:00Z"));
    expect(focus(m, "card:acme/app#89").textContent).toContain("4 d");
    cleanup();
  });
});

describe("displayMenu", () => {
  const menu = (p = prefs(), extra: any = {}) => {
    const onChange = vi.fn();
    const root = new FakeElement("div");
    root.append(d.displayMenu(p, onChange, extra));
    return { root, onChange };
  };
  it("has one checkbox per property, in order, checked as in props", () => {
    const { root } = menu(prefs({ props: ["age"] }));
    const boxes = root.querySelectorAll("[data-focus]").filter((e: any) => e.attrs["data-focus"].startsWith("work-prop-"));
    expect(boxes.map((e: any) => e.attrs["data-focus"].slice(10))).toEqual(ALL);
    expect(boxes.filter((e: any) => e.checked).map((e: any) => e.attrs["data-focus"])).toEqual(["work-prop-age"]);
  });
  it("sends the changes", () => {
    const { root, onChange } = menu();
    focus(root, "work-prop-owner").listeners.change![0]!({ target: { checked: false } });
    expect(onChange).toHaveBeenLastCalledWith({ props: ALL.filter((x) => x !== "owner") });
    focus(root, "work-compact").listeners.change![0]!({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({ compact: true });
    focus(root, "work-group").listeners.change![0]!({ target: { value: "repo" } });
    expect(onChange).toHaveBeenLastCalledWith({ group: "repo" });
    focus(root, "work-order").listeners.change![0]!({ target: { value: "title" } });
    expect(onChange).toHaveBeenLastCalledWith({ order: "title" });
  });
  it("is open on request, reports the toggle, and shows the note only on the board", () => {
    expect(menu(prefs(), { open: true }).root.all("details")[0]!.attrs.open).toBeDefined();
    expect(menu().root.all("details")[0]!.attrs.open).toBeUndefined();
    const onToggle = vi.fn();
    menu(prefs(), { onToggle }).root.all("details")[0]!.listeners.toggle![0]!({ target: { open: true } });
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(menu(prefs({ group: "none" })).root.textContent).toContain("groups by status");
    expect(menu(prefs({ group: "none", layout: "list" })).root.textContent).not.toContain("groups by status");
  });
});

describe("source", () => {
  it("has the board, snap, touch and height rules and does not reuse board-card", () => {
    const css = readFileSync("ui/css/pages/work.css", "utf8");
    for (const s of [".work-board", ".work-col", ".work-card", "scroll-snap-type", "min-height: 44px", "max-height"]) expect(css, s).toContain(s);
    expect(css).not.toContain(".board-card");
    expect(readFileSync("ui/work-board.js", "utf8")).not.toContain("board-card");
  });
});
