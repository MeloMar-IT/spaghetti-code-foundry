import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitSourceProblems, parseCss, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Example { name: string; build: () => FakeElement }
interface Section { id: string; title: string; component: string; examples: Example[] }
let restore: () => void;
let sections: Section[];
let LONG: string;
let view: any;
const kitExports: Record<string, string[]> = {};

beforeAll(async () => {
  restore = installFakeDom();
  ({ sections, LONG } = (await import("../ui/gallery/registry.js" as string)) as any);
  view = await import("../ui/gallery/view.js" as string);
  for (const f of readdirSync("ui/kit").filter((n) => n.endsWith(".js") && n !== "core.js")) {
    const mod = (await import(`../ui/kit/${f.slice(0, -3)}.js` as string)) as Record<string, unknown>;
    kitExports[f] = Object.keys(mod).filter((k) => typeof mod[k] === "function");
  }
});
afterAll(() => restore());

/** The export names that no section covers. */
const missing = (names: string[], list: { component: string }[]) => names.filter((n) => !list.some((s) => s.component === n));
const section = (id: string) => sections.find((s) => s.id === id)!;
const example = (id: string, name: string) => section(id).examples.find((e) => e.name === name)!;
function* walk(el: FakeElement): Generator<FakeElement> {
  yield el;
  for (const c of el.children) if (c instanceof FakeElement) yield* walk(c);
}
const all = (el: FakeElement) => [...walk(el)];
const classes = (el: FakeElement) => all(el).flatMap((e) => (e.getAttribute("class") ?? "").split(" "));
/** What a person (or a screen reader) gets: text, values and labels. */
const shown = (el: FakeElement) => all(el).map((e) => `${e.textContent}|${e.value}|${e.getAttribute("aria-label") ?? ""}`).join("\n");
const isOff = (e: FakeElement) => e.getAttribute("disabled") !== null || e.getAttribute("aria-disabled") === "true";

describe("the registry", () => {
  it("has well-formed sections", () => {
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) {
      for (const k of ["id", "title", "component"] as const) expect(typeof s[k] === "string" && s[k] !== "", `${s.id} ${k}`).toBe(true);
      expect(s.examples.length, s.id).toBeGreaterThan(0);
      for (const e of s.examples) {
        expect(e.name, s.id).toBeTruthy();
        expect(typeof e.build, `${s.id} ${e.name}`).toBe("function");
      }
      expect(new Set(s.examples.map((e) => e.name)).size, s.id).toBe(s.examples.length);
    }
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
  });

  it("has a section for every function a kit module exports, and no other", () => {
    const names = Object.values(kitExports).flat();
    expect(names.length).toBe(8);
    expect(new Set(names).size).toBe(names.length);
    expect(missing(names, sections)).toEqual([]);
    for (const s of sections) expect(names, s.id).toContain(s.component);
  });

  it("the coverage check finds a function without a section", () => {
    expect(missing(["button", "newThing"], sections)).toEqual(["newThing"]);
  });

  it("every section has Long content and Disabled examples", () => {
    for (const s of sections) {
      expect(s.examples.map((e) => e.name), s.id).toContain("Long content");
      expect(s.examples.map((e) => e.name), s.id).toContain("Disabled");
    }
    expect(section("field").examples.map((e) => e.name)).toContain("Error");
  });

  it("builds every example in both themes and both densities", () => {
    const frame = document.getElementById("gallery-frame") as unknown as FakeElement;
    for (const theme of ["light", "dark"]) {
      for (const density of ["comfortable", "compact"]) {
        view.applyView(document.documentElement, frame, { theme, density, width: "wide" });
        for (const s of sections) for (const e of s.examples) expect(e.build(), `${s.id} ${e.name}`).toBeInstanceOf(FakeElement);
      }
    }
  });

  it("each action section shows its own variants", () => {
    const cls = (id: string) => section(id).examples.flatMap((e) => classes(e.build()));
    for (const id of ["button", "iconButton"]) {
      for (const c of ["scf-btn--primary", "scf-btn--danger", "scf-btn--ghost", "scf-btn--busy"]) expect(cls(id), `${id} ${c}`).toContain(c);
    }
    expect(cls("button")).toContain("scf-btn--small");
    expect(cls("iconButton")).toContain("scf-btn--icon");
    expect(cls("link")).toContain("scf-link--disabled");
    const ext = all(example("link", "External").build()).find((e) => e.tag === "a")!;
    expect(ext.getAttribute("target")).toBe("_blank");
  });

  it("every Disabled example has a really disabled control", () => {
    for (const s of sections) {
      const off = all(example(s.id, "Disabled").build()).filter(isOff);
      expect(off.length, s.id).toBeGreaterThan(0);
    }
    expect(all(example("button", "Disabled").build()).filter((e) => e.tag === "button" && isOff(e)).length).toBe(4);
    expect(all(example("iconButton", "Disabled").build()).filter((e) => e.tag === "button" && isOff(e)).length).toBe(4);
    expect(all(example("checkbox", "Disabled").build()).filter((e) => e.tag === "input" && isOff(e)).length).toBe(2);
    const link = all(example("link", "Disabled").build()).find((e) => e.tag === "a")!;
    expect(link.getAttribute("href")).toBeNull();
    expect(link.getAttribute("aria-disabled")).toBe("true");
  });

  it("every Long content example shows the long text", () => {
    expect(LONG.length).toBeGreaterThan(150);
    for (const s of sections) expect(shown(example(s.id, "Long content").build()), s.id).toContain(LONG);
  });

  it("the field Error example has an alert", () => {
    expect(all(example("field", "Error").build()).some((e) => e.getAttribute("role") === "alert")).toBe(true);
  });

  it("makes no API call and reads no storage", () => {
    const files = readdirSync("ui/gallery").filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const text = readFileSync(`ui/gallery/${f}`, "utf8");
      for (const m of text.matchAll(/from "([^"]+)"/g)) {
        expect(m[1], f).toMatch(/^(\.\/[\w-]+\.js|\.\.\/kit\/[\w-]+\.js|\.\.\/dom\.js|\.\.\/icons\.js)$/);
      }
      for (const bad of ["fetch(", "/api/", "EventSource", "XMLHttpRequest", "localStorage", "api.js", "auth.js"]) expect(text, `${f} ${bad}`).not.toContain(bad);
      expect(kitSourceProblems(text), f).toEqual([]);
    }
  });
});

describe("the view", () => {
  const combos = ["light", "dark"].flatMap((theme) => ["comfortable", "compact"].flatMap((density) => ["wide", "narrow"].map((width) => ({ theme, density, width }))));

  it("reads the query, with defaults for anything unknown", () => {
    const d = { theme: "light", density: "comfortable", width: "wide" };
    expect(view.readView("")).toEqual(d);
    expect(view.readView("?theme=dark&density=compact&width=narrow")).toEqual({ theme: "dark", density: "compact", width: "narrow" });
    expect(view.readView("?theme=system&density=x&width=")).toEqual(d);
  });
  it("writes all three keys in order and reads them back", () => {
    expect(view.viewQuery(combos[0])).toBe("theme=light&density=comfortable&width=wide");
    expect(combos.length).toBe(8);
    for (const v of combos) expect(view.readView("?" + view.viewQuery(v))).toEqual(v);
  });
  it("applyView sets the attributes", () => {
    const root = new FakeElement("html");
    const frame = new FakeElement("div");
    view.applyView(root, frame, { theme: "dark", density: "compact", width: "narrow" });
    expect([root.getAttribute("data-theme"), root.getAttribute("data-density"), frame.getAttribute("data-width")]).toEqual(["dark", "compact", "narrow"]);
  });
  it("drawBar has three groups of two buttons, one pressed each, and reports clicks", () => {
    const onChange = vi.fn();
    const nodes = view.drawBar({ theme: "dark", density: "comfortable", width: "wide" }, onChange) as FakeElement[];
    expect(nodes.length).toBe(3);
    expect(nodes.every((n) => n.getAttribute("role") === "group")).toBe(true);
    const pressed = nodes.map((n) => n.all("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent));
    expect(pressed).toEqual([["dark"], ["comfortable"], ["wide"]]);
    expect(nodes.flatMap((n) => n.all("button")).length).toBe(6);
    nodes[2]!.all("button")[1]!.click();
    expect(onChange).toHaveBeenCalledWith("width", "narrow");
  });
  it("drawSections draws one section per entry and one box per example", () => {
    const nodes = view.drawSections(sections) as FakeElement[];
    expect(nodes.map((n) => n.getAttribute("id"))).toEqual(sections.map((s) => s.id));
    expect(nodes.every((n) => n.tag === "section")).toBe(true);
    const boxes = nodes.flatMap((n) => all(n)).filter((e) => e.getAttribute("class") === "gallery-example");
    expect(boxes.length).toBe(sections.reduce((n, s) => n + s.examples.length, 0));
  });
  it("shows the message of an example that throws", () => {
    const bad = [{ id: "x", title: "X", component: "x", examples: [{ name: "Boom", build: () => { throw new Error("boom"); } }] }];
    const nodes = view.drawSections(bad) as FakeElement[];
    expect(nodes[0]!.textContent).toContain("boom");
  });
  it("start applies the query, draws, and keeps the sections when the view changes", () => {
    const replaceState = vi.fn();
    view.start({ location: { search: "?theme=dark" }, history: { replaceState } });
    const root = document.documentElement as unknown as FakeElement;
    const main = document.getElementById("gallery-main") as unknown as FakeElement;
    const bar = document.getElementById("gallery-bar") as unknown as FakeElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(main.children.filter((c) => c instanceof FakeElement && c.tag === "section").length).toBe(8);
    const before = [...main.children];
    bar.all("button").find((b) => b.textContent === "compact")!.click();
    expect(replaceState.mock.calls[0]![2]).toBe("?theme=dark&density=compact&width=wide");
    expect(root.getAttribute("data-density")).toBe("compact");
    expect(main.children.length).toBe(before.length);
    expect(main.children.every((c, i) => c === before[i])).toBe(true);
  });
});

describe("the page and its style", () => {
  const html = readFileSync("ui/gallery/index.html", "utf8");
  it("loads files only, so the CSP is fine", () => {
    expect(html.indexOf('href="/style.css"')).toBeGreaterThan(html.indexOf('href="/tokens.css"'));
    expect(html.indexOf('href="/kit/kit.css"')).toBeGreaterThan(html.indexOf('href="/style.css"'));
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).toContain('<script type="module" src="/gallery/gallery.js"></script>');
    expect(html).not.toMatch(/<style|style=|\son\w+=|prefs-boot/);
    const frame = html.indexOf('id="gallery-frame"');
    expect(html.indexOf('id="modal-root"')).toBeGreaterThan(frame);
    expect(html.indexOf('id="modal-root"')).toBeLessThan(html.indexOf("</div>", frame));
  });
  it("has gallery rules that use tokens and a container named scf-page", () => {
    const css = readFileSync("ui/css/pages/gallery.css", "utf8");
    expect(css).toMatch(/^\/\*[\s\S]*Belongs here:[\s\S]*Does not belong here:[\s\S]*?\*\//);
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("container-name: scf-page");
    expect(css).toMatch(/\[data-width="narrow"\][^{]*\{[^}]*width: 390px/);
    const tokens = tokenNames();
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) expect(tokens.has(m[1]!), m[1]).toBe(true);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const r of parseCss(css)) for (const sel of r.selector.split(",")) expect(sel.trim(), sel).toMatch(/^\.gallery-/);
  });
});
