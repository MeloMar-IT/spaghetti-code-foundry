import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let p: any;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  p = await import("../ui/work-prefs.js" as string);
  m = await import("../ui/work-model.js" as string);
});
afterAll(() => restore());

const mem = () => {
  const data: Record<string, string> = {};
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
};
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("loadPrefs / savePrefs", () => {
  it("keeps the choices per account under scf.work.<id>", () => {
    const s = mem();
    p.savePrefs("u1", { ...m.DEFAULTS, repo: "a/b", group: "repo" }, s);
    expect(Object.keys(s.data)).toEqual(["scf.work.u1"]);
    expect(p.loadPrefs("u1", s)).toMatchObject({ repo: "a/b", group: "repo" });
    expect(plain(p.loadPrefs("u2", s))).toEqual(plain(m.DEFAULTS));
  });
  it("keeps layout, props and compact per account, and drops an unknown prop", () => {
    const s = mem();
    p.savePrefs("u1", { ...m.DEFAULTS, layout: "list", props: ["age", "step"], compact: true }, s);
    expect(p.loadPrefs("u1", s)).toMatchObject({ layout: "list", props: ["age", "step"], compact: true });
    expect(p.loadPrefs("u2", s)).toMatchObject({ layout: "board", compact: false });
    expect(p.cleanPrefs({ v: 2, props: ["step", "nope", "age"] }).props).toEqual(["step", "age"]);
  });
  it("adds the step to props saved before it existed, and keeps a later choice to hide it", () => {
    expect(p.cleanPrefs({ props: ["age", "owner"] }).props).toEqual(["owner", "age", "step"]);
    expect(p.cleanPrefs({ props: [] }).props).toEqual(["step"]);
    expect(p.cleanPrefs({ v: 2, props: ["age"] }).props).toEqual(["age"]);
    expect(p.cleanPrefs({ props: [] , v: 2 }).props).toEqual([]);
  });
  it("uses scf.work.local without an account", () => {
    const s = mem();
    p.savePrefs(undefined, m.DEFAULTS, s);
    expect(Object.keys(s.data)).toEqual(["scf.work.local"]);
  });
  it("falls back to the defaults for garbage", () => {
    for (const raw of ["{nope", "null", "[1]", "5", '"x"']) {
      const s = mem();
      s.data["scf.work.u1"] = raw;
      expect(plain(p.loadPrefs("u1", s)), raw).toEqual(plain(m.DEFAULTS));
    }
  });
  it("does not throw when the store throws or is missing", () => {
    const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(plain(p.loadPrefs("u1", bad))).toEqual(plain(m.DEFAULTS));
    expect(() => p.savePrefs("u1", m.DEFAULTS, bad)).not.toThrow();
    expect(plain(p.loadPrefs("u1", undefined))).toEqual(plain(m.DEFAULTS));
    expect(() => p.savePrefs("u1", m.DEFAULTS, undefined)).not.toThrow();
  });
});

describe("cleanPrefs", () => {
  it("drops unknown keys", () => expect("junk" in p.cleanPrefs({ junk: 1 })).toBe(false));
  it("replaces wrong values by the defaults or filters them", () => {
    const c = p.cleanPrefs({ group: "x", order: 5, status: "coding", v: 2, props: ["age", "nope"], compact: "yes", layout: "grid" });
    expect(c).toMatchObject({ group: "status", order: "issue", status: [], props: ["age"], compact: false, layout: "board" });
    expect(p.cleanPrefs({ status: ["coding", 3, "coding"] }).status).toEqual(["coding"]);
  });
  it("drops a next move and columns the server does not have", () => {
    const c = p.cleanPrefs({ who: "bogus", status: ["not-a-column", "done"] });
    expect(c.who).toBe("");
    expect(c.status).toEqual(["done"]);
    expect(p.cleanPrefs({ who: "You" }).who).toBe("You");
  });
  it("never shares arrays with the defaults", () => {
    const c = p.cleanPrefs({});
    c.status.push("done");
    c.props.push("x");
    expect(m.DEFAULTS.status).toEqual([]);
    expect(m.DEFAULTS.props).toEqual(["repo", "next", "blockers", "owner", "age", "step"]);
  });
  const card = (over: Record<string, unknown>) => ({ issue: 1, repo: "a/b", ...over });
  it("clears a repository or owner that is gone, and keeps one that exists", () => {
    const items = [card({ owner: "u1" })];
    expect(p.cleanPrefs({ repo: "x/y", owner: "u9" }, items)).toMatchObject({ repo: "", owner: "" });
    expect(p.cleanPrefs({ repo: "a/b", owner: "u1" }, items)).toMatchObject({ repo: "a/b", owner: "u1" });
    expect(p.cleanPrefs({ repo: "x/y", owner: "u9" })).toMatchObject({ repo: "x/y", owner: "u9" });
  });
  it("counts a repository without cards as existing when given the answer", () => {
    const data = { repos: [{ repo: "a/b", columns: [{ id: "coding", title: "Coding", cards: [card({ owner: "u1" })] }] }, { repo: "a/empty", columns: [] }] };
    expect(p.cleanPrefs({ repo: "a/empty" }, data).repo).toBe("a/empty");
    expect(p.cleanPrefs({ repo: "a/none" }, data).repo).toBe("");
  });
});
