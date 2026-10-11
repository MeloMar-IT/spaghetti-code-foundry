import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let d: any;
let ia: any;
beforeAll(async () => {
  restore = installFakeDom();
  d = await import("../ui/palette-data.js" as string);
  ia = await import("../ui/ia.js" as string);
});
afterAll(() => restore());

const mem = (start: Record<string, string> = {}) => {
  const data: Record<string, string> = { ...start };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};
const RUN = { type: "run", id: "r-1" };
const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("filterCommands", () => {
  const list = () => ia.commandsFor("admin").goTo;
  it("keeps everything for an empty query", () => {
    expect(d.filterCommands(list(), "")).toHaveLength(16);
    expect(d.filterCommands(list(), "   ")).toHaveLength(16);
  });
  it("needs every word, in any case", () => {
    expect(d.filterCommands(list(), "all REPO").map((c: any) => c.id)).toEqual(["all-repos"]);
    expect(d.filterCommands(list(), "repositories all").map((c: any) => c.id)).toEqual(["all-repos"]);
  });
  it("matches the hint", () => {
    const ids = d.filterCommands(list(), "administration").map((c: any) => c.id);
    expect(ids).toContain("users");
    expect(ids).not.toContain("runs");
  });
  it("returns nothing when no command matches", () => {
    expect(d.filterCommands(list(), "zzz")).toEqual([]);
  });
});

describe("allowedHit", () => {
  const hit = (href: string, extra = {}) => ({ type: "issue", id: "o/r#1", title: "T", href, ...extra });
  it("accepts a page the role has", () => {
    expect(d.allowedHit("admin", hit("#/board/o%2Fr"))).toBe(true);
    expect(d.allowedHit("user", hit("#/runs/r-1"))).toBe(true);
  });
  it("refuses a page the role does not have", () => {
    expect(d.allowedHit("user", hit("#/board/x"))).toBe(false);
    expect(d.allowedHit("user", hit("#/flows/x"))).toBe(false);
  });
  it("refuses a foreign or unknown address", () => {
    expect(d.allowedHit("admin", hit("https://example.com/#/runs"))).toBe(false);
    expect(d.allowedHit("admin", hit("#/nope"))).toBe(false);
    expect(d.allowedHit("admin", hit("javascript:alert(1)"))).toBe(false);
  });
  it("refuses a hit with a missing field", () => {
    expect(d.allowedHit("admin", null)).toBe(false);
    expect(d.allowedHit("admin", { ...hit("#/runs"), title: undefined })).toBe(false);
    expect(d.allowedHit("admin", { ...hit("#/runs"), id: 3 })).toBe(false);
    expect(d.allowedHit("admin", { ...hit("#/runs"), type: undefined })).toBe(false);
  });
});

describe("wishFor", () => {
  it("chooses the flow for a user", () => {
    expect(d.wishFor("user", { type: "flow", id: "deliver", href: "#/start" })).toEqual({ page: "start", wish: { flow: "deliver" } });
  });
  it("has nothing for an admin flow or a run", () => {
    expect(d.wishFor("admin", { type: "flow", id: "deliver", href: "#/flows/deliver" })).toBeNull();
    expect(d.wishFor("user", { type: "run", id: "r-1", href: "#/runs/r-1" })).toBeNull();
  });
  it("names the list of a repository", () => {
    expect(d.wishFor("user", { type: "repo", id: UUID, href: "#/repos" })).toEqual({ page: "repos", wish: { repo: UUID } });
    expect(d.wishFor("admin", { type: "repo", id: UUID, href: "#/all-repos" })).toEqual({ page: "all-repos", wish: { repo: UUID } });
  });
});

describe("recent items", () => {
  it("writes only type and id, even when the ref has a title", () => {
    const s = mem();
    d.addRecent(s, "u1", { ...RUN, title: "secret", href: "#/runs/r-1" });
    expect(JSON.parse(s.data["scf-recent:u1"]!)).toEqual([RUN]);
  });
  it("keeps accounts apart", () => {
    const s = mem();
    d.addRecent(s, "u1", RUN);
    d.addRecent(s, "u2", { type: "run", id: "r-2" });
    expect(d.readRecents(s, "u1")).toEqual([RUN]);
    expect(d.readRecents(s, "u2")).toEqual([{ type: "run", id: "r-2" }]);
  });
  it("moves a repeated ref to the front and keeps 8", () => {
    const s = mem();
    for (let i = 1; i <= 10; i++) d.addRecent(s, "u1", { type: "run", id: `r-${i}` });
    expect(d.readRecents(s, "u1")).toHaveLength(8);
    expect(d.readRecents(s, "u1")[0]).toEqual({ type: "run", id: "r-10" });
    d.addRecent(s, "u1", { type: "run", id: "r-5" });
    expect(d.readRecents(s, "u1").map((r: any) => r.id).slice(0, 2)).toEqual(["r-5", "r-10"]);
    expect(d.readRecents(s, "u1")).toHaveLength(8);
  });
  it("reads broken data as empty, without throwing", () => {
    expect(d.readRecents(mem({ "scf-recent:u1": "{not json" }), "u1")).toEqual([]);
    expect(d.readRecents(mem({ "scf-recent:u1": '{"a":1}' }), "u1")).toEqual([]);
    expect(d.readRecents(mem({ "scf-recent:u1": '[1,null,{"type":"run"},{"type":"x","id":"a"},{"type":"run","id":"a b"}]' }), "u1")).toEqual([]);
    const broken = { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } };
    expect(d.readRecents(broken, "u1")).toEqual([]);
    expect(() => d.addRecent(broken, "u1", RUN)).not.toThrow();
  });
  it("drops what the server would refuse, and keeps the rest", () => {
    const s = mem({ "scf-recent:u1": JSON.stringify([{ type: "repo", id: "not-a-uuid" }, RUN, { type: "repo", id: UUID }, RUN]) });
    expect(d.readRecents(s, "u1")).toEqual([RUN, { type: "repo", id: UUID }]);
  });
  it("ignores a ref that is not valid when adding", () => {
    const s = mem();
    d.addRecent(s, "u1", { type: "repo", id: "x" });
    expect(s.data["scf-recent:u1"]).toBeUndefined();
  });
  it("pruneRecents keeps the stored order, removes refs not returned, keeps incomplete types", () => {
    const s = mem();
    for (const r of [{ type: "run", id: "a" }, { type: "run", id: "b" }, { type: "flow", id: "f" }, { type: "run", id: "c" }].reverse()) d.addRecent(s, "u1", r);
    const kept = d.pruneRecents(s, "u1", [{ type: "run", id: "c" }, { type: "run", id: "a" }], ["flow"]);
    expect(kept).toEqual([{ type: "run", id: "a" }, { type: "flow", id: "f" }, { type: "run", id: "c" }]);
    expect(d.readRecents(s, "u1")).toEqual(kept);
  });
});

describe("isTypingTarget", () => {
  const el = (tag: string, attrs: Record<string, string> = {}, extra = {}) => ({ tagName: tag, getAttribute: (k: string) => attrs[k] ?? null, ...extra });
  it("knows fields, roles and editable text", () => {
    for (const t of ["INPUT", "TEXTAREA", "SELECT"]) expect(d.isTypingTarget(el(t)), t).toBe(true);
    for (const r of ["textbox", "combobox", "searchbox"]) expect(d.isTypingTarget(el("DIV", { role: r })), r).toBe(true);
    expect(d.isTypingTarget(el("DIV", { contenteditable: "true" }))).toBe(true);
    expect(d.isTypingTarget(el("DIV", {}, { isContentEditable: true }))).toBe(true);
    expect(d.isTypingTarget(el("BUTTON"))).toBe(false);
    expect(d.isTypingTarget(el("DIV", { role: "option" }))).toBe(false);
    expect(d.isTypingTarget(null)).toBe(false);
  });
});

describe("keysOff", () => {
  it("round-trips and survives a store that throws", () => {
    const s = mem();
    expect(d.keysOff(s)).toBe(false);
    d.setKeysOff(s, true);
    expect(s.data["scf-keys"]).toBe("off");
    expect(d.keysOff(s)).toBe(true);
    d.setKeysOff(s, false);
    expect(d.keysOff(s)).toBe(false);
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(d.keysOff(broken)).toBe(false);
    expect(() => d.setKeysOff(broken, true)).not.toThrow();
  });
});

describe("decodeKey", () => {
  const base = { off: false, typing: false, blocked: false, open: false, prefix: 0, now: 10_000, letters: ["h", "r"] };
  const key = (k: string, e: object = {}, st: object = {}) => d.decodeKey({ key: k, ...e }, { ...base, ...st });

  it("opens with Ctrl+K and ⌘K, also while typing", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(key("k", mod, { typing: true, off: true })).toMatchObject({ open: true, prevent: true });
    }
  });
  it("only prevents Ctrl+K when the palette is open", () => {
    expect(key("k", { ctrlKey: true }, { open: true })).toMatchObject({ open: false, prevent: true });
  });
  it("opens with / and prevents the browser's own action", () => {
    expect(key("/")).toMatchObject({ open: true, prevent: true });
  });
  it("goes after g and a letter within 1000 ms", () => {
    const first = key("g");
    expect(first).toMatchObject({ prefix: 10_000, go: null, open: false });
    expect(key("h", {}, { prefix: 10_000, now: 11_000 })).toMatchObject({ go: "h", prefix: 0 });
  });
  it("does nothing at 1001 ms, and an unknown letter clears the prefix", () => {
    expect(key("h", {}, { prefix: 10_000, now: 11_001 })).toMatchObject({ go: null });
    expect(key("x", {}, { prefix: 10_000, now: 10_100 })).toMatchObject({ go: null, prefix: 0 });
    expect(key("g", {}, { prefix: 10_000, now: 12_000 })).toMatchObject({ prefix: 12_000 });
  });
  it("ignores single keys when off, typing, blocked, open, repeating or with a modifier", () => {
    for (const st of [{ off: true }, { typing: true }, { blocked: true }, { open: true }]) {
      expect(key("/", {}, st), JSON.stringify(st)).toMatchObject({ open: false, prevent: false });
      expect(key("g", {}, st).prefix).toBe(0);
    }
    for (const e of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(key("/", e)).toMatchObject({ open: false, prevent: false });
      expect(key("g", e).prefix).toBe(0);
    }
  });
});

describe("api.search and api.recent", () => {
  let mod: any;
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  beforeAll(async () => {
    mod = await import("../ui/api.js" as string);
  });
  beforeEach(() => {
    urls.length = 0;
    (globalThis as any).fetch = async (url: string, init: { method: string }) => {
      urls.push(`${init.method} ${url}`);
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ groups: [] }) };
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    mod.setViewAs("");
  });

  it("encodes the text", async () => {
    await mod.api.search("a b&c#1");
    expect(urls).toEqual(["GET /api/search?q=a%20b%26c%231"]);
  });

  it("sends the recent refs as ordered id parameters", async () => {
    await mod.api.recent([{ type: "run", id: "r-1" }, { type: "issue", id: "o/r#7" }, { type: "flow", id: "deliver" }]);
    expect(urls).toEqual(["GET /api/search?id=run%3Ar-1&id=issue%3Ao%2Fr%237&id=flow%3Adeliver"]);
  });

  it("adds as= by itself in a preview", async () => {
    mod.setViewAs("u 9");
    await mod.api.search("x");
    await mod.api.recent([{ type: "run", id: "r-1" }]);
    expect(urls).toEqual(["GET /api/search?q=x&as=u%209", "GET /api/search?id=run%3Ar-1&as=u%209"]);
  });
});

describe("wishes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    d.resetWishes();
  });
  it("calls the handler of an open page and keeps nothing", () => {
    const fn = vi.fn();
    d.onWish("start", fn);
    d.sendWish("start", { flow: "a" });
    expect(fn).toHaveBeenCalledWith({ flow: "a" });
    expect(d.takeWish("start")).toBeNull();
  });
  it("keeps a wish for the next page, once", () => {
    d.sendWish("start", { flow: "a" });
    expect(d.takeWish("start")).toEqual({ flow: "a" });
    expect(d.takeWish("start")).toBeNull();
  });
  it("lets a wish last 5 seconds", () => {
    d.sendWish("start", { flow: "a" });
    vi.advanceTimersByTime(5001);
    expect(d.takeWish("start")).toBeNull();
    d.sendWish("start", { flow: "b" });
    vi.advanceTimersByTime(5000);
    expect(d.takeWish("start")).toEqual({ flow: "b" });
  });
  it("replaces the handler, and a disposer only removes its own", () => {
    const one = vi.fn();
    const two = vi.fn();
    const offOne = d.onWish("repos", one);
    const offTwo = d.onWish("repos", two);
    offOne();
    d.sendWish("repos", { repo: "x" });
    expect(two).toHaveBeenCalledTimes(1);
    expect(one).not.toHaveBeenCalled();
    offTwo();
    d.sendWish("repos", { repo: "y" });
    expect(d.takeWish("repos")).toEqual({ repo: "y" });
  });
  it("drops a wish that was not taken", () => {
    d.sendWish("start", { flow: "a" });
    d.dropWish("start");
    expect(d.takeWish("start")).toBeNull();
  });
  it("hands a wish to another tab of the same account, once, for its page only", () => {
    const s = mem();
    d.setWishScope("u1", s);
    d.handoffWish("start", { flow: "a" });
    expect(JSON.parse(s.data["scf-wish:u1"]!)).toMatchObject({ page: "start", wish: { flow: "a" } });
    // The tab that wrote it does not take it back.
    expect(d.takeWish("start")).toBeNull();
    const entry = JSON.parse(s.data["scf-wish:u1"]!);
    s.data["scf-wish:u1"] = JSON.stringify({ ...entry, tab: "another" });
    expect(d.takeWish("repos")).toBeNull();
    expect(d.takeWish("start")).toEqual({ flow: "a" });
    expect(d.takeWish("start")).toBeNull();
  });
  it("does not hand a wish to another account or an old one", () => {
    const s = mem();
    d.setWishScope("u1", s);
    s.data["scf-wish:u2"] = JSON.stringify({ tab: "t", page: "start", wish: { flow: "a" }, at: Date.now() });
    expect(d.takeWish("start")).toBeNull();
    s.data["scf-wish:u1"] = JSON.stringify({ tab: "t", page: "start", wish: { flow: "a" }, at: Date.now() - 6000 });
    expect(d.takeWish("start")).toBeNull();
    s.data["scf-wish:u1"] = "{broken";
    expect(d.takeWish("start")).toBeNull();
  });
});
