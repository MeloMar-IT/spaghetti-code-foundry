import { readFileSync } from "node:fs";
import * as YAML from "yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let state: any;
let shell: any;
let real: Record<string, any>;
beforeAll(async () => {
  restore = installFakeDom();
  state = await import("../ui/flow-state.js" as string);
  shell = await import("../ui/flow-shell.js" as string);
  real = {
    dom: await import("../ui/dom.js" as string),
    ia: await import("../ui/ia.js" as string),
    problems: await import("../ui/flow-problems.js" as string),
    states: await import("../ui/states.js" as string),
  };
});
afterAll(() => restore());

const g = globalThis as any;
const text = (el: FakeElement) => el.textContent;
const buttons = (el: FakeElement) => el.all("button");
const byText = (el: FakeElement, t: string) => buttons(el).find((b) => text(b) === t);
const withClass = (el: FakeElement, tag: string, cls: string) => el.all(tag).filter((e) => (e.getAttribute("class") ?? "").split(" ").includes(cls));
const mountAll = (nodes: FakeElement[]) => { const root = new FakeElement("div"); root.append(...nodes); return root; };

const clean = (over: object = {}) => ({ name: "a", scope: "repo", saveScope: "repo", obj: { name: "a" }, dirty: false, validation: { ok: true }, problems: [], checking: false, ...over });

describe("editorState", () => {
  it("a new flow is unsaved and primary is save", () => {
    const st = state.editorState({ name: null, scope: null, saveScope: "repo", obj: { name: "x" }, dirty: true, validation: null }, []);
    expect(st).toMatchObject({ title: "x", scopeLabel: "not saved yet", dirtyLabel: "Unsaved changes", saveLabel: "Saves to this repo", primary: "save" });
  });

  it("a clean flow is saved, valid, and primary is run", () => {
    const st = state.editorState(clean(), []);
    expect(st).toMatchObject({ scopeLabel: "repo", dirtyLabel: "Saved", primary: "run", validation: { kind: "valid", label: "Valid" } });
  });

  it("a dirty flow has save as primary", () => {
    const st = state.editorState(clean({ dirty: true }), []);
    expect(st.dirtyLabel).toBe("Unsaved changes");
    expect(st.primary).toBe("save");
  });

  it("a built-in flow says it saves your own copy", () => {
    expect(state.editorState(clean({ scope: "builtin" }), []).saveLabel).toBe("Saves your own copy to this repo");
    const st = state.editorState(clean({ scope: "builtin", saveScope: "global" }), []);
    expect(st.scopeLabel).toBe("builtin");
    expect(st.saveLabel).toBe("Saves your own copy to global flows");
    expect(state.editorState(clean({ saveScope: "global" }), []).saveLabel).toBe("Saves to global flows");
  });

  it("counts problems", () => {
    const bad = (problems: unknown[] | undefined) => state.editorState(clean({ validation: { ok: false }, problems }), []).validation;
    expect(bad([{}])).toEqual({ kind: "problems", label: "1 problem" });
    expect(bad([{}, {}, {}])).toEqual({ kind: "problems", label: "3 problems" });
    expect(bad(undefined)).toEqual({ kind: "problems", label: "1 problem" });
  });

  it("says Checking… without an answer or while a check runs", () => {
    expect(state.editorState(clean({ validation: null }), []).validation).toEqual({ kind: "checking", label: "Checking…" });
    expect(state.editorState(clean({ checking: true }), []).validation.kind).toBe("checking");
  });

  it("falls back for the title and the scope", () => {
    expect(state.editorState(clean({ obj: { name: 5 } }), []).title).toBe("a");
    expect(state.editorState(clean({ obj: null, name: null }), []).title).toBe("flow");
    expect(state.editorState(clean({ scope: undefined }), [{ name: "a", scope: "global" }]).scopeLabel).toBe("global");
  });
});

describe("renderHeader", () => {
  const handlers = () => ({ onMode: vi.fn(), onSave: vi.fn(), onRun: vi.fn(), onOverview: vi.fn(), onProblems: vi.fn(), onAsk: vi.fn(), onScope: vi.fn(), onDelete: vi.fn() });
  const draw = (cur: object, over: object = {}) => {
    const h = handlers();
    const st = state.editorState(cur, []);
    const root = mountAll(shell.renderHeader(st, { mode: "visual", overviewOpen: false, saveScope: "repo", canDelete: false, ...h, ...over }));
    return { root, h, st };
  };
  const cases: Array<[string, object, string]> = [
    ["new", { name: null, obj: { name: "n" }, dirty: true, validation: null }, "Save"],
    ["clean", clean(), "Test run"],
    ["dirty", clean({ dirty: true }), "Save"],
    ["invalid", clean({ validation: { ok: false }, problems: [{}], dirty: false }), "Test run"],
  ];

  it.each(cases)("%s: exactly one primary button", (_n, cur, label) => {
    const { root } = draw(cur);
    const primary = withClass(root, "button", "primary");
    expect(primary.map(text)).toEqual([label]);
    const other = label === "Save" ? "Test run" : "Save";
    expect(byText(root, other)).toBeDefined();
  });

  it.each(["visual", "yaml"])("shows the four things in %s mode", (mode) => {
    const { root } = draw(clean({ dirty: true, validation: { ok: false }, problems: [{}, {}] }), { mode });
    const t = text(root);
    for (const s of ["a", "repo", "Unsaved changes", "2 problems", "Saves to this repo"]) expect(t).toContain(s);
    expect(withClass(root, "button", "on").map(text)).toEqual([mode === "visual" ? "Visual" : "YAML"]);
  });

  it("keeps Ask Claude, Save to and Delete in the More menu, and the mode switch outside", () => {
    const { root } = draw(clean(), { canDelete: true });
    const details = root.all("details")[0]!;
    expect(text(details)).toContain("Ask Claude");
    expect(details.all("select")).toHaveLength(1);
    expect(byText(details, "Delete flow")).toBeDefined();
    expect(details.all("button").map(text)).not.toContain("Visual");
    expect(draw(clean()).root.all("details")[0]!.all("button").map(text)).not.toContain("Delete flow");
    expect(byText(root, "Visual")).toBeDefined();
  });

  it("calls the handlers", () => {
    const { root, h } = draw(clean({ validation: { ok: false }, problems: [{}] }), { overviewOpen: true });
    byText(root, "1 problem")!.click();
    expect(h.onProblems).toHaveBeenCalled();
    const toggle = byText(root, "Overview")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(h.onOverview).toHaveBeenCalled();
    byText(root, "YAML")!.click();
    expect(h.onMode).toHaveBeenCalledWith("yaml");
    byText(root, "✨ Ask Claude")!.click();
    expect(h.onAsk).toHaveBeenCalled();
    expect(draw(clean()).root.all("button").find((b) => text(b) === "Overview")!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("filterFlows and renderNavigator", () => {
  const flows = [
    { name: "alpha", description: "Builds things", scope: "repo", published: true },
    { name: "beta", scope: "global" },
    { name: "gamma", description: "Broken", scope: "repo", error: "bad" },
  ];
  const nav = (over: object = {}) => mountAll(shell.renderNavigator({ flows, current: null, query: "", onQuery: vi.fn(), onDraft: vi.fn(), onBlank: vi.fn(), ...over }));

  it("filters by name and description, any case, ignoring spaces", () => {
    expect(state.filterFlows(flows, "ALP").map((f: any) => f.name)).toEqual(["alpha"]);
    expect(state.filterFlows(flows, "  builds ").map((f: any) => f.name)).toEqual(["alpha"]);
    expect(state.filterFlows(flows, "")).toEqual(flows);
    expect(state.filterFlows(flows, "beta").map((f: any) => f.name)).toEqual(["beta"]);
    expect(state.filterFlows(flows, "zzz")).toEqual([]);
  });

  it("starts with the two buttons, then the search box", () => {
    const root = nav();
    expect(root.children[0]).toBeInstanceOf(FakeElement);
    expect(buttons(root.children[0] as FakeElement).map(text)).toEqual(["✨ Draft flow with Claude", "+ Blank flow"]);
    const search = root.all("input")[0]!;
    expect(search.getAttribute("aria-label")).toBe("Search flows");
  });

  it("marks published, dirty, active and invalid flows", () => {
    const root = nav({ current: { name: "alpha", dirty: true } });
    const t = text(root);
    expect(t).toContain("published");
    expect(t).toContain(" •");
    expect(t).toContain("invalid flow");
    expect(withClass(root, "li", "bad")).toHaveLength(1);
    expect(withClass(root, "a", "active")).toHaveLength(1);
  });

  it("keeps the open flow listed and says when nothing matches", () => {
    const root = nav({ current: { name: "alpha", dirty: false }, query: "beta" });
    expect(root.all("a").map((a) => a.getAttribute("href"))).toEqual(["#/flows/alpha", "#/flows/beta"]);
    const none = nav({ query: "zzz" });
    expect(text(none)).toContain("No flow matches.");
    expect(text(nav())).not.toContain("No flow matches.");
  });

  it("makes Draft primary only without a current flow", () => {
    expect(withClass(nav(), "button", "primary").map(text)).toEqual(["✨ Draft flow with Claude"]);
    expect(withClass(nav({ current: { name: "alpha" } }), "button", "primary")).toEqual([]);
  });

  it("shows the unsaved new flow row and reports typing", () => {
    const onQuery = vi.fn();
    const root = nav({ current: { name: null, obj: { name: "n" } }, onQuery });
    expect(text(root)).toContain("unsaved");
    root.all("input")[0]!.fire("input", { target: { value: "x" } });
    expect(onQuery).toHaveBeenCalledWith("x");
  });
});

describe("the overview choice", () => {
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  const throwing = { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } };

  it("starts open only when the person chose open", () => {
    expect(state.overviewStartsOpen({ stored: "open" })).toBe(true);
    expect(state.overviewStartsOpen({ stored: "closed" })).toBe(false);
    expect(state.overviewStartsOpen({ stored: null })).toBe(false);
  });

  it("round-trips open and closed", () => {
    const mem = memory();
    const s = state.overviewStore(mem);
    expect(s.get()).toBeNull();
    s.set(true);
    expect(s.get()).toBe("open");
    s.set(false);
    expect(s.get()).toBe("closed");
  });

  it("survives a store that throws, no store and a garbage value", () => {
    const s = state.overviewStore(throwing);
    expect(s.get()).toBeNull();
    expect(() => s.set(true)).not.toThrow();
    expect(state.overviewStore(undefined).get()).toBeNull();
    expect(() => state.overviewStore(undefined).set(true)).not.toThrow();
    const mem = memory();
    mem.setItem("scf-overview", "maybe");
    expect(state.overviewStore(mem).get()).toBeNull();
  });

  it("keeps the wide and the narrow choice apart", () => {
    const mem = memory();
    state.overviewStoreFor(mem, true).set(true);
    expect(state.overviewStoreFor(mem, true).get()).toBe("open");
    expect(state.overviewStoreFor(mem, false).get()).toBeNull();
  });
});

describe("the flow page controller", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const YAML_TEXT = "name: a\nsteps:\n  - id: s\n    type: shell\n    run: x\n";
  let mainEl: FakeElement;
  let sideEl: FakeElement;
  let toast: any;
  let editorOpts: any;
  let graphOpts: any;
  let drawn: number;

  function load() {
    const deps: Record<string, any> = {
      "/vendor/yaml/index.js": { default: YAML },
      "./dom.js": { ...real.dom, toast },
      "./editor.js": {
        cleanFlow: (x: unknown) => x,
        editable: (v: unknown) => !!v && typeof v === "object",
        renderEditor: (_o: unknown, opts: unknown) => { editorOpts = opts; return real.dom.h("div", {}, "form"); },
      },
      "./flow-state.js": state,
      "./flow-shell.js": shell,
      "./flow-problems.js": real.problems,
      "./states.js": real.states,
      "./ia.js": real.ia,
      "./graph.js": { renderGraph: (_o: unknown, opts: unknown) => { graphOpts = opts; drawn++; return real.dom.h("div", {}, "graph"); } },
      "./library.js": { insertBlock: vi.fn(), pickBlock: vi.fn(), saveStepAsBlock: vi.fn() },
    };
    const src = readFileSync("ui/flow-page.js", "utf8")
      .replace(/^import (\w+) from "([^"]+)";$/gm, (_m, x, s) => `const ${x} = __deps[${JSON.stringify(s)}].default;`)
      .replace(/^import \{([^}]+)\} from "([^"]+)";$/gm, (_m, names, s) => `const {${names}} = __deps[${JSON.stringify(s)}];`)
      .replace("export function createFlowPage", "function createFlowPage");
    if (/^import /m.test(src)) throw new Error("an import form is not supported");
    return new AsyncFunction("__deps", `"use strict";\n${src}\nreturn createFlowPage;`)(deps) as Promise<any>;
  }

  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const apiFor = (over: Record<string, any> = {}) => ({
    flows: vi.fn(async () => [{ name: "a", scope: "repo" }]),
    flow: vi.fn(async (name: string) => ({ name, scope: "repo", yaml: YAML_TEXT })),
    validate: vi.fn(async () => ({ ok: true, flow: { name: "a", vars: {} } })),
    saveFlow: vi.fn(async () => ({})),
    deleteFlow: vi.fn(async () => ({})),
    ...over,
  });
  async function open(opts: { storage?: any; narrow?: boolean; api?: any; cur?: any } = {}) {
    const createFlowPage = await load();
    const s: any = { info: { repo: "r" }, flows: [{ name: "a", scope: "repo" }], flowsLoaded: true, cur: opts.cur ?? null };
    const onNavigate = vi.fn();
    const api = opts.api ?? apiFor();
    const page = createFlowPage({ main: mainEl, sidebar: sideEl, state: s, api, onNavigate, storage: opts.storage, isNarrow: () => !!opts.narrow });
    await page.openFlow("a");
    await tick();
    return { page, s, onNavigate, api };
  }
  const pane = () => mainEl.all("div").find((d) => d.getAttribute("id") === "flow-overview")!;
  const toggle = () => byText(mainEl, "Overview")!;

  beforeEach(() => {
    mainEl = new FakeElement("main");
    sideEl = new FakeElement("aside");
    toast = vi.fn();
    drawn = 0;
    g.location = { hash: "#/flows/a" };
    g.confirm = vi.fn(() => true);
    g.document.querySelectorAll = () => [];
    (FakeElement.prototype as any).scrollIntoView = vi.fn();
    g.document.activeElement = null;
  });

  it("opens with the overview closed, draws the state line, and opens it on request", async () => {
    const storage = memory();
    await open({ storage });
    expect(pane().hidden).toBe(true);
    expect(drawn).toBe(0);
    expect(text(mainEl)).toContain("Saved");
    expect(text(mainEl)).toContain("Valid");
    expect(byText(mainEl, "Test run")!.getAttribute("class")).toBe("primary");
    toggle().click();
    expect(pane().hidden).toBe(false);
    expect(drawn).toBeGreaterThan(0);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(storage.m.get("scf-overview")).toBe("open");
  });

  it("remembers the choice, also on a narrow window, and works when storage throws", async () => {
    const storage = memory();
    await open({ storage });
    toggle().click();
    await open({ storage });
    expect(pane().hidden).toBe(false);
    // The narrow window has its own choice: closed to start with, and remembered once changed.
    await open({ storage, narrow: true });
    expect(pane().hidden).toBe(true);
    toggle().click();
    expect(storage.m.get("scf-overview-narrow")).toBe("open");
    await open({ storage, narrow: true });
    expect(pane().hidden).toBe(false);
    const throwing = { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } };
    await open({ storage: throwing });
    expect(() => toggle().click()).not.toThrow();
    expect(pane().hidden).toBe(false);
  });

  it("selects the step when a graph node is clicked", async () => {
    const { s } = await open({ storage: memory() });
    toggle().click();
    graphOpts.onSelect(0);
    expect(s.cur.selected).toBe(0);
  });

  it("marks the open flow as unsaved in the list and makes Save primary after an edit", async () => {
    await open({ storage: memory() });
    expect(text(sideEl)).not.toContain(" •");
    editorOpts.onChange();
    expect(text(sideEl)).toContain(" •");
    expect(text(mainEl)).toContain("Unsaved changes");
    expect(byText(mainEl, "Save")!.getAttribute("class")).toBe("primary");
    expect(text(mainEl)).toContain("Checking…");
    await vi.waitFor(() => expect(text(mainEl)).toContain("Valid"));
  });

  it("moves the focus to the first problem when the validation button is clicked", async () => {
    const api = apiFor({ validate: vi.fn(async () => ({ ok: false, issues: [{ path: ["steps", 0, "run"], message: "bad" }] })) });
    await open({ storage: memory(), api });
    const button = byText(mainEl, "1 problem")!;
    button.click();
    const link = withClass(mainEl, "button", "problem-link")[0]!;
    expect(g.document.activeElement).toBe(link);
  });

  it("does nothing when the flow is valid", async () => {
    await open({ storage: memory() });
    byText(mainEl, "Valid")!.click();
    expect(g.document.activeElement).toBeNull();
  });

  it("keeps the flow and its edits when deleting fails, and leaves when it works", async () => {
    const fail = apiFor({ deleteFlow: vi.fn(async () => { throw new Error("no way"); }) });
    const first = await open({ storage: memory(), api: fail });
    editorOpts.onChange();
    byText(mainEl, "Delete flow")!.click();
    await tick();
    expect(toast).toHaveBeenCalledWith("no way", "error");
    expect(first.s.cur).not.toBeNull();
    expect(first.s.cur.dirty).toBe(true);
    expect(first.onNavigate).not.toHaveBeenCalled();

    const ok = await open({ storage: memory() });
    byText(mainEl, "Delete flow")!.click();
    await vi.waitFor(() => expect(ok.onNavigate).toHaveBeenCalledWith("#/flows", "go"));
    expect(ok.s.cur).toBeNull();
  });

  it("does not delete when the person says no", async () => {
    const { api } = await open({ storage: memory() });
    g.confirm = vi.fn(() => false);
    byText(mainEl, "Delete flow")!.click();
    await tick();
    expect(api.deleteFlow).not.toHaveBeenCalled();
  });

  it("shows and runs the winning repo copy after saving different text to global", async () => {
    const REPO_YAML = "name: a\nsteps:\n  - id: s\n    type: shell\n    run: from-repo\n";
    let saved = false;
    const api = apiFor({
      flow: vi.fn(async (name: string) => ({ name, scope: "repo", yaml: saved ? REPO_YAML : YAML_TEXT })),
      saveFlow: vi.fn(async () => { saved = true; return {}; }),
    });
    const { page, s } = await open({ storage: memory(), api });
    s.cur.saveScope = "global";
    s.cur.yaml = YAML_TEXT.replace("run: x", "run: from-global");
    s.cur.dirty = true;
    await page.save();
    expect(s.cur.yaml).toBe(REPO_YAML);
    expect(s.cur.dirty).toBe(false);
  });

  it("reads the overview choice again when the width changes", async () => {
    const storage = memory();
    storage.m.set("scf-overview", "open");
    let narrow = false;
    let change: () => void = () => {};
    const createFlowPage = await load();
    const s: any = { info: { repo: "r" }, flows: [{ name: "a", scope: "repo" }], flowsLoaded: true, cur: null };
    const page = createFlowPage({ main: mainEl, sidebar: sideEl, state: s, api: apiFor(), onNavigate: vi.fn(), storage, isNarrow: () => narrow, watchNarrow: (fn: () => void) => { change = fn; } });
    await page.openFlow("a");
    await tick();
    expect(pane().hidden).toBe(false);
    narrow = true;
    change();
    expect(pane().hidden).toBe(true);
    narrow = false;
    change();
    expect(pane().hidden).toBe(false);
    // Entering the editor again at the other width reads that width's choice too.
    narrow = true;
    s.cur = null;
    await page.openFlow("a");
    expect(pane().hidden).toBe(true);
  });

  it("shows the scope that wins after saving a repo flow to global", async () => {
    const { page, s, api, onNavigate } = await open({ storage: memory() });
    s.cur.saveScope = "global";
    s.cur.dirty = true;
    await page.save();
    expect(api.saveFlow).toHaveBeenCalledWith("a", YAML_TEXT, "global");
    expect(onNavigate).toHaveBeenCalledWith("#/flows/a", "replace");
    expect(s.cur.scope).toBe("repo"); // the repo copy still wins in the list
    expect(toast.mock.calls.at(-1)[0]).toContain("still wins");
    expect(text(mainEl)).toContain("Saved");
  });

  it("saves a global flow to the repo and a built-in as a copy", async () => {
    const api = apiFor({ flows: vi.fn(async () => [{ name: "a", scope: "repo" }]) });
    const g1 = await open({ storage: memory(), api, cur: null });
    g1.s.cur.scope = "global";
    g1.s.cur.saveScope = "repo";
    g1.s.cur.dirty = true;
    await g1.page.save();
    expect(g1.s.cur.scope).toBe("repo");
    expect(toast.mock.calls.at(-1)[0]).toBe("Saved a");

    const built = apiFor({ flow: vi.fn(async (name: string) => ({ name, scope: "builtin", yaml: YAML_TEXT })), flows: vi.fn(async () => [{ name: "a", scope: "repo" }]) });
    const b = await open({ storage: memory(), api: built });
    expect(text(mainEl)).toContain("Saves your own copy to this repo");
    b.s.cur.dirty = true;
    await b.page.save();
    expect(built.saveFlow).toHaveBeenCalledWith("a", YAML_TEXT, "repo");
    expect(b.s.cur.scope).toBe("repo");
    expect(byText(mainEl, "Delete flow")).toBeDefined();
  });

  it("keeps the draft and its Save button for a new flow", async () => {
    const createFlowPage = await load();
    const s: any = { info: { repo: "r" }, flows: [], flowsLoaded: true, cur: null };
    const onNavigate = vi.fn();
    const page = createFlowPage({ main: mainEl, sidebar: sideEl, state: s, api: apiFor(), onNavigate, storage: memory(), isNarrow: () => false });
    g.location.hash = "#/new";
    page.openNew();
    expect(onNavigate).toHaveBeenCalledWith("#/new", "push");
    expect(text(mainEl)).toContain("not saved yet");
    expect(byText(mainEl, "Save")!.getAttribute("class")).toBe("primary");
    expect(text(sideEl)).toContain("unsaved");
  });
});

describe("the source", () => {
  it("flow-page.js exports createFlowPage and draws the header", () => {
    const src = readFileSync("ui/flow-page.js", "utf8");
    expect(src).toContain("export function createFlowPage");
    expect(src).toContain("drawHeader");
  });

  it("app.js uses the flow page and no longer holds the editor", () => {
    const src = readFileSync("ui/app.js", "utf8");
    expect(src).not.toContain("renderEditor(");
    expect(src).toContain("createFlowPage({ main, sidebar, state: S, api, onNavigate");
  });
});
