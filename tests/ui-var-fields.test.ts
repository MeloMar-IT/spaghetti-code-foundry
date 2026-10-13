import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/var-fields.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const info = {
  github_repo: { set_by_run: true },
  risk: { label: "Risk", help: "How risky", kind: "number", min: 0, max: 100 },
  approve: { label: "Approve", kind: "yes_no" },
  cmd: { label: "Command", kind: "text" },
  docs: { label: "Docs", kind: "list", separator: "comma" },
  mode: { label: "Mode", kind: "choice", choices: ["", "fast", "safe"] },
  agent_env: { label: "Env", kind: "list", separator: "line" },
};
const defaults = { risk: "70", approve: "yes", cmd: "auto", docs: "a,b", mode: "fast", agent_env: "" };
const make = (values: Record<string, string> = {}) => mod.varFields({ info, defaults, values });

describe("splitVars", () => {
  it("sends described variables to fields and the rest to the box, whatever their value", () => {
    const { fields, rest } = mod.splitVars({ risk: "abc", cmd: "", other: "x", github_repo: "o/a", mode: "zzz" }, info);
    expect(fields).toEqual({ risk: "abc", cmd: "", mode: "zzz" });
    expect(rest).toEqual({ other: "x", github_repo: "o/a" });
  });
});

describe("lists", () => {
  it("splits and joins by separator, and pairs on a line or semicolon", () => {
    expect(mod.listItems("a, b\nc", "comma")).toEqual(["a", "b", "c"]);
    expect(mod.listItems("a b  c", "space")).toEqual(["a", "b", "c"]);
    expect(mod.listItems("a b\n c", "line")).toEqual(["a b", "c"]);
    expect(mod.listItems("A=1;B=2\nC=3", "line", true)).toEqual(["A=1", "B=2", "C=3"]);
    expect(mod.joinItems(["a", "b"], "comma")).toBe("a,b");
    expect(mod.joinItems(["a", "b"], "space")).toBe("a b");
    expect(mod.joinItems(["a", "b"], "line")).toBe("a\nb");
  });
});

describe("varFields", () => {
  it("draws one control per described variable, in order, without set_by_run ones", () => {
    const f = make();
    expect(Object.keys(f.controls)).toEqual(["risk", "approve", "cmd", "docs", "mode", "agent_env"]);
    const risk = f.controls.risk as FakeElement;
    expect([risk.attrs.type, risk.attrs.min, risk.attrs.max, risk.attrs.placeholder]).toEqual(["number", "0", "100", "70"]);
    expect((f.controls.approve as FakeElement).checked).toBe(true);
    expect((f.controls.cmd as FakeElement).attrs.placeholder).toBe("auto");
    expect(walk(f.el).find((e) => e.tag === "small")!.textContent).toBe("How risky");
    expect(walk(f.controls.docs).some((e) => e.textContent === "Default: a, b")).toBe(true);
    expect((f.controls.mode as FakeElement).children.map((o) => (o as FakeElement).textContent)).toEqual(["Default (fast)", "(empty)", "fast", "safe"]);
  });

  it("has no element for a flow that describes nothing", () => {
    expect(mod.varFields({ info: {}, defaults: {}, values: {} }).el).toBeNull();
    expect(mod.varFields({ info: undefined, defaults: undefined, values: undefined }).read()).toEqual({ values: {} });
  });

  it("renders a variable made up in the test with no code change", () => {
    const f = mod.varFields({ info: { brand_new: { label: "Brand new", kind: "number", min: 1 } }, defaults: { brand_new: "3" }, values: {} });
    expect((f.controls.brand_new as FakeElement).attrs.min).toBe("1");
    expect(walk(f.el).some((e) => e.textContent === "Brand new")).toBe(true);
  });

  it("returns nothing for a field left at its default", () => {
    const f = make({ risk: "70.0", approve: "yes", docs: "a, b" });
    expect(f.read()).toEqual({ values: { risk: undefined, approve: undefined, cmd: undefined, docs: undefined, mode: undefined, agent_env: undefined } });
  });

  it("returns a changed value and drops one set back to the default", () => {
    const f = make({ risk: "abc" });
    const risk = f.controls.risk as FakeElement;
    expect(risk.value).toBe("abc"); // an invalid stored value stays visible
    expect(f.read().values.risk).toBe("abc"); // untouched: kept as it is
    risk.value = "70"; // typed back to the default: the old override goes
    expect(f.read().values.risk).toBeUndefined();
    risk.value = "80";
    expect(f.read().values.risk).toBe("80");
    risk.value = "";
    expect(f.read().values.risk).toBeUndefined();
  });

  it("keeps an empty text or list override over a non-empty default, and returns to the default on request", () => {
    const f = make();
    const use = (name: string) => walk(f.el).find((e) => e.attrs["aria-label"] === `Use default for ${info[name as keyof typeof info].label}`)!;
    expect(use("cmd").checked).toBe(true);
    // Typing clears "Use default"; clearing the text again is an empty override.
    (f.controls.cmd as FakeElement).fire("input");
    (f.controls.cmd as FakeElement).value = "";
    expect(use("cmd").checked).toBe(false);
    expect(f.read().values.cmd).toBe("");
    use("cmd").checked = true;
    expect(f.read().values.cmd).toBeUndefined();
    // A list: removing the last item leaves an empty override of "a,b".
    const g = make({ docs: "x" });
    walk(g.controls.docs).find((e) => e.tag === "button" && e.textContent === "✕")!.click();
    expect(g.read().values.docs).toBe("");
    // A stored empty value stays an override when the field is untouched, and shows "Use default" off.
    const h2 = make({ cmd: "", docs: "" });
    expect(h2.read().values).toMatchObject({ cmd: "", docs: "" });
    expect(walk(h2.el).filter((e) => e.attrs.type === "checkbox" && ["Use default for Command", "Use default for Docs"].includes(e.attrs["aria-label"]!)).every((e) => !e.checked)).toBe(true);
  });

  it("reads a switch and a text field", () => {
    const f = make();
    (f.controls.approve as FakeElement).checked = false;
    (f.controls.cmd as FakeElement).value = "npm test";
    expect(f.read().values).toMatchObject({ approve: "no", cmd: "npm test" });
  });

  it("keeps an unchanged list as its original text, and reads an edited one", () => {
    const f = make({ docs: "x, y", agent_env: "A=1\nB=2" });
    expect(f.read().values).toMatchObject({ docs: "x, y", agent_env: "A=1\nB=2" });
    const rows = walk(f.controls.docs).filter((e) => e.tag === "input");
    expect(rows.map((r) => r.value)).toEqual(["x", "y"]);
    rows[1]!.value = "z";
    expect(f.read().values.docs).toBe("x,z");
  });

  it("corrects an invalid choice to its default, and selects, saves and reopens an empty-string choice", () => {
    const f = make({ mode: "zzz" });
    const sel = f.controls.mode as FakeElement;
    expect(sel.children.map((o) => (o as FakeElement).textContent).at(-1)).toBe("zzz (not a choice)");
    expect(f.read().values.mode).toBe("zzz");
    sel.value = "default";
    expect(f.read().values.mode).toBeUndefined();
    sel.value = "c0"; // the choice ""
    expect(f.read().values.mode).toBe("");
    const again = make({ mode: "" });
    expect((again.controls.mode as FakeElement).value).toBe("c0");
    expect(again.read().values.mode).toBe("");
  });

  it("shows agent_env as KEY / value rows with the secrets note, and refuses a row without a KEY", () => {
    const f = make({ agent_env: "A=1" });
    expect(walk(f.el).some((e) => e.tag === "small" && e.textContent.startsWith("May contain secrets"))).toBe(true);
    const inputs = walk(f.controls.agent_env).filter((e) => e.tag === "input");
    expect(inputs.map((i) => [i.attrs.placeholder, i.value])).toEqual([["KEY", "A"], ["value", "1"]]);
    inputs[0]!.value = "";
    expect(f.read().error).toBe('vars.agent_env: "=1" should be KEY=value');
    expect(f.read({ lenient: true }).values.agent_env).toBeUndefined();
    inputs[0]!.value = "B";
    expect(f.read().values.agent_env).toBe("B=1");
  });

  it("add and remove rows", () => {
    const f = make({ docs: "x" });
    const buttons = walk(f.controls.docs).filter((e) => e.tag === "button");
    buttons.find((b) => b.textContent === "+ Add")!.click();
    expect(walk(f.controls.docs).filter((e) => e.tag === "input")).toHaveLength(2);
    buttons.find((b) => b.textContent === "✕")!.click();
    expect(walk(f.controls.docs).filter((e) => e.tag === "input")).toHaveLength(1);
  });

  it("mergeVars sets and removes", () => {
    expect(mod.mergeVars({ a: "1", b: "2" }, { a: undefined, c: "3" })).toEqual({ b: "2", c: "3" });
  });
});
