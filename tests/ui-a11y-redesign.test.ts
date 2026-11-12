import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { audit, parseHtml } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { parseCss, readUiCss } from "./helpers/ui-css.js";
import { oldWordsIn } from "../ui/change-words.js";

// The new shell (sidebar), the phase strip and the composer: names, keyboard, plain words and colours that work in dark mode.
/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let dom: any, shell: any, ia: any, viewMode: any, product: any, composer: any;
const doc = () => (globalThis as any).document;
const read = (p: string) => readFileSync(p, "utf8");

beforeAll(async () => {
  restore = installFakeDom();
  dom = await import("../ui/dom.js" as string);
  shell = await import("../ui/shell.js" as string);
  ia = await import("../ui/ia.js" as string);
  viewMode = await import("../ui/view-mode.js" as string);
  product = await import("../ui/kit/product.js" as string);
  composer = await import("../ui/composer.js" as string);
});
afterAll(() => restore());
beforeEach(() => {
  restore();
  restore = installFakeDom();
});

const mkMedia = (matches: boolean) => Object.assign(new FakeElement("media"), { matches });
const mkStore = () => ({ getItem: () => null, setItem: () => {} });
const text = (el: FakeElement) => el.textContent.replace(/\s+/g, " ").trim();
/** The text of an element plus the names of the images inside it, as a screen reader says it. */
const said = (el: FakeElement): string => [el.attrs["aria-label"] ?? "", ...el.children.map((c) => (typeof c === "string" ? c : c instanceof FakeElement ? said(c) : ""))].join(" ").replace(/\s+/g, " ").trim();

describe.each([
  ["ui/index.html", "admin", "admin"],
  ["ui/user/index.html", "user", "advanced"],
  ["ui/user/index.html", "user", "simple"],
] as const)("the sidebar of %s in the %s view (%s)", (file, role, view) => {
  let stop: (() => void) | undefined;
  let body: FakeElement;
  let byId: Map<string, FakeElement>;

  beforeEach(() => {
    body = parseHtml(read(file)).all("body")[0]!;
    byId = new Map();
    const index = (el: FakeElement) => {
      if (el.attrs.id) byId.set(el.attrs.id, el);
      for (const c of el.children) if (c instanceof FakeElement) index(c);
    };
    index(body);
    const d = doc();
    d.body = body;
    d.getElementById = (id: string) => byId.get(id) ?? null;
    d.querySelectorAll = (s: string) => body.querySelectorAll(s);
  });
  afterEach(() => { stop?.(); stop = undefined; });

  const draw = (narrow: boolean) => {
    stop = shell.initShell(role, { store: mkStore(), media: mkMedia(narrow), user: { name: "Ann" } });
    viewMode.showViewNav(view, body);
    shell.showPage(role, ia.resolve(role, "#/home"));
  };
  const visibleLinks = () => byId.get("side")!.querySelectorAll("a[href]").filter((a) => !a.hidden && !a.closest("[hidden]"));

  it("has no violations and the labels of its view, in plain words", () => {
    draw(false);
    expect(audit(body)).toEqual([]);
    const labels = visibleLinks().map(text);
    const side = ia.sidebarFor(view);
    const expected = [...side.main, ...(view === "simple" ? [] : side.extra)].map((e: { label: string }) => e.label);
    for (const l of expected) expect(labels, l).toContain(l);
    for (const l of labels) expect(oldWordsIn(l), l).toEqual([]);
    expect(oldWordsIn(text(byId.get("top")!))).toEqual([]);
  });
  it("marks one page as the current one", () => {
    draw(false);
    const current = byId.get("side")!.querySelectorAll("a[href]").filter((a) => a.attrs["aria-current"] === "page");
    expect(current.length).toBe(1);
  });
  it("hides the extra pages in the Simple view only", () => {
    draw(false);
    const all = byId.get("side")!.querySelectorAll("a[href]");
    const hidden = (a: FakeElement) => a.hidden || !!a.closest("[hidden]") || (a.parent?.hidden ?? false);
    const shown = all.filter((a) => !hidden(a)).length;
    if (view === "simple") expect(shown).toBeLessThanOrEqual(ia.sidebarFor("simple").main.length);
    else expect(shown).toBe(all.length);
    expect(shown).toBeGreaterThanOrEqual(ia.sidebarFor(view).main.length);
  });
  it("opens as a drawer: focus goes to a visible link, and the page has no violations", () => {
    draw(true);
    byId.get("menu-btn")!.click();
    const active = doc().activeElement as FakeElement;
    expect(visibleLinks()).toContain(active);
    expect(byId.get("menu-btn")!.attrs["aria-expanded"]).toBe("true");
    expect(audit(body)).toEqual([]);
  });
});

describe("the phase strip", () => {
  const PHASES = ["Understand", "Plan", "Build", "Check", "Deliver"];
  it("names the current phase and the done ones, and takes no tab stop", () => {
    const el: FakeElement = product.phaseStrip({ label: "Progress", phases: PHASES, current: 2 });
    const host = dom.h("div", {}, el);
    expect(audit(host)).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("Progress");
    const items = el.querySelectorAll("li");
    expect(items.filter((i) => i.attrs["aria-current"] === "step").map((i) => text(i))).toEqual([expect.stringContaining("Build")]);
    expect(said(items[2]!)).toContain("Now");
    expect(items.filter((i) => said(i).includes("Done")).length).toBe(2);
    expect(dom.tabStops(host)).toEqual([]);
  });
  it("marks every phase done when complete, and none when not started", () => {
    const done: FakeElement = product.phaseStrip({ label: "Progress", phases: PHASES, complete: true });
    expect(done.querySelectorAll("li").filter((i) => i.attrs["aria-current"]).length).toBe(0);
    expect(done.querySelectorAll("li").filter((i) => said(i).includes("Done")).length).toBe(5);
    const none: FakeElement = product.phaseStrip({ label: "Progress", phases: PHASES, current: null });
    expect(none.querySelectorAll("li").filter((i) => i.attrs["aria-current"]).length).toBe(0);
    expect(audit(dom.h("div", {}, none))).toEqual([]);
  });
});

describe("the composer", () => {
  const key = (box: FakeElement, init: object) => {
    const calls = { prevented: 0 };
    for (const fn of (box as any).listeners.keydown ?? []) fn({ preventDefault: () => { calls.prevented++; }, ...init });
    return calls.prevented;
  };
  it("has a label for its box, and no violations", () => {
    const { field, box } = composer.composerBox({ id: "t", hint: "Say what you want." });
    expect(audit(dom.h("form", {}, field))).toEqual([]);
    expect(field.attrs.for).toBe("t");
    expect(text(field).startsWith(composer.COMPOSER.what)).toBe(true);
    expect(text(field)).toContain("Say what you want.");
    expect(box.attrs.id).toBe("t");
    expect(audit(dom.h("form", {}, composer.composerBox({}).field))).toEqual([]);
  });
  it("sends on Ctrl+Enter or Meta+Enter only", () => {
    let sent = 0;
    const { box } = composer.composerBox({ id: "t", onSubmit: () => { sent++; } });
    expect(key(box, { key: "Enter", ctrlKey: true })).toBe(1);
    expect(key(box, { key: "Enter", metaKey: true })).toBe(1);
    expect(key(box, { key: "Enter" })).toBe(0);
    expect(key(box, { key: "Enter", shiftKey: true })).toBe(0);
    expect(sent).toBe(2);
  });
  it("can be disabled", () => {
    expect(composer.composerBox({ id: "t", disabled: true }).box.attrs.disabled).toBeDefined();
  });
  it("has a closed Advanced disclosure with a name", () => {
    const d: FakeElement = composer.advancedBox(dom.h("p", {}, "More"));
    expect(d.tag).toBe("details");
    expect(text(d.querySelectorAll("summary")[0]!)).toBe("Advanced");
    expect(audit(dom.h("div", {}, d))).toEqual([]);
  });
});

describe("colours work in dark mode", () => {
  const rules = parseCss(readUiCss() + "\n" + ["product", "forms"].map((n) => read(`ui/kit/${n}.css`)).join("\n"));
  const mine = rules.filter((r) => /(^|[\s.#,])(side|sidebar|scf-phase-strip[\w-]*|composer|composer-advanced)\b/.test(r.selector) || /#side\b/.test(r.selector));
  it("finds the rules", () => {
    expect(mine.length).toBeGreaterThan(3);
  });
  it("uses tokens, not fixed colours", () => {
    for (const r of mine) {
      for (const d of r.declarations) {
        const m = /^(color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke)\s*:\s*(.*)$/.exec(d);
        if (!m) continue;
        expect(m[2], `${r.selector} { ${d} }`).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
      }
    }
  });
});
