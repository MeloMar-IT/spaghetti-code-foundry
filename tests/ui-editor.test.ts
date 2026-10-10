import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let editor: any;
beforeAll(async () => {
  restore = installFakeDom();
  editor = await import("../ui/editor.js" as string);
});
afterAll(() => restore());

const flow = (): any => ({
  name: "t",
  steps: [
    { id: "a", type: "claude", prompt: "Do the thing\nsecond line", model: "sonnet" },
    { id: "b", type: "shell", run: "npm test", jump_only: true, on_success: "a", on_failure: "a", resume: "a", resume_from: "a", routes: [{ if: "x", goto: "a" }] },
    { id: "p", type: "parallel", steps: ["a", "b"] },
  ],
});
const make = (f: any, over: Record<string, unknown> = {}) => {
  const ctx = { onChange: vi.fn(), rerender: vi.fn(), onSelect: vi.fn(), onLibrary: vi.fn(), onSaveBlock: vi.fn(), ...over };
  const root: FakeElement = editor.renderEditor(f, ctx);
  return { root, ctx };
};
const rows = (root: FakeElement) => root.querySelectorAll("[data-step]");
const byTitle = (root: FakeElement, title: string) => root.all("button").find((b) => b.attrs.title === title)!;
const byText = (root: FakeElement, t: string) => root.all("button").find((b) => b.textContent === t)!;
const ids = (root: FakeElement) => root.querySelectorAll("[id]").map((e) => e.attrs.id);
const field = (root: FakeElement, name: string) => root.querySelectorAll("[data-field]").find((e) => e.attrs["data-field"] === name)!;

describe("the structure list", () => {
  it("has Flow settings first and a row per step", () => {
    const { root } = make(flow());
    const r = rows(root);
    expect(r.map((x) => x.attrs["data-step"])).toEqual(["settings", "0", "1", "2"]);
    expect(r[0].textContent).toContain("Flow settings");
    expect(r[1].textContent).toContain("1");
    expect(r[1].textContent).toContain("a");
    expect(r[1].textContent).toContain("◆");
    expect(r[1].textContent).toContain("sonnet · Do the thing");
    expect(r[2].textContent).toContain("only via jumps");
    expect(r[1].textContent).not.toContain("only via jumps");
  });

  it("marks a step with a problem, and the settings row for a settings problem", () => {
    const { root } = make(flow(), { problems: [{ stepIndex: 1, section: null }] });
    const hidden = rows(root).map((r) => r.querySelector("[data-mark]")!.hidden);
    expect(hidden).toEqual([true, true, false, true]);
    const s = make(flow(), { problems: [{ stepIndex: null, section: "defaults" }] }).root;
    expect(rows(s).map((r) => r.querySelector("[data-mark]")!.hidden)).toEqual([false, true, true, true]);
  });

  it("calls onSelect with the index or settings", () => {
    const { root, ctx } = make(flow());
    rows(root)[2].click();
    rows(root)[0].click();
    expect(ctx.onSelect.mock.calls).toEqual([[1], ["settings"]]);
  });

  it("marks the selected row", () => {
    const { root } = make(flow(), { selected: 1 });
    expect(rows(root).map((r) => r.classList.contains("selected"))).toEqual([false, false, true, false]);
    expect(rows(root)[2].attrs["aria-current"]).toBe("true");
  });

  it("updates the row text while typing, without a rerender", () => {
    const f = flow();
    const { root, ctx } = make(f, { selected: 0 });
    const prompt = field(root, "prompt");
    prompt.value = "Changed";
    prompt.fire("input", { target: prompt });
    expect(rows(root)[1].textContent).toContain("sonnet · Changed");
    expect(ctx.onChange).toHaveBeenCalledTimes(1);
    expect(ctx.rerender).not.toHaveBeenCalled();
  });
});

describe("one inspector", () => {
  it("draws only the selected step", () => {
    const { root } = make(flow(), { selected: 1 });
    expect(ids(root).filter((i) => String(i).startsWith("step-"))).toEqual(["step-1"]);
    expect(root.querySelectorAll("[data-section]")).toHaveLength(0);
  });

  it.each([[undefined], [null], ["settings"], [99]])("draws flow settings for selected = %s", (selected) => {
    const { root } = make(flow(), { selected });
    expect(ids(root)).toContain("flow-settings");
    expect(ids(root).filter((i) => String(i).startsWith("step-"))).toEqual([]);
    expect(root.querySelectorAll("[data-section]").map((e) => e.attrs["data-section"])).toEqual(["flow", "defaults", "limits sandbox", "vars", "publish"]);
  });

  it("shows only the controls of the step type", () => {
    const shell = make(flow(), { selected: 1 }).root.textContent;
    expect(shell).toContain("Command");
    expect(shell).toContain("Needs repository access");
    expect(shell).not.toContain("Model");
    const agent = make(flow(), { selected: 0 }).root.textContent;
    expect(agent).toContain("Prompt");
    expect(agent).not.toContain("Needs repository access");
  });

  it("opens a group that holds a value", () => {
    const { root } = make(flow(), { selected: 1 });
    const group = (id: string) => root.querySelectorAll("[data-group]").find((g) => g.attrs["data-group"] === id)!;
    expect(group("routing").attrs.open).toBeDefined();
    expect(group("limits").attrs.open).toBeUndefined();
  });

  it("says to use the YAML tab for an unknown type", () => {
    const f: any = { name: "t", steps: [{ id: "x", type: "weird" }] };
    const { root } = make(f, { selected: 0 });
    expect(root.textContent).toContain("edit it in the YAML tab");
    expect(root.querySelectorAll("[data-group]")).toHaveLength(0);
    expect(rows(root)[1].textContent).toContain("?");
  });

  it("draws a step with a number in a text field", () => {
    const f: any = { name: "t", steps: [{ id: "a", type: "shell", run: 5 }] };
    expect(() => make(f)).not.toThrow();
    expect(() => make(f, { selected: 0 })).not.toThrow();
  });
});

describe("adding steps", () => {
  it("adds after the selected step and selects it", () => {
    const f = flow();
    const { root, ctx } = make(f, { selected: 0 });
    byText(root, "+ Shell step").click();
    expect(f.steps.map((s: any) => s.id)).toEqual(["a", "shell", "b", "p"]);
    expect(ctx.onSelect).toHaveBeenCalledWith(1, false);
    expect(ctx.rerender).toHaveBeenCalled();
  });

  it("appends when settings are selected", () => {
    const f = flow();
    const { root, ctx } = make(f);
    byText(root, "+ Agent step").click();
    expect(f.steps).toHaveLength(4);
    expect(f.steps[3].type).toBe("claude");
    expect(ctx.onSelect).toHaveBeenCalledWith(3, false);
  });

  it("adds at the top or the end when asked", () => {
    const f = flow();
    const { root } = make(f, { selected: 0 });
    const where = root.all("select").find((s) => s.attrs["data-focus"] === "step-add-where")!;
    where.fire("change", { target: { value: "top" } });
    byText(root, "+ Shell step").click();
    expect(f.steps[0].id).toBe("shell");
    where.fire("change", { target: { value: "end" } });
    byText(root, "+ Agent step").click();
    expect(f.steps[f.steps.length - 1].type).toBe("claude");
  });

  it("adds an approval step from the more list", () => {
    const f = flow();
    const { root } = make(f, { selected: 2 });
    const more = root.all("select").find((s) => s.attrs.title === "More step types")!;
    more.fire("change", { target: { value: "approval" } });
    expect(f.steps[3].type).toBe("approval");
  });

  it("asks the library for the place", () => {
    const { root, ctx } = make(flow(), { selected: 1 });
    byText(root, "+ From library").click();
    expect(ctx.onLibrary).toHaveBeenCalledWith(2);
    const where = root.all("select").find((s) => s.attrs["data-focus"] === "step-add-where")!;
    where.fire("change", { target: { value: "top" } });
    byText(root, "+ From library").click();
    expect(ctx.onLibrary).toHaveBeenLastCalledWith(0);
  });
});

describe("step actions", () => {
  it("moves down and up", () => {
    const f = flow();
    const { root, ctx } = make(f, { selected: 0 });
    expect(byTitle(root, "Move up").attrs.disabled).toBeDefined();
    byTitle(root, "Move down").click();
    expect(f.steps.map((s: any) => s.id)).toEqual(["b", "a", "p"]);
    expect(ctx.onSelect).toHaveBeenCalledWith(1, false);
    expect(ctx.rerender).toHaveBeenCalled();
    const second = make(f, { selected: 1 });
    byTitle(second.root, "Move up").click();
    expect(f.steps.map((s: any) => s.id)).toEqual(["a", "b", "p"]);
    expect(second.ctx.onSelect).toHaveBeenCalledWith(0, false);
  });

  it("duplicates with a unique id", () => {
    const f = flow();
    const { root, ctx } = make(f, { selected: 0 });
    byTitle(root, "Duplicate").click();
    expect(f.steps.map((s: any) => s.id)).toEqual(["a", "a2", "b", "p"]);
    expect(ctx.onSelect).toHaveBeenCalledWith(1, false);
  });

  it("deletes and selects a neighbour, or settings", () => {
    const f = flow();
    const last = make(f, { selected: 2 });
    byTitle(last.root, "Delete step").click();
    expect(last.ctx.onSelect).toHaveBeenCalledWith(1, false);
    const only: any = { name: "t", steps: [{ id: "a", type: "shell", run: "x" }] };
    const one = make(only, { selected: 0 });
    byTitle(one.root, "Delete step").click();
    expect(one.ctx.onSelect).toHaveBeenCalledWith("settings", false);
    expect(only.steps).toEqual([]);
  });

  it("saves a step as a block", () => {
    const f = flow();
    const { root, ctx } = make(f, { selected: 1 });
    byTitle(root, "Save as reusable block").click();
    expect(ctx.onSaveBlock).toHaveBeenCalledWith(f.steps[1]);
  });

  it("names every header button", () => {
    const { root } = make(flow(), { selected: 1 });
    for (const t of ["Move up", "Move down", "Save as reusable block", "Duplicate", "Delete step"]) expect(byTitle(root, t).attrs["aria-label"]).toBe(t);
  });

  it("renames and follows every reference", () => {
    const f = flow();
    const { root, ctx } = make(f, { selected: 0 });
    const id = field(root, "id");
    id.value = "first";
    id.fire("input", { target: id });
    id.fire("change", { target: id });
    expect(f.steps[0].id).toBe("first");
    const b = f.steps[1];
    expect([b.on_success, b.on_failure, b.resume, b.resume_from, b.routes[0].goto]).toEqual(["first", "first", "first", "first", "first"]);
    expect(f.steps[2].steps).toEqual(["first", "b"]);
    expect(ctx.rerender).toHaveBeenCalled();
  });
});

describe("flow settings", () => {
  const summaries = (root: FakeElement) => root.all("summary").map((s) => s.textContent);
  const section = (root: FakeElement, name: string) => root.querySelectorAll("[data-section]").find((e) => e.attrs["data-section"].split(" ").includes(name))!;

  it("names its groups", () => {
    const { root } = make(flow());
    expect(summaries(root)).toEqual(["Defaults for agent steps", "Safety", "Variables (0)", "Publish to users"]);
  });

  it("opens the defaults group only when it holds a value", () => {
    const withValue = make({ ...flow(), defaults: { model: "x" } }).root;
    expect(section(withValue, "defaults").attrs.open).toBeDefined();
    const without = make({ ...flow(), defaults: {} }).root;
    expect(section(without, "defaults").attrs.open).toBeUndefined();
  });

  it("opens Safety and Publish for stored false values", () => {
    const root = make({ ...flow(), sandbox: { claude: false }, one_per_repo: false, publish: { enabled: false } }).root;
    expect(section(root, "sandbox").attrs.open).toBeDefined();
    expect(section(root, "publish").attrs.open).toBeDefined();
    const blank = make(flow()).root;
    expect(section(blank, "sandbox").attrs.open).toBeUndefined();
    expect(section(blank, "publish").attrs.open).toBeUndefined();
  });
});

describe("the YAML of an unchanged flow", () => {
  for (const file of ["issue-gitflow.yaml", "refine-brief.yaml"]) {
    it(`stays the same after a draw of ${file}`, () => {
      const obj: any = YAML.parse(readFileSync(`flows/${file}`, "utf8"));
      const before = YAML.stringify(editor.cleanFlow(obj));
      for (const selected of ["settings", ...obj.steps.map((_: unknown, i: number) => i)]) {
        make(obj, { selected });
        expect(YAML.stringify(editor.cleanFlow(obj))).toBe(before);
      }
    });
  }
});
