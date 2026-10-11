import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let c: any;
beforeAll(async () => {
  restore = installFakeDom();
  c = await import("../ui/context.js" as string);
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
  it("imports only ia.js and filters.js", () => {
    const src = readFileSync("ui/context.js", "utf8");
    expect([...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).sort()).toEqual(["./filters.js", "./ia.js"]);
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
