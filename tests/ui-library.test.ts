import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { loadUiSource } from "./helpers/ui-load.js";

// The block library: filter, preview and insert, the dialog and the Library page, on the fake DOM.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let lib: Record<string, any>;
const api: Record<string, any> = {};
beforeAll(async () => {
  restore = installFakeDom();
  const dom = await import("../ui/dom.js" as string);
  const states = await import("../ui/states.js" as string);
  lib = await loadUiSource("library.js", {
    "/vendor/yaml/index.js": { default: { stringify: (v: unknown) => JSON.stringify(v) } },
    "./api.js": { api },
    "./dom.js": dom,
    "./states.js": states,
  }, ["filterBlocks", "countText", "previewInsert", "insertBlock", "pickBlock", "renderLibrary"]);
});
afterAll(() => restore());

const g = globalThis as any;
const el = (id: string) => g.document.getElementById(id) as FakeElement;
const main = () => el("main");
const root = () => el("modal-root");
const mk = (id: string, scope: string, category: string, steps: any[], vars?: any) => ({
  id, scope, yaml: `name: ${id}`, block: { name: `Block ${id}`, category, description: `does ${id}`, steps, ...(vars ? { vars } : {}) },
});
const A = mk("alpha", "builtin", "Git", [{ id: "pull", type: "shell" }]);
const B = mk("beta", "repo", "Custom", [{ id: "plan", type: "claude" }, { id: "code", type: "shell", on_failure: "plan" }], { a: "x", b: "2" });
const BAD = { id: "bad", scope: "repo", yaml: "x", error: "bad: invalid block" };
const flowOf = () => ({ steps: [{ id: "plan", type: "shell" }, { id: "plan2", type: "shell" }], vars: { a: "1" } });

const btn = (box: FakeElement, text: string) => box.all("button").find((b) => b.textContent === text);
const clickIn = (box: FakeElement, text: string) => {
  const b = btn(box, text);
  if (!b) throw new Error(`no button "${text}" in ${box.textContent.slice(0, 120)}`);
  b.click();
};
const cardsIn = (box: FakeElement) => box.all("button").filter((b) => b.getAttribute("class") === "block-card");
const items = () => main().all("div").filter((d) => d.getAttribute("class") === "block-item");
const input = (box: FakeElement) => box.all("input")[0]!;
const select = (box: FakeElement) => box.all("select")[0]!;

beforeEach(() => {
  api.blocks = vi.fn(async () => [A, B, BAD]);
  api.deleteBlock = vi.fn(async () => ({}));
  main().replaceChildren();
  root().replaceChildren();
  el("toast").replaceChildren();
  g.document.listeners.keydown = [];
});

describe("filterBlocks and countText", () => {
  const all = [A, B, BAD];
  it("returns everything in order for an empty filter", () => {
    expect(lib.filterBlocks(all)).toEqual(all);
    expect(lib.filterBlocks(all, { q: "  ", category: "" })).toEqual(all);
  });
  it("matches id, name, description, category and scope, ignoring case and outer spaces", () => {
    expect(lib.filterBlocks(all, { q: " ALPHA " })).toEqual([A]);
    expect(lib.filterBlocks(all, { q: "block beta" })).toEqual([B]);
    expect(lib.filterBlocks(all, { q: "does beta" })).toEqual([B]);
    expect(lib.filterBlocks(all, { q: "custom" })).toEqual([B]);
    expect(lib.filterBlocks(all, { q: "builtin" })).toEqual([A]);
  });
  it("filters by category, with Invalid for blocks without a block, and combines with the text", () => {
    expect(lib.filterBlocks(all, { category: "Git" })).toEqual([A]);
    expect(lib.filterBlocks(all, { category: "Invalid" })).toEqual([BAD]);
    expect(lib.filterBlocks(all, { q: "beta", category: "Git" })).toEqual([]);
  });
  it("does not match an invalid block on the word undefined", () => {
    expect(lib.filterBlocks(all, { q: "undefined" })).toEqual([]);
  });
  it("counts", () => {
    expect(lib.countText(12, 12)).toBe("12 blocks");
    expect(lib.countText(1, 1)).toBe("1 block");
    expect(lib.countText(3, 12)).toBe("3 of 12 blocks");
    expect(lib.countText(0, 0)).toBe("0 blocks");
  });
});

describe("previewInsert and insertBlock", () => {
  it("without a clash lists the block's ids and types and changes nothing", () => {
    const flow = { steps: [{ id: "x", type: "shell" }], vars: {} };
    const before = structuredClone(flow);
    const p = lib.previewInsert(flow, A.block);
    expect(p).toEqual({ steps: [{ id: "pull", type: "shell" }], vars: {}, renamed: [] });
    expect(flow).toEqual(before);
  });
  it("renames a clash, including the block's own references", () => {
    const p = lib.previewInsert(flowOf(), B.block);
    expect(p.renamed).toEqual([["plan", "plan3"]]);
    expect(p.steps.map((s: any) => s.id)).toEqual(["plan3", "code"]);
  });
  it("gives two clashing block steps different ids", () => {
    const block = { steps: [{ id: "s", type: "shell" }, { id: "s2", type: "shell" }] };
    const p = lib.previewInsert({ steps: [{ id: "s" }, { id: "s2" }] }, block);
    expect(p.steps.map((s: any) => s.id)).toEqual(["s3", "s22"]);
  });
  it("lists only variables the flow does not have", () => {
    expect(lib.previewInsert(flowOf(), B.block).vars).toEqual({ b: "2" });
    expect(lib.previewInsert({ steps: [] }, B.block).vars).toEqual({ a: "x", b: "2" });
    expect(lib.previewInsert(flowOf(), A.block).vars).toEqual({});
  });
  it("lists variables named like Object.prototype members and __proto__", () => {
    const vars = JSON.parse('{"constructor": "c", "__proto__": "p"}');
    const block = { steps: [{ id: "s", type: "shell" }], vars };
    const p = lib.previewInsert({ steps: [], vars: {} }, block);
    expect(Object.keys(p.vars)).toEqual(["constructor", "__proto__"]);
    const flow: any = { steps: [], vars: {} };
    lib.insertBlock(flow, block, 0);
    expect(Object.keys(flow.vars)).toEqual(["constructor", "__proto__"]);
    expect(Object.getPrototypeOf(flow.vars)).toBe(Object.prototype);
  });
  it("maps every kind of reference", () => {
    const block = { steps: [
      { id: "a", type: "claude" },
      { id: "b", type: "claude", resume: "a", resume_from: "a", on_success: "a", on_failure: "end", routes: [{ if: "x", goto: "a" }, { if: "y", goto: "fail" }] },
      { id: "p", type: "parallel", steps: ["a", "b"] },
    ] };
    const flow: any = { steps: [{ id: "a" }, { id: "b" }, { id: "p" }] };
    lib.insertBlock(flow, block, 3);
    const b = flow.steps[4];
    expect(b).toMatchObject({ id: "b2", resume: "a2", resume_from: "a2", on_success: "a2", on_failure: "end" });
    expect(b.routes.map((r: any) => r.goto)).toEqual(["a2", "fail"]);
    expect(flow.steps[5].steps).toEqual(["a2", "b2"]);
    expect(block.steps[1]!.resume).toBe("a");
  });
  it("insertBlock does what the preview said", () => {
    const flow: any = flowOf();
    const p = lib.previewInsert(flow, B.block);
    const r = lib.insertBlock(flow, B.block, 1);
    expect(flow.steps.slice(1, 1 + r.count).map((s: any) => s.id)).toEqual(p.steps.map((s: any) => s.id));
    expect(r.renamed).toEqual(p.renamed);
    for (const [k, v] of Object.entries(p.vars)) expect(flow.vars[k]).toBe(v);
    expect(flow.vars.a).toBe("1");
    expect(flow.steps[2].on_failure).toBe("plan3");
    expect(B.block.steps[1]!.on_failure).toBe("plan");
  });
});

describe("pickBlock", () => {
  const open = (flow: any = flowOf()) => {
    const done = lib.pickBlock(flow);
    return done;
  };
  const ready = () => vi.waitFor(() => expect(cardsIn(root())).toHaveLength(3));
  const type = (q: string) => { const i = input(root()); i.value = q; i.fire("input"); };

  it("has a search box and category select in labels, and a scope pill on every card", async () => {
    void open();
    await ready();
    expect(root().all("label").map((l) => l.all("span")[0]!.textContent)).toEqual(["Search", "Category"]);
    expect(input(root()).getAttribute("type")).toBe("search");
    const pills = (c: FakeElement) => c.all("span").filter((s) => s.getAttribute("class") === "pill").map((s) => s.textContent);
    expect(pills(cardsIn(root())[0]!)).toContain("builtin");
    expect(pills(cardsIn(root())[1]!)).toContain("repo");
  });

  it("works when querySelectorAll returns a NodeList, which has no find()", async () => {
    const proto = FakeElement.prototype;
    const real = proto.querySelectorAll;
    proto.querySelectorAll = function (this: FakeElement, sel: string) {
      const list = real.call(this, sel);
      return { length: list.length, [Symbol.iterator]: () => list[Symbol.iterator]() } as any;
    };
    try {
      void open();
      await ready();
      cardsIn(root())[0]!.click();
      expect(btn(root(), "Insert")).toBeDefined();
      clickIn(root(), "Back");
      expect(cardsIn(root())).toHaveLength(3);
    } finally {
      proto.querySelectorAll = real;
    }
  });

  it("filters by text and category, and Clear filters brings the cards back", async () => {
    void open();
    await ready();
    type("beta");
    expect(cardsIn(root())).toHaveLength(1);
    const sel = select(root());
    sel.value = "Git";
    sel.fire("change");
    expect(cardsIn(root())).toHaveLength(0);
    expect(root().textContent).toContain("No blocks match.");
    clickIn(root(), "Clear filters");
    expect(cardsIn(root())).toHaveLength(3);
    expect(input(root()).value).toBe("");
  });

  it("shows a preview before anything changes", async () => {
    const flow = flowOf();
    const before = structuredClone(flow);
    let result: any = "pending";
    void open(flow).then((r: any) => { result = r; });
    await ready();
    cardsIn(root())[1]!.click();
    const t = root().textContent;
    expect(t).toContain("Steps (2)");
    expect(t).toContain("plan3");
    expect(t).toContain("(was plan)");
    expect(t).toContain("Variables added");
    expect(t).toContain("b = 2");
    expect(t).not.toContain("a = x");
    expect(t).toContain("Renamed ids");
    expect(t).toContain("plan → plan3");
    expect(root().all("span").some((s) => s.getAttribute("class") === "pill" && s.textContent === "claude")).toBe(true);
    expect(btn(root(), "Back")).toBeDefined();
    expect(btn(root(), "Insert")).toBeDefined();
    expect(result).toBe("pending");
    expect(flow).toEqual(before);
  });

  it("shows no renames without a clash, and says when no variable is added", async () => {
    void open({ steps: [] });
    await ready();
    cardsIn(root())[0]!.click();
    expect(root().textContent).not.toContain("Renamed ids");
    expect(root().textContent).toContain("No variables are added.");
  });

  it("Back keeps the filter, and Insert resolves with the listing", async () => {
    const p = open();
    await ready();
    type("beta");
    cardsIn(root())[0]!.click();
    clickIn(root(), "Back");
    expect(input(root()).value).toBe("beta");
    expect(cardsIn(root())).toHaveLength(1);
    cardsIn(root())[0]!.click();
    clickIn(root(), "Insert");
    expect(await p).toBe(B);
    expect(root().children).toHaveLength(0);
  });

  it("resolves undefined on Escape in the preview", async () => {
    const p = open();
    await ready();
    cardsIn(root())[0]!.click();
    for (const fn of g.document.listeners.keydown) fn({ key: "Escape" });
    expect(await p).toBeUndefined();
  });

  it("lists an invalid block with its error, disabled, and does not preview it", async () => {
    void open();
    await ready();
    const card = cardsIn(root()).find((c) => c.textContent.includes("bad: invalid block"))!;
    expect(card.getAttribute("disabled")).not.toBeNull();
    expect(card.textContent).toContain("Invalid");
    for (const fn of card.listeners.click ?? []) fn({});
    expect(btn(root(), "Insert")).toBeUndefined();
    expect(cardsIn(root())).toHaveLength(3);
  });
});

describe("Library page", () => {
  const count = () => main().all("span").find((s) => s.getAttribute("class") === "muted" && /blocks?$/.test(s.textContent))!.textContent;
  const open = async (list: any[] = [A, B]) => {
    api.blocks = vi.fn(async () => list);
    await lib.renderLibrary(main());
  };
  const type = (q: string) => { const i = input(main()); i.value = q; i.fire("input"); };

  it("counts, filters and shows the YAML", async () => {
    await open();
    expect(count()).toBe("2 blocks");
    expect(items()).toHaveLength(2);
    expect(items()[0]!.all("pre")[0]!.textContent).toBe("name: alpha");
    type("beta");
    expect(count()).toBe("1 of 2 blocks");
    expect(items()).toHaveLength(1);
  });

  it("says when nothing matches, and Clear filters restores the cards", async () => {
    await open();
    type("zzz");
    expect(main().textContent).toContain("No blocks match.");
    expect(items()).toHaveLength(0);
    clickIn(main(), "Clear filters");
    expect(items()).toHaveLength(2);
    expect(input(main()).value).toBe("");
  });

  it("filters by category", async () => {
    await open();
    const sel = select(main());
    sel.value = "Git";
    sel.fire("change");
    expect(items()).toHaveLength(1);
  });

  it("has no search box for an empty library", async () => {
    await open([]);
    expect(main().textContent).toContain("No blocks yet.");
    expect(main().all("input")).toHaveLength(0);
  });

  it("keeps Delete for your own blocks only, and keeps the search after a delete", async () => {
    await open();
    expect(btn(items()[0]!, "Delete")).toBeUndefined();
    type("beta");
    clickIn(items()[0]!, "Delete");
    expect(root().textContent).toContain("Delete block?");
    clickIn(root(), "Delete");
    await vi.waitFor(() => expect(api.blocks).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(input(main())?.value).toBe("beta"));
    expect(items()).toHaveLength(1);
  });
});
