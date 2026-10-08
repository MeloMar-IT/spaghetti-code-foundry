import { FakeElement } from "./fake-dom.js";

// A small accessibility check for the fake DOM. It walks the tree directly (the fake querySelectorAll is too small).
// It is a test aid, not a full audit: it covers the rules in `audit` and nothing else.

export type Violation = { rule: string; severity: "serious" | "moderate"; element: string };

const kids = (el: FakeElement): FakeElement[] => el.children.filter((c): c is FakeElement => c instanceof FakeElement);

function walk(el: FakeElement, out: FakeElement[] = []): FakeElement[] {
  out.push(el);
  for (const c of kids(el)) walk(c, out);
  return out;
}

const attr = (el: FakeElement, k: string): string | undefined => el.attrs[k];
const has = (el: FakeElement, k: string): boolean => k in el.attrs;

/** The text a screen reader would read from the content: aria-hidden subtrees are left out. */
function text(el: FakeElement): string {
  if (attr(el, "aria-hidden") === "true") return "";
  // Text set through `textContent` is kept apart from `children`; the getter returns it.
  if (!el.children.length) return el.textContent.trim();
  return el.children.map((c) => (typeof c === "string" ? c : c instanceof FakeElement ? text(c) : "")).join("").trim();
}

function describe(el: FakeElement): string {
  const cls = attr(el, "class")?.trim().split(/\s+/).filter(Boolean).join(".");
  const t = el.textContent.trim().slice(0, 30);
  return `${el.tag}${attr(el, "id") ? `#${attr(el, "id")}` : ""}${cls ? `.${cls}` : ""}${t ? ` "${t}"` : ""}`;
}

/** The text of the element(s) named by aria-labelledby, or "" when none of the ids exists. */
function labelledText(el: FakeElement, ids: Map<string, FakeElement>): string {
  return (attr(el, "aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => {
    const t = ids.get(id);
    return t ? (t.textContent ?? "").trim() : "";
  }).join(" ").trim();
}

const named = (el: FakeElement, ids: Map<string, FakeElement>): boolean =>
  !!(attr(el, "aria-label")?.trim() || labelledText(el, ids));

const nameOf = (el: FakeElement, ids: Map<string, FakeElement>): boolean => named(el, ids) || !!text(el);

const NATIVE = new Set(["button", "input", "select", "textarea", "summary"]);
const isNative = (el: FakeElement): boolean => NATIVE.has(el.tag) || (el.tag === "a" && has(el, "href"));

// `disabled` only takes a control out of the tab order for the elements that support it.
const CAN_DISABLE = new Set(["button", "input", "select", "textarea"]);
const isDisabled = (el: FakeElement): boolean => CAN_DISABLE.has(el.tag) && (el.disabled || has(el, "disabled"));

function isTabStop(el: FakeElement): boolean {
  if (isDisabled(el) || Number(attr(el, "tabindex")) < 0) return false;
  for (let p: FakeElement | undefined = el; p; p = p.parent) if (p.hidden) return false;
  if (el.tag === "a") return has(el, "href") || has(el, "tabindex");
  if (el.tag === "input") return attr(el, "type") !== "hidden" || has(el, "tabindex");
  return ["button", "select", "textarea", "summary"].includes(el.tag) || has(el, "tabindex");
}

/** Checks the tree under `root` (and `root` itself); each element gets at most one violation per rule. */
export function audit(root: FakeElement): Violation[] {
  const all = walk(root);
  const ids = new Map<string, FakeElement>();
  for (const el of all) if (attr(el, "id")) ids.set(attr(el, "id")!, el);
  const out: Violation[] = [];
  const add = (rule: string, el: FakeElement) => out.push({ rule, severity: "serious", element: describe(el) });

  for (const el of all) {
    const role = attr(el, "role");
    if ((el.tag === "button" || (el.tag === "a" && has(el, "href")) || el.tag === "summary" || role === "button" || role === "link") && !nameOf(el, ids)) {
      add("control-name", el);
    }
    if (["input", "select", "textarea"].includes(el.tag)) {
      let inLabel = false;
      for (let p = el.parent; p; p = p.parent) if (p.tag === "label") inLabel = true;
      if (!inLabel && !named(el, ids)) add("field-label", el);
    }
    if (el.listeners.click?.length && !isNative(el) && attr(el, "data-a11y-skip") !== "stop") {
      if (!role || attr(el, "tabindex") !== "0" || !el.listeners.keydown?.length) add("click-needs-key", el);
    }
    if (Number(attr(el, "tabindex")) > 0) add("no-positive-tabindex", el);
    if (el.tag === "img" && !attr(el, "alt")?.trim() && !named(el, ids)) add("img-name", el);
    if (el.tag === "svg" && role === "img" && !named(el, ids) && !kids(el).some((c) => c.tag === "title" && c.textContent.trim())) add("img-name", el);
    if (role === "dialog" && (attr(el, "aria-modal") !== "true" || !named(el, ids))) add("dialog-name", el);
    if (isTabStop(el)) {
      for (let p: FakeElement | undefined = el; p; p = p.parent) {
        if (attr(p, "aria-hidden") === "true") { add("focusable-hidden", el); break; }
      }
    }
  }
  return out;
}

const VOID = new Set(["meta", "link", "input", "img", "br", "hr"]);

/** Parses a well-formed HTML file (double-quoted attributes only) into fake elements. Not a general HTML parser. */
export function parseHtml(source: string): FakeElement {
  const src = source.replace(/<!doctype[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g;
  const stack: FakeElement[] = [];
  let html: FakeElement | undefined;
  let last = 0;
  const addText = (s: string) => {
    if (s.trim() && stack.length) stack.at(-1)!.append(s);
  };
  for (let m = tag.exec(src); m; m = tag.exec(src)) {
    addText(src.slice(last, m.index));
    last = tag.lastIndex;
    const name = m[2]!.toLowerCase();
    if (m[1]) {
      const i = stack.map((e) => e.tag).lastIndexOf(name);
      if (i >= 0) stack.length = i;
      continue;
    }
    const el = new FakeElement(name);
    for (const a of m[3]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      if (a[1] === "hidden") el.hidden = true;
      else el.setAttribute(a[1]!, a[2] ?? "");
    }
    if (stack.length) stack.at(-1)!.append(el);
    else if (!html && name === "html") html = el;
    if (!VOID.has(name)) stack.push(el);
  }
  if (!html) throw new Error("parseHtml: no <html> element");
  return html;
}

/** The checks that make sense for a page file: control names, field labels and the language of the page. */
export function auditHtml(source: string): Violation[] {
  const html = parseHtml(source);
  const out = audit(html).filter((v) => v.rule === "control-name" || v.rule === "field-label");
  if (!attr(html, "lang")?.trim()) out.push({ rule: "lang", severity: "moderate", element: "html" });
  return out;
}
