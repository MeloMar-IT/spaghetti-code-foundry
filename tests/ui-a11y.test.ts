import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { audit, auditHtml, parseHtml, type Violation } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let dom: any;
let shell: any;
let ia: any;
const doc = () => (globalThis as any).document;
const read = (p: string) => readFileSync(p, "utf8");

beforeAll(async () => {
  restore = installFakeDom();
  dom = await import("../ui/dom.js" as string);
  shell = await import("../ui/shell.js" as string);
  ia = await import("../ui/ia.js" as string);
});
afterAll(() => restore());
beforeEach(() => {
  restore();
  restore = installFakeDom();
});

const h = (tag: string, props: object = {}, ...kids: unknown[]): FakeElement => dom.h(tag, props, ...kids);
const root = (...kids: unknown[]) => h("div", {}, ...kids);
const rules = (el: FakeElement) => audit(el).map((v: Violation) => v.rule);

describe("control-name", () => {
  it("fails for controls without a name", () => {
    expect(rules(root(h("button")))).toEqual(["control-name"]);
    expect(rules(root(h("a", { href: "#/x" }, h("span", { "aria-hidden": "true" }, "✕"))))).toEqual(["control-name"]);
    expect(rules(root(h("div", { role: "button" })))).toEqual(["control-name"]);
    expect(rules(root(h("div", { role: "link" })))).toEqual(["control-name"]);
    expect(rules(root(h("summary")))).toEqual(["control-name"]);
  });
  it("accepts a name set through textContent after creation, but not inside aria-hidden", () => {
    const b = h("button");
    b.textContent = "Health";
    expect(rules(root(b))).toEqual([]);
    const s = h("span", { "aria-hidden": "true" });
    s.textContent = "✕";
    expect(rules(root(h("button", {}, s)))).toEqual(["control-name"]);
  });
  it("passes with text, aria-label or aria-labelledby", () => {
    expect(rules(root(h("button", {}, "Save")))).toEqual([]);
    expect(rules(root(h("button", { "aria-label": "Close" })))).toEqual([]);
    expect(rules(root(h("span", { id: "t" }, "Name"), h("button", { "aria-labelledby": "t" })))).toEqual([]);
  });
  it("fails when aria-labelledby points nowhere or at nothing", () => {
    expect(rules(root(h("button", { "aria-labelledby": "missing" })))).toEqual(["control-name"]);
    expect(rules(root(h("span", { id: "t" }), h("button", { "aria-labelledby": "t" })))).toEqual(["control-name"]);
  });
  it("does not check an a without href", () => {
    expect(rules(root(h("a", {})))).toEqual([]);
  });
});

describe("field-label", () => {
  it("fails for a bare field, and placeholder or title do not count", () => {
    expect(rules(root(h("input")))).toEqual(["field-label"]);
    expect(rules(root(h("input", { placeholder: "Name" })))).toEqual(["field-label"]);
    expect(rules(root(h("select", { title: "Pick" })))).toEqual(["field-label"]);
    expect(rules(root(h("textarea")))).toEqual(["field-label"]);
  });
  it("passes inside a label, with aria-label or with aria-labelledby", () => {
    expect(rules(root(h("label", {}, "Notes", h("textarea"))))).toEqual([]);
    expect(rules(root(h("input", { "aria-label": "Name" })))).toEqual([]);
    expect(rules(root(h("span", { id: "n" }, "Name"), h("input", { "aria-labelledby": "n" })))).toEqual([]);
  });
  it("does not accept a sibling label", () => {
    expect(rules(root(h("label", {}, "Name"), h("input")))).toEqual(["field-label"]);
  });
  it("checks every input, also type hidden", () => {
    expect(rules(root(h("input", { type: "hidden" })))).toEqual(["field-label"]);
  });
});

describe("click-needs-key", () => {
  const noop = () => {};
  it("fails for a custom control that is missing role, tabindex or keydown", () => {
    expect(rules(root(h("div", { onClick: noop })))).toContain("click-needs-key");
    expect(rules(root(h("div", { role: "button", "aria-label": "x", tabindex: 0, onClick: noop })))).toEqual(["click-needs-key"]);
    expect(rules(root(h("div", { role: "button", "aria-label": "x", tabindex: -1, onClick: noop, onKeydown: noop })))).toEqual(["click-needs-key"]);
    expect(rules(root(h("div", { tabindex: 0, onClick: noop, onKeydown: noop })))).toEqual(["click-needs-key"]);
    expect(rules(root(h("a", { onClick: noop }, "x")))).toEqual(["click-needs-key"]);
    expect(rules(root(h("div", { "data-a11y-skip": "other", onClick: noop })))).toEqual(["click-needs-key"]);
  });
  it("does not let label or option escape the rule", () => {
    expect(rules(root(h("label", { onClick: noop }, "x")))).toEqual(["click-needs-key"]);
    expect(rules(root(h("option", { onClick: noop }, "x")))).toEqual(["click-needs-key"]);
  });
  it("passes for a full custom control, a native control, a stop-only listener, or a removed listener", () => {
    expect(rules(root(h("div", { role: "button", tabindex: 0, "aria-label": "x", onClick: noop, onKeydown: noop })))).toEqual([]);
    expect(rules(root(h("button", { onClick: noop }, "x")))).toEqual([]);
    expect(rules(root(h("a", { href: "#/x", onClick: noop }, "x")))).toEqual([]);
    expect(rules(root(h("div", { "data-a11y-skip": "stop", onClick: noop })))).toEqual([]);
    const d = h("div", {});
    d.addEventListener("click", noop);
    d.removeEventListener("click", noop);
    expect(rules(root(d))).toEqual([]);
  });
  it("does not exempt delegate or backdrop", () => {
    expect(rules(root(h("div", { "data-a11y-skip": "delegate", onClick: noop })))).toEqual(["click-needs-key"]);
    expect(rules(root(h("div", { "data-a11y-skip": "backdrop", onClick: noop })))).toEqual(["click-needs-key"]);
  });
});

describe("no-positive-tabindex", () => {
  it("fails for 1 and passes for 0 and -1", () => {
    expect(rules(root(h("div", { tabindex: 1 })))).toEqual(["no-positive-tabindex"]);
    expect(rules(root(h("div", { tabindex: 0 })))).toEqual([]);
    expect(rules(root(h("div", { tabindex: -1 })))).toEqual([]);
  });
  it("also looks into hidden elements", () => {
    const d = h("div", { tabindex: 3 });
    d.hidden = true;
    expect(rules(root(d))).toEqual(["no-positive-tabindex"]);
  });
});

describe("img-name", () => {
  it("fails for an img without a name and an svg image without a name", () => {
    expect(rules(root(h("img")))).toEqual(["img-name"]);
    expect(rules(root(h("img", { alt: "" })))).toEqual(["img-name"]);
    expect(rules(root(h("svg", { role: "img" })))).toEqual(["img-name"]);
  });
  it("passes with alt, aria-label, a title child or no role", () => {
    expect(rules(root(h("img", { alt: "x" })))).toEqual([]);
    expect(rules(root(h("img", { "aria-label": "x" })))).toEqual([]);
    expect(rules(root(h("svg", { role: "img", "aria-label": "Chart" })))).toEqual([]);
    expect(rules(root(h("svg", { role: "img" }, h("title", {}, "Chart"))))).toEqual([]);
    expect(rules(root(h("svg", {})))).toEqual([]);
  });
});

describe("dialog-name", () => {
  it("fails without aria-modal, without a name, or when the label is empty", () => {
    expect(rules(root(h("div", { role: "dialog", "aria-label": "x" })))).toEqual(["dialog-name"]);
    expect(rules(root(h("div", { role: "dialog", "aria-modal": "true" }, "text")))).toEqual(["dialog-name"]);
    expect(rules(root(h("h2", { id: "t" }), h("div", { role: "dialog", "aria-modal": "true", "aria-labelledby": "t" })))).toEqual(["dialog-name"]);
  });
  it("passes with aria-modal and aria-label or aria-labelledby", () => {
    expect(rules(root(h("div", { role: "dialog", "aria-modal": "true", "aria-label": "x" })))).toEqual([]);
    expect(rules(root(h("h2", { id: "t" }, "T"), h("div", { role: "dialog", "aria-modal": "true", "aria-labelledby": "t" })))).toEqual([]);
  });
  it("applies to role dialog only", () => {
    expect(rules(root(h("div", { role: "alertdialog" })))).toEqual([]);
  });
});

describe("focusable-hidden", () => {
  it("fails for a tab stop inside aria-hidden, or aria-hidden on the tab stop", () => {
    expect(rules(root(h("div", { "aria-hidden": "true" }, h("button", {}, "x"))))).toEqual(["focusable-hidden"]);
    expect(rules(root(h("button", { "aria-hidden": "true", "aria-label": "x" })))).toEqual(["focusable-hidden"]);
  });
  it("models sequential focus: disabled counts only on controls, any negative tabindex and hidden subtrees are out", () => {
    const hid = (...k: unknown[]) => Object.assign(h("div", { "aria-hidden": "true" }, ...k), {});
    expect(rules(root(hid(h("a", { href: "#/x", disabled: true, "aria-label": "x" }))))).toEqual(["focusable-hidden"]);
    expect(rules(root(hid(h("div", { tabindex: 0, disabled: true }))))).toEqual(["focusable-hidden"]);
    expect(rules(root(hid(h("button", { tabindex: -2, "aria-label": "x" }))))).toEqual([]);
    const gone = hid(h("button", { "aria-label": "x" }));
    gone.hidden = true;
    expect(rules(root(gone))).toEqual([]);
  });
  it("passes with tabindex -1, disabled (property or attribute) or aria-hidden false", () => {
    expect(rules(root(h("div", { "aria-hidden": "true" }, h("button", { tabindex: -1 }, "x"))))).toEqual([]);
    const off = h("button", {}, "x");
    off.disabled = true;
    expect(rules(root(h("div", { "aria-hidden": "true" }, off)))).toEqual([]);
    expect(rules(root(h("div", { "aria-hidden": "true" }, h("button", { disabled: true }, "x"))))).toEqual([]);
    expect(rules(root(h("div", { "aria-hidden": "false" }, h("button", {}, "x"))))).toEqual([]);
  });
});

describe("violation shape", () => {
  it("has rule, severity and a description with tag and id", () => {
    const v = audit(root(h("button", { id: "x", class: "icon" })));
    expect(v).toEqual([{ rule: "control-name", severity: "serious", element: "button#x.icon" }]);
  });
});

describe("parseHtml", () => {
  const page = (body: string) => `<!doctype html><!-- note --><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`;
  it("builds nested elements with parents, void tags and bare attributes", () => {
    const html = parseHtml(page('<div id="a"><input type="text" disabled><br><span class="x">Hi</span></div>'));
    expect(html.tag).toBe("html");
    expect(html.attrs.lang).toBe("en");
    const div = html.all("div")[0]!;
    expect(div.children.map((c) => (c as FakeElement).tag)).toEqual(["input", "br", "span"]);
    expect(div.all("input")[0]!.attrs).toEqual({ type: "text", disabled: "" });
    expect(div.all("span")[0]!.textContent).toBe("Hi");
    expect(div.all("span")[0]!.parent).toBe(div);
    expect(html.all("meta")).toHaveLength(1);
  });
  it("sets hidden as the property", () => {
    const el = parseHtml(page('<div id="a" hidden></div>')).all("div")[0]!;
    expect(el.hidden).toBe(true);
    expect("hidden" in el.attrs).toBe(false);
  });
  it("ignores comments and the doctype", () => {
    const html = parseHtml(page("<!-- <button></button> -->"));
    expect(html.all("button")).toHaveLength(0);
  });
  it("throws without an html element", () => {
    expect(() => parseHtml("<div></div>")).toThrow("parseHtml: no <html> element");
  });
});

describe("audit of an open modal()", () => {
  it("is clean for a labelled form", () => {
    void dom.modal("Title", () => h("form", {}, h("label", {}, "Name", h("input")), h("button", {}, "Save")));
    expect(audit(doc().getElementById("modal-root"))).toEqual([]);
  });
  it("reports an unlabelled field", () => {
    void dom.modal("Title", () => h("form", {}, h("input"), h("button", {}, "Save")));
    expect(rules(doc().getElementById("modal-root"))).toEqual(["field-label"]);
  });
});

describe("auditHtml", () => {
  it("is clean for both page files", () => {
    expect(auditHtml(read("ui/index.html"))).toEqual([]);
    expect(auditHtml(read("ui/user/index.html"))).toEqual([]);
  });
  it("reports a missing lang as moderate, and an empty control", () => {
    expect(auditHtml("<html><body><button></button></body></html>")).toEqual([
      { rule: "control-name", severity: "serious", element: "button" },
      { rule: "lang", severity: "moderate", element: "html" },
    ]);
    expect(auditHtml('<html lang=""><body></body></html>')).toEqual([{ rule: "lang", severity: "moderate", element: "html" }]);
  });
  it("reports a bare input and leaves other rules out", () => {
    expect(auditHtml('<html lang="en"><body><input></body></html>').map((v) => v.rule)).toEqual(["field-label"]);
    expect(auditHtml('<html lang="en"><body><div tabindex="5"></div></body></html>')).toEqual([]);
  });
});

const mkMedia = (matches: boolean) => Object.assign(new FakeElement("media"), { matches });
const mkStore = (value: string | null) => ({ getItem: () => value, setItem: () => {} });

describe.each([
  ["ui/index.html", "admin", ["#/users", "#/runs/r1"]],
  ["ui/user/index.html", "user", ["#/runs/a"]],
] as const)("the shell of %s", (file, role, hashes) => {
  let stop: (() => void) | undefined;
  let body: FakeElement;
  let byId: Map<string, FakeElement>;
  const saved: Record<string, unknown> = {};

  beforeEach(() => {
    const html = parseHtml(read(file));
    body = html.all("body")[0]!;
    byId = new Map();
    const index = (el: FakeElement) => {
      if (el.attrs.id) byId.set(el.attrs.id, el);
      for (const c of el.children) if (c instanceof FakeElement) index(c);
    };
    index(body);
    const d = doc();
    for (const k of ["body", "getElementById", "querySelectorAll"]) saved[k] = d[k];
    d.body = body;
    d.getElementById = (id: string) => byId.get(id) ?? null;
    d.querySelectorAll = (s: string) => body.querySelectorAll(s);
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  const draw = (media: boolean) => {
    stop = shell.initShell(role, { store: mkStore(null), media: mkMedia(media), user: { name: "Ann" } });
    for (const hash of hashes) shell.showPage(role, ia.resolve(role, hash));
  };

  it("has no violations on a wide screen", () => {
    draw(false);
    expect(audit(body)).toEqual([]);
  });
  it("has no violations with the drawer open", () => {
    draw(true);
    byId.get("menu-btn")!.click();
    expect(byId.get("scrim")!.hidden).toBe(false);
    expect(audit(body)).toEqual([]);
  });
  it("reports a click listener on the sidebar itself", () => {
    draw(false);
    byId.get("side")!.addEventListener("click", () => {});
    expect(rules(body)).toEqual(["click-needs-key"]);
  });
});

describe("ui/style.css", () => {
  const style = readUiCss().replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string, indent = ""): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^${indent}${esc} \\{([^}]*)\\}`, "m").exec(style);
    if (!m) throw new Error(`no rule for ${selector}`);
    return m[1]!;
  };

  it("turns the spinner, toast and chart tip motion off under reduced motion", () => {
    const m = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(style);
    expect(m).not.toBeNull();
    expect(m![1]).toContain(".spinner { animation: none; }");
    expect(m![1]).toMatch(/#toast, \.chart-tip \{[^}]*transition: none/);
  });

  it("shows a focus mark on chart bars", () => {
    expect(rule(".chart .bar-hit:focus-visible")).toMatch(/outline: 2px solid var\(--color-focus\)/);
    expect(style).not.toContain(".bar-hit:focus {");
    for (const m of style.matchAll(/^([^{}\n]*bar-hit[^{}\n]*) \{([^}]*)\}/gm)) expect(m[2], m[1]).not.toMatch(/outline: none/);
  });

  it("uses :focus-visible with the same outline on fields", () => {
    expect(rule("input:focus-visible, select:focus-visible, textarea:focus-visible")).toMatch(/outline: 2px solid var\(--color-focus\)/);
    expect(style).not.toMatch(/(input|select|textarea):focus(?!-)/);
  });

  it("keeps buttons, table links and icon buttons at least 24 × 24 px", () => {
    const r = rule("button, .btn, .table a");
    expect(r).toContain("min-width: 24px");
    expect(r).toContain("min-height: 24px");
    expect(rule(".table a")).toContain("inline-block");
    for (const m of style.matchAll(/^([^{}\n]*button[^{}\n]*) \{([^}]*)\}/gm)) {
      for (const d of m[2]!.matchAll(/(?:^|[\s;])(height|min-height|min-width):\s*(\d+)px/g)) expect(Number(d[2]), `${m[1]} ${d[1]}`).toBeGreaterThanOrEqual(24);
    }
  });

  it("does not scroll the page sideways at 320 px", () => {
    expect(rule(".table-box")).toContain("overflow-x: auto");
    const blocks = [...style.matchAll(/@media \(max-width: 767px\) \{([\s\S]*?)\n\}/g)];
    const last = blocks.map((b) => b[1]).join("\n");
    expect(last).toContain(".table { display: block; overflow-x: auto; }");
    expect(last).toContain(".table-box > .table { display: table");
    expect(last).toMatch(/\.top \{[^}]*flex-wrap: wrap/);
    expect(last).toMatch(/main pre \{[^}]*overflow-x: auto/);
    for (const m of style.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/gm)) expect(Number(m[1])).toBeLessThanOrEqual(320);
  });

  it("makes the toast a live region in both HTML files", () => {
    for (const f of ["ui/index.html", "ui/user/index.html"]) expect(read(f)).toMatch(/<div id="toast"[^>]*role="status"/);
    for (const f of ["ui/index.html", "ui/user/index.html"]) expect(read(f)).toMatch(/<div id="toast"[^>]*aria-live="polite"/);
  });
});
