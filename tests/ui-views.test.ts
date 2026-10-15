import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let v: any;
let board: any;
let work: any;
let refinement: any;
beforeAll(async () => {
  restore = installFakeDom();
  v = await import("../ui/views.js" as string);
  board = await import("../ui/board.js" as string);
  work = await import("../ui/work.js" as string);
  refinement = await import("../ui/refinement.js" as string);
});
afterAll(() => restore());

const mem = (opts: { getThrows?: boolean; setThrows?: boolean } = {}) => {
  const data: Record<string, string> = {};
  const calls = { get: 0, set: 0 };
  return {
    data, calls,
    getItem: (k: string) => { calls.get++; if (opts.getThrows) throw new Error("no"); return data[k] ?? null; },
    setItem: (k: string, x: string) => { calls.set++; if (opts.setThrows) throw new Error("no"); data[k] = x; },
  };
};
const doc = () => (globalThis as any).document;
const root = () => doc().getElementById("modal-root") as FakeElement;
const btn = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text)!;
const byLabel = (el: FakeElement, label: string) => el.all("button").find((b) => b.attrs["aria-label"] === label)!;
const names = (s: any, page = "runs") => s.list(page).map((x: any) => x.name);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  root().replaceChildren();
  doc().listeners.keydown = [];
  v.setViewAccount(null);
});
afterEach(() => {
  v.setViewAccount(null);
  vi.unstubAllGlobals();
});

describe("the module", () => {
  it("imports only dom.js, filters.js and ia.js, and never the API", () => {
    const src = readFileSync("ui/views.js", "utf8");
    expect([...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).sort()).toEqual(["./dom.js", "./filters.js", "./ia.js"]);
    expect(src).not.toMatch(/fetch\(|api\./);
  });
});

describe("save", () => {
  it("trims the name, keeps only known filter keys and stores the state under the account key", () => {
    const st = mem();
    const s = v.viewStore("u1", st);
    const r = s.add("runs", "  Mine  ", { repo: "acme/app", owner: "u1", x: 1 });
    expect(r.ok).toBe(true);
    expect(s.key).toBe("scf.views.u1");
    const saved = JSON.parse(st.data["scf.views.u1"]!);
    expect(saved.v).toBe(1);
    expect(saved.views).toEqual([{ id: r.view.id, page: "runs", name: "Mine", filters: { repo: "acme/app", owner: "u1" } }]);
  });

  it("checks the name length", () => {
    const s = v.viewStore("u1", mem());
    for (const n of ["", "   ", undefined, 5]) expect(s.add("runs", n, { repo: "a/b" }).error, String(n)).toBe(v.ERRORS.empty);
    expect(s.add("runs", "x".repeat(41), { repo: "a/b" }).error).toBe(v.ERRORS.long);
    expect(s.add("runs", "x".repeat(40), { repo: "a/b" }).ok).toBe(true);
  });

  it("refuses a duplicate name on a page (ignoring case) but not on another page", () => {
    const s = v.viewStore("u1", mem());
    s.add("runs", "Mine", { repo: "a/b" });
    expect(s.add("runs", "mine", { repo: "c/d" }).error).toBe(v.ERRORS.taken);
    expect(s.add("board", "mine", { repo: "c/d" }).ok).toBe(true);
  });

  it("refuses the 21st view of the account and leaves storage as it was", () => {
    const st = mem();
    const s = v.viewStore("u1", st);
    for (let i = 0; i < 20; i++) expect(s.add(i % 2 ? "runs" : "board", `v${i}`, { repo: "a/b" }).ok).toBe(true);
    const before = st.data["scf.views.u1"];
    expect(s.add("refinement", "one more", { repo: "a/b" }).error).toBe(v.ERRORS.full);
    expect(v.viewStore("u2", mem()).add("epics", "Epics", { repo: "a/b" }).ok).toBe(true);
    expect(st.data["scf.views.u1"]).toBe(before);
  });

  it("allows a view without filters (All runs) and cleans repo=all away", () => {
    const s = v.viewStore("u1", mem());
    expect(s.add("runs", "Everything", {}).view.filters).toEqual({});
    expect(s.add("board", "All", { repo: "all" }).view.filters).toEqual({});
    expect(s.add("nope", "x", { repo: "a/b" }).error).toBe(v.ERRORS.page);
  });
});

describe("rename, move, remove", () => {
  const three = () => {
    const st = mem();
    const s = v.viewStore("u1", st);
    const ids = ["A", "B", "C"].map((n) => s.add("runs", n, { repo: "a/b" }).view.id);
    return { st, s, ids };
  };

  it("renames and trims; its own name in another case is fine; another view's name is taken", () => {
    const { s, ids } = three();
    expect(s.rename(ids[0], "  New  ").ok).toBe(true);
    expect(names(s)).toEqual(["New", "B", "C"]);
    expect(s.rename(ids[1], "b").ok).toBe(true);
    expect(s.rename(ids[1], "new").error).toBe(v.ERRORS.taken);
    expect(s.rename(ids[1], " ").error).toBe(v.ERRORS.empty);
    expect(s.rename("missing", "x").ok).toBe(false);
  });

  it("moves a middle view and writes nothing at the first or last position", () => {
    const { st, s, ids } = three();
    expect(s.move(ids[1], -1).changed).toBe(true);
    expect(names(s)).toEqual(["B", "A", "C"]);
    const writes = st.calls.set;
    expect(s.move(ids[1], -1)).toMatchObject({ ok: true, changed: false });
    expect(s.move(ids[2], 1)).toMatchObject({ ok: true, changed: false });
    expect(st.calls.set).toBe(writes);
    expect(s.move("missing", 1).ok).toBe(false);
  });

  it("keeps the place of the views of other pages", () => {
    const s = v.viewStore("u1", mem());
    const a = s.add("runs", "A", { repo: "a/b" }).view.id;
    s.add("board", "X", { repo: "a/b" });
    s.add("runs", "B", { repo: "a/b" });
    s.move(a, 1);
    expect(names(s)).toEqual(["B", "A"]);
    expect(names(s, "board")).toEqual(["X"]);
  });

  it("removes only that view", () => {
    const { s, ids } = three();
    expect(s.remove(ids[1]).ok).toBe(true);
    expect(names(s)).toEqual(["A", "C"]);
    expect(s.remove(ids[1]).ok).toBe(false);
  });
});

describe("accounts and ids", () => {
  it("keeps accounts apart", () => {
    const st = mem();
    v.viewStore("u1", st).add("runs", "Mine", { repo: "a/b" });
    expect(v.viewStore("u2", st).list("runs")).toEqual([]);
    expect(v.viewStore("u2", st).key).not.toBe(v.viewStore("u1", st).key);
  });

  it("never reuses an id: a pending action of another tab cannot reach a newer view", () => {
    const st = mem();
    const tabA = v.viewStore("u1", st);
    const tabB = v.viewStore("u1", st);
    const old = tabA.add("runs", "Old", { repo: "a/b" }).view;
    const pendingId = tabA.list("runs")[0].id; // tab A holds a confirmation for this view
    expect(tabB.remove(old.id).ok).toBe(true);
    const fresh = tabB.add("runs", "New", { repo: "a/b" }).view;
    expect(fresh.id).not.toBe(old.id);
    expect(tabA.remove(pendingId).ok).toBe(false);
    expect(tabA.rename(pendingId, "x").ok).toBe(false);
    expect(tabA.move(pendingId, 1).ok).toBe(false);
    expect(names(tabB)).toEqual(["New"]);
  });
});

describe("garbage and broken storage", () => {
  it("reads garbage as no views and replaces it on the next save", () => {
    for (const raw of ["{nope", "null", "[1]", JSON.stringify({ v: 2, views: [] }), JSON.stringify({ v: 1, views: "x" })]) {
      const st = mem();
      st.data["scf.views.u1"] = raw;
      const s = v.viewStore("u1", st);
      expect(s.list("runs"), raw).toEqual([]);
      expect(s.add("runs", "Mine", { repo: "a/b" }).ok).toBe(true);
      expect(JSON.parse(st.data["scf.views.u1"]!).views).toHaveLength(1);
    }
  });

  it("drops bad entries and keeps good ones", () => {
    const st = mem();
    const good = { id: "g1", page: "runs", name: "Good", filters: { repo: "a/b" } };
    st.data["scf.views.u1"] = JSON.stringify({ v: 1, views: [
      good,
      { ...good, id: "g2", page: "nowhere" },
      { ...good, id: "g3", name: "x".repeat(41) },
      { ...good, id: "g1", name: "Same id" },
      { ...good, id: "g4", name: "good" },
      { ...good, id: "g5", name: "  ", },
      { id: "m1", page: "runs", name: "Missing" },
      { id: "m2", page: "runs", name: "Primitive", filters: "garbage" },
      { id: "m3", page: "runs", name: "Array", filters: [1] },
      { id: "m4", page: "runs", name: "Null", filters: null },
      { ...good, id: "g6", name: "Other", filters: { zzz: 1, owner: "u1" } },
      "junk",
    ] });
    expect(v.viewStore("u1", st).list("runs")).toEqual([good, { id: "g6", page: "runs", name: "Other", filters: { owner: "u1" } }]);
  });

  it("with a throwing getItem: no views, no exception, and a change is refused without touching the stored bytes", () => {
    const st = mem();
    v.viewStore("u1", st).add("runs", "Keep", { repo: "a/b" });
    const bytes = st.data["scf.views.u1"];
    const broken = { getItem: () => { throw new Error("no"); }, setItem: vi.fn((k: string, x: string) => { st.data[k] = x; }) };
    const s = v.viewStore("u1", broken);
    expect(s.list("runs")).toEqual([]);
    expect(s.add("runs", "New", { repo: "a/b" })).toEqual({ ok: false, error: v.ERRORS.storage });
    const id = JSON.parse(bytes!).views[0].id;
    expect(s.rename(id, "x").ok).toBe(false);
    expect(s.move(id, 1).ok).toBe(false);
    expect(s.remove(id).ok).toBe(false);
    expect(broken.setItem).not.toHaveBeenCalled();
    expect(st.data["scf.views.u1"]).toBe(bytes);
  });

  it("with a throwing setItem or no storage: the change is refused and nothing is listed", () => {
    const s = v.viewStore("u1", mem({ setThrows: true }));
    expect(s.add("runs", "Mine", { repo: "a/b" }).error).toBe(v.ERRORS.storage);
    expect(s.list("runs")).toEqual([]);
    const none = v.viewStore("u1", null);
    expect(none.add("runs", "Mine", { repo: "a/b" }).error).toBe(v.ERRORS.storage);
    expect(none.list("runs")).toEqual([]);
    expect(none.remove("x").ok).toBe(false);
  });
});

describe("viewHash and sameFilters", () => {
  it("writes the address of each page, with repo=all when there is no repository", () => {
    const view = (page: string, filters: any) => ({ id: "x", page, name: "n", filters });
    expect(v.viewHash(view("runs", { repo: "acme/app", owner: "u1" }))).toBe("#/runs?repo=acme%2Fapp&owner=u1");
    expect(v.viewHash(view("runs", { owner: "u1" }))).toBe("#/runs?repo=all&owner=u1");
    expect(v.viewHash(view("runs", {}))).toBe("#/runs?repo=all");
    expect(v.viewHash(view("refinement", { repo: "acme/app" }))).toBe("#/refinement?repo=acme%2Fapp");
    expect(v.viewHash(view("refinement", {}))).toBe("#/refinement?repo=all");
    expect(v.viewHash(view("epics", { repo: "acme/app" }))).toBe("#/epics?repo=acme%2Fapp");
    expect(v.viewHash(view("epics", {}))).toBe("#/epics?repo=all");
    expect(v.viewHash(view("board", { repo: "acme/app", owner: "u1" }))).toBe("#/board/acme%2Fapp?owner=u1");
    expect(v.viewHash(view("board", { owner: "u1" }))).toBe("#/board?repo=all&owner=u1");
    expect(v.viewHash(view("board", {}))).toBe("#/board?repo=all");
  });

  it("compares the repository ignoring case, the owner exactly, and no repository with repo=all", () => {
    expect(v.sameFilters({ repo: "A/B" }, { repo: "a/b" })).toBe(true);
    expect(v.sameFilters({ owner: "u1" }, { owner: "U1" })).toBe(false);
    expect(v.sameFilters({}, { repo: "all" })).toBe(true);
    expect(v.sameFilters({ repo: "a/b" }, {})).toBe(false);
  });
});

describe("isStale", () => {
  const view = (filters: any) => ({ id: "x", page: "runs", name: "n", filters });
  it("marks an unknown repository, ignoring case", () => {
    expect(v.isStale(view({ repo: "gone/x" }), { repos: ["a/b"] })).toBe(true);
    expect(v.isStale(view({ repo: "A/B" }), { repos: ["a/b"] })).toBe(false);
    expect(v.isStale(view({ repo: "gone/x" }), { repos: null })).toBe(false);
    expect(v.isStale(view({ repo: "gone/x" }))).toBe(false);
  });
  it("marks an owner that is not among the owners", () => {
    expect(v.isStale(view({ owner: "u9" }), { owners: ["u1"] })).toBe(true);
    expect(v.isStale(view({ owner: "u1" }), { owners: ["u1"] })).toBe(false);
    expect(v.isStale(view({ owner: "u9" }), { owners: null })).toBe(false);
  });
});

describe("viewsRow", () => {
  const list = [{ id: "a", page: "runs", name: "<b>x</b>", filters: { repo: "a/b" } }, { id: "b", page: "runs", name: "Two", filters: { owner: "u1" } }];
  it("is null without views", () => {
    expect(v.viewsRow([], undefined)).toBeNull();
  });
  it("draws one link per view, marks the active one and the stale ones, and names are text", () => {
    const onManage = vi.fn();
    const row = v.viewsRow(list, "a", { stale: (x: any) => x.id === "b", onManage }) as FakeElement;
    expect(row.attrs["aria-label"]).toBe("Saved views");
    const links = row.all("a");
    expect(links.map((a) => a.attrs.href)).toEqual(["#/runs?repo=a%2Fb", "#/runs?repo=all&owner=u1"]);
    expect(links[0]!.attrs["aria-current"]).toBe("true");
    expect(links[0]!.attrs.class).toBe("btn primary");
    expect(links[1]!.attrs["aria-current"]).toBeUndefined();
    expect(links[0]!.textContent).toBe("<b>x</b>");
    expect(row.all("b")).toHaveLength(0);
    expect(links[1]!.textContent).toContain("out of date");
    expect(links[0]!.textContent).not.toContain("out of date");
    btn(row, "Manage views").click();
    expect(onManage).toHaveBeenCalled();
  });
});

describe("saveViewDialog", () => {
  it("keeps the dialog open with the message on an error, and resolves true after a save", async () => {
    const s = v.viewStore("u1", mem());
    s.add("runs", "Taken", { repo: "a/b" });
    const done = v.saveViewDialog(s, "runs", { repo: "c/d" });
    const input = root().all("input")[0]!;
    expect(input.attrs.maxlength).toBe("40");
    btn(root(), "Save").click();
    expect(root().textContent).toContain(v.ERRORS.empty);
    input.value = "taken";
    btn(root(), "Save").click();
    expect(root().textContent).toContain(v.ERRORS.taken);
    expect(root().all("p").find((p) => p.attrs.role === "alert")?.attrs.class).toBe("status bad");
    input.value = "Fresh";
    input.fire("keydown", { key: "Enter", preventDefault() {} });
    expect(await done).toBe(true);
    expect(root().children).toHaveLength(0);
    expect(s.list("runs").find((x: any) => x.name === "Fresh").filters).toEqual({ repo: "c/d" });
  });

  it("resolves false on Cancel and stores nothing", async () => {
    const st = mem();
    const done = v.saveViewDialog(v.viewStore("u1", st), "runs", { repo: "c/d" });
    btn(root(), "Cancel").click();
    expect(await done).toBe(false);
    expect(st.calls.set).toBe(0);
  });

  it("shows the storage message when the browser cannot write", async () => {
    const done = v.saveViewDialog(v.viewStore("u1", mem({ setThrows: true })), "runs", { repo: "c/d" });
    root().all("input")[0]!.value = "x";
    btn(root(), "Save").click();
    expect(root().textContent).toContain(v.ERRORS.storage);
    btn(root(), "Cancel").click();
    expect(await done).toBe(false);
  });
});

describe("manageViewsDialog", () => {
  const open = (s: any, extra: any = {}) => {
    const done = v.manageViewsDialog(s, "runs", extra);
    return done;
  };
  const rowOf = (text: string) => root().all("li").find((li) => li.textContent.startsWith(text))!;

  it("says so when there are no views", async () => {
    const done = open(v.viewStore("u1", mem()));
    expect(root().textContent).toContain("No saved views on this page.");
    btn(root(), "Done").click();
    await done;
    expect(root().children).toHaveLength(0);
  });

  it("renames", () => {
    const s = v.viewStore("u1", mem());
    s.add("runs", "One", { repo: "a/b" });
    open(s);
    byLabel(root(), "Rename One").click();
    const input = root().all("input")[0]!;
    input.value = "Uno";
    btn(root(), "Save").click();
    expect(names(s)).toEqual(["Uno"]);
    expect(root().textContent).toContain("Uno");
    byLabel(root(), "Rename Uno").click();
    root().all("input")[0]!.value = " ";
    btn(root(), "Save").click();
    expect(root().textContent).toContain(v.ERRORS.empty);
    btn(root(), "Cancel").click();
    expect(names(s)).toEqual(["Uno"]);
  });

  it("disables up on the first and down on the last, and moves", () => {
    const s = v.viewStore("u1", mem());
    s.add("runs", "One", { repo: "a/b" });
    s.add("runs", "Two", { repo: "a/b" });
    open(s);
    expect(byLabel(root(), "Move One up").attrs.disabled).toBeDefined();
    expect(byLabel(root(), "Move Two down").attrs.disabled).toBeDefined();
    expect(byLabel(root(), "Move One down").attrs.disabled).toBeUndefined();
    byLabel(root(), "Move One down").click();
    expect(names(s)).toEqual(["Two", "One"]);
  });

  it("asks before deleting, says only the view goes, and Keep it keeps it", () => {
    const s = v.viewStore("u1", mem());
    s.add("runs", "One", { repo: "a/b" });
    s.add("runs", "Two", { repo: "a/b" });
    open(s);
    byLabel(root(), "Delete One").click();
    expect(root().textContent).toContain(v.deleteText("One"));
    expect(root().textContent).toContain("Only the saved view is removed. Runs, sessions and repositories stay.");
    expect(names(s)).toEqual(["One", "Two"]);
    btn(root(), "Keep it").click();
    expect(names(s)).toEqual(["One", "Two"]);
    byLabel(root(), "Delete One").click();
    btn(root(), "Delete view").click();
    expect(names(s)).toEqual(["Two"]);
  });

  it("shows the out-of-date mark", () => {
    const s = v.viewStore("u1", mem());
    s.add("runs", "Old", { repo: "gone/x" });
    s.add("runs", "Fine", { repo: "a/b" });
    open(s, { stale: (x: any) => x.name === "Old" });
    expect(rowOf("Old").textContent).toContain("out of date");
    expect(rowOf("Fine").textContent).not.toContain("out of date");
  });

  it("shows an error when a change cannot be written or the view is gone", () => {
    const st = mem();
    const s = v.viewStore("u1", st);
    s.add("runs", "One", { repo: "a/b" });
    s.add("runs", "Two", { repo: "a/b" });
    open(s);
    const id = s.list("runs")[0].id;
    v.viewStore("u1", st).remove(id); // another tab
    byLabel(root(), "Move One down").click();
    expect(root().textContent).toContain(v.ERRORS.gone);
    st.setItem = () => { throw new Error("full"); };
    byLabel(root(), "Delete Two").click();
    btn(root(), "Delete view").click();
    expect(root().textContent).toContain(v.ERRORS.storage);
    expect(names(s)).toEqual(["Two"]);
  });
});

describe("pageViews", () => {
  const acct = (over: any = {}) => () => ({ id: "u1", readOnly: false, repos: ["a/b"], ...over });
  it("is null without a source, in a preview, for an unknown page or with a source that throws", () => {
    expect(v.pageViews("runs")).toBeNull();
    expect(v.pageViews("runs", { account: acct({ readOnly: true }), storage: mem() })).toBeNull();
    expect(v.pageViews("nope", { account: acct(), storage: mem() })).toBeNull();
    expect(v.pageViews("runs", { account: () => null, storage: mem() })).toBeNull();
    expect(v.pageViews("runs", { account: () => { throw new Error("x"); }, storage: mem() })).toBeNull();
  });

  it("uses the registered source, and setViewAccount(null) clears it", () => {
    v.setViewAccount(acct({ readOnly: true }));
    expect(v.pageViews("runs")).toBeNull();
    v.setViewAccount(acct());
    expect(v.pageViews("runs")?.store.key).toBe("scf.views.u1");
    v.setViewAccount(null);
    expect(v.pageViews("runs")).toBeNull();
  });

  it("offers Save view without filters too, and marks the active view", () => {
    const pv = v.pageViews("runs", { account: acct(), storage: mem() });
    pv.store.add("runs", "All", {});
    pv.store.add("runs", "App", { repo: "a/b" });
    const p = pv.parts({});
    expect(typeof p.onSave).toBe("function");
    expect(p.row.all("a").map((a: FakeElement) => a.attrs["aria-current"])).toEqual(["true", undefined]);
    expect(p.onDelete).toBeNull();
    expect(p.stale).toBe(false);
  });

  it("offers Delete this view only for a stale active view, and removes it after the answer", async () => {
    const ask = vi.fn(async () => true);
    const pv = v.pageViews("runs", { account: acct(), storage: mem(), ask });
    const id = pv.store.add("runs", "Old", { repo: "gone/x" }).view.id;
    expect(pv.parts({ repo: "a/b" }).onDelete).toBeNull();
    const redraw = vi.fn();
    const p = pv.parts({ repo: "GONE/x" }, { redraw });
    expect(p.stale).toBe(true);
    await p.onDelete();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete this view", text: v.deleteText("Old") }));
    expect(pv.store.list("runs")).toEqual([]);
    expect(redraw).toHaveBeenCalled();
    expect(id).toBeTruthy();
  });

  it("deletes nothing when the answer is no, and nothing is deleted automatically", async () => {
    const pv = v.pageViews("runs", { account: acct(), storage: mem(), ask: async () => false });
    pv.store.add("runs", "Old", { repo: "gone/x" });
    const p = pv.parts({ repo: "gone/x" });
    expect(pv.store.list("runs")).toHaveLength(1);
    await p.onDelete();
    expect(pv.store.list("runs")).toHaveLength(1);
  });

  it("marks an owner that is not known, and not when owners are unknown", () => {
    const pv = v.pageViews("runs", { account: acct(), storage: mem() });
    pv.store.add("runs", "Bob", { owner: "u9" });
    expect(pv.parts({}, { owners: ["u1"] }).row.textContent).toContain("out of date");
    expect(pv.parts({}, { owners: null }).row.textContent).not.toContain("out of date");
  });
});

describe("no view action calls the API", () => {
  it("calls fetch never", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const s = v.viewStore("u1", mem());
    const a = s.add("runs", "One", { repo: "a/b" }).view;
    s.add("runs", "Two", { repo: "a/b" });
    s.rename(a.id, "Uno");
    s.move(a.id, 1);
    v.viewsRow(s.list("runs"), a.id, { stale: () => true });
    const save = v.saveViewDialog(s, "runs", { repo: "c/d" });
    btn(root(), "Cancel").click();
    await save;
    const manage = v.manageViewsDialog(s, "runs");
    byLabel(root(), "Delete Uno").click();
    btn(root(), "Delete view").click();
    btn(root(), "Done").click();
    await manage;
    s.remove(s.list("runs")[0].id);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the pages", () => {
  const registered = (repos: string[] | null, st = mem()) => {
    v.setViewAccount(() => ({ id: "u1", readOnly: false, repos }));
    return st;
  };
  const holder = () => {
    const m = new FakeElement("div") as FakeElement & { isConnected: boolean };
    m.isConnected = true;
    return m;
  };
  const cardsOf = (repo: string, owner: string) => ({
    repos: [{ repo, columns: [{ id: "queued", title: "Queued", cards: [{ key: `${repo}#1`, issue: 1, title: "One", column: "queued", owner, ownerName: owner, runId: "r1", after: [], chain: [], next: { text: "x", who: "pipeline" } }] }] }],
  });

  describe("refinement", () => {
    beforeEach(() => {
      (globalThis as any).location = { hash: "#/refinement" };
    });
    afterEach(() => {
      delete (globalThis as any).location;
      vi.unstubAllGlobals();
    });
    it("a stale view shows the row and the empty state with both actions, though a session still matches", async () => {
      const st = mem();
      v.viewStore("u1", st).add("refinement", "Gone", { repo: "gone/repo" });
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: any) => {
        urls.push(`${init.method} ${url}`);
        const s = { id: "s1", repo: "gone/repo", repoAvailable: true, title: "Idea", idea: "x", state: "exploring", drafts: [], log: [], created: new Date().toISOString(), updated: new Date().toISOString(), mine: true };
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ sessions: [s], repos: ["acme/app"] }) };
      });
      registered(["acme/app"]);
      const views = v.pageViews("refinement", { storage: st });
      const m = holder();
      const stop = await refinement.renderRefinement(m, { query: { repo: "gone/repo" }, go: vi.fn(), views });
      expect(urls).toEqual(["GET /api/refinement"]);
      expect(m.textContent).toContain("out of date");
      expect(m.textContent).toContain("Clear filters");
      expect(btn(m, "Delete this view")).toBeDefined();
      expect(m.all("table")).toHaveLength(0);
      stop();
    });
  });

  describe("the board and the redesigned Work page", () => {
    const answers: Record<string, unknown> = {};
    beforeEach(() => {
      vi.useFakeTimers();
      (globalThis as any).location = { hash: "#/board" };
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      delete (globalThis as any).location;
      vi.unstubAllGlobals();
    });
    const stubFetch = (data: unknown, owners: unknown) => {
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
        urls.push(`${init.method ?? "GET"} ${url}`);
        if (url === "/api/run-owners" && owners instanceof Error) throw owners;
        return { ok: true, status: 200, statusText: "OK", json: async () => (url === "/api/run-owners" ? owners : url === "/api/board" ? data : answers[url] ?? {}) };
      });
      return urls;
    };
    const flush = () => vi.advanceTimersByTimeAsync(0);

    it("Board: an owner with runs but no cards is not out of date; an absent owner is; a failed list marks nothing", async () => {
      const st = mem();
      const s = v.viewStore("u1", st);
      s.add("board", "Has runs", { owner: "u2" });
      s.add("board", "Absent", { owner: "u9" });
      for (const [owners, expectStale] of [[[{ id: "u1", name: "A", runs: 1 }, { id: "u2", name: "B", runs: 1 }], ["Absent"]], [new Error("down"), []]] as const) {
        const urls = stubFetch(cardsOf("acme/app", "u1"), owners);
        registered(["acme/app"]);
        const m = holder();
        const stop = board.renderBoard(m, "acme/app", { query: {}, go: vi.fn(), views: v.pageViews("board", { storage: st }) });
        await flush();
        await flush();
        const marked = m.all("a").filter((a) => a.textContent.includes("out of date")).map((a) => a.textContent.replace(" out of date", ""));
        expect(marked).toEqual(expectStale);
        expect(urls.filter((u) => u.startsWith("POST") || u.startsWith("PUT") || u.startsWith("DELETE"))).toEqual([]);
        stop();
      }
    });

    it("Board: parts get the repository and owner, and a view for a repository outside the list is marked", async () => {
      const st = mem();
      v.viewStore("u1", st).add("board", "Old", { repo: "acme/app" });
      stubFetch(cardsOf("acme/app", "u1"), []);
      registered(["other/repo"]);
      const m = holder();
      const stop = board.renderBoard(m, "acme/app", { query: { owner: "u1" }, go: vi.fn(), views: v.pageViews("board", { storage: st }) });
      await flush();
      expect(m.all("a").find((a) => a.textContent.includes("Old"))!.attrs["aria-current"]).toBeUndefined(); // the page also filters by owner: not the active view
      expect(m.all("a").filter((a) => a.textContent.includes("out of date"))).toHaveLength(1);
      stop();
    });

    it("Work page: the row, Save view, the stale empty state, and unfiltered links work", async () => {
      const st = mem();
      const s = v.viewStore("u1", st);
      s.add("board", "Gone", { repo: "acme/app" });
      s.add("board", "Everything", {});
      stubFetch(cardsOf("acme/app", "u1"), [{ id: "u1", name: "A", runs: 1 }]);
      registered(["other/repo"]);
      const m = holder();
      const stop = work.renderWork(m, "acme/app", { user: { id: "u1" }, store: mem(), query: {}, go: vi.fn(), media: { matches: false }, views: v.pageViews("board", { storage: st }) });
      await flush();
      await flush();
      expect(m.all("nav")[0]!.attrs["aria-label"]).toBe("Saved views");
      expect(m.all("a").map((a) => a.attrs.href)).toContain("#/board?repo=all");
      expect(btn(m, "Save view")).toBeDefined();
      expect(btn(m, "Delete this view")).toBeDefined(); // the view for acme/app is active and out of date
      expect(btn(m, "Clear filters")).toBeDefined();
      stop();
    });

    it("Work page: an empty board still offers Save view", async () => {
      const st = mem();
      stubFetch({ repos: [], empty: "Nothing here." }, []);
      registered(["acme/app"]);
      const m = holder();
      const stop = work.renderWork(m, undefined, { user: { id: "u1" }, store: mem(), query: {}, go: vi.fn(), media: { matches: false }, views: v.pageViews("board", { storage: st }) });
      await flush();
      await flush();
      expect(m.textContent).toContain("Nothing here.");
      btn(m, "Save view").click();
      expect(root().textContent).toContain("Name of the view");
      btn(root(), "Cancel").click();
      stop();
    });

    it("the router passes the default views to both Board branches", () => {
      const app = readFileSync("ui/app.js", "utf8");
      expect(app).toContain("renderWork(main, arg, { user: S.me, query: to.query, go })");
      expect(app).toContain("renderBoard(main, arg, { query: to.query, go })");
      expect(readFileSync("ui/board.js", "utf8")).toContain('views = pageViews("board")');
      expect(readFileSync("ui/work.js", "utf8")).toContain('views = pageViews("board")');
    });
  });
});
