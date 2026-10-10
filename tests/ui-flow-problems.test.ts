import * as YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let fp: any;
let editor: any;
beforeAll(async () => {
  restore = installFakeDom();
  fp = await import("../ui/flow-problems.js" as string);
  editor = await import("../ui/editor.js" as string);
});
afterAll(() => restore());

const TEXT = `name: t
defaults:
  model: sonnet
steps:
  - id: a
    type: shell
    run: |
      echo hi
  - id: b
    type: claude
    prompt: p
`;

describe("locate", () => {
  it("finds steps, sections and nothing", () => {
    expect(fp.locate(["steps", 1, "run"])).toEqual({ stepIndex: 1, field: "run", section: null });
    expect(fp.locate(["steps", 0, "routes", 2, "if"]).field).toBe("routes.2.if");
    expect(fp.locate(["defaults", "timeout_sec"])).toEqual({ stepIndex: null, field: "timeout_sec", section: "defaults" });
    expect(fp.locate(["limits", "max_cost_usd"]).section).toBe("limits");
    expect(fp.locate(["vars", "x"])).toEqual({ stepIndex: null, field: "x", section: "vars" });
    expect(fp.locate(["publish", "vars", "x"])).toEqual({ stepIndex: null, field: null, section: "publish" });
    expect(fp.locate(["publish", "vars", "x", "label"]).field).toBe("vars.x.label");
    expect(fp.locate(["name"])).toEqual({ stepIndex: null, field: "name", section: "flow" });
    expect(fp.locate([])).toEqual({ stepIndex: null, field: null, section: null });
    expect(fp.locate(["steps"])).toEqual({ stepIndex: null, field: null, section: null });
  });
});

describe("lineOf and offsetOf", () => {
  it("finds nested, list and missing paths", () => {
    expect(fp.lineOf(TEXT, ["defaults", "model"], YAML)).toMatchObject({ line: 3 });
    expect(fp.lineOf(TEXT, ["steps", 0, "run"], YAML)).toMatchObject({ line: 7 });
    expect(fp.lineOf(TEXT, ["steps", 1], YAML)).toMatchObject({ line: 9 });
    expect(fp.lineOf(TEXT, ["steps", 0, "nope"], YAML)).toMatchObject({ line: 5 });
  });
  it("returns null for unknown places", () => {
    expect(fp.lineOf(TEXT, ["steps", 9, "run"], YAML)).toBeNull();
    expect(fp.lineOf(TEXT, ["nope", "deep", "x"], YAML)).toBeNull();
    expect(fp.lineOf(TEXT, [], YAML)).toBeNull();
    expect(fp.lineOf("[[[ not: yaml: (", ["a"], YAML)).toBeNull();
  });
  it("converts line and column to an offset", () => {
    expect(fp.offsetOf("ab\ncd\nef", 1, 1)).toBe(0);
    expect(fp.offsetOf("ab\ncd\nef", 3, 2)).toBe(7);
    expect(fp.offsetOf("ab\ncd", 9, 1)).toBe(5);
  });
});

describe("problemsOf", () => {
  it("adds places to schema issues", () => {
    const r = { ok: false, error: "x", issues: [{ path: ["steps", 1, "prompt"], message: "bad" }, { path: ["defaults", "model"], message: "worse" }] };
    const ps = fp.problemsOf(r, TEXT, YAML);
    expect(ps[0]).toMatchObject({ stepIndex: 1, stepId: "b", field: "prompt", line: 11, message: "bad" });
    expect(ps[1]).toMatchObject({ section: "defaults", field: "model", line: 3 });
  });
  it("gives a syntax error its line and column", () => {
    const text = "name: a\nname: b\n";
    const ps = fp.problemsOf({ ok: false, error: "<flow>: invalid YAML: dup", issues: [] }, text, YAML);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ line: 2, col: 1, message: "invalid YAML: dup" });
  });
  it("keeps a transport failure plain, even over broken text", () => {
    const ps = fp.problemsOf({ ok: false, error: "boom" }, "name: a\nname: b\n", YAML);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ message: "boom", line: null, section: null, stepIndex: null });
    expect(fp.problemsOf({ ok: true }, TEXT, YAML)).toEqual([]);
  });
});

describe("renderProblems", () => {
  const step = { message: "m", path: ["steps", 0, "run"], stepIndex: 0, stepId: "a", field: "run", section: null, line: 7, col: 5 };
  const root = { message: "r", path: [], stepIndex: null, stepId: null, field: null, section: null, line: null, col: null };
  it("draws spans and buttons", () => {
    const opened: unknown[] = [];
    const el: FakeElement = fp.renderProblems([step, root], { onOpen: (p: unknown) => opened.push(p) });
    const rows = el.all("li");
    expect(rows).toHaveLength(2);
    expect(rows[0].all("button")).toHaveLength(1);
    expect(rows[1].all("span")).toHaveLength(1);
    expect(rows[0].textContent).toBe("steps.0.run: m");
    rows[1].all("span")[0].click();
    expect(opened).toEqual([]);
    rows[0].all("button")[0].click();
    expect(opened[0]).toBe(step);
  });
  it("depends on the mode", () => {
    const syntax = { ...root, line: 2, col: 1 };
    expect(fp.renderProblems([syntax], { mode: "yaml" }).all("button")).toHaveLength(1);
    expect(fp.renderProblems([syntax]).all("button")).toHaveLength(0);
    expect(fp.renderProblems([])).toBeNull();
  });
});

describe("openInVisual", () => {
  const flow = () => ({ name: "t", steps: [{ id: "a", type: "shell", run: "x" }, { id: "b", type: "claude", prompt: "p" }] });
  const ctx = { onChange: () => {}, rerender: () => {}, onSelect: () => {} };
  const tree = (selected: number | string = 0) => editor.renderEditor(flow(), { ...ctx, selected });
  const p = (path: (string | number)[]) => ({ message: "m", path, ...fp.locate(path), stepId: null, line: null, col: null });
  const active = () => (document as any).activeElement;

  it("selects the step and focuses the field", () => {
    const calls: unknown[][] = [];
    expect(fp.openInVisual(tree(), p(["steps", 0, "run"]), (...a: unknown[]) => calls.push(a))).toBe(true);
    expect(calls).toEqual([[0, true]]);
    expect(active().getAttribute("data-field")).toBe("run");
  });
  it("opens a closed details around the field", () => {
    fp.openInVisual(tree(1), p(["steps", 1, "system_prompt"]), () => {});
    expect(active().getAttribute("data-field")).toBe("system_prompt");
    expect(active().closest("details").open).toBe(true);
  });
  it("selects only when the field has no control", () => {
    (document as any).activeElement = null;
    let n = 0;
    expect(fp.openInVisual(tree(), p(["steps", 0, "type"]), () => n++)).toBe(true);
    expect(n).toBe(1);
    expect(active()).toBeNull();
  });
  it("opens settings sections", () => {
    const root = tree("settings");
    fp.openInVisual(root, p(["defaults", "timeout_sec"]), () => {});
    expect(active().getAttribute("data-field")).toBe("timeout_sec");
    expect(active().closest("details").open).toBe(true);
    fp.openInVisual(root, p(["limits", "max_cost_usd"]), () => {});
    expect(active().getAttribute("data-field")).toBe("max_cost_usd");
    fp.openInVisual(root, p(["sandbox", "docker_image"]), () => {});
    expect(active().getAttribute("data-field")).toBe("docker_image");
    (document as any).activeElement = null;
    expect(fp.openInVisual(root, p(["publish", "vars", "x"]), () => {})).toBe(true);
    expect(active()).toBeNull();
  });
  it("focuses a published variable control", () => {
    const f: any = { ...flow(), vars: { x: "1" }, publish: { enabled: true, vars: { x: { mode: "input", label: "L" } } } };
    const root = editor.renderEditor(f, ctx);
    for (const k of ["mode", "label", "required"]) {
      expect(fp.openInVisual(root, p(["publish", "vars", "x", k]), () => {})).toBe(true);
      expect(active().getAttribute("data-field")).toBe(`vars.x.${k}`);
    }
  });
  it("does nothing for a step that is gone", () => {
    let n = 0;
    expect(fp.openInVisual(tree(), p(["steps", 99, "run"]), () => n++)).toBe(false);
    expect(n).toBe(0);
  });
});

describe("openInYaml", () => {
  const area = (value: string) => { const t = new FakeElement("textarea") as any; t.value = value; return t; };
  const prob = (path: (string | number)[]) => ({ message: "m", path, stepIndex: null, stepId: null, field: null, section: null, line: null, col: null });

  it("puts the cursor on the line", () => {
    const t = area(TEXT);
    expect(fp.openInYaml(t, prob(["defaults", "model"]), YAML)).toBe(true);
    expect(t.selectionStart).toBe(t.selectionEnd);
    expect(t.selectionStart).toBe(fp.offsetOf(TEXT, 3, 3));
    expect(Number.isFinite(t.scrollTop)).toBe(true);
  });
  it("uses the line of a syntax problem", () => {
    const t = area("name: a\nname: b\n");
    expect(fp.openInYaml(t, { ...prob([]), line: 2, col: 1 }, YAML)).toBe(true);
    expect(t.selectionStart).toBe(8);
  });
  it("ignores stale paths and a missing textarea", () => {
    const t = area(TEXT);
    t.selectionStart = 4;
    expect(fp.openInYaml(t, prob(["steps", 9, "run"]), YAML)).toBe(false);
    expect(t.selectionStart).toBe(4);
    expect(fp.openInYaml(null, prob(["name"]), YAML)).toBe(false);
  });
});

describe("openInVisual with one inspector", () => {
  const f = (): any => ({
    name: "t", defaults: { model: "m" }, vars: {},
    steps: [
      { id: "a", type: "shell", run: "x" },
      { id: "b", type: "claude", prompt: "p", routes: [{ if: "x", goto: "end" }, { if: "y", goto: "end" }] },
      { id: "c", type: "parallel", steps: ["a"] },
      { id: "d", type: "flow", flow: "g", vars: { k: "v" } },
    ],
  });
  const p = (path: (string | number)[]) => ({ message: "m", path, ...fp.locate(path), stepId: null, line: null, col: null });
  const active = () => (document as any).activeElement;
  const ctx = { onChange: () => {}, rerender: () => {}, onSelect: () => {} };

  /** A holder that draws the editor again for the item `select` is called with, as the page does. */
  function holder(start: number | string) {
    const flow = f();
    const root = new FakeElement("div");
    const draw = (selected: number | string) => root.replaceChildren(editor.renderEditor(flow, { ...ctx, selected }));
    draw(start);
    const calls: unknown[][] = [];
    return { root, calls, select: (i: number | string, scroll: boolean) => { calls.push([i, scroll]); draw(i); } };
  }

  it("selects a step that is not drawn and focuses its field", () => {
    const h = holder("settings");
    expect(fp.openInVisual(h.root, p(["steps", 0, "run"]), h.select)).toBe(true);
    expect(h.calls).toEqual([[0, true]]);
    expect(active().getAttribute("data-field")).toBe("run");
  });

  it("focuses the second invalid route and opens the routing group", () => {
    const h = holder(1);
    expect(fp.openInVisual(h.root, p(["steps", 1, "routes", 1, "if"]), h.select)).toBe(true);
    expect(active().getAttribute("data-field")).toBe("routes.1.if");
    expect(active().closest("details").open).toBe(true);
    fp.openInVisual(h.root, p(["steps", 1, "routes", 1, "goto"]), h.select);
    expect(active().getAttribute("data-field")).toBe("routes.1.goto");
  });

  it("focuses the parallel picker and the sub-flow variables", () => {
    const h = holder("settings");
    fp.openInVisual(h.root, p(["steps", 2, "steps", 0]), h.select);
    expect(active().getAttribute("data-field")).toBe("steps");
    fp.openInVisual(h.root, p(["steps", 3, "vars", "k"]), h.select);
    expect(active().getAttribute("data-field")).toBe("vars.k");
    expect(fp.locate(["steps", 3, "vars"]).field).toBe("vars");
  });

  it("switches to the settings for a settings problem", () => {
    const h = holder(0);
    expect(fp.openInVisual(h.root, p(["defaults", "model"]), h.select)).toBe(true);
    expect(h.calls).toEqual([["settings", true]]);
    expect(active().getAttribute("data-field")).toBe("model");
  });

  it("still refuses a step that is gone", () => {
    const h = holder(0);
    expect(fp.openInVisual(h.root, p(["steps", 99, "run"]), h.select)).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe("markProblems", () => {
  const list = () => editor.renderEditor({ name: "t", steps: [{ id: "a", type: "shell", run: "x" }, { id: "b", type: "shell", run: "x" }] }, { onChange: () => {}, rerender: () => {}, onSelect: () => {} });
  const hidden = (root: FakeElement) => root.querySelectorAll("[data-mark]").map((m) => m.hidden);

  it("sets and clears the marks", () => {
    const root = list();
    fp.markProblems(root, [{ stepIndex: 1, section: null }]);
    expect(hidden(root)).toEqual([true, true, false]);
    fp.markProblems(root, [{ stepIndex: null, section: "vars" }, { stepIndex: null, section: null }]);
    expect(hidden(root)).toEqual([false, true, true]);
    fp.markProblems(root, []);
    expect(hidden(root)).toEqual([true, true, true]);
  });

  it("ignores a missing root", () => {
    expect(() => fp.markProblems(null, [])).not.toThrow();
  });
});
