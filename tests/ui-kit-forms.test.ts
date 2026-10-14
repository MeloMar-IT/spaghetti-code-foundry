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

describe("settingControl", () => {
  const base = { effectText: "at once", optional: false, default: 5, label: "Resumes", help: "How many resumes." };
  const number = { ...base, key: "a", kind: "number", integer: true, min: 1, max: 49 };
  const records = { ...base, key: "r", kind: "list", maxItems: 50, default: [], fields: [{ key: "catalogue", kind: "text" }, { key: "version", kind: "text" }, { key: "digest", kind: "text" }] };
  const control = (e: FakeElement, tag: string) => e.all(tag)[0]!;
  const hint = (e: FakeElement) => e.all("small")[0]!.textContent;

  it("number: an input with its range; a Number or undefined", () => {
    const onChange = vi.fn();
    const f = kit.settingControl(number, { value: 7, onChange }) as FakeElement;
    const i = control(f, "input");
    expect([i.getAttribute("type"), i.getAttribute("min"), i.getAttribute("max"), i.getAttribute("step"), i.value]).toEqual(["number", "1", "49", "1", "7"]);
    i.fire("change", { target: { value: "7" } });
    expect(onChange).toHaveBeenLastCalledWith(7);
    i.fire("change", { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(control(kit.settingControl({ ...number, integer: false }), "input").getAttribute("step")).toBe("any");
  });

  it("yes-no: a switch", () => {
    const onChange = vi.fn();
    const f = kit.settingControl({ ...base, kind: "yes-no", default: true }, { value: true, onChange }) as FakeElement;
    const i = control(f, "input");
    expect(i.getAttribute("role")).toBe("switch");
    expect(i.checked).toBe(true);
    i.fire("change", { target: { checked: true } });
    expect(onChange).toHaveBeenCalledWith(true);
    expect(hint(f)).toContain("Default: yes.");
  });

  it("text: an empty value is undefined only when optional", () => {
    const onChange = vi.fn();
    control(kit.settingControl({ ...base, kind: "text", optional: true, default: undefined }, { onChange }), "input").fire("change", { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    control(kit.settingControl({ ...base, kind: "text" }, { onChange }), "input").fire("change", { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("list: one item per line", () => {
    const onChange = vi.fn();
    const f = kit.settingControl({ ...base, kind: "list", default: [], maxItems: 50 }, { value: ["x", "y"], onChange }) as FakeElement;
    const t = control(f, "textarea");
    expect(t.value).toBe("x\ny");
    t.fire("change", { target: { value: "a\n\n b " } });
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);
    expect(hint(f)).toContain("One per line.");
    expect(hint(f)).toContain("Default: none.");
    expect(hint(f)).toContain("At most 50 items.");
  });

  it("list of records: parts in the order of the fields", () => {
    const onChange = vi.fn();
    const f = kit.settingControl(records, { value: [{ catalogue: "core", version: "1.0.0", digest: "sha256:ab" }], onChange }) as FakeElement;
    const t = control(f, "textarea");
    expect(t.value).toBe("core 1.0.0 sha256:ab");
    t.fire("change", { target: { value: "core 1.0.0 sha256:ab\n\nx 2.0.0" } });
    expect(onChange).toHaveBeenLastCalledWith([{ catalogue: "core", version: "1.0.0", digest: "sha256:ab" }, { catalogue: "x", version: "2.0.0" }]);
    t.fire("change", { target: { value: "a b c d e" } });
    expect(onChange).toHaveBeenLastCalledWith([{ catalogue: "a", version: "b", digest: "c d e" }]);
    expect(hint(f)).toContain("One per line: catalogue version digest.");
  });

  it("choice: a select; Not set only when optional", () => {
    const onChange = vi.fn();
    const choice = { ...base, kind: "choice", choices: ["read", "write"], default: "write" };
    const s = control(kit.settingControl(choice, { value: "read", onChange }), "select");
    expect(s.all("option").map((o) => o.value)).toEqual(["read", "write"]);
    s.fire("change", { target: { value: "write" } });
    expect(onChange).toHaveBeenLastCalledWith("write");
    const o = control(kit.settingControl({ ...choice, optional: true }, { onChange }), "select");
    expect(o.all("option").map((x) => [x.value, x.textContent])[0]).toEqual(["", "Not set"]);
    o.fire("change", { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("hint: help, default, range and when it takes effect", () => {
    expect(hint(kit.settingControl(number))).toBe("How many resumes. Default: 5. Allowed: 1 to 49. Takes effect at once.");
    expect(hint(kit.settingControl({ ...number, min: undefined, max: undefined, exclusiveMin: 0 }))).toContain("More than 0.");
    expect(hint(kit.settingControl({ ...number, min: 2, max: undefined }))).toContain("At least 2.");
    expect(hint(kit.settingControl({ ...number, min: undefined }))).toContain("At most 49.");
    expect(hint(kit.settingControl({ ...records, default: [{ catalogue: "a", version: "1.0.0" }, { catalogue: "b", version: "2.0.0" }] }))).toContain("Default: a 1.0.0, b 2.0.0.");
  });

  it("error: one alert, aria-invalid and the id in aria-describedby", () => {
    for (const d of [number, { ...base, kind: "yes-no" }]) {
      const f = kit.settingControl(d, { error: "Too big." }) as FakeElement;
      const alerts = f.all("div").filter((x) => x.getAttribute("role") === "alert");
      expect(alerts.length).toBe(1);
      expect(alerts[0]!.textContent).toBe("Too big.");
      const i = control(f, "input");
      expect(i.getAttribute("aria-invalid")).toBe("true");
      expect(i.getAttribute("aria-describedby")).toContain(alerts[0]!.getAttribute("id"));
      expect(cls(f)).toContain("scf-field--error");
    }
    expect(control(kit.settingControl(number), "input").getAttribute("aria-invalid")).toBeNull();
  });

  it("disabled reaches the control", () => {
    expect(control(kit.settingControl(number, { disabled: true }), "input").getAttribute("disabled")).toBe("");
    expect(control(kit.settingControl({ ...base, kind: "yes-no" }, { disabled: true }), "input").getAttribute("disabled")).toBe("");
  });

  it("throws for an unknown kind, a blank label and a style prop", () => {
    expect(() => kit.settingControl({ ...number, kind: "color" })).toThrow(/unknown setting kind/);
    expect(() => kit.settingControl({ ...number, label: " " })).toThrow(/needs a label/);
    expect(() => kit.settingControl(number, { style: {} })).toThrow(/inline style/);
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
