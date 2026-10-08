import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let prefs: any;
beforeAll(async () => {
  restore = installFakeDom();
  prefs = await import("../ui/prefs.js" as string);
});
afterAll(() => restore());

const KEY = "scf.prefs";
// A map-backed store: it checks the key of every access and keeps other keys as they are.
const mem = (initial?: unknown) => {
  const keys: string[] = [];
  const map = new Map<string, string>([["scf-side", "untouched"]]);
  if (initial !== undefined) map.set(KEY, typeof initial === "string" ? initial : JSON.stringify(initial));
  const s: any = {
    keys,
    map,
    getItem: vi.fn((k: string) => { keys.push(k); return map.get(k) ?? null; }),
    setItem: vi.fn((k: string, v: string) => { keys.push(k); map.set(k, v); }),
    get data() { return map.get(KEY); },
    set data(v: string | undefined) { if (v === undefined) map.delete(KEY); else map.set(KEY, v); },
  };
  return s;
};
const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
const saved = (s: any) => JSON.parse(s.data);
const DEF = { theme: "system", density: "comfortable" };
const DARK = { theme: "dark", density: "compact" };
const root = () => new FakeElement("html");

describe("cleanPrefs", () => {
  it("gives the defaults for garbage", () => {
    for (const x of [undefined, null, 42, "dark", [], ["dark", "compact"], { theme: "blue", density: "tiny" }, { theme: "Dark" }]) {
      expect(prefs.cleanPrefs(x)).toEqual(DEF);
    }
  });
  it("keeps valid values and only the two keys", () => {
    expect(prefs.cleanPrefs({ theme: "dark" })).toEqual({ theme: "dark", density: "comfortable" });
    expect(prefs.cleanPrefs({ ...DARK, extra: 1 })).toEqual(DARK);
  });
});

describe("readPrefs", () => {
  it("gives the defaults when nothing usable is stored", () => {
    expect(prefs.readPrefs("u1", undefined)).toEqual(DEF);
    expect(prefs.readPrefs("u1", bad)).toEqual(DEF);
    for (const raw of ["{nope", "[1]", "null", { v: 2, last: { theme: "dark" } }, { v: 1 }, { v: 1, accounts: [] }]) {
      expect(prefs.readPrefs("u1", mem(raw))).toEqual(DEF);
    }
  });
  it("uses the account's entry, else last", () => {
    const store = mem({ v: 1, last: { theme: "light", density: "comfortable" }, accounts: { u1: DARK, u3: { theme: 5 } } });
    expect(prefs.readPrefs("u1", store)).toEqual(DARK);
    expect(prefs.readPrefs("u2", store)).toEqual({ theme: "light", density: "comfortable" });
    expect(prefs.readPrefs("u3", store)).toEqual(DEF);
    for (const id of [undefined, "", "toString", "__proto__"]) expect(prefs.readPrefs(id, store)).toEqual({ theme: "light", density: "comfortable" });
  });
  it("only touches the key scf.prefs", () => {
    const store = mem({ v: 1, last: DARK, accounts: {} });
    prefs.readPrefs("u1", store);
    expect(new Set(store.keys)).toEqual(new Set([KEY]));
  });
});

describe("writePrefs", () => {
  it("saves the account and last on an empty store, and leaves other keys alone", () => {
    const store = mem();
    prefs.writePrefs("u1", DARK, store);
    expect(saved(store)).toEqual({ v: 1, last: DARK, accounts: { u1: DARK } });
    expect(store.map.get("scf-side")).toBe("untouched");
    expect(new Set(store.keys)).toEqual(new Set([KEY]));
  });
  it("keeps other accounts and updates last", () => {
    const store = mem({ v: 1, last: DEF, accounts: { u2: DEF } });
    prefs.writePrefs("u1", DARK, store);
    expect(saved(store)).toEqual({ v: 1, last: DARK, accounts: { u2: DEF, u1: DARK } });
  });
  it("reads before it writes (another tab)", () => {
    const store = mem();
    prefs.writePrefs("u1", DARK, store);
    store.data = JSON.stringify({ v: 1, last: DEF, accounts: { u2: DEF } });
    prefs.writePrefs("u1", DARK, store);
    expect(saved(store).accounts).toEqual({ u2: DEF, u1: DARK });
  });
  it("keeps at most 20 accounts and drops the oldest", () => {
    const store = mem();
    for (let i = 0; i <= 20; i++) prefs.writePrefs(`a${i}`, DARK, store);
    const ids = Object.keys(saved(store).accounts);
    expect(ids).toHaveLength(20);
    expect(ids).not.toContain("a0");
    expect(ids).toContain("a1");
    expect(ids).toContain("a20");
  });
  it("moves a rewritten account to the newest place", () => {
    const store = mem();
    for (let i = 0; i < 20; i++) prefs.writePrefs(`a${i}`, DARK, store);
    prefs.writePrefs("a0", DEF, store);
    prefs.writePrefs("a20", DARK, store);
    const ids = Object.keys(saved(store).accounts);
    expect(ids).not.toContain("a1");
    expect(ids).toContain("a0");
  });
  it("cleans values, survives bad storage, and treats ids safely", () => {
    const store = mem();
    prefs.writePrefs("u1", { theme: "blue", density: "compact" }, store);
    expect(saved(store).accounts.u1).toEqual({ theme: "system", density: "compact" });
    expect(() => prefs.writePrefs("u1", DARK, bad)).not.toThrow();
    expect(() => prefs.writePrefs("u1", DARK, undefined)).not.toThrow();
    prefs.writePrefs("", DARK, store);
    expect(saved(store).last).toEqual(DARK);
    expect(Object.keys(saved(store).accounts)).toEqual(["u1"]);
    prefs.writePrefs("__proto__", DARK, store);
    expect(({} as any).theme).toBeUndefined();
  });
  it("overwrites a broken value", () => {
    const store = mem("{nope");
    prefs.writePrefs("u1", DARK, store);
    expect(saved(store)).toEqual({ v: 1, last: DARK, accounts: { u1: DARK } });
  });
});

describe("applyPrefs", () => {
  it.each(
    ["system", "light", "dark"].flatMap((theme) => ["comfortable", "compact"].map((density) => [theme, density])),
  )("sets %s and %s", (theme, density) => {
    const r = root();
    prefs.applyPrefs({ theme, density }, r);
    expect(r.attrs).toEqual({ "data-theme": theme, "data-density": density });
  });
  it("uses the defaults for garbage, and never removes an attribute", () => {
    const r = root();
    const remove = vi.spyOn(r, "removeAttribute");
    prefs.applyPrefs(DARK, r);
    prefs.applyPrefs(prefs.DEFAULTS, r);
    expect(r.attrs).toEqual({ "data-theme": "system", "data-density": "comfortable" });
    prefs.applyPrefs("junk", r);
    expect(r.attrs).toEqual({ "data-theme": "system", "data-density": "comfortable" });
    expect(remove).not.toHaveBeenCalled();
  });
  it("defaults to document.documentElement", () => {
    prefs.applyPrefs(DARK);
    expect((document as any).documentElement.attrs).toEqual({ "data-theme": "dark", "data-density": "compact" });
  });
});

describe("initPrefs", () => {
  it("applies the account's choice and makes it last", () => {
    const store = mem({ v: 1, last: DEF, accounts: { u1: DARK } });
    const r = root();
    prefs.initPrefs({ id: "u1" }, { store, root: r });
    expect(r.attrs).toEqual({ "data-theme": "dark", "data-density": "compact" });
    expect(saved(store)).toEqual({ v: 1, last: DARK, accounts: { u1: DARK } });
  });
  it("uses last for an account without an entry, and adds none", () => {
    const store = mem({ v: 1, last: DARK, accounts: { u1: DEF } });
    const r = root();
    prefs.initPrefs({ id: "u2" }, { store, root: r });
    expect(r.attrs["data-theme"]).toBe("dark");
    expect(saved(store).accounts).toEqual({ u1: DEF });
  });
  it("does not throw with bad storage or no user", () => {
    const r = root();
    expect(() => prefs.initPrefs({ id: "u1" }, { store: bad, root: r })).not.toThrow();
    expect(r.attrs).toEqual({ "data-theme": "system", "data-density": "comfortable" });
    expect(() => prefs.initPrefs(undefined, { store: mem(), root: r })).not.toThrow();
  });
  it("does not write when last already matches", () => {
    const store = mem({ v: 1, last: DARK, accounts: { u1: DARK } });
    prefs.initPrefs({ id: "u1" }, { store, root: root() });
    expect(store.setItem).not.toHaveBeenCalled();
  });
  it("uses one snapshot: last and the applied choice agree even if the store changes after", () => {
    const first = { v: 1, last: DEF, accounts: { u1: DARK } };
    const store = mem(first);
    const real = store.getItem.getMockImplementation()!;
    let reads = 0;
    store.getItem.mockImplementation((k: string) => (++reads === 1 ? real(k) : JSON.stringify({ v: 1, last: DEF, accounts: { u1: { theme: "light", density: "comfortable" } } })));
    const r = root();
    prefs.initPrefs({ id: "u1" }, { store, root: r });
    expect(reads).toBe(1);
    expect(r.attrs["data-theme"]).toBe("dark");
    expect(saved(store).last).toEqual(DARK);
    expect(saved(store).accounts.u1).toEqual(DARK);
  });
});

describe("the Appearance dialog", () => {
  const modalRoot = () => document.getElementById("modal-root") as unknown as FakeElement;
  const groups = () => modalRoot().all("div").filter((d) => d.attrs.role === "group");
  const buttons = (g: FakeElement) => g.all("button");
  const marks = (g: FakeElement) => buttons(g).map((b) => b.attrs["aria-pressed"]);
  beforeEach(() => modalRoot().replaceChildren());

  it("shows the title, the groups and the marks", () => {
    void prefs.appearanceDialog({ id: "u1" }, { store: mem(), root: root() });
    expect(modalRoot().all("h2").map((x) => x.textContent)).toEqual(["Appearance"]);
    const [theme, density] = groups();
    expect(theme!.attrs["aria-label"]).toBe("Theme");
    expect(density!.attrs["aria-label"]).toBe("Density");
    expect(buttons(theme!).map((b) => b.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(buttons(density!).map((b) => b.textContent)).toEqual(["Comfortable", "Compact"]);
    expect(marks(theme!)).toEqual(["true", "false", "false"]);
    expect(marks(density!)).toEqual(["true", "false"]);
    expect(buttons(theme!).map((b) => b.all("svg").length)).toEqual([2, 1, 1]);
    expect(buttons(theme!).map((b) => b.attrs.class === "on")).toEqual([true, false, false]);
  });
  it("starts on the stored choice", () => {
    void prefs.appearanceDialog({ id: "u1" }, { store: mem({ v: 1, last: DEF, accounts: { u1: DARK } }), root: root() });
    const [theme, density] = groups();
    expect(marks(theme!)).toEqual(["false", "false", "true"]);
    expect(marks(density!)).toEqual(["false", "true"]);
  });
  it("a click applies, saves and moves the mark", () => {
    const store = mem();
    const r = root();
    void prefs.appearanceDialog({ id: "u1" }, { store, root: r });
    buttons(groups()[0]!)[2]!.click();
    expect(r.attrs["data-theme"]).toBe("dark");
    expect(saved(store).accounts.u1.theme).toBe("dark");
    expect(saved(store).last.theme).toBe("dark");
    expect(marks(groups()[0]!)).toEqual(["false", "false", "true"]);
    expect(marks(groups()[1]!)).toEqual(["true", "false"]);
    buttons(groups()[1]!)[1]!.click();
    expect(saved(store).accounts.u1).toEqual(DARK);
    expect(modalRoot().children.length).toBeGreaterThan(0);
  });
  it("works when storage throws", () => {
    const r = root();
    void prefs.appearanceDialog({ id: "u1" }, { store: bad, root: r });
    expect(marks(groups()[0]!)).toEqual(["true", "false", "false"]);
    buttons(groups()[0]!)[1]!.click();
    expect(r.attrs["data-theme"]).toBe("light");
    expect(marks(groups()[0]!)).toEqual(["false", "true", "false"]);
  });
  it("keeps accounts apart", () => {
    const store = mem({ v: 1, last: DARK, accounts: { u1: DARK } });
    void prefs.appearanceDialog({ id: "u2" }, { store, root: root() });
    expect(marks(groups()[0]!)).toEqual(["false", "false", "true"]);
    buttons(groups()[0]!)[1]!.click();
    expect(saved(store).accounts.u1).toEqual(DARK);
    expect(saved(store).accounts.u2.theme).toBe("light");
  });
  it("closes with the ✕ button", () => {
    void prefs.appearanceDialog({ id: "u1" }, { store: mem(), root: root() });
    modalRoot().all("button").find((b) => b.attrs["aria-label"] === "Close")!.click();
    expect(modalRoot().children).toHaveLength(0);
  });
});

describe("appearanceButton", () => {
  it("is a small button with an icon that opens the dialog", () => {
    const modalRoot = document.getElementById("modal-root") as unknown as FakeElement;
    modalRoot.replaceChildren();
    const b = prefs.appearanceButton({ id: "u1" }, { store: mem(), root: root() });
    expect(b.attrs.class).toBe("small");
    expect(b.textContent).toBe("Appearance");
    expect(b.all("svg")).toHaveLength(1);
    b.click();
    expect(modalRoot.children.length).toBeGreaterThan(0);
    modalRoot.replaceChildren();
  });
});

describe("the names from the issue", () => {
  it("displayDialog and displayButton are the Appearance functions", () => {
    expect(prefs.displayDialog).toBe(prefs.appearanceDialog);
    expect(prefs.displayButton).toBe(prefs.appearanceButton);
  });
});

describe("ui/prefs-boot.js", () => {
  const src = readFileSync("ui/prefs-boot.js", "utf8");
  const boot = (raw: unknown, opts: { throws?: boolean; none?: boolean } = {}) => {
    const r = new FakeElement("html");
    const asked: string[] = [];
    const text = raw === null || typeof raw === "string" ? raw : JSON.stringify(raw);
    const ctx: any = { document: { documentElement: r } };
    if (!opts.none) {
      ctx.localStorage = {
        getItem: (k: string) => { asked.push(k); if (opts.throws) throw new Error("x"); return k === KEY ? text : "other"; },
      };
    }
    vm.runInNewContext(src, ctx);
    if (!opts.none) expect(asked).toEqual([KEY]);
    return r.attrs;
  };

  it("sets nothing for empty or broken storage", () => {
    for (const raw of [null, "{nope", "[]", "null", { v: 1 }, { v: 2, last: DARK }]) expect(boot(raw)).toEqual({});
    expect(boot(null, { throws: true })).toEqual({});
    expect(boot(null, { none: true })).toEqual({});
  });
  it("sets the attributes from last", () => {
    expect(boot({ v: 1, last: DARK })).toEqual({ "data-theme": "dark", "data-density": "compact" });
    expect(boot({ v: 1, last: { theme: "light", density: "comfortable" } })).toEqual({ "data-theme": "light" });
    expect(boot({ v: 1, last: { theme: "system", density: "compact" } })).toEqual({ "data-density": "compact" });
  });
  it("ignores unknown values and accounts", () => {
    expect(boot({ v: 1, last: { theme: "blue", density: "tiny" } })).toEqual({});
    expect(boot({ v: 1, accounts: { u1: DARK } })).toEqual({});
  });
  it("has no import or export, and uses the same key as prefs.js", () => {
    expect(/^\s*(import|export)\b/m.test(src)).toBe(false);
    expect(src).toContain('"scf.prefs"');
    expect(readFileSync("ui/prefs.js", "utf8")).toContain('"scf.prefs"');
  });
  it("agrees with writePrefs", () => {
    const store = mem();
    prefs.writePrefs("u1", DARK, store);
    expect(boot(store.data!)).toEqual({ "data-theme": "dark", "data-density": "compact" });
  });
  it("is loaded before the stylesheets on both displays", () => {
    for (const f of ["ui/index.html", "ui/user/index.html"]) {
      const html = readFileSync(f, "utf8");
      const tag = '<script src="/prefs-boot.js"></script>';
      expect(html.split(tag)).toHaveLength(2);
      expect(html.indexOf(tag)).toBeGreaterThan(html.indexOf("<head>"));
      expect(html.indexOf(tag)).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    }
    expect(readFileSync("ui/style.css", "utf8")).toContain(".prefs");
  });
});
