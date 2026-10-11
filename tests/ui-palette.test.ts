import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let palette: any;
let shell: any;
let ia: any;
let data: any;
const g = globalThis as any;
const doc = () => g.document;
const byId = (id: string) => doc().getElementById(id) as FakeElement;

beforeAll(async () => {
  restore = installFakeDom();
  palette = await import("../ui/palette.js" as string);
  shell = await import("../ui/shell.js" as string);
  ia = await import("../ui/ia.js" as string);
  data = await import("../ui/palette-data.js" as string);
});
afterAll(() => restore());

// ---- a small browser: location, history, hashchange; a document whose capture listeners run first ----

const nav = { entries: ["#/home"], i: 0, queue: 0, listeners: [] as ((e?: unknown) => void)[] };
const caps: Record<string, ((e: any) => void)[]> = {};
const mem = (start: Record<string, string> = {}) => {
  const store: Record<string, string> = { ...start };
  return { store, getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
};
/** Runs the queued hashchange events; the listeners run in the order they were added. */
const flush = () => {
  while (nav.queue > 0) {
    nav.queue--;
    for (const fn of [...nav.listeners]) fn({});
  }
};
const press = (key: string, extra: object = {}) => {
  const e = { key, prevented: false, stopped: false, preventDefault() { e.prevented = true; }, stopPropagation() { e.stopped = true; }, ...extra };
  for (const fn of caps.keydown ?? []) fn(e);
  if (!e.stopped) for (const fn of [...(doc().listeners.keydown ?? [])]) fn(e);
  // A browser drops the focus of an element that left the page; the fake keeps it.
  const at = doc().activeElement as FakeElement | null;
  if (at?.getAttribute("role") === "combobox" && !byId("modal-root").children.length) doc().activeElement = null;
  return e;
};

let stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  nav.entries = ["#/home"];
  nav.i = 0;
  nav.queue = 0;
  nav.listeners = [];
  g.location = {
    get hash() { return nav.entries[nav.i]!; },
    set hash(v: string) {
      if (v === nav.entries[nav.i]) return;
      nav.entries = [...nav.entries.slice(0, nav.i + 1), v];
      nav.i++;
      nav.queue++;
    },
    pathname: "/app/",
    search: "?x=1",
  };
  g.history = { replaceState: (_s: unknown, _t: string, h: string) => { nav.entries[nav.i] = h; }, back: () => { nav.i--; nav.queue++; } };
  g.window = {
    addEventListener: (t: string, fn: () => void) => { if (t === "hashchange") nav.listeners.push(fn); },
    removeEventListener: (t: string, fn: () => void) => { if (t === "hashchange") nav.listeners = nav.listeners.filter((f) => f !== fn); },
  };
  for (const k of Object.keys(caps)) delete caps[k];
  doc().listeners = {};
  doc().addEventListener = (t: string, fn: (e: any) => void, cap?: boolean) => { ((cap ? caps : doc().listeners)[t] ??= []).push(fn); };
  doc().removeEventListener = (t: string, fn: (e: any) => void, cap?: boolean) => {
    const set = cap ? caps : doc().listeners;
    set[t] = (set[t] ?? []).filter((f: unknown) => f !== fn);
  };
  doc().querySelectorAll = () => [];
  doc().activeElement = null;
  doc().title = "";
  doc().body.classList.names.clear();
  for (const id of ["modal-root", "main", "route-status", "menu-btn", "side", "scrim", "account", "page-title", "content", "search-btn"]) {
    const e = byId(id);
    e.attrs = {};
    e.listeners = {};
    e.hidden = false;
    e.replaceChildren();
  }
  data.resetWishes();
});
afterEach(() => {
  for (const s of stops.splice(0)) s();
  vi.useRealTimers();
  delete g.location;
  delete g.history;
  delete g.window;
});

const hit = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "run", id, title: `Run ${id}`, href: `#/runs/${id}`, status: "running", repo: "o/r", owner: "Ann", at: new Date().toISOString(), ...extra,
});
const answer = (...hits: any[]) => ({ q: "x", groups: hits.length ? [{ type: "run", label: "Runs", hits, more: false }] : [] });
const deferred = () => {
  let res!: (v: any) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<any>((a, b) => { res = a; rej = b; });
  return { promise, res, rej };
};

interface Opts { role?: string; preview?: boolean; search?: any; recent?: any; store?: any; openTab?: any; user?: { id: string } }
function start(o: Opts = {}) {
  const store = o.store ?? mem();
  const search = o.search ?? vi.fn(async () => answer());
  const recent = o.recent ?? vi.fn(async () => answer());
  const openTab = o.openTab ?? vi.fn();
  const role = o.role ?? "admin";
  const stop = palette.initPalette({ role, user: o.user ?? { id: "u1" }, preview: o.preview, search, recent, store, openTab });
  stops.push(stop);
  return { store, search, recent, openTab, stop, role };
}
/** The router of the app: draws the frame for the hash. */
const router = (role = "admin") => nav.listeners.push(() => shell.showPage(role, ia.resolve(role, g.location.hash)));
/** Sets up the shell and the first page, as after sign-in. */
function page(role = "admin", narrow = false) {
  const media = Object.assign(new FakeElement("media"), { matches: narrow });
  stops.push(shell.initShell(role, { store: mem(), media }));
  shell.showPage(role, ia.resolve(role, g.location.hash));
  router(role);
}

const root = () => byId("modal-root");
const backdrop = () => root().children[0] as FakeElement;
const box = () => backdrop().children[0] as FakeElement;
const input = () => box().all("input").find((i) => i.getAttribute("role") === "combobox")!;
const checkbox = () => box().all("input").find((i) => i.getAttribute("type") === "checkbox")!;
const options = () => box().all("div").filter((d) => d.getAttribute("role") === "option");
const labels = () => options().map((o) => (o.children[0] as FakeElement).textContent);
const heads = () => box().all("div").filter((d) => d.attrs.class === "palette-head").map((d) => d.textContent);
const status = () => box().all("div").find((d) => d.getAttribute("role") === "status")!;
const type = (text: string) => { input().value = text; input().fire("input", {}); };
const go = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
const option = (label: string) => options().find((o) => (o.children[0] as FakeElement).textContent === label)!;
const opener = () => {
  const b = new FakeElement("button");
  b.focus();
  return b;
};

describe("opening and closing", () => {
  it("opens with Ctrl+K, ⌘K, / and the Search button", () => {
    start();
    for (const open of [() => press("k", { ctrlKey: true }), () => press("k", { metaKey: true }), () => press("/"), () => byId("search-btn").click()]) {
      open();
      expect(root().children).toHaveLength(1);
      press("Escape");
      expect(root().children).toHaveLength(0);
    }
  });

  it("names the dialog and makes the input a combobox with one selected option", () => {
    start();
    press("/");
    expect(box().getAttribute("role")).toBe("dialog");
    expect(box().getAttribute("aria-modal")).toBe("true");
    expect(box().getAttribute("aria-label")).toBe("Search");
    expect(input().getAttribute("aria-controls")).toBe(box().all("div").find((d) => d.getAttribute("role") === "listbox")!.getAttribute("id"));
    const selected = options().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(input().getAttribute("aria-activedescendant")).toBe(selected[0]!.getAttribute("id"));
    expect(doc().activeElement).toBe(input());
  });

  it("opens with Ctrl+K from a form field, but / does not", () => {
    start();
    const field = new FakeElement("input");
    field.focus();
    const slash = press("/", { target: field });
    expect(slash.prevented).toBe(false);
    expect(root().children).toHaveLength(0);
    const k = press("k", { ctrlKey: true, target: field });
    expect(k.prevented).toBe(true);
    expect(root().children).toHaveLength(1);
    press("Escape");
    expect(doc().activeElement).toBe(field);
  });

  it("closes with Escape and a backdrop mousedown, and gives the focus back; a mousedown inside does nothing", () => {
    start();
    const was = opener();
    press("/");
    box().fire("mousedown", { target: box(), currentTarget: backdrop() });
    expect(root().children).toHaveLength(1);
    backdrop().fire("mousedown", { target: backdrop(), currentTarget: backdrop() });
    expect(root().children).toHaveLength(0);
    expect(doc().activeElement).toBe(was);
    press("/");
    press("Escape");
    expect(doc().activeElement).toBe(was);
  });

  it("keeps Tab and Shift+Tab inside", () => {
    start();
    press("/");
    expect(press("Tab").prevented).toBe(false); // the input is first: the browser moves on to the checkbox
    checkbox().focus();
    expect(press("Tab").prevented).toBe(true);
    expect(doc().activeElement).toBe(input());
    expect(press("Tab", { shiftKey: true }).prevented).toBe(true);
    expect(doc().activeElement).toBe(checkbox());
  });

  it("opens the Search button for the button itself as the opener", () => {
    start();
    byId("search-btn").click();
    press("Escape");
    expect(doc().activeElement).toBe(byId("search-btn"));
  });
});

describe("the options", () => {
  it("lists Go to and Actions for each role, and no New refinement session in a preview", () => {
    start();
    press("/");
    expect(heads()).toEqual(["Go to", "Actions"]);
    expect(labels()).toContain("Users");
    expect(labels()).toContain("New refinement session");
    press("Escape");
    stops.pop()!();
    start({ role: "user" });
    press("/");
    expect(labels()).toEqual(["Home", "Refinement", "My runs", "My repositories", "Start work", "New refinement session"]);
    press("Escape");
    stops.pop()!();
    start({ role: "user", preview: true });
    press("/");
    expect(labels()).not.toContain("New refinement session");
    expect(labels()).toContain("Start work");
  });

  it("filters the commands as the person types", () => {
    start();
    press("/");
    type("all repo");
    expect(labels()).toEqual(["All repositories"]);
  });

  it("wraps the active option with the arrow keys", () => {
    start();
    press("/");
    const n = options().length;
    const active = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(press("ArrowUp").prevented).toBe(true);
    expect(active()).toBe(n - 1);
    press("ArrowDown");
    expect(active()).toBe(0);
    for (let i = 0; i < n; i++) press("ArrowDown");
    expect(active()).toBe(0);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]!.getAttribute("id"));
  });

  it("opens the active option with Enter and an option with a click", () => {
    page();
    start();
    press("/");
    press("ArrowDown");
    press("Enter");
    expect(g.location.hash).toBe("#/board");
    expect(root().children).toHaveLength(0);
    flush();
    press("k", { ctrlKey: true });
    option("Runs").click();
    expect(g.location.hash).toBe("#/runs");
  });

  it("with Ctrl or ⌘ and Enter opens a new tab, adds no entry and keeps the palette", () => {
    page();
    const s = start();
    press("/");
    press("ArrowDown");
    press("Enter", { ctrlKey: true });
    press("Enter", { metaKey: true });
    expect(s.openTab).toHaveBeenCalledTimes(2);
    expect(s.openTab).toHaveBeenCalledWith("/app/?x=1#/board");
    expect(nav.entries).toEqual(["#/home"]);
    expect(root().children).toHaveLength(1);
  });

  it("hands a wish to the new tab when the option has an intent", () => {
    page("user");
    const s = start({ role: "user" });
    press("/");
    type("new refinement");
    press("Enter", { ctrlKey: true });
    expect(JSON.parse(s.store.store["scf-wish:u1"]!)).toMatchObject({ page: "refinement", wish: {} });
    expect(nav.entries).toEqual(["#/home"]);
  });
});

describe("the search", () => {
  it("waits 200 ms, sends only the last text, and makes no call for an empty text", async () => {
    const s = start();
    press("/");
    type("a");
    type("ab");
    type("abc");
    await go(199);
    expect(s.search).not.toHaveBeenCalled();
    await go(1);
    expect(s.search).toHaveBeenCalledTimes(1);
    expect(s.search).toHaveBeenCalledWith("abc");
    type("");
    await go(500);
    expect(s.search).toHaveBeenCalledTimes(1);
  });

  it("draws the groups of the server after the commands, and announces the count", async () => {
    const s = start({ search: vi.fn(async () => answer(hit("a"), hit("b"), hit("c"))) });
    press("/");
    type("zzq");
    expect(options()).toHaveLength(0);
    await go(200);
    expect(heads()).toEqual(["Runs"]);
    expect(labels()).toEqual(["Run a", "Run b", "Run c"]);
    expect(status().textContent).toBe("3 results.");
    expect(s.search).toHaveBeenCalledTimes(1);
  });

  it("says 1 result, No results for … and what is missing", async () => {
    let next: any = answer(hit("a"));
    start({ search: vi.fn(async () => next) });
    press("/");
    type("zzq");
    await go(200);
    expect(status().textContent).toBe("1 result.");
    next = answer();
    type("zzz");
    await go(200);
    expect(status().textContent).toBe('No results for "zzz".');
    next = { ...answer(hit("a")), incomplete: ["run"] };
    type("zzy");
    await go(200);
    expect(status().textContent).toBe("1 result. Some results are missing.");
  });

  it("says search is not available, and still lists the commands", async () => {
    start({ search: vi.fn(async () => { throw new Error("down"); }) });
    press("/");
    type("repo");
    await go(200);
    expect(status().textContent).toBe("Search is not available. Pages and actions are still listed.");
    expect(labels()).toContain("All repositories");
  });

  it("shows the title, status, repository, owner and time of a hit", async () => {
    start({ search: vi.fn(async () => answer(hit("a"))) });
    press("/");
    type("zzq");
    await go(200);
    const meta = (options()[0]!.children[1] as FakeElement).textContent;
    expect(meta).toBe("running · o/r · Ann · just now");
  });

  it("does not draw or count a hit with a foreign address", async () => {
    start({ search: vi.fn(async () => answer(hit("a"), hit("b", { href: "https://evil.example/" }), hit("c", { href: "#/nope" }))) });
    press("/");
    type("zzq");
    await go(200);
    expect(labels()).toEqual(["Run a"]);
    expect(status().textContent).toBe("1 result.");
  });

  it("drops a slow answer that arrives after a newer one", async () => {
    const first = deferred();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(answer(hit("new")));
    start({ search });
    press("/");
    type("zzq");
    await go(200);
    type("zzqq");
    await go(200);
    first.res(answer(hit("old")));
    await go(0);
    expect(labels()).toEqual(["Run new"]);
  });

  it("drops an answer when the text changed before the next debounce fired", async () => {
    const first = deferred();
    start({ search: vi.fn().mockReturnValueOnce(first.promise) });
    press("/");
    type("zzq");
    await go(200);
    type("zzqq");
    first.res(answer(hit("old")));
    await go(0);
    expect(labels()).not.toContain("Run old");
    expect(status().textContent).toBe("");
  });

  it("clears the old results at once when the text changes", async () => {
    start({ search: vi.fn(async () => answer(hit("a"))) });
    press("/");
    type("zzq");
    await go(200);
    expect(labels()).toEqual(["Run a"]);
    type("zzqq");
    expect(labels()).toEqual([]);
  });

  it("sends nothing after the palette closed, and nothing old appears when it opens again", async () => {
    const s = start();
    press("/");
    type("zzq");
    await go(150);
    press("Escape");
    await go(500);
    expect(s.search).not.toHaveBeenCalled();
    press("/");
    await go(500);
    expect(s.search).not.toHaveBeenCalled();
    expect(input().value).toBe("");
  });

  it("sends nothing after stop with a debounce pending", async () => {
    const s = start();
    press("/");
    type("zzq");
    await go(100);
    s.stop();
    await go(500);
    expect(s.search).not.toHaveBeenCalled();
    expect(root().children).toHaveLength(0);
  });

  it("drops an answer that arrives after the palette closed and opened again", async () => {
    const first = deferred();
    start({ search: vi.fn().mockReturnValueOnce(first.promise) });
    press("/");
    type("zzq");
    await go(200);
    press("Escape");
    press("/");
    first.res(answer(hit("old")));
    await go(0);
    expect(labels()).not.toContain("Run old");
  });
});

describe("recent items", () => {
  const stored = () => mem({ "scf-recent:u1": JSON.stringify([{ type: "run", id: "r-1" }, { type: "run", id: "r-2" }, { type: "flow", id: "f" }]) });

  it("draws nothing before the server answered, then the returned ones in the stored order, and removes the others", async () => {
    const answerLater = deferred();
    const s = start({ store: stored(), recent: vi.fn(() => answerLater.promise) });
    press("/");
    expect(heads()).not.toContain("Recent");
    expect(s.recent).toHaveBeenCalledWith([{ type: "run", id: "r-1" }, { type: "run", id: "r-2" }, { type: "flow", id: "f" }]);
    answerLater.res(answer(hit("r-2"), hit("r-1"), { type: "flow", id: "f", title: "flow f", href: "#/flows/f" }));
    await go(0);
    expect(heads()[0]).toBe("Recent");
    expect(labels().slice(0, 3)).toEqual(["Run r-1", "Run r-2", "flow f"]);
  });

  it("removes a ref the server did not return, keeps an incomplete type, and writes ids only", async () => {
    const s = start({ store: stored(), recent: vi.fn(async () => ({ ...answer(hit("r-2")), incomplete: ["flow"] })) });
    press("/");
    await go(0);
    expect(labels().slice(0, 1)).toEqual(["Run r-2"]);
    expect(JSON.parse(s.store.store["scf-recent:u1"]!)).toEqual([{ type: "run", id: "r-2" }, { type: "flow", id: "f" }]);
  });

  it("removes nothing when the request fails, also with a 400", async () => {
    for (const err of [new Error("down"), Object.assign(new Error("bad"), { status: 400 })]) {
      const s = start({ store: stored(), recent: vi.fn(async () => { throw err; }) });
      const before = s.store.store["scf-recent:u1"];
      press("/");
      await go(0);
      expect(heads()).not.toContain("Recent");
      expect(s.store.store["scf-recent:u1"]).toBe(before);
      press("Escape");
      stops.pop()!();
    }
  });

  it("does not let a malformed stored id erase the good ones, and does not send it", async () => {
    const store = mem({ "scf-recent:u1": JSON.stringify([{ type: "repo", id: "nope" }, { type: "run", id: "r-1" }]) });
    const s = start({ store, recent: vi.fn(async () => answer(hit("r-1"))) });
    press("/");
    await go(0);
    expect(s.recent).toHaveBeenCalledWith([{ type: "run", id: "r-1" }]);
    expect(labels()[0]).toBe("Run r-1");
  });

  it("hides them when text is typed, and brings them back when it is cleared before they arrive", async () => {
    const later = deferred();
    start({ store: stored(), recent: vi.fn(() => later.promise) });
    press("/");
    type("zzq");
    later.res(answer(hit("r-1")));
    await go(0);
    expect(heads()).not.toContain("Recent");
    type("");
    expect(heads()[0]).toBe("Recent");
  });

  it("announces the count when recent items arrive and when the text is cleared", async () => {
    start({ store: stored(), recent: vi.fn(async () => ({ ...answer(hit("r-1")), incomplete: ["flow"] })) });
    press("/");
    const n = options().length;
    await go(0);
    expect(status().textContent).toBe(`${n + 1} options. Some recent items could not be checked.`);
    type("zzq");
    expect(status().textContent).toBe("");
    type("");
    expect(status().textContent).toBe(`${n + 1} options.`);
  });

  it("makes no request when nothing is stored, and writes {type,id} when a hit is opened", async () => {
    page();
    const s = start({ search: vi.fn(async () => answer(hit("a"))) });
    press("/");
    expect(s.recent).not.toHaveBeenCalled();
    type("zzq");
    await go(200);
    options()[0]!.click();
    flush();
    expect(JSON.parse(s.store.store["scf-recent:u1"]!)).toEqual([{ type: "run", id: "a" }]);
  });

  it("neither asks for nor writes recent items in a preview", async () => {
    page("user");
    const s = start({ role: "user", preview: true, store: stored(), search: vi.fn(async () => answer(hit("a"))) });
    const before = s.store.store["scf-recent:u1"];
    press("/");
    await go(0);
    expect(s.recent).not.toHaveBeenCalled();
    expect(heads()).not.toContain("Recent");
    type("zzq");
    await go(200);
    options()[0]!.click();
    flush();
    expect(s.store.store["scf-recent:u1"]).toBe(before);
  });

  it("keeps the recent items of another account apart", async () => {
    const store = stored();
    const s = start({ store, user: { id: "u2" } });
    press("/");
    await go(0);
    expect(s.recent).not.toHaveBeenCalled();
  });
});

describe("opening a page", () => {
  it("adds one history entry, Back returns, and focus moves to main with the page announced", () => {
    page();
    start();
    press("/");
    option("Runs").click();
    expect(nav.entries).toEqual(["#/home", "#/runs"]);
    flush();
    vi.advanceTimersByTime(60);
    expect(doc().activeElement).toBe(byId("main"));
    expect(byId("route-status").textContent).toBe("Runs");
    g.history.back();
    flush();
    expect(g.location.hash).toBe("#/home");
    expect(nav.entries).toHaveLength(2);
  });

  it("draws nothing again for the page that is open, and announces it again", () => {
    page();
    start();
    byId("route-status").textContent = "Home";
    press("/");
    option("Home").click();
    expect(nav.entries).toEqual(["#/home"]);
    expect(nav.queue).toBe(0);
    expect(doc().activeElement).toBe(byId("main"));
    expect(byId("route-status").textContent).toBe("");
    vi.advanceTimersByTime(60);
    expect(byId("route-status").textContent).toBe("Home");
  });

  it("gives the focus back to the opener and records nothing when the page refuses", async () => {
    page();
    nav.listeners.unshift(() => { g.history.replaceState(null, "", "#/home"); });
    const s = start({ search: vi.fn(async () => answer(hit("a"))) });
    const was = opener();
    press("/");
    type("zzq");
    await go(200);
    options()[0]!.click();
    expect(g.location.hash).toBe("#/runs/a");
    flush();
    expect(g.location.hash).toBe("#/home");
    expect(doc().activeElement).toBe(was);
    expect(s.store.store["scf-recent:u1"]).toBeUndefined();
  });

  it("forgets a wish when the page refuses", () => {
    page();
    nav.listeners.unshift(() => { g.history.replaceState(null, "", "#/home"); });
    start();
    press("/");
    option("New refinement session").click();
    flush();
    expect(data.takeWish("refinement")).toBeNull();
  });

  it("gives up waiting when no hashchange comes", () => {
    page();
    start();
    const was = opener();
    press("/");
    option("Runs").click();
    vi.advanceTimersByTime(2001);
    expect(doc().activeElement).toBe(was);
    expect(nav.listeners).toHaveLength(1); // only the router is left
  });
});

describe("keys", () => {
  it("goes to a page with g and a letter, with one history entry", () => {
    page();
    start();
    press("g");
    press("r");
    expect(nav.entries).toEqual(["#/home", "#/runs"]);
    flush();
    press("g");
    vi.advanceTimersByTime(1001);
    press("h");
    expect(g.location.hash).toBe("#/runs");
  });

  it("only offers the letters of the role", () => {
    page("user");
    start({ role: "user" });
    press("g");
    press("b");
    expect(nav.entries).toEqual(["#/home"]);
    press("g");
    press("s");
    expect(g.location.hash).toBe("#/start");
  });

  it("ignores / and g while another dialog is open or the drawer is open", () => {
    start();
    root().append(new FakeElement("div"));
    press("/");
    press("g");
    press("r");
    expect(root().children).toHaveLength(1);
    expect(nav.entries).toEqual(["#/home"]);
    root().replaceChildren();
    doc().body.classList.add("drawer-open");
    press("/");
    expect(root().children).toHaveLength(0);
  });

  it("opens over another dialog without touching it, and Escape closes only the palette", () => {
    start();
    const other = new FakeElement("div");
    root().append(other);
    const was = opener();
    press("k", { ctrlKey: true });
    expect(root().children).toEqual([other, expect.anything()]);
    const underlying = vi.fn();
    doc().addEventListener("keydown", underlying);
    const esc = press("Escape");
    expect(esc.stopped).toBe(true);
    expect(underlying).not.toHaveBeenCalled();
    expect(root().children).toEqual([other]);
    expect(doc().activeElement).toBe(was);
  });

  it("opens over the open drawer, leaves it open, and returns to the element that had the focus", () => {
    page("admin", true);
    start();
    byId("menu-btn").click();
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    const link = new FakeElement("a");
    link.setAttribute("href", "#/runs");
    byId("side").append(link);
    link.focus();
    press("k", { ctrlKey: true });
    expect(root().children).toHaveLength(1);
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    press("Escape");
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    expect(doc().activeElement).toBe(link);
  });

  it("closes the drawer when a result is opened", () => {
    page("admin", true);
    start();
    byId("menu-btn").click();
    press("k", { ctrlKey: true });
    option("Runs").click();
    flush();
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
  });

  it("switches the single keys off with the checkbox, and Ctrl+K still opens", () => {
    const s = start();
    press("/");
    expect(checkbox().checked).toBe(true);
    checkbox().checked = false;
    checkbox().fire("change", {});
    expect(s.store.store["scf-keys"]).toBe("off");
    press("Escape");
    press("/");
    expect(root().children).toHaveLength(0);
    press("k", { ctrlKey: true });
    expect(root().children).toHaveLength(1);
    expect(checkbox().checked).toBe(false);
  });

  it("stops: no key opens it, and an open palette closes", () => {
    const s = start();
    press("/");
    s.stop();
    expect(root().children).toHaveLength(0);
    press("/");
    press("k", { ctrlKey: true });
    expect(root().children).toHaveLength(0);
    expect(caps.keydown ?? []).toHaveLength(0);
  });
});

describe("intents", () => {
  it("sets the start wish for a flow of a user, and the handler of an open Start work page gets it", async () => {
    page("user");
    const flow = { type: "flow", id: "deliver", title: "Deliver", href: "#/start", detail: "d" };
    start({ role: "user", search: vi.fn(async () => ({ q: "x", groups: [{ type: "flow", label: "Flows", hits: [flow], more: false }] })) });
    press("/");
    type("zzq");
    await go(200);
    options()[0]!.click();
    expect(data.takeWish("start")).toEqual({ flow: "deliver" });
    flush();
    // now Start work is open: the same hit goes to its handler, nothing is drawn again
    const fn = vi.fn();
    data.onWish("start", fn);
    press("/");
    type("zzy");
    await go(200);
    options()[0]!.click();
    expect(fn).toHaveBeenCalledWith({ flow: "deliver" });
    expect(nav.entries).toEqual(["#/home", "#/start"]);
  });

  it("sets the refinement wish for New refinement session", () => {
    page();
    start();
    press("/");
    option("New refinement session").click();
    expect(g.location.hash).toBe("#/refinement");
    expect(data.takeWish("refinement")).toEqual({});
  });

  it("calls the handler of the refinement list when it is open", () => {
    nav.entries = ["#/refinement"];
    page();
    start();
    const fn = vi.fn();
    data.onWish("refinement", fn);
    press("/");
    option("New refinement session").click();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(nav.entries).toEqual(["#/refinement"]);
  });

  it("sets the repos wish for a repository of the user and all-repos for an admin", async () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    for (const [role, href, wishPage] of [["user", "#/repos", "repos"], ["admin", "#/all-repos", "all-repos"]] as const) {
      nav.entries = ["#/home"];
      nav.i = 0;
      page(role);
      start({ role, search: vi.fn(async () => ({ q: "x", groups: [{ type: "repo", label: "Repositories", hits: [{ type: "repo", id, title: "o/r", href }], more: false }] })) });
      press("/");
      type("zzq");
      await go(200);
      options()[0]!.click();
      expect(data.takeWish(wishPage)).toEqual({ repo: id });
      doc().activeElement = null;
      stops.splice(0).forEach((s) => s());
    }
  });
});

describe("the file", () => {
  it("has no shared dialog helper, no native dialog and no inline style", () => {
    const src = readFileSync("ui/palette.js", "utf8");
    for (const word of ["modal(", "confirm(", "prompt(", "style"]) expect(src.includes(word), word).toBe(false);
  });
});
