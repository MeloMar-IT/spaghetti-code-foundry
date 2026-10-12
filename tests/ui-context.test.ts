import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let c: any;
let fl: any;
beforeAll(async () => {
  restore = installFakeDom();
  c = await import("../ui/context.js" as string);
  fl = await import("../ui/filters.js" as string);
});
afterAll(() => restore());

const mem = (opts: { getThrows?: boolean; setThrows?: boolean } = {}) => {
  const data: Record<string, string> = {};
  const calls = { get: 0, set: 0 };
  return {
    data, calls,
    getItem: (k: string) => { calls.get++; if (opts.getThrows) throw new Error("no"); return data[k] ?? null; },
    setItem: (k: string, v: string) => { calls.set++; if (opts.setThrows) throw new Error("no"); data[k] = v; },
  };
};
const EMPTY = { repo: "", favourites: [], recents: [] };

describe("the module", () => {
  it("imports only api.js, context-view.js, dom.js, filters.js, ia.js and views.js", () => {
    const src = readFileSync("ui/context.js", "utf8");
    expect([...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).sort()).toEqual(["./api.js", "./context-view.js", "./dom.js", "./filters.js", "./ia.js", "./views.js"]);
  });
});

describe("validName", () => {
  it("accepts owner/name only, and never throws", () => {
    expect(c.validName("a/b")).toBe(true);
    for (const bad of ["", "all", "acme", "a/b/c", 5, null, "\ud800", "a/\ud800"]) expect(c.validName(bad), String(bad)).toBe(false);
  });
});

describe("cleanState", () => {
  it("gives the empty state for garbage", () => {
    for (const raw of ["{nope", "null", "[1]", "5", '"x"']) {
      const s = mem();
      s.data["scf.context.u1"] = raw;
      expect(c.contextStore("u1", s).get(), raw).toEqual(EMPTY);
    }
  });
  it("cleans each part", () => {
    expect(c.cleanState({ repo: "all", x: 1 })).toEqual(EMPTY);
    expect(c.cleanState({ repo: "bad" })).toEqual(EMPTY);
    expect(c.cleanState({ repo: "" })).toEqual(EMPTY);
    expect(c.cleanState({ repo: "a/b", favourites: ["a/b", "all", "", 3, "\ud800", "A/B", "c/d"] })).toEqual({ repo: "a/b", favourites: ["a/b", "c/d"], recents: [] });
    expect(c.cleanState({ recents: ["a/a", "b/b", "c/c", "d/d", "e/e", "f/f", "g/g"] }).recents).toEqual(["a/a", "b/b", "c/c", "d/d", "e/e"]);
    expect(c.cleanState({ favourites: "x", recents: 5 })).toEqual(EMPTY);
  });
});

describe("the store", () => {
  it("uses the key per account", () => {
    const s = mem();
    const a = c.contextStore("u1", s);
    const b = c.contextStore("u2", s);
    expect(a.key).toBe("scf.context.u1");
    expect(c.contextStore("", s).key).toBe("scf.context.local");
    a.toggleFavourite("a/b");
    expect(b.get()).toEqual(EMPTY);
    expect(Object.keys(s.data)).toEqual(["scf.context.u1"]);
  });

  it("choose puts the name first, de-duplicates ignoring case and caps at 5", () => {
    const st = c.contextStore("u1", mem());
    st.choose("a/b");
    st.choose("c/d");
    expect(st.get()).toEqual({ repo: "c/d", favourites: [], recents: ["c/d", "a/b"] });
    st.choose("A/B");
    expect(st.get().recents).toEqual(["A/B", "c/d"]);
    for (const n of ["e/e", "f/f", "g/g", "h/h"]) st.choose(n);
    expect(st.get().recents).toEqual(["h/h", "g/g", "f/f", "e/e", "A/B"]);
    st.choose("i/i");
    expect(st.get().recents).toEqual(["i/i", "h/h", "g/g", "f/f", "e/e"]);
  });

  it("choose of All keeps the recents; an invalid name changes nothing and writes nothing", () => {
    const s = mem();
    const st = c.contextStore("u1", s);
    st.choose("a/b");
    expect(st.choose("").repo).toBe("");
    st.choose("a/b");
    expect(st.choose("all")).toEqual({ repo: "", favourites: [], recents: ["a/b"] });
    const n = s.calls.set;
    expect(st.choose("bad")).toEqual({ repo: "", favourites: [], recents: ["a/b"] });
    expect(st.choose("\ud800").repo).toBe("");
    expect(s.calls.set).toBe(n);
  });

  it("toggleFavourite adds at the end, removes ignoring case, has no cap and ignores bad names", () => {
    const s = mem();
    const st = c.contextStore("u1", s);
    st.toggleFavourite("a/b");
    st.toggleFavourite("c/d");
    expect(st.get().favourites).toEqual(["a/b", "c/d"]);
    st.toggleFavourite("A/B");
    expect(st.get().favourites).toEqual(["c/d"]);
    for (let i = 0; i < 8; i++) st.toggleFavourite(`o/n${i}`);
    expect(st.get().favourites).toHaveLength(9);
    const n = s.calls.set;
    for (const bad of ["all", "", "x", 5, "\ud800"]) st.toggleFavourite(bad);
    expect(st.get().favourites).toHaveLength(9);
    expect(s.calls.set).toBe(n);
  });

  it("prune drops unknown names from all three lists and says what went", () => {
    const s = mem();
    const st = c.contextStore("u1", s);
    st.toggleFavourite("a/b");
    st.toggleFavourite("x/y");
    st.choose("a/b");
    st.choose("z/z");
    const gone = st.prune(["A/B"]);
    expect(gone).toEqual({ repo: "z/z", favourites: ["x/y"], recents: ["z/z"] });
    expect(st.get()).toEqual({ repo: "", favourites: ["a/b"], recents: ["a/b"] });
    const n = s.calls.set;
    expect(st.prune(["a/b"])).toEqual({ repo: "", favourites: [], recents: [] });
    expect(s.calls.set).toBe(n);
    expect(st.prune("nope").favourites).toEqual(["a/b"]);
  });

  it("get returns copies", () => {
    const st = c.contextStore("u1", mem());
    st.choose("a/b");
    st.get().recents.push("x/y");
    expect(st.get().recents).toEqual(["a/b"]);
  });

  it("survives a round trip through the same storage", () => {
    const s = mem();
    const st = c.contextStore("u1", s);
    st.toggleFavourite("a/b");
    st.choose("c/d");
    st.choose("");
    expect(c.contextStore("u1", s).get()).toEqual({ repo: "", favourites: ["a/b"], recents: ["c/d"] });
  });

  it("picks up a change of another store before it writes", () => {
    const s = mem();
    const a = c.contextStore("u1", s);
    const b = c.contextStore("u1", s);
    a.toggleFavourite("a/b");
    b.choose("c/d");
    expect(b.get()).toEqual({ repo: "c/d", favourites: ["a/b"], recents: ["c/d"] });
    expect(a.reload().recents).toEqual(["c/d"]);
  });
});

describe("broken storage", () => {
  it("works in memory without storage", () => {
    for (const storage of [null, undefined]) {
      const st = c.contextStore("u1", storage);
      st.toggleFavourite("a/b");
      st.choose("c/d");
      expect(st.get()).toEqual({ repo: "c/d", favourites: ["a/b"], recents: ["c/d"] });
    }
  });
  it("works in memory when both getItem and setItem throw, and writes once", () => {
    const s = mem({ getThrows: true, setThrows: true });
    const st = c.contextStore("u1", s);
    st.toggleFavourite("a/b");
    st.choose("c/d");
    st.choose("e/f");
    expect(st.get()).toEqual({ repo: "e/f", favourites: ["a/b"], recents: ["e/f", "c/d"] });
    expect(s.calls.set).toBe(1);
  });
  it("keeps the state when only setItem throws, and does not call storage again", () => {
    const s = mem({ setThrows: true });
    const st = c.contextStore("u1", s);
    st.toggleFavourite("a/b");
    const gets = s.calls.get;
    st.choose("c/d");
    st.choose("e/f");
    expect(st.get()).toEqual({ repo: "e/f", favourites: ["a/b"], recents: ["e/f", "c/d"] });
    expect(s.calls.set).toBe(1);
    expect(s.calls.get).toBe(gets);
  });
});

describe("scopedHash", () => {
  const on = (repo: string, own = true) => ({ active: true, repo, own });
  const sh = (hash: any, ctx: any, role = "admin") => c.scopedHash(role, hash, ctx);

  it("adds the repository or all to a bare scoped page", () => {
    for (const p of ["runs", "refinement", "all-repos"]) {
      expect(sh(`#/${p}`, on("a/b"))).toBe(`#/${p}?repo=a%2Fb`);
      expect(sh(`#/${p}`, on(""))).toBe(`#/${p}?repo=all`);
    }
    expect(sh("#/runs", on("not valid"))).toBe("#/runs?repo=all");
  });
  it("handles the Board forms", () => {
    expect(sh("#/board", on("a/b"))).toBe("#/board/a%2Fb");
    expect(sh("#/board", on(""))).toBe("#/board?repo=all");
  });
  it("handles My repositories", () => {
    expect(sh("#/repos", on("a/b", true))).toBe("#/repos?repo=a%2Fb");
    expect(sh("#/repos", on("a/b", false))).toBe("#/repos?repo=all");
  });
  it("works for a user on the pages a user has", () => {
    expect(sh("#/runs", on("a/b"), "user")).toBe("#/runs?repo=a%2Fb");
    expect(sh("#/board", on("a/b"), "user")).toBeNull();
    expect(sh("#/all-repos", on("a/b"), "user")).toBeNull();
  });
  it("gives null when it must not change the address", () => {
    expect(sh("#/runs", { active: false, repo: "a/b", own: true })).toBeNull();
    expect(sh("#/runs", undefined)).toBeNull();
    for (const h of ["#/runs?owner=u1", "#/runs?x=1", "#/runs?", "#/runs/r1", "#/board/a%2Fb", "#/refinement/s-1", "#/refinement/backlog", "#/home", "#/flows", "#/nope", 5, undefined]) {
      expect(sh(h, on("a/b")), String(h)).toBeNull();
    }
  });
});

describe("chosenHash", () => {
  const ch = (hash: any, repo: string, own = true, role = "admin") => c.chosenHash(role, hash, { active: true, repo, own });

  it("replaces the repository and keeps owner", () => {
    expect(ch("#/runs?repo=x%2Fy&owner=u1", "a/b")).toBe("#/runs?repo=a%2Fb&owner=u1");
    expect(ch("#/runs?repo=x%2Fy&owner=u1", "")).toBe("#/runs?repo=all&owner=u1");
    expect(ch("#/runs", "a/b")).toBe("#/runs?repo=a%2Fb");
  });
  it("handles both Board forms", () => {
    expect(ch("#/board/x%2Fy?owner=u1", "a/b")).toBe("#/board/a%2Fb?owner=u1");
    expect(ch("#/board/x%2Fy?owner=u1", "")).toBe("#/board?repo=all&owner=u1");
    expect(ch("#/board?repo=all", "a/b")).toBe("#/board/a%2Fb");
  });
  it("handles My repositories and works when not active", () => {
    expect(ch("#/repos?repo=x%2Fy", "a/b", false)).toBe("#/repos?repo=all");
    expect(c.chosenHash("admin", "#/runs", { active: false, repo: "a/b", own: true })).toBe("#/runs?repo=a%2Fb");
  });
  it("gives null on pages without scope", () => {
    for (const h of ["#/runs/r1", "#/home", "#/users", "#/nope", 5]) expect(ch(h, "a/b"), String(h)).toBeNull();
    expect(ch("#/board", "a/b", true, "user")).toBeNull();
  });
});

describe("repoList", () => {
  it("leaves out rows without github, keeps a name once with the own row winning, and sorts", () => {
    expect(c.repoList([{ github: "" }, {}, { github: "all" }, { github: "b/b" }, { github: "A/a" }])).toEqual([{ name: "A/a", own: false }, { name: "b/b", own: false }]);
    expect(c.repoList([{ github: "a/b" }, { github: "a/b", own: true }])).toEqual([{ name: "a/b", own: true }]);
    expect(c.repoList([{ github: "a/b", own: true }, { github: "a/b" }])).toEqual([{ name: "a/b", own: true }]);
    expect(c.repoList("x")).toEqual([]);
  });
});

describe("switcherRows", () => {
  const list = ["a/a", "b/b", "c/c", "d/d"].map((name) => ({ name, own: false }));
  const state = { repo: "d/d", favourites: ["c/c", "gone/x"], recents: ["d/d", "c/c", "gone/y"] };
  const brief = (rows: any[]) => rows.map((r) => `${r.group}:${r.name}`);

  it("orders All, Favourites, Recent, the rest, without repeats", () => {
    const rows = c.switcherRows(list, state);
    expect(brief(rows)).toEqual(["all:", "favourite:c/c", "recent:d/d", "rest:a/a", "rest:b/b"]);
    expect(rows.filter((r: any) => r.current).map((r: any) => r.name)).toEqual(["d/d"]);
    expect(rows[1]).toMatchObject({ favourite: true, label: "c/c" });
    expect(rows[0]).toMatchObject({ label: "All repositories", current: false });
    expect(c.switcherRows(list, { ...state, repo: "" }).filter((r: any) => r.current).map((r: any) => r.group)).toEqual(["all"]);
  });
  it("narrows by text", () => {
    expect(brief(c.switcherRows(list, state, "B/"))).toEqual(["rest:b/b"]);
    expect(brief(c.switcherRows(list, state, "all"))).toEqual(["all:"]);
    expect(c.switcherRows(list, state, "acme")).toEqual([]);
    expect(c.switcherRows(list, state, "  ")).toHaveLength(5);
  });
});

describe("goneText and switcherSections", () => {
  it("goneText", () => {
    expect(c.goneText("a/b")).toBe("a/b is no longer in your list. The switcher shows All repositories now.");
  });
  const rows = (names: string[]) => c.switcherRows(names.map((n) => ({ name: n, own: true })), { repo: "", favourites: [], recents: [] });
  it("a user gets All and Repositories; empty sections are left out", () => {
    const s = c.switcherSections(rows(["a/b", "c/d"]));
    expect(s.map((x: any) => x.title)).toEqual([null, "Repositories"]);
    expect(c.switcherSections(rows([])).map((x: any) => x.title)).toEqual([null]);
    const st = { repo: "", favourites: ["a/b"], recents: ["c/d"] };
    const items = [{ name: "a/b", own: true }, { name: "c/d", own: true }, { name: "e/f", own: true }];
    expect(c.switcherSections(c.switcherRows(items, st)).map((x: any) => x.title)).toEqual([null, "Favourites", "Recent", "Repositories"]);
  });
  it("an admin gets one section per owner, sorted ignoring case, Unknown account last", () => {
    const owner: Record<string, string> = { "a/1": "bob (b@x)", "b/2": "Zed (z@x)", "c/3": "alice (a@x)", "d/4": "" };
    const s = c.switcherSections(rows(["a/1", "b/2", "c/3", "d/4"]), (n: string) => owner[n]);
    expect(s.map((x: any) => x.title)).toEqual([null, "alice (a@x)", "bob (b@x)", "Zed (z@x)", "Unknown account"]);
  });
});

describe("clearedHash", () => {
  const ctx = { active: true, repo: "a/b", own: true };
  it("writes repo=all and keeps owner", () => {
    const to = (role: string, hash: string) => c.clearedHash(role, hash, ctx);
    expect(to("admin", "#/runs")).toBe("#/runs?repo=all");
    expect(to("admin", "#/runs?owner=u1")).toBe("#/runs?repo=all&owner=u1");
    expect(to("admin", "#/board?owner=u1")).toBe("#/board?repo=all&owner=u1");
    for (const p of ["#/refinement", "#/repos", "#/all-repos"]) expect(to("admin", p), p).toBe(`${p}?repo=all`);
    expect(to("user", "#/runs")).toBe("#/runs?repo=all");
  });
  it("leaves everything else alone", () => {
    for (const [role, hash] of [
      ["admin", "#/runs?repo=a%2Fb"], ["admin", "#/runs?repo=all&owner=u1"], ["admin", "#/board/a%2Fb?owner=u1"], ["admin", "#/home"],
      ["admin", "#/runs/r1"], ["admin", "#/refinement/s1"], ["admin", "#/nope"], ["user", "#/board"],
    ]) expect(c.clearedHash(role, hash, ctx), `${role} ${hash}`).toBe(hash);
    expect(c.clearedHash("admin", "#/runs", { ...ctx, active: false })).toBe("#/runs");
    expect(c.clearedHash("admin", undefined, ctx)).toBeUndefined();
  });
});

describe("offerFor", () => {
  const ctx = { active: true, repo: "a/b", own: true };
  const list = [{ name: "a/b", own: true }, { name: "c/d", own: false }];
  const all = { repo: "", label: "All repositories" };
  it("offers another known repository, in the spelling of the list", () => {
    expect(c.offerFor("admin", "#/runs?repo=c%2Fd", ctx, list)).toEqual({ repo: "c/d", label: "Repository: c/d" });
    expect(c.offerFor("admin", "#/runs?repo=C%2FD", ctx, list)).toEqual({ repo: "c/d", label: "Repository: c/d" });
    expect(c.offerFor("admin", "#/board/c%2Fd?owner=u1", ctx, list)).toEqual({ repo: "c/d", label: "Repository: c/d" });
    expect(c.offerFor("admin", "#/board?repo=all", ctx, list, "c/d")).toEqual({ repo: "c/d", label: "Repository: c/d" });
  });
  it("offers All while a context repository is set", () => {
    expect(c.offerFor("admin", "#/runs?repo=all", ctx, list)).toEqual(all);
    expect(c.offerFor("admin", "#/runs?owner=u1", ctx, list)).toEqual(all);
  });
  it("offers nothing otherwise", () => {
    expect(c.offerFor("admin", "#/runs?repo=A%2FB", ctx, list)).toBeNull();
    expect(c.offerFor("admin", "#/runs?repo=x%2Fy", ctx, list)).toBeNull();
    expect(c.offerFor("admin", "#/runs?repo=c%2Fd", { ...ctx, active: false }, list)).toBeNull();
    expect(c.offerFor("admin", "#/home", ctx, list)).toBeNull();
    expect(c.offerFor("admin", "#/runs/r1", ctx, list)).toBeNull();
    expect(c.offerFor("admin", "#/runs?repo=all", { active: true, repo: "", own: false }, list)).toBeNull();
    expect(c.offerFor("admin", "#/repos?repo=all", { ...ctx, own: false }, list)).toBeNull();
    expect(c.offerFor("admin", "#/repos?repo=all", ctx, list)).toEqual(all);
    expect(c.offerFor("admin", "#/repos?repo=c%2Fd", ctx, list)).toBeNull();
    expect(c.offerFor("admin", undefined, ctx, list)).toBeNull();
  });
});

describe("initContext", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const box = () => (globalThis as any).document.getElementById("context") as FakeElement;
  const doc = () => (globalThis as any).document;
  const gh = (github: string, extra: Record<string, unknown> = {}) => ({ github, owner: "u1", account: null, ...extra });
  const fakeA = (...lists: any[]) => {
    const queue = [...lists];
    const next = () => {
      const l = queue.length > 1 ? queue.shift() : queue[0];
      return typeof l === "function" ? l() : l instanceof Error ? Promise.reject(l) : Promise.resolve(l);
    };
    return { repos: vi.fn(next), allRepos: vi.fn(next) };
  };
  const focusOf = (name: string) => box().querySelectorAll("[data-focus]").find((e) => e.attrs["data-focus"] === name) as FakeElement;
  const names = (n: number) => Array.from({ length: n }, (_, i) => gh(`o/r${i}`));
  const two = [gh("a/b"), gh("c/d")];
  const text = () => box().textContent;
  let ctxs: any[] = [];
  const make = (role: string, a: any, extra: Record<string, unknown> = {}) => {
    const go = vi.fn();
    const notify = vi.fn();
    const store = c.contextStore("u1", mem());
    const ctx = c.initContext(role, { id: "u1" }, { a, go, notify, store, where: () => "#/home", ...extra });
    ctxs.push(ctx);
    return { ctx, go, notify, store, a };
  };
  beforeEach(() => {
    box().replaceChildren();
    doc().listeners.keydown = [];
    doc().listeners.mousedown = [];
    doc().activeElement = null;
  });
  afterEach(() => {
    for (const x of ctxs) x.stop();
    ctxs = [];
    vi.unstubAllGlobals();
  });

  it("adapts to the number of repositories", async () => {
    let t = make("user", fakeA([]));
    await t.ctx.ready;
    expect(text()).toContain("No repository yet.");
    expect(focusOf("context-add").attrs.href).toBe("#/repos");
    t = make("user", fakeA([gh("a/b")]));
    await t.ctx.ready;
    expect(text()).toBe("a/b");
    expect(box().querySelectorAll("button")).toHaveLength(0);
    t = make("user", fakeA(two));
    await t.ctx.ready;
    expect(focusOf("context-btn")).toBeTruthy();
    expect(text()).toContain("All repositories");
  });
  it("shows the search box from eight repositories", async () => {
    for (const [n, has] of [[7, false], [8, true]] as const) {
      const t = make("user", fakeA(names(n)));
      await t.ctx.ready;
      focusOf("context-btn").click();
      expect(!!focusOf("context-search"), String(n)).toBe(has);
    }
  });
  it("a user reads repos only, an admin allRepos only", async () => {
    const u = make("user", fakeA(two));
    await u.ctx.ready;
    expect(u.a.repos).toHaveBeenCalledTimes(1);
    expect(u.a.allRepos).not.toHaveBeenCalled();
    const ad = make("admin", fakeA(two));
    await ad.ctx.ready;
    expect(ad.a.allRepos).toHaveBeenCalledTimes(1);
    expect(ad.a.repos).not.toHaveBeenCalled();
  });
  it("an admin's panel groups by owner; own row decides for the same name; other hosts do not throw", async () => {
    const t = make("admin", fakeA([
      gh("z/z", { owner: "u2", account: { name: "Ann", email: "a@x" } }),
      gh("y/y", { owner: "u1", account: { name: "Me", email: "m@x" } }),
      gh("y/y", { owner: "u2", account: { name: "Ann", email: "a@x" } }),
      gh("q/q", { owner: "u3", account: null }),
      { owner: "u2", account: { name: "Ann", email: "a@x" } },
    ]));
    await t.ctx.ready;
    focusOf("context-btn").click();
    const heads = box().querySelectorAll("div").filter((e) => e.attrs.class === "context-head").map((e) => e.textContent);
    expect(heads).toEqual(["Ann (a@x)", "Me (m@x)", "Unknown account"]);
    await tick();
    expect(t.ctx.current().own).toBe(false);
    focusOf("context-item-y/y").click();
    expect(t.ctx.current()).toEqual({ active: true, repo: "y/y", own: true });
  });
  it("a list with no GitHub repository does not throw for an admin", async () => {
    const t = make("admin", fakeA([{ owner: "u1", account: null }]));
    await t.ctx.ready;
    expect(t.ctx.scoped("#/runs")).toBeNull();
  });
  it("draws nothing before the first load settles", async () => {
    let release: (v: unknown) => void = () => {};
    const t = make("user", fakeA(() => new Promise((r) => { release = r; })));
    expect(box().children).toHaveLength(0);
    expect(t.ctx.scoped("#/runs")).toBeNull();
    release(two);
    await t.ctx.ready;
    expect(box().children).toHaveLength(1);
    expect(t.ctx.scoped("#/runs")).toBe(c.scopedHash("user", "#/runs", t.ctx.current()));
    expect(t.ctx.scoped("#/runs")).toContain("repo=all");
    expect(t.ctx.keep("#/x")).toBe("#/x");
  });
  it("keep writes repo=all with a context; it is the identity before load, with one repository and after stop", async () => {
    let release: (v: unknown) => void = () => {};
    const early = make("user", fakeA(() => new Promise((r) => { release = r; })));
    early.store.choose("a/b");
    expect(early.ctx.keep("#/runs")).toBe("#/runs");
    release(two);
    await early.ctx.ready;
    const t = make("user", fakeA(two));
    t.store.choose("a/b");
    await t.ctx.ready;
    expect(t.ctx.keep("#/runs?owner=u1")).toBe("#/runs?repo=all&owner=u1");
    expect(t.ctx.keep("#/runs?repo=c%2Fd")).toBe("#/runs?repo=c%2Fd");
    const one = make("user", fakeA([gh("a/b")]));
    await one.ctx.ready;
    expect(one.ctx.keep("#/runs")).toBe("#/runs");
    t.ctx.stop();
    expect(t.ctx.keep("#/runs")).toBe("#/runs");
  });
  describe("the offer", () => {
    afterEach(() => fl.setContextOffer(null));
    it("offers the shown repository; a click stores it, redraws the switcher and ends the offer", async () => {
      const t = make("user", fakeA(two), { where: () => "#/runs?repo=c%2Fd" });
      t.store.choose("a/b");
      await t.ctx.ready;
      expect(fl.contextOffer().label).toBe("Repository: c/d");
      fl.contextOffer().onUse();
      expect(t.store.get().repo).toBe("c/d");
      expect(text()).toContain("c/d");
      expect(fl.contextOffer()).toBeNull();
    });
    it("offers All on a page without a repository, and a click chooses All", async () => {
      const t = make("user", fakeA(two), { where: () => "#/runs?repo=all" });
      t.store.choose("a/b");
      await t.ctx.ready;
      expect(fl.contextOffer().label).toBe("All repositories");
      fl.contextOffer().onUse();
      expect(t.store.get().repo).toBe("");
    });
    it("takes the repository the page really shows", async () => {
      const t = make("admin", fakeA(two), { where: () => "#/board?repo=all" });
      t.store.choose("a/b");
      await t.ctx.ready;
      expect(fl.contextOffer({ repo: "c/d" }).label).toBe("Repository: c/d");
      expect(fl.contextOffer({ repo: "a/b" })).toBeNull();
    });
    it("a bar already on the page loses its offer when the switcher chooses that repository", async () => {
      let here = "#/repos?repo=c%2Fd";
      const t = make("user", fakeA(two), { where: () => here });
      t.store.choose("a/b");
      await t.ctx.ready;
      const bar = fl.filterBar({ repo: "c/d" }) as FakeElement;
      const use = bar.all("button").find((b) => b.textContent === "Use as my context")!;
      expect(use.hidden).toBeFalsy();
      focusOf("context-btn").click();
      focusOf("context-item-c/d").click();
      expect(use.hidden).toBe(true);
      here = "#/repos?repo=c%2Fd";
    });
    it("a repository that goes from the list ends the offer, and a stale click does not store it", async () => {
      const t = make("user", fakeA(two, [gh("a/b"), gh("e/f")]), { where: () => "#/repos?repo=c%2Fd" });
      t.store.choose("a/b");
      await t.ctx.ready;
      const stale = fl.contextOffer();
      const bar = fl.filterBar({ repo: "c/d" }) as FakeElement;
      const use = bar.all("button").find((b) => b.textContent === "Use as my context")!;
      await t.ctx.refresh();
      expect(use.hidden).toBe(true);
      stale.onUse();
      expect(t.store.get().repo).toBe("a/b");
    });
    it("a button of the page registered with watchContextOffer is hidden when the context matches", async () => {
      const t = make("user", fakeA(two), { where: () => "#/repos?repo=c%2Fd" });
      t.store.choose("a/b");
      await t.ctx.ready;
      const hide = vi.fn();
      fl.watchContextOffer({ repo: "c/d" }, hide);
      focusOf("context-btn").click();
      focusOf("context-item-c/d").click();
      expect(hide).toHaveBeenCalledOnce();
    });
    it("stop clears the offer, but not the one of a newer context", async () => {
      const a = make("user", fakeA(two), { where: () => "#/runs?repo=all" });
      a.store.choose("a/b");
      await a.ctx.ready;
      a.ctx.stop();
      expect(fl.contextOffer()).toBeNull();
      const old = make("user", fakeA(two), { where: () => "#/runs?repo=all" });
      const newer = make("user", fakeA(two), { where: () => "#/runs?repo=all" });
      newer.store.choose("a/b");
      await newer.ctx.ready;
      old.ctx.stop();
      expect(fl.contextOffer()).not.toBeNull();
    });
  });
  it("scoped is null with fewer than two and after stop", async () => {
    const one = make("user", fakeA([gh("a/b")]));
    await one.ctx.ready;
    expect(one.ctx.scoped("#/runs")).toBeNull();
    const t = make("user", fakeA(two));
    await t.ctx.ready;
    t.ctx.stop();
    expect(t.ctx.scoped("#/runs")).toBeNull();
    expect(box().children).toHaveLength(0);
  });
  it("opens, closes with Escape and focus on the trigger, and closes on choosing", async () => {
    const t = make("user", fakeA(two));
    await t.ctx.ready;
    focusOf("context-btn").click();
    expect(focusOf("context-btn").attrs["aria-expanded"]).toBe("true");
    expect(doc().listeners.keydown).toHaveLength(1);
    doc().listeners.keydown.forEach((f: any) => f({ key: "Escape" }));
    expect(focusOf("context-btn").attrs["aria-expanded"]).toBe("false");
    expect(doc().activeElement).toBe(focusOf("context-btn"));
    focusOf("context-btn").click();
    focusOf("context-item-a/b").click();
    expect(focusOf("context-btn").attrs["aria-expanded"]).toBe("false");
    expect(doc().listeners.keydown).toHaveLength(0);
  });
  it("choosing goes to the address on a scoped page and keeps owner; not elsewhere", async () => {
    const t = make("user", fakeA(two), { where: () => "#/runs?owner=u2" });
    await t.ctx.ready;
    focusOf("context-btn").click();
    focusOf("context-item-a/b").click();
    expect(t.store.get().repo).toBe("a/b");
    expect(t.go).toHaveBeenCalledTimes(1);
    expect(t.go.mock.calls[0]).toEqual([c.chosenHash("user", "#/runs?owner=u2", { active: true, repo: "a/b", own: true })]);
    expect(t.go.mock.calls[0][0]).toContain("owner=u2");
    const u = make("user", fakeA(two));
    await u.ctx.ready;
    focusOf("context-btn").click();
    focusOf("context-item-c/d").click();
    expect(u.go).not.toHaveBeenCalled();
    expect(text()).toContain("c/d");
    focusOf("context-btn").click();
    focusOf("context-item-all").click();
    expect(u.store.get().repo).toBe("");
  });
  it("prunes a repository that is gone: one notice, no go, none the second time", async () => {
    const store = c.contextStore("u1", mem());
    store.choose("x/y");
    const t = make("user", fakeA(two), { store, where: () => "#/runs" });
    await t.ctx.ready;
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith(c.goneText("x/y"));
    expect(t.go).not.toHaveBeenCalled();
    expect(store.get().repo).toBe("");
    await t.ctx.refresh();
    expect(t.notify).toHaveBeenCalledTimes(1);
  });
  it("a repository that goes in a refresh is told, and the page is not moved", async () => {
    const t = make("user", fakeA([...two, gh("e/f")], two), { where: () => "#/runs" });
    await t.ctx.ready;
    focusOf("context-btn").click();
    focusOf("context-item-e/f").click();
    t.go.mockClear();
    await t.ctx.refresh();
    expect(t.notify).toHaveBeenCalledWith(c.goneText("e/f"));
    expect(t.go).not.toHaveBeenCalled();
  });
  it("a failed first load shows Retry, leaves the store alone; Retry loads", async () => {
    const m = mem();
    const a = fakeA(new Error("no"), two);
    const t = make("user", a, { store: c.contextStore("u1", m) });
    await t.ctx.ready;
    expect(text()).toContain("Repositories could not be loaded.");
    expect(m.calls.set).toBe(0);
    expect(t.ctx.scoped("#/runs")).toBeNull();
    focusOf("context-retry").click();
    await tick();
    expect(focusOf("context-btn")).toBeTruthy();
  });
  it("a failed refresh keeps the old list", async () => {
    const t = make("user", fakeA(two, new Error("no")));
    await t.ctx.ready;
    await t.ctx.refresh();
    expect(focusOf("context-btn")).toBeTruthy();
    expect(t.ctx.current().active).toBe(true);
  });
  it("readOnly never touches localStorage", async () => {
    const m = mem();
    vi.stubGlobal("localStorage", m);
    const ctx = c.initContext("user", { id: "u1" }, { readOnly: true, a: fakeA(two), go: vi.fn(), notify: vi.fn(), where: () => "#/home" });
    ctxs.push(ctx);
    await ctx.ready;
    focusOf("context-btn").click();
    focusOf("context-star-a/b").click();
    focusOf("context-item-a/b").click();
    expect(ctx.current().repo).toBe("a/b");
    expect(m.calls).toEqual({ get: 0, set: 0 });
  });
  it("refresh changes the switcher and navigates on a bare scoped address", async () => {
    const t = make("user", fakeA([], [gh("a/b")], two), { where: () => "#/runs" });
    await t.ctx.ready;
    expect(text()).toContain("No repository yet.");
    await t.ctx.refresh();
    expect(text()).toBe("a/b");
    expect(t.go).not.toHaveBeenCalled();
    await t.ctx.refresh();
    expect(focusOf("context-btn")).toBeTruthy();
    expect(t.go).toHaveBeenCalledWith("#/runs?repo=all", { replace: true, draw: false });
  });
  it("refresh draws only when the new address filters by a repository", async () => {
    const store = c.contextStore("u1", mem());
    store.choose("a/b");
    const t = make("user", fakeA(two), { store, where: () => "#/runs" });
    await t.ctx.ready;
    await t.ctx.refresh();
    expect(t.go).toHaveBeenLastCalledWith(c.scopedHash("user", "#/runs", t.ctx.current()), { replace: true, draw: true });
    const b = make("admin", fakeA(two), { store: c.contextStore("u1", mem()), where: () => "#/board" });
    await b.ctx.ready;
    await b.ctx.refresh();
    expect(b.go).toHaveBeenLastCalledWith("#/board?repo=all", { replace: true, draw: false });
    for (const hash of ["#/runs?repo=x/y", "#/home"]) {
      const n = make("user", fakeA(two), { where: () => hash });
      await n.ctx.ready;
      await n.ctx.refresh();
      expect(n.go, hash).not.toHaveBeenCalled();
    }
  });
  it("reposChanged refreshes the live context, and does nothing without one", async () => {
    const a = fakeA(two);
    const t = make("user", a);
    await t.ctx.ready;
    await c.reposChanged();
    expect(a.repos).toHaveBeenCalledTimes(2);
    t.ctx.stop();
    expect(c.reposChanged()).toBeUndefined();
    expect(a.repos).toHaveBeenCalledTimes(2);
  });
  it("a second context replaces the first; stopping the first again leaves the second alone", async () => {
    const first = make("user", fakeA(two));
    await first.ctx.ready;
    const second = make("user", fakeA(two));
    await second.ctx.ready;
    expect(first.ctx.scoped("#/runs")).toBeNull();
    first.ctx.stop();
    expect(focusOf("context-btn")).toBeTruthy();
    focusOf("context-btn").click();
    expect(doc().listeners.keydown).toHaveLength(1);
    expect(second.ctx.scoped("#/runs")).not.toBeNull();
  });
  it("a late answer after stop draws nothing and calls nothing", async () => {
    const store = c.contextStore("u1", mem());
    store.choose("x/y");
    for (const how of ["resolve", "reject", "stop-then-reject"]) {
      let settle: (v?: unknown) => void = () => {};
      let self: any;
      const a = fakeA(() => new Promise((res, rej) => {
        settle = how === "resolve" ? res : (v) => { if (how === "stop-then-reject") self.stop(); rej(v); };
      }));
      const t = make("user", a, { store });
      self = t.ctx;
      t.ctx.stop();
      settle(how === "resolve" ? two : new Error("no"));
      await t.ctx.ready;
      expect(box().children, how).toHaveLength(0);
      expect(t.go).not.toHaveBeenCalled();
      expect(t.notify).not.toHaveBeenCalled();
    }
  });
  it("a star keeps the panel, the search text and the focus; typing keeps the input", async () => {
    const t = make("user", fakeA(names(8)));
    await t.ctx.ready;
    focusOf("context-btn").click();
    const input = focusOf("context-search");
    input.value = "r";
    input.fire("input");
    expect(focusOf("context-search")).toBe(input);
    focusOf("context-star-o/r3").focus();
    focusOf("context-star-o/r3").click();
    expect(focusOf("context-search")).toBe(input);
    expect(input.value).toBe("r");
    expect(doc().activeElement.attrs["data-focus"]).toBe("context-star-o/r3");
    expect(doc().activeElement.attrs["aria-pressed"]).toBe("true");
    expect(t.store.get().favourites).toEqual(["o/r3"]);
    input.value = "zzz";
    input.fire("input");
    expect(text()).toContain("No repository matches.");
  });
  it("leaves no document listener behind", async () => {
    const t = make("user", fakeA(two));
    await t.ctx.ready;
    focusOf("context-btn").click();
    focusOf("context-btn").click();
    expect(doc().listeners.keydown).toHaveLength(0);
    focusOf("context-btn").click();
    await t.ctx.refresh();
    expect(doc().listeners.keydown.length).toBeLessThanOrEqual(1);
    expect(doc().listeners.mousedown.length).toBeLessThanOrEqual(1);
    t.ctx.stop();
    expect(doc().listeners.keydown).toHaveLength(0);
    expect(doc().listeners.mousedown).toHaveLength(0);
  });
});

describe("the account for saved views", () => {
  let views: any;
  beforeAll(async () => {
    views = await import("../ui/views.js" as string);
  });
  const gh = (github: string) => ({ github, owner: "u1", account: null });
  const make = (extra: Record<string, unknown> = {}) =>
    c.initContext("user", { id: "u1" }, { a: { repos: async () => [gh("b/b"), gh("a/a")], allRepos: async () => [] }, go: vi.fn(), notify: vi.fn(), store: c.contextStore("u1", mem()), where: () => "#/home", ...extra });

  it("gives the id, readOnly and the sorted repository names once loaded", async () => {
    const ctx = make();
    expect(ctx.account()).toEqual({ id: "u1", readOnly: false, repos: null });
    await ctx.ready;
    expect(ctx.account()).toEqual({ id: "u1", readOnly: false, repos: ["a/a", "b/b"] });
    expect(views.pageViews("runs", { storage: mem() })?.store.key).toBe("scf.views.u1");
    ctx.stop();
  });

  it("makes saved views null in a preview, and clears the source on stop", async () => {
    const ctx = make({ readOnly: true });
    await ctx.ready;
    expect(ctx.account().readOnly).toBe(true);
    expect(views.pageViews("runs")).toBeNull();
    ctx.stop();
    const live = make();
    expect(views.pageViews("runs")).not.toBeNull();
    live.stop();
    expect(views.pageViews("runs")).toBeNull();
  });
});
