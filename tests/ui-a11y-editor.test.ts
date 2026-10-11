import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { audit } from "./helpers/a11y.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let fields: any, editor: any, graph: any, library: any, runForm: any, start: any, dom: any;
beforeAll(async () => {
  restore = installFakeDom();
  fields = await import("../ui/fields.js" as string);
  editor = await import("../ui/editor.js" as string);
  graph = await import("../ui/graph.js" as string);
  library = await import("../ui/library.js" as string);
  runForm = await import("../ui/run-form.js" as string);
  start = await import("../ui/user/start.js" as string);
  dom = await import("../ui/dom.js" as string);
});
afterAll(() => restore());
beforeEach(() => {
  (document as any).activeElement = null;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const el = (tag = "div") => document.createElement(tag) as unknown as FakeElement;
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((e) => Object.entries(attrs).every(([k, v]) => e.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [e] = find(root, tag, attrs);
  if (!e) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return e;
};

describe("fields", () => {
  it("label sets aria-label on text, area, select and list, and is absent otherwise", () => {
    const o: any = {};
    const f = () => {};
    expect(fields.text(o, "a", f, { label: "A" }).attrs["aria-label"]).toBe("A");
    expect(fields.area(o, "a", f, { label: "B" }).attrs["aria-label"]).toBe("B");
    expect(fields.select(o, "a", [["x", "X"]], f, { label: "C" }).attrs["aria-label"]).toBe("C");
    expect(fields.list(o, "a", f, "ph", { label: "D" }).attrs["aria-label"]).toBe("D");
    expect("aria-label" in fields.text(o, "a", f).attrs).toBe(false);
    expect("aria-label" in fields.area(o, "a", f).attrs).toBe(false);
    expect("aria-label" in fields.select(o, "a", [], f).attrs).toBe(false);
    expect("aria-label" in fields.list(o, "a", f, "ph").attrs).toBe(false);
  });

  it("list still takes the placeholder as its fourth argument", () => {
    expect(fields.list({}, "a", () => {}, "Read, Edit").attrs.placeholder).toBe("Read, Edit");
  });

  it("field wraps in a label and links the hint with aria-describedby", () => {
    const input = el("input");
    const f = fields.field("L", input, "hint");
    expect(f.tag).toBe("label");
    const small = one(f, "small");
    expect(input.attrs["aria-describedby"]).toBe(small.attrs.id);
    expect(small.textContent).toBe("hint");
    const other = el("input");
    fields.field("M", other, "hint 2");
    expect(other.attrs["aria-describedby"]).not.toBe(input.attrs["aria-describedby"]);
  });

  it("field without a hint adds no aria-describedby, and keeps an existing one", () => {
    const input = el("input");
    fields.field("L", input);
    expect("aria-describedby" in input.attrs).toBe(false);
    const own = el("input");
    own.setAttribute("aria-describedby", "mine");
    const f = fields.field("L", own, "hint");
    expect(own.attrs["aria-describedby"]).toBe(`mine ${one(f, "small").attrs.id}`);
  });

  it("group is a named role=group, not a label", () => {
    const g = fields.group("Steps", el("div"), "hint");
    expect(g.tag).toBe("div");
    expect(g.attrs.role).toBe("group");
    const span = one(g, "span");
    expect(g.attrs["aria-labelledby"]).toBe(span.attrs.id);
    expect(g.attrs["aria-describedby"]).toBe(one(g, "small").attrs.id);
    expect("aria-describedby" in fields.group("S", el("div")).attrs).toBe(false);
  });

  it("markInvalid keeps other descriptions and clearInvalid restores them", () => {
    const input = el("input");
    input.setAttribute("aria-describedby", "hint-1");
    fields.markInvalid(input, "err");
    fields.markInvalid(input, "err");
    expect(input.attrs["aria-invalid"]).toBe("true");
    expect(input.attrs["aria-describedby"]).toBe("hint-1 err");
    fields.clearInvalid(input, "err");
    expect("aria-invalid" in input.attrs).toBe(false);
    expect(input.attrs["aria-describedby"]).toBe("hint-1");
    const bare = el("input");
    fields.markInvalid(bare, "err");
    fields.clearInvalid(bare, "err");
    expect("aria-describedby" in bare.attrs).toBe(false);
  });
});

const editorFlow = () => ({
  name: "f",
  vars: { a: "1", b: "2" },
  publish: { enabled: true, vars: { a: { mode: "input", default: "x", required: true } } },
  steps: [
    { id: "c", type: "claude", prompt: "p" },
    { id: "s", type: "shell", run: "ls", routes: [{ if: "x", goto: "c" }] },
    { id: "ap", type: "approval", message: "ok?" },
    { id: "p", type: "parallel", steps: ["s"] },
    { id: "f", type: "flow", flow: "other", vars: { k: "v" } },
  ],
});
const ctx = () => ({ onChange: vi.fn(), rerender: vi.fn(), selected: 0, onSelect: vi.fn() });

/** The editor draws one item at a time: the flow settings, then each step. */
const drawAll = (flow: any = editorFlow()) =>
  ["settings", ...flow.steps.map((_: unknown, i: number) => i)].map((selected) => editor.renderEditor(flow, { ...ctx(), selected }));
const holder = (roots: FakeElement[]) => {
  const box = el("div");
  box.append(...roots);
  return box;
};

describe("flow editor", () => {
  it("has no audit violations with one step of each type", () => {
    for (const root of drawAll()) expect(audit(root)).toEqual([]);
  });

  it("names variable, step, route and sub-flow variable fields by row", () => {
    const root = holder(drawAll());
    for (const name of ["Variable 1 name", "Variable 2 value", "Step 1 id", "Step 5 id", "Route 1 pattern", "Route 1 target", "Sub-flow variable 1 name", "Sub-flow variable 1 value", "More step types", "Default value for a", "How a shows to users"]) {
      expect(find(root, "input", { "aria-label": name }).length + find(root, "select", { "aria-label": name }).length, name).toBeGreaterThan(0);
    }
  });

  it("does not nest a label in a label (the parallel block is a group)", () => {
    const root = holder(drawAll());
    for (const l of root.all("label")) expect(l.all("label")).toHaveLength(0);
    expect(find(root, "div", { role: "group" }).length).toBeGreaterThan(0);
  });

  it("still writes a variable value into the flow", () => {
    const flow = editorFlow();
    const root = editor.renderEditor(flow, { ...ctx(), selected: "settings" });
    const input = one(root, "input", { "aria-label": "Variable 2 value" });
    input.value = "changed";
    input.fire("input", { target: input });
    expect((flow.vars as any).b).toBe("changed");
  });
});

describe("flow graph", () => {
  const steps = () => editorFlow();
  const nodes = (root: FakeElement) => find(root, "g", { role: "button" });

  it("has no audit violations and a labelled svg group", () => {
    const root = graph.renderGraph(steps(), { selected: 1, onSelect: () => {} });
    expect(audit(root)).toEqual([]);
    const svg = one(root, "svg");
    expect(svg.attrs.role).toBe("group");
    expect(svg.attrs["aria-label"]).toBeTruthy();
  });

  it("makes each node a focusable button with a name and pressed state", () => {
    const root = graph.renderGraph(steps(), { selected: 1, onSelect: () => {} });
    const list = nodes(root);
    expect(list).toHaveLength(5);
    expect(list[1]!.attrs["aria-label"]).toBe("Step 2: s, shell");
    expect(list[1]!.attrs.tabindex).toBe("0");
    expect(list.map((n) => n.attrs["aria-pressed"])).toEqual(["false", "true", "false", "false", "false"]);
    expect(one(list[0]!, "tspan").attrs["aria-hidden"]).toBe("true");
  });

  it("selects with Enter, Space and click, and ignores other keys", () => {
    const onSelect = vi.fn();
    const root = graph.renderGraph(steps(), { selected: 0, onSelect });
    const node = nodes(root)[2]!;
    const preventDefault = vi.fn();
    node.fire("keydown", { key: "Enter", preventDefault });
    node.fire("keydown", { key: " ", preventDefault });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    node.fire("keydown", { key: "a", preventDefault });
    expect(onSelect).toHaveBeenCalledTimes(2);
    node.click();
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("keeps the focus on the same node when a selection redraws the graph", () => {
    const main = el("div");
    const flow = steps();
    const draw = (selected: number) => dom.mount(main, graph.renderGraph(flow, { selected, onSelect: (i: number) => draw(i) }));
    draw(0);
    const before = nodes(main)[1]!;
    before.focus();
    before.fire("keydown", { key: "Enter", preventDefault() {} });
    const after = nodes(main)[1]!;
    expect(after).not.toBe(before);
    expect((document as any).activeElement).toBe(after);
    expect(after.attrs["aria-pressed"]).toBe("true");
    expect(nodes(main)[0]!.attrs["aria-pressed"]).toBe("false");
    after.fire("keydown", { key: " ", preventDefault() {} });
    expect((document as any).activeElement).toBe(nodes(main)[1]);
  });

  it("still says so when there are no steps", () => {
    expect(graph.renderGraph({ steps: [] }).textContent).toBe("No steps yet");
  });
});

describe("library", () => {
  const blocks = [
    { id: "lint", scope: "builtin", yaml: "name: Lint", block: { name: "Lint", category: "Checks", description: "d", steps: [{ id: "lint", type: "shell" }] } },
    { id: "mine", scope: "repo", yaml: "name: Mine", block: { name: "Mine", category: "Custom", description: "m", steps: [{ id: "m", type: "claude" }] } },
  ];
  const a = { blocks: async () => blocks, saveBlock: async () => ({}), deleteBlock: async () => ({}) };

  it("renders the page without violations", async () => {
    const main = el("div");
    await library.renderLibrary(main, { a });
    expect(audit(main)).toEqual([]);
  });

  it("names the search box of the picker and has no violations", async () => {
    void library.pickBlock({ steps: [], vars: {} }, { a });
    await flush();
    const root = document.getElementById("modal-root") as unknown as FakeElement;
    expect(one(root, "input", { "aria-label": "Search blocks" })).toBeTruthy();
    expect(audit(root)).toEqual([]);
  });

  it("has no violations in the save-as-block dialog, and its error is an alert", async () => {
    void library.saveStepAsBlock({ vars: {} }, { id: "my_step", type: "shell", run: "ls" }, { a });
    await flush();
    const root = document.getElementById("modal-root") as unknown as FakeElement;
    expect(audit(root)).toEqual([]);
    expect(one(root, "p", { role: "alert" })).toBeTruthy();
  });
});

describe("run form", () => {
  const make = (over: { dirty?: boolean; name?: string | null } = {}) => {
    const startRun = vi.fn(async () => ({ runId: "r1" }));
    const close = vi.fn();
    const cur = { yaml: "{{task}}", dirty: false, name: "f", ...over };
    const root = runForm.runForm({
      flow: { name: "f", workspace: "worktree", vars: { x: "1" } }, yaml: cur.yaml, cur, repo: "/r", close, a: { startRun },
    }) as FakeElement;
    return { root, startRun, close, cur };
  };
  const startBtn = (root: FakeElement) => find(root, "button").find((b) => b.textContent.includes("Start run"))!;

  it("has no audit violations", () => {
    expect(audit(make().root)).toEqual([]);
  });

  it("sends the flow name, or the yaml when it has unsaved edits", async () => {
    const a = make();
    one(a.root, "textarea").value = "do it";
    startBtn(a.root).click();
    await flush();
    expect(a.startRun).toHaveBeenCalledWith({ task: "do it", repo: "/r", vars: { x: "1" }, flow: "f" });
    expect(a.close).toHaveBeenCalledWith("r1");
    const b = make({ dirty: true });
    one(b.root, "textarea").value = "do it";
    startBtn(b.root).click();
    await flush();
    expect(b.startRun).toHaveBeenCalledWith({ task: "do it", repo: "/r", vars: { x: "1" }, yaml: "{{task}}" });
  });

  it("reads the editor state when Start is clicked, so a save while the dialog is open counts", async () => {
    const a = make({ dirty: true, name: null });
    one(a.root, "textarea").value = "do it";
    // the editor saves the flow under a name: same object, dirty off
    Object.assign(a.cur, { name: "saved", dirty: false });
    startBtn(a.root).click();
    await flush();
    expect(a.startRun).toHaveBeenCalledWith({ task: "do it", repo: "/r", vars: { x: "1" }, flow: "saved" });
  });

  it("shows a failure in the alert and turns the button on again", async () => {
    const a = make();
    a.startRun.mockRejectedValueOnce(new Error("nope"));
    one(a.root, "textarea").value = "do it";
    startBtn(a.root).click();
    await flush();
    expect(one(a.root, "div", { role: "alert" }).textContent).toContain("nope");
    expect(startBtn(a.root).disabled).toBe(false);
  });

  it("starts with Ctrl+Enter and Cmd+Enter in the task, not with Enter alone", async () => {
    for (const [mods, sent] of [[{}, 0], [{ ctrlKey: true }, 1], [{ metaKey: true }, 1]] as const) {
      const a = make();
      const task = one(a.root, "textarea");
      task.value = "do it";
      task.fire("keydown", { key: "Enter", ...mods });
      await flush();
      expect(a.startRun).toHaveBeenCalledTimes(sent);
    }
  });
});

describe("Start work", () => {
  const field = (name: string, over: object = {}) => ({ name, mode: "input", label: name, value: "", required: false, ...over });
  const flows = [{ name: "a", title: "A", description: "d", version: 1, usesTask: true, fields: [field("github_repo", { required: true, help: "Pick" }), field("branch", { required: true, help: "Name" })] }];
  const startRun = vi.fn(async () => ({ runId: "r1" }));
  const api = (repos: unknown[]) => ({
    flows: async () => flows,
    repos: async () => repos,
    repoMethods: async () => ({ methods: [], githubApp: { available: false } }),
    startRun,
  });
  const repos = [{ id: "1", url: "https://github.com/o/r", method: "none", owner: "u", github: "o/r" }];

  it("has no audit violations for both displays", async () => {
    for (const admin of [false, true]) {
      const main = el("div");
      await start.renderStart(main, { a: api(repos), admin, go: () => {} });
      expect(audit(main)).toEqual([]);
    }
  });

  it("marks the first empty required field, links the alert and focuses it", async () => {
    const main = el("div");
    await start.renderStart(main, { a: api(repos), go: () => {} });
    one(main, "form").fire("submit", { preventDefault() {} });
    await flush();
    const input = one(main, "input", { name: "branch" });
    const alert = one(main, "p", { role: "alert" });
    expect(input.attrs["aria-invalid"]).toBe("true");
    expect(input.attrs["aria-describedby"]).toContain(alert.attrs.id);
    expect(alert.textContent).toBe('Fill in "branch".');
    expect((document as any).activeElement).toBe(input);
    expect(audit(main)).toEqual([]);
  });

  it("marks the repository group when there is no repository", async () => {
    const main = el("div");
    await start.renderStart(main, { a: api([]), go: () => {} });
    one(main, "form").fire("submit", { preventDefault() {} });
    await flush();
    const group = one(main, "div", { role: "group", "aria-label": "Repository" });
    expect(group.attrs["aria-invalid"]).toBe("true");
    expect((document as any).activeElement).toBe(group);
    expect(audit(main)).toEqual([]);
  });
});

describe("ui/flow-page.js and ui/app.js (source)", () => {
  const src = readFileSync(new URL("../ui/flow-page.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  it("names the YAML editor and the Claude dialog box", () => {
    expect(src).toContain('"aria-label": "Flow YAML"');
    expect(src).toContain('"aria-label": modify ? "Describe the change" : "Describe the flow"');
  });
  it("keeps Ctrl/Cmd+S: modifier, preventDefault and save()", () => {
    expect(app).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "s"[^\n]*\{\n\s+e\.preventDefault\(\);\n\s+flowPage\.save\(\);/);
  });
  it("opens the Run dialog with the run form", () => {
    expect(src).toContain("runForm({");
    expect(src).toContain('from "./run-form.js"');
  });
});
