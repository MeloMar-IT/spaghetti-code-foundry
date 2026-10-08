import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { parseCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let editor: any;
let types: any;
let graph: any;
beforeAll(async () => {
  restore = installFakeDom();
  editor = await import("../ui/editor.js" as string);
  types = await import("../ui/step-types.js" as string);
  graph = await import("../ui/graph.js" as string);
});
afterAll(() => restore());

const read = (f: string) => readFileSync(f, "utf8");
const rules = parseCss(read("ui/css/pages/editor.css"));
const decls = (selector: string) => rules.find((r) => r.selector === selector)?.declarations;
const index = (selector: string) => rules.findIndex((r) => r.selector === selector);

/** Every label that holds a checkbox, with its input. */
const checkRows = (el: FakeElement): Array<{ label: FakeElement; input: FakeElement }> =>
  el.all("label").flatMap((label) => {
    const input = label.all("input").find((i) => i.attrs.type === "checkbox");
    return input ? [{ label, input }] : [];
  });

describe("editor.css", () => {
  it("hides the dirty dot with a class and keeps its space", () => {
    expect(decls(".dirty-dot.clean")).toEqual(["visibility: hidden"]);
    expect(decls(".dirty-dot")!.some((d) => d.startsWith("visibility"))).toBe(false);
  });

  it("styles the five legend lines after the base rule", () => {
    expect(decls(".legend i.seq")).toEqual(["border-color: var(--muted)"]);
    expect(decls(".legend i.ok")).toEqual(["border-color: var(--ok)"]);
    expect(decls(".legend i.fail")).toEqual(["border-color: var(--fail)", "border-top-style: dashed"]);
    expect(decls(".legend i.route")).toEqual(["border-color: var(--route)"]);
    expect(decls(".legend i.par")).toEqual(["border-color: var(--muted)", "border-top-style: dotted"]);
    for (const k of ["seq", "ok", "fail", "route", "par"]) expect(index(`.legend i.${k}`)).toBeGreaterThan(index(".legend i"));
  });
});

describe("graph legend", () => {
  it("takes colour and line style from classes", () => {
    const g: FakeElement = graph.renderGraph({ steps: [{ id: "a", type: "shell", run: "x" }] });
    const legend = [g, ...g.all("div")].find((e) => e.attrs.class === "legend")!;
    const lines = legend.all("i");
    expect(lines.map((i) => i.attrs.class)).toEqual(["seq", "ok", "fail", "route", "par"]);
    for (const i of lines) expect(i.style).toEqual({});
  });

  it("shows no legend without steps", () => {
    const g: FakeElement = graph.renderGraph({ steps: [] });
    expect(g.all("i")).toEqual([]);
    expect(g.textContent).toContain("No steps yet");
  });
});

describe("checkbox rows", () => {
  it("publish panel rows use row tight text-sm and fit", () => {
    const flow = { name: "t", steps: [{ id: "a", type: "shell", run: "x" }], vars: { x: "v" }, publish: { enabled: true, vars: { x: { mode: "input" } } } };
    const rows = checkRows(editor.publishPanel(flow, () => {}, () => {}));
    expect(rows.length).toBeGreaterThan(1);
    for (const { label, input } of rows) {
      expect(String(label.attrs.class)).toMatch(/^row tight text-sm/);
      expect(input.attrs.class).toBe("fit");
      expect(label.style).toEqual({});
      expect(input.style).toEqual({});
    }
    expect(rows.find((r) => r.label.textContent.includes("Available to users"))!.label.attrs.class).toBe("row tight text-sm mt-6");
  });

  const body = (step: any) => {
    const flow = { name: "t", steps: [step, { id: "z", type: "shell", run: "x" }, { id: "y", type: "shell", run: "x" }] };
    const nodes: FakeElement[] = types.stepBody(flow, step, 0, { onChange: () => {}, rerender: () => {}, vars: [], earlier: [], priorClaude: [] });
    const root = new FakeElement("div");
    root.append(...nodes);
    return root;
  };

  it("step body helper rows use row tight text-sm and fit", () => {
    const rows = checkRows(body({ id: "a", type: "shell", run: "x" }));
    expect(rows.length).toBeGreaterThan(0);
    for (const { label, input } of rows) {
      expect(label.attrs.class).toBe("row tight text-sm");
      expect(input.attrs.class).toBe("fit");
      expect(label.style).toEqual({});
      expect(input.style).toEqual({});
    }
  });

  it("parallel step rows use row tight and fit", () => {
    const rows = checkRows(body({ id: "p", type: "parallel", steps: [] })).filter((r) => r.label.attrs.class !== "field");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const { label, input } of rows) {
      expect(label.attrs.class).toBe("row tight");
      expect(input.attrs.class).toBe("fit");
    }
  });

  it("every checkbox in the source is fit and the row classes are counted", () => {
    const e = read("ui/editor.js");
    const s = read("ui/step-types.js");
    for (const src of [e, s]) {
      for (const line of src.split("\n").filter((l) => l.includes('type: "checkbox"'))) expect(line).toContain('class: "fit"');
    }
    expect(e.split('class: "row tight text-sm').length - 1).toBe(6);
    expect(s.split('class: "row tight text-sm').length - 1).toBe(1);
    expect(s.split('class: "row tight" }').length - 1).toBe(1);
  });
});

describe("dirty dot", () => {
  it("is toggled with a class in app.js", () => {
    const src = read("ui/app.js");
    expect(src).toContain('class: c.dirty ? "dirty-dot" : "dirty-dot clean"');
    expect(src).toContain('ui.dirty.classList.toggle("clean", !S.cur.dirty)');
    expect(src).not.toContain("visibility");
  });

  it("fake classList.toggle adds and removes the class", () => {
    const el = new FakeElement("span");
    el.classList.toggle("clean", true);
    expect(el.classList.contains("clean")).toBe(true);
    el.classList.toggle("clean", false);
    expect(el.classList.contains("clean")).toBe(false);
  });
});
