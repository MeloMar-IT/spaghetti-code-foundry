import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitCssImports, kitCssProblems, kitSourceProblems, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let kit: any;
let core: any;

beforeAll(async () => {
  restore = installFakeDom();
  kit = await import("../ui/kit/actions.js" as string);
  core = await import("../ui/kit/core.js" as string);
});
afterAll(() => restore());

const cls = (e: FakeElement) => e.getAttribute("class");

describe("button", () => {
  it("is a plain button of type button", () => {
    const b = kit.button({}, "Save", "!") as FakeElement;
    expect(b.tag).toBe("button");
    expect(b.getAttribute("type")).toBe("button");
    expect(cls(b)).toBe("scf-btn");
    expect(b.textContent).toBe("Save!");
  });
  it("keeps a given type", () => {
    expect(kit.button({ type: "submit" }).getAttribute("type")).toBe("submit");
  });
  it("sets the classes of variant and size, and the caller class last", () => {
    expect(cls(kit.button({ variant: "primary" }))).toBe("scf-btn scf-btn--primary");
    expect(cls(kit.button({ variant: "danger", size: "small", class: "mine" }))).toBe("scf-btn scf-btn--danger scf-btn--small mine");
    expect(cls(kit.button({ variant: "ghost" }))).toBe("scf-btn scf-btn--ghost");
  });
  it("throws on an unknown variant or size", () => {
    expect(() => kit.button({ variant: "huge" })).toThrow(/variant/);
    expect(() => kit.button({ size: "big" })).toThrow(/size/);
  });
  it("sets disabled", () => {
    expect(kit.button({ disabled: true }).getAttribute("disabled")).toBe("");
    expect(kit.button({}).getAttribute("disabled")).toBeNull();
  });
  it("busy: marks itself, shows a spinner and ignores clicks", () => {
    const onClick = vi.fn();
    const b = kit.button({ busy: true, onClick }, "Go") as FakeElement;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("disabled")).toBeNull();
    expect(cls(b)).toContain("scf-btn--busy");
    const spinner = b.children[0] as FakeElement;
    expect(spinner.tag).toBe("svg");
    expect(cls(spinner)).toContain("spin");
    const preventDefault = vi.fn();
    b.fire("click", { preventDefault });
    expect(onClick).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    b.click();
    expect(onClick).not.toHaveBeenCalled();
  });
  it("calls onClick once when not busy", () => {
    const onClick = vi.fn();
    kit.button({ onClick }, "Go").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("passes data-focus and id through", () => {
    const b = kit.button({ "data-focus": "save", id: "x" });
    expect(b.getAttribute("data-focus")).toBe("save");
    expect(b.getAttribute("id")).toBe("x");
  });
  it("throws on a style prop", () => {
    expect(() => kit.button({ style: { color: "x" } })).toThrow(/inline style/);
  });
});

describe("iconButton", () => {
  it("needs a label", () => {
    for (const label of [undefined, "", "   "]) expect(() => kit.iconButton({ icon: "x", label })).toThrow(/needs a label/);
  });
  it("uses the label as name and title", () => {
    const b = kit.iconButton({ icon: "x", label: "Close" }) as FakeElement;
    expect(b.getAttribute("aria-label")).toBe("Close");
    expect(b.getAttribute("title")).toBe("Close");
  });
  it("is a ghost icon button with only a hidden icon", () => {
    const b = kit.iconButton({ icon: "x", label: "Close" }) as FakeElement;
    expect(cls(b)).toBe("scf-btn scf-btn--ghost scf-btn--icon");
    expect(b.children).toHaveLength(1);
    const svg = b.children[0] as FakeElement;
    expect(svg.tag).toBe("svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
  it("throws on an unknown icon", () => {
    expect(() => kit.iconButton({ icon: "nope", label: "L" })).toThrow(/unknown icon/);
  });
});

describe("link", () => {
  it("is an anchor with href and class", () => {
    const a = kit.link({ href: "#/runs" }, "Runs") as FakeElement;
    expect(a.tag).toBe("a");
    expect(a.getAttribute("href")).toBe("#/runs");
    expect(cls(a)).toBe("scf-link");
    expect(a.textContent).toBe("Runs");
  });
  it("sets rel and target only when external", () => {
    const a = kit.link({ href: "/x" }, "x") as FakeElement;
    expect(a.getAttribute("rel")).toBeNull();
    expect(a.getAttribute("target")).toBeNull();
    const e = kit.link({ href: "https://example.test", external: true }, "x") as FakeElement;
    expect(e.getAttribute("rel")).toBe("noopener noreferrer");
    expect(e.getAttribute("target")).toBe("_blank");
  });
  it("disabled has no href and says aria-disabled", () => {
    const a = kit.link({ href: "/x", external: true, disabled: true }, "x") as FakeElement;
    expect(a.getAttribute("href")).toBeNull();
    expect(a.getAttribute("target")).toBeNull();
    expect(a.getAttribute("aria-disabled")).toBe("true");
    expect(a.getAttribute("role")).toBe("link");
    expect(cls(a)).toBe("scf-link scf-link--disabled");
  });
  it("disabled cannot be activated or focused, whatever the caller passes", () => {
    const onClick = vi.fn();
    const onKeydown = vi.fn();
    const a = kit.link({ href: "/x", disabled: true, onClick, onKeydown, tabindex: "0" }, "x") as FakeElement;
    expect(a.getAttribute("tabindex")).toBe("-1");
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    a.fire("click", event);
    a.fire("keydown", event);
    expect(onClick).not.toHaveBeenCalled();
    expect(onKeydown).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
  it("needs an href", () => {
    expect(() => kit.link({}, "x")).toThrow(/href/);
    expect(() => kit.link({ href: " " }, "x")).toThrow(/href/);
  });
  it("throws on a style prop", () => {
    expect(() => kit.link({ href: "/x", style: {} }, "x")).toThrow(/inline style/);
  });
});

describe("core", () => {
  it("cx skips empty values", () => {
    expect(core.cx("a", "", undefined, false, null, "b")).toBe("a b");
  });
  it("nextId gives different ids", () => {
    expect(core.nextId("p")).not.toBe(core.nextId("p"));
  });
  it("rest throws on style", () => {
    expect(() => core.rest({ style: undefined })).toThrow();
    expect(core.rest({ id: "x" })).toEqual({ id: "x" });
  });
});

describe("kit CSS", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("kit.css imports every other css file in ui/kit, in order", () => {
    expect(kitCssImports()).toEqual(["/kit/actions.css", "/kit/forms.css", "/kit/display.css", "/kit/overlays.css", "/kit/product.css"]);
    const files = readdirSync("ui/kit").filter((f) => f.endsWith(".css") && f !== "kit.css").map((f) => `/kit/${f}`).sort();
    expect([...kitCssImports()].sort()).toEqual(files);
  });
  it("actions.css has only kit selectors, tokens and no colour literals", () => {
    expect(kitCssProblems(read("ui/kit/actions.css"), tokenNames())).toEqual([]);
  });
  it("actions.css keeps the states that must win over the global button rule", () => {
    const css = read("ui/kit/actions.css");
    expect(css).toContain(".scf-btn--primary:hover");
    expect(css).toContain(".scf-btn:disabled");
  });
  it("a disabled ghost button stays flat on hover: its rule comes after the hover rule", () => {
    const css = read("ui/kit/actions.css");
    expect(css.indexOf(".scf-btn--ghost:disabled")).toBeGreaterThan(css.indexOf(".scf-btn--ghost:hover"));
    expect(css.lastIndexOf(".scf-btn--ghost:hover")).toBeLessThan(css.indexOf(".scf-btn--ghost:disabled"));
  });
  it("both pages link /kit/kit.css after /style.css", () => {
    for (const p of ["ui/index.html", "ui/user/index.html"]) {
      const text = read(p);
      expect(text.indexOf('href="/kit/kit.css"'), p).toBeGreaterThan(text.indexOf('href="/style.css"'));
    }
  });
});

describe("kit CSS checker", () => {
  const tokens = new Set(["--color-text", "--accent"]);
  const bad = [
    "#x { }", "button { }", ".scf-a span { }", ".card { }", ".scf-a { color: #fff }", ".scf-a { color: red }",
    ".scf-a { color: rebeccapurple }", ".scf-a { background: rgb(0 0 0) }", ".scf-a { color: var(--nope) }", ".scf-a { color: var(--accent) }",
  ];
  it.each(bad)("finds a problem in %s", (css) => {
    expect(kitCssProblems(css, tokens)).toHaveLength(1);
  });
  it("accepts good rules, also inside @media", () => {
    const good = '.scf-a:hover > .scf-b[aria-busy="true"] { color: var(--color-text); border-color: transparent }';
    expect(kitCssProblems(good, tokens)).toEqual([]);
    expect(kitCssProblems(`@media (min-width: 600px) { ${good} }`, tokens)).toEqual([]);
  });
});

describe("kit source", () => {
  it("has no inline style in core.js and actions.js", () => {
    for (const f of ["core", "actions"]) expect(kitSourceProblems(readFileSync(`ui/kit/${f}.js`, "utf8")), f).toEqual([]);
  });
  it("finds the ways to pass a style", () => {
    for (const src of ['h("a", { style: { x: 1 } })', 'h("a", { "style": 1 })', "h('a', { style })", "el.style.x = 1", "style = 1"]) {
      expect(kitSourceProblems(src).length, src).toBeGreaterThan(0);
    }
    expect(kitSourceProblems('Object.hasOwn(props, "style")')).toEqual([]);
  });
});
