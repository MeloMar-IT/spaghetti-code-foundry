import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let p: any;
let b: any;
let l: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/work.js" as string);
  p = await import("../ui/work-panel.js" as string);
  b = await import("../ui/work-board.js" as string);
  l = await import("../ui/work-list.js" as string);
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
const waits = (issue: number, blockers: number[], over: Record<string, unknown> = {}) => ({
  key: `acme/app#${issue}`, repo: "acme/app", issue, title: `Story ${issue}`, column: "waiting", runId: `r${issue}`, after: blockers, chain: blockers,
  next: nextStep("dependency", { repo: "acme/app", issue, title: `Story ${issue}`, runId: `r${issue}` }, { watched: true, blockers: blockers.map((i) => ({ issue: i })) }),
  since: "2026-10-05T12:00:00Z", owner: "u1", ownerName: "Ann", watcher: "w1", ...over,
});
const free = (issue: number, over: Record<string, unknown> = {}) => ({
  key: `acme/app#${issue}`, repo: "acme/app", issue, title: `Story ${issue}`, column: "coding", runId: `r${issue}`, after: [], chain: [],
  next: nextStep("running", { repo: "acme/app", issue, title: `Story ${issue}`, runId: `r${issue}` }, { watched: true }),
  since: "2026-10-06T12:00:00Z", owner: "u1", ownerName: "Ann", watcher: "w1", ...over,
});
const board = (cards: any[]) => ({
  repos: [{ repo: "acme/app", columns: COLS.map((id, i) => ({ id, title: TITLES[i], cards: cards.filter((c) => c.column === id) })) }],
});
const withTitles = (c: any) => ({ ...c, columnTitle: TITLES[COLS.indexOf(c.column)] });
const issues = (list: any[]) => list.map((e) => e.issue);

describe("chainOrder", () => {
  it("lists direct blockers in order, marked direct", () => {
    const items = [waits(89, [88, 87]), free(88), free(87)].map(withTitles);
    expect(p.chainOrder(items[0], items)).toEqual([
      { issue: 87, direct: true, item: items[2] },
      { issue: 88, direct: true, item: items[1] },
    ]);
  });
  it("puts the deepest blocker first", () => {
    const items = [waits(89, [88, 87]), waits(88, [86]), free(87), free(86)].map(withTitles);
    const out = p.chainOrder(items[0], items);
    expect(issues(out)).toEqual([87, 86, 88]);
    expect(out.find((e: any) => e.issue === 86).direct).toBe(false);
  });
  it("has no item for a story that is not on the board, and follows its own blockers", () => {
    const first = waits(89, [88]);
    first.next.blockers[0].next = nextStep("dependency", { repo: "acme/app", issue: 88, title: "x" }, { blockers: [{ issue: 70 }] });
    const items = [first].map(withTitles);
    const out = p.chainOrder(items[0], items);
    expect(issues(out)).toEqual([70, 88]);
    expect("item" in out[0]).toBe(false);
    expect("item" in out[1]).toBe(false);
  });
  it("is safe against cycles and self-references, and lists each story once", () => {
    const items = [waits(89, [88]), waits(88, [89, 88])].map(withTitles);
    expect(issues(p.chainOrder(items[0], items))).toEqual([88]);
  });
  it("does not match a story of another repository", () => {
    const other = { ...free(88), repo: "acme/other", key: "acme/other#88" };
    const items = [waits(89, [88]), other].map(withTitles);
    expect("item" in p.chainOrder(items[0], items)[0]).toBe(false);
  });
  it("appends an issue of chain that the walk did not reach", () => {
    const first = { ...waits(89, [88]), chain: [88, 60] };
    expect(issues(p.chainOrder(first, [first]))).toEqual([88, 60]);
  });
  it("is empty without blockers and does not change its input", () => {
    const one = free(5);
    expect(p.chainOrder(one, [one])).toEqual([]);
    const first = waits(89, [88, 87]);
    const before = JSON.stringify(first);
    p.chainOrder(first, [first]);
    expect(JSON.stringify(first)).toBe(before);
  });
});

describe("panelView", () => {
  const items = [waits(89, [88, 87], { next: { ...waits(89, [88]).next, where: { label: "Open on GitHub", url: "https://github.com/acme/app/issues/88" } } }), free(88), waits(86, [])].map(withTitles);
  const view = (over: Record<string, unknown> = {}, list = items) => p.panelView(list[0], list, { now: NOW, onClose: vi.fn(), onPick: vi.fn(), onLeave: vi.fn(), ...over });
  const named = (el: FakeElement, n: string) => el.querySelectorAll("[data-focus]").find((e) => e.attrs["data-focus"] === n)!;

  it("shows the story, its sentence, next move, owner, age and the heading", () => {
    const el = view();
    const n = items[0].next;
    for (const s of ["#89 Story 89", n.text, n.who, n.action, "Ann", "3 d", "In the way of #89", "Open on GitHub"]) expect(el.textContent, s).toContain(s);
    expect(named(el, "work-panel-issue").attrs.href).toBe("https://github.com/acme/app/issues/89");
    expect(named(el, "work-panel-run").attrs.href).toBe("#/runs/r89");
    expect(named(el, "work-panel-run").textContent).toBe("Open run");
  });
  it("shows the where link also when it is the run page, and no Open run without a run", () => {
    const own = [{ ...items[0], next: { ...items[0].next, where: { label: "Open the run", url: "#/runs/r89" } } }];
    expect(view({}, own).textContent).toContain("Open the run");
    const none = [{ ...items[0], runId: undefined }];
    expect(view({}, none).querySelectorAll("[data-focus]").some((e) => e.attrs["data-focus"] === "work-panel-run")).toBe(false);
  });
  it("lists the chain: a button for a story on the board, a GitHub link for one that is not", () => {
    const onPick = vi.fn();
    const onLeave = vi.fn();
    const el = view({ onPick, onLeave });
    const on = named(el, "work-panel-chain-88");
    expect(on.tag).toBe("button");
    expect(on.textContent).toBe("#88 Story 88");
    on.click();
    expect(onPick).toHaveBeenCalledWith(items[1]);
    const off = named(el, "work-panel-chain-87");
    expect(off.tag).toBe("a");
    expect(off.attrs.href).toBe("https://github.com/acme/app/issues/87");
    off.click();
    expect(onLeave).toHaveBeenCalledWith(items[0]);
    expect(el.textContent).toContain("not on the board");
    expect(el.textContent).toContain(items[1].next.who);
    expect(el.all("li")).toHaveLength(2);
  });
  it("marks only the direct entries", () => {
    const deep = [waits(89, [88]), waits(88, [86]), free(86)].map(withTitles);
    const lis = p.panelView(deep[0], deep, { now: NOW }).all("li");
    expect(lis.map((li: FakeElement) => li.textContent.includes("directly"))).toEqual([false, true]);
  });
  it("says nothing is in the way", () => {
    const one = [withTitles(free(5))];
    expect(p.panelView(one[0], one, { now: NOW }).textContent).toContain("Nothing is in the way.");
  });
  it("is a complementary region named after the story, and a dialog when narrow; never an aside", () => {
    const el = view();
    expect(el.tag).not.toBe("aside");
    expect(el.attrs).toMatchObject({ role: "complementary", "aria-label": "#89 Story 89" });
    expect(el.attrs["aria-modal"]).toBeUndefined();
    expect(view({ narrow: true }).attrs).toMatchObject({ role: "dialog", "aria-modal": "true" });
  });
  it("offers Back only with onBack, and Close calls onClose", () => {
    expect(view().querySelectorAll("[data-focus]").some((e) => e.attrs["data-focus"] === "work-panel-back")).toBe(false);
    const onBack = vi.fn();
    const onClose = vi.fn();
    const el = view({ onBack, onClose });
    named(el, "work-panel-back").click();
    named(el, "work-panel-close").click();
    expect(onBack).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the button", () => {
  const prefs = { layout: "board", props: [], compact: false };
  const way = (el: FakeElement) => el.querySelectorAll("[data-way]");
  it("is on a blocked card and row, closed, and absent without blockers; also with props off", () => {
    const item = withTitles(waits(89, [88]));
    const card = b.workCard(item, prefs, {});
    expect(way(card)).toHaveLength(1);
    expect(way(card)[0]!.textContent).toBe("What is in the way?");
    expect(way(card)[0]!.attrs).toMatchObject({ "aria-expanded": "false", "aria-controls": "work-panel" });
    expect(way(b.workCard({ ...item, after: [] }, prefs, {}))).toHaveLength(0);
    const rows = l.listView([{ id: "x", title: "X", items: [item, withTitles(free(5))] }], { ...prefs, props: ["next"] }, {});
    expect(rows.flatMap((r: FakeElement) => way(r))).toHaveLength(1);
  });
  it("calls onOpen with the item, stops the click and leaves the hash alone", () => {
    (globalThis as any).location = { hash: "" };
    const onOpen = vi.fn();
    const item = withTitles(waits(89, [88]));
    const card = b.workCard(item, prefs, { onOpen });
    way(card)[0]!.click();
    expect(onOpen).toHaveBeenCalledWith(item, "way:acme/app#89");
    expect((globalThis as any).location.hash).toBe("");
  });
  it("opens with Enter on a card without a run; a card with a run still goes to the run", () => {
    (globalThis as any).location = { hash: "" };
    const onOpen = vi.fn();
    const noRun = withTitles(waits(89, [88], { runId: undefined }));
    b.workCard(noRun, prefs, { onOpen }).open();
    expect(onOpen).toHaveBeenCalledWith(noRun, "card:acme/app#89");
    const run = b.workCard(withTitles(waits(89, [88])), prefs, { onOpen });
    run.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect((globalThis as any).location.hash).toBe("#/runs/r89");
  });
});

describe("renderWork with the panel", () => {
  const mem = () => {
    const data: Record<string, string> = {};
    return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
  };
  const keys = () => (document as any).listeners.keydown ?? [];
  const press = (k: string, extra: Record<string, unknown> = {}) => {
    const e = { key: k, preventDefault: vi.fn(), ...extra };
    for (const fn of [...keys()]) fn(e);
    return e;
  };
  const cards = () => [waits(89, [88, 87]), free(88), waits(90, [88], { runId: undefined })];
  const open = async (data: unknown = board(cards()), media?: any, store: any = mem()) => {
    const m = new FakeElement("main");
    const cleanup = ui.renderWork(m, undefined, { user: "u1", store, now: () => NOW, media });
    calls.shift()!.answer(data);
    await flush();
    return { m, cleanup, store };
  };
  const named = (m: FakeElement, n: string) => m.querySelectorAll("[data-focus]").find((e) => e.attrs["data-focus"] === n)!;
  const slotOf = (m: FakeElement) => m.querySelectorAll("div").find((e) => e.attrs.id === "work-panel")!;
  const cardsOf = (m: FakeElement) => m.querySelectorAll("[data-card]");
  const wide = () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const narrow = () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const active = () => (document as any).activeElement;

  it("opens the panel with the heading focused, and changes nothing else on the page", async () => {
    const { m, cleanup, store } = await open(undefined, wide());
    const before = cardsOf(m);
    const saved = { ...store.data };
    named(m, "way:acme/app#89").click();
    const panel = slotOf(m).children[0] as FakeElement;
    expect(panel.attrs.role).toBe("complementary");
    expect(panel.textContent).toContain("In the way of #89");
    expect(active().attrs["data-focus"]).toBe("work-panel-title");
    expect(named(m, "way:acme/app#89").attrs["aria-expanded"]).toBe("true");
    expect(named(m, "way:acme/app#90").attrs["aria-expanded"]).toBe("false");
    expect(cardsOf(m)).toEqual(before);
    cardsOf(m).forEach((c, i) => expect(c).toBe(before[i]));
    named(m, "work-panel-close").click();
    cardsOf(m).forEach((c, i) => expect(c).toBe(before[i]));
    expect(store.data).toEqual(saved);
    expect(calls).toHaveLength(0);
    cleanup();
  });
  it("dims nothing: no dim class in the page or in the sources", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    const all = (el: FakeElement): FakeElement[] => [el, ...el.querySelectorAll("div, section, button, a, span, li, ol, h2, h3, p")];
    expect(all(m).some((e) => /\bdim\b/.test(e.attrs.class ?? ""))).toBe(false);
    for (const f of ["work.js", "work-board.js", "work-list.js", "work-panel.js", "css/pages/work.css"]) expect(readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8"), f).not.toMatch(/\bdim\b/);
    expect(readFileSync(new URL("../ui/work-panel.js", import.meta.url), "utf8")).not.toContain("style:");
    cleanup();
  });
  it("is not hidden by the no-side rule: the panel is no aside", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    expect(m.all("aside")).toHaveLength(0);
    cleanup();
  });
  it("closes with Close and with Escape, focus back on the opener; a second click toggles", async () => {
    const { m, cleanup } = await open(undefined, wide());
    const btn = () => named(m, "way:acme/app#89");
    press("Escape");
    expect(slotOf(m).children).toHaveLength(0);
    btn().click();
    named(m, "work-panel-close").click();
    expect(slotOf(m).children).toHaveLength(0);
    expect(active()).toBe(btn());
    expect(btn().attrs["aria-expanded"]).toBe("false");
    btn().click();
    press("Escape");
    expect(slotOf(m).children).toHaveLength(0);
    expect(active()).toBe(btn());
    btn().click();
    btn().click();
    expect(slotOf(m).children).toHaveLength(0);
    cleanup();
  });
  it("opens with Enter on a card without a run, and Escape returns the focus to the card", async () => {
    const { m, cleanup } = await open(undefined, wide());
    const card = cardsOf(m).find((c) => c.attrs["data-card"] === "acme/app#90")!;
    const box = m.querySelectorAll("div").find((e) => /work-board/.test(e.attrs.class ?? ""))!;
    box.listeners.keydown![0]!({ key: "Enter", target: card, preventDefault: vi.fn() });
    expect((slotOf(m).children[0] as FakeElement).textContent).toContain("In the way of #90");
    press("Escape");
    expect(active()).toBe(cardsOf(m).find((c) => c.attrs["data-card"] === "acme/app#90"));
    cleanup();
  });
  it("opens a listed story, and Back returns to the one before", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#90").click();
    expect(slotOf(m).textContent).toContain("In the way of #90");
    named(m, "work-panel-chain-88").click();
    expect(slotOf(m).textContent).toContain("In the way of #88");
    named(m, "work-panel-back").click();
    expect(slotOf(m).textContent).toContain("In the way of #90");
    expect(slotOf(m).querySelectorAll("[data-focus]").some((e) => e.attrs["data-focus"] === "work-panel-back")).toBe(false);
    cleanup();
  });
  it("follows the refresh: new data in the panel, focus kept on Close", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    named(m, "work-panel-close").focus();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([{ ...waits(89, [88, 87]), title: "Renamed" }, free(88)]));
    await flush();
    expect(slotOf(m).textContent).toContain("#89 Renamed");
    expect(active().attrs["data-focus"]).toBe("work-panel-close");
    cleanup();
  });
  it("closes with a line when the story is gone, drops gone stories from Back, and keeps working", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    named(m, "work-panel-chain-88").click();
    named(m, "work-panel-close").focus();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([waits(89, [88, 87])]));
    await flush();
    expect(slotOf(m).children).toHaveLength(0);
    expect(document.getElementById("toast")!.textContent).toBe("#88 is no longer on the board");
    expect(active()).toBe(named(m, "way:acme/app#89")); // the opener is still there
    cleanup();
    const second = await open(undefined, wide());
    named(second.m, "way:acme/app#89").click();
    named(second.m, "work-panel-chain-88").click();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([waits(89, [88, 87]), waits(90, [88])]));
    await flush();
    expect(slotOf(second.m).children).toHaveLength(0);
    expect(document.getElementById("toast")!.textContent).toBe("#88 is no longer on the board");
    second.cleanup();
  });
  it("falls back to the heading when the opener is gone", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([waits(89, [88, 87], { after: [] }), free(88)]));
    await flush();
    named(m, "work-panel-close").click();
    expect(active().tag).toBe("h1");
    cleanup();
  });
  it("is a dialog when narrow and keeps the Tab key inside", async () => {
    const media = narrow();
    const { m, cleanup } = await open(undefined, media);
    named(m, "way:acme/app#89").click();
    const panel = slotOf(m).children[0] as FakeElement;
    expect(panel.attrs.role).toBe("dialog");
    const stops = [...panel.querySelectorAll("button, a")];
    stops[stops.length - 1]!.focus();
    const fwd = press("Tab");
    expect(fwd.preventDefault).toHaveBeenCalled();
    expect(active()).toBe(stops[0]);
    const back = press("Tab", { shiftKey: true });
    expect(back.preventDefault).toHaveBeenCalled();
    expect(active()).toBe(stops[stops.length - 1]);
    named(m, "way:acme/app#89").focus();
    press("Tab");
    expect(active()).toBe(stops[0]);
    cleanup();
  });
  it("does not trap Tab on a wide screen", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    const stops = [...(slotOf(m).children[0] as FakeElement).querySelectorAll("button, a")];
    stops[stops.length - 1]!.focus();
    expect(press("Tab").preventDefault).not.toHaveBeenCalled();
    cleanup();
  });
  it("moves the focus into the panel when the screen becomes narrow, and listens to the change", async () => {
    const media = wide();
    const { m, cleanup } = await open(undefined, media);
    named(m, "way:acme/app#89").click();
    named(m, "way:acme/app#89").focus();
    const change = media.addEventListener.mock.calls.find((c: any[]) => c[0] === "change")![1];
    media.matches = true;
    change();
    const panel = slotOf(m).children[0] as FakeElement;
    expect(panel.attrs.role).toBe("dialog");
    expect(panel.contains(active())).toBe(true);
    named(m, "work-panel-close").focus();
    media.matches = false;
    change();
    expect(active().attrs["data-focus"]).toBe("work-panel-close");
    cleanup();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", change);
  });
  it("checks the watcher after a GitHub link in the panel and a return to the tab", async () => {
    const { m, cleanup } = await open(undefined, wide());
    named(m, "way:acme/app#89").click();
    named(m, "work-panel-issue").click();
    (document as any).listeners.visibilitychange![0]();
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/watchers/w1/tick" });
    calls[0]!.answer({});
    await flush();
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/board" });
    cleanup();
  });
  it("works when querySelectorAll returns a NodeList (no find, no map)", async () => {
    const proto = FakeElement.prototype as any;
    const orig = proto.querySelectorAll;
    class NodeListLike {
      length: number;
      constructor(private list: FakeElement[]) { this.length = list.length; }
      [Symbol.iterator]() { return this.list[Symbol.iterator](); }
      forEach(fn: any) { this.list.forEach(fn); }
    }
    const { m, cleanup } = await open(undefined, wide());
    const find = (n: string) => orig.call(m, "[data-focus]").find((e: FakeElement) => e.attrs["data-focus"] === n) as FakeElement;
    proto.querySelectorAll = function (this: FakeElement, s: string) { return new NodeListLike(orig.call(this, s)); };
    try {
      const btn = find("way:acme/app#89");
      btn.click();
      find("work-panel-close").click();
      expect(active()).toBe(btn);
      btn.click();
      press("Escape");
      expect(active()).toBe(btn);
      btn.click();
      await vi.advanceTimersByTimeAsync(5000);
      calls.shift()!.answer(board([free(88)]));
      await flush();
      expect(document.getElementById("toast")!.textContent).toBe("#89 is no longer on the board");
    } finally {
      proto.querySelectorAll = orig;
      cleanup();
    }
  });
  it("works in the list layout, and removes its key listener on cleanup", async () => {
    const store = mem();
    store.data["scf.work.u1"] = JSON.stringify({ layout: "list" });
    const count = keys().length;
    const { m, cleanup } = await open(undefined, wide(), store);
    expect(keys().length).toBe(count + 1);
    named(m, "way:acme/app#89").click();
    expect(slotOf(m).textContent).toContain("In the way of #89");
    press("Escape");
    expect(slotOf(m).children).toHaveLength(0);
    cleanup();
    expect(keys().length).toBe(count);
  });
});
