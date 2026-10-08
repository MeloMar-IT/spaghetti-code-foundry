import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitCssProblems, kitSourceProblems, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let kit: any;

beforeAll(async () => {
  restore = installFakeDom();
  kit = await import("../ui/kit/forms.js" as string);
});
afterAll(() => restore());

const cls = (e: FakeElement) => e.getAttribute("class");

describe("textInput and textArea", () => {
  it("textInput is an input with type, class and value", () => {
    const i = kit.textInput({ value: "a" }) as FakeElement;
    expect(i.tag).toBe("input");
    expect(i.getAttribute("type")).toBe("text");
    expect(cls(i)).toBe("scf-input");
    expect(i.value).toBe("a");
    expect(kit.textInput({}).value).toBe("");
    expect(cls(kit.textInput({ mono: true }))).toBe("scf-input scf-input--mono");
  });
  it("passes handlers, type, placeholder and disabled", () => {
    const onInput = vi.fn();
    const onChange = vi.fn();
    const i = kit.textInput({ onInput, onChange, type: "number", placeholder: "n", disabled: true }) as FakeElement;
    const target = { value: "3" };
    i.fire("input", { target });
    i.fire("change", { target });
    expect(onInput).toHaveBeenCalledWith({ target });
    expect(onChange).toHaveBeenCalledWith({ target });
    expect(i.getAttribute("type")).toBe("number");
    expect(i.getAttribute("placeholder")).toBe("n");
    expect(i.getAttribute("disabled")).toBe("");
  });
  it("throws on a style prop", () => {
    expect(() => kit.textInput({ style: {} })).toThrow(/inline style/);
    expect(() => kit.textArea({ style: {} })).toThrow(/inline style/);
  });
  it("textArea is a textarea with rows, classes, value and handlers", () => {
    const onInput = vi.fn();
    const onChange = vi.fn();
    const t = kit.textArea({ onInput, onChange, placeholder: "p", disabled: true, mono: true }) as FakeElement;
    expect(t.tag).toBe("textarea");
    expect(t.getAttribute("rows")).toBe("4");
    expect(cls(t)).toBe("scf-input scf-input--area scf-input--mono");
    expect(t.value).toBe("");
    expect(t.getAttribute("placeholder")).toBe("p");
    expect(t.getAttribute("disabled")).toBe("");
    t.fire("input");
    t.fire("change");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(kit.textArea({ rows: 8, value: "v" }).getAttribute("rows")).toBe("8");
    expect(kit.textArea({ value: "v" }).value).toBe("v");
  });
});

describe("select", () => {
  const options = (s: FakeElement) => s.all("option");
  it("takes pairs and plain strings", () => {
    const s = kit.select({ options: [["a", "Alpha"], "b"] }) as FakeElement;
    expect(s.tag).toBe("select");
    expect(cls(s)).toBe("scf-input scf-input--select");
    expect(options(s).map((o) => [o.value, o.textContent])).toEqual([["a", "Alpha"], ["b", "b"]]);
  });
  it("adds an empty first option for emptyLabel and selects it without a value", () => {
    const s = kit.select({ options: ["a"], emptyLabel: "None" }) as FakeElement;
    const [empty, a] = options(s);
    expect([empty!.value, empty!.textContent]).toEqual(["", "None"]);
    expect(empty!.getAttribute("selected")).toBe("");
    expect(a!.getAttribute("selected")).toBeNull();
  });
  it("selects the matching option, also a number against a string", () => {
    const s = kit.select({ options: ["1", "2"], value: 2 }) as FakeElement;
    expect(options(s).map((o) => o.getAttribute("selected"))).toEqual([null, ""]);
  });
  it("fires onChange and rejects options that are not an array", () => {
    const onChange = vi.fn();
    kit.select({ options: [], onChange }).fire("change");
    expect(onChange).toHaveBeenCalled();
    expect(() => kit.select({ options: "ab" })).toThrow(/options/);
    expect(() => kit.select({ options: [], style: {} })).toThrow(/inline style/);
  });
});

describe("checkbox", () => {
  it("is a native checkbox inside its label", () => {
    const c = kit.checkbox({ label: "Yes", checked: true, disabled: true, name: "n" }) as FakeElement;
    expect(c.tag).toBe("label");
    expect(cls(c)).toBe("scf-checkbox");
    const [input, text] = c.children as FakeElement[];
    expect(input!.tag).toBe("input");
    expect(input!.getAttribute("type")).toBe("checkbox");
    expect(input!.checked).toBe(true);
    expect(input!.getAttribute("disabled")).toBe("");
    expect(input!.getAttribute("name")).toBe("n");
    expect(text!.tag).toBe("span");
    expect(text!.textContent).toBe("Yes");
    expect((kit.checkbox({ label: "x" }).children[0] as FakeElement).checked).toBe(false);
  });
  it("fires onChange from the input and rejects a blank label or a style prop", () => {
    const onChange = vi.fn();
    (kit.checkbox({ label: "x", onChange }).children[0] as FakeElement).fire("change");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(() => kit.checkbox({ label: " " })).toThrow(/needs a label/);
    expect(() => kit.checkbox({ label: "x", style: {} })).toThrow(/inline style/);
  });
});

describe("field", () => {
  const find = (root: FakeElement, pred: (e: FakeElement) => boolean) => {
    const walk = (e: FakeElement): FakeElement[] => e.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
    return walk(root).filter(pred);
  };
  it("joins label and control by for and id", () => {
    const input = kit.textInput({});
    const f = kit.field({ label: "Name" }, input) as FakeElement;
    const label = f.children[0] as FakeElement;
    expect(label.tag).toBe("label");
    expect(label.getAttribute("for")).toBe(input.getAttribute("id"));
    expect(input.getAttribute("id")).toMatch(/^scf-field-\d+$/);
    expect(cls(f)).toBe("scf-field");
    expect(f.children[1]).toBe(input);
  });
  it("keeps an existing id and gives different ids to two fields", () => {
    const own = kit.textInput({ id: "mine" });
    expect((kit.field({ label: "A" }, own).children[0] as FakeElement).getAttribute("for")).toBe("mine");
    const a = kit.textInput({});
    const b = kit.textInput({});
    kit.field({ label: "A" }, a);
    kit.field({ label: "B" }, b);
    expect(a.getAttribute("id")).not.toBe(b.getAttribute("id"));
  });
  it("hint only: describes the control and does not mark it invalid", () => {
    const input = kit.textInput({});
    const f = kit.field({ label: "A", hint: "Help" }, input) as FakeElement;
    const id = input.getAttribute("id");
    expect(input.getAttribute("aria-describedby")).toBe(`${id}-hint`);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(find(f, (e) => e.getAttribute("role") === "alert")).toHaveLength(0);
    expect(find(f, (e) => e.getAttribute("id") === `${id}-hint`)[0]!.textContent).toBe("Help");
  });
  it("error only: invalid, an alert and a wrapper class", () => {
    const input = kit.textInput({});
    const f = kit.field({ label: "A", error: "Bad" }, input) as FakeElement;
    const id = input.getAttribute("id");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(`${id}-error`);
    const alert = find(f, (e) => e.getAttribute("role") === "alert");
    expect(alert).toHaveLength(1);
    expect(alert[0]!.textContent).toBe("Bad");
    expect(cls(f)).toBe("scf-field scf-field--error");
  });
  it("hint and error: both ids, after an existing aria-describedby", () => {
    const input = kit.textInput({ "aria-describedby": "other" });
    kit.field({ label: "A", hint: "h", error: "e" }, input);
    const id = input.getAttribute("id");
    expect(input.getAttribute("aria-describedby")).toBe(`other ${id}-hint ${id}-error`);
  });
  it("neither: no aria-describedby", () => {
    const input = kit.textInput({});
    kit.field({ label: "A" }, input);
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });
  it("required: sets the attribute and a hidden marker", () => {
    const input = kit.textInput({});
    const f = kit.field({ label: "A", required: true }, input) as FakeElement;
    expect(input.getAttribute("required")).toBe("");
    expect(find(f, (e) => e.getAttribute("aria-hidden") === "true")).toHaveLength(1);
  });
  it("throws on a blank label or a style prop", () => {
    expect(() => kit.field({ label: " " }, kit.textInput({}))).toThrow(/needs a label/);
    expect(() => kit.field({ label: "A", style: {} }, kit.textInput({}))).toThrow(/inline style/);
  });
});

describe("kit forms: CSS and source", () => {
  it("forms.css has only kit selectors and tokens, and resets the global input width for checkboxes", () => {
    const css = readFileSync("ui/kit/forms.css", "utf8");
    expect(kitCssProblems(css, tokenNames())).toEqual([]);
    expect(css).toMatch(/\.scf-checkbox__input \{[^}]*width: auto/);
  });
  it("forms.js has no inline style", () => {
    expect(kitSourceProblems(readFileSync("ui/kit/forms.js", "utf8"))).toEqual([]);
  });
});
