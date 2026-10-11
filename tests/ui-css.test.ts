import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { competingSelectors, importsOf, parseCss, readUiCss, sharedSelectors, uiCssImports, type CssRule } from "./helpers/ui-css.js";

// ui/style.css only imports the modules under ui/css/ (#337). These tests keep the split honest.

const ORDER = [
  "tokens", "reset", "layout", "templates", "components", "utilities",
  "pages/shell", "pages/editor", "pages/runs", "pages/dashboard", "pages/turn", "pages/board", "pages/start", "pages/refinement", "pages/gallery", "pages/work", "responsive",
].map((n) => `/css/${n}.css`);
// Classes that components.css names but whose base rule a page file owns, each with the reason.
const OWNED_BY_PAGE: Record<string, string> = {
  "block-card": "pages/editor.css owns the base rule; components.css only has its hover variant",
  "chart-tip": "pages/dashboard.css owns the base rules; components.css only has the reduced-motion override",
};
const file = (imp: string) => readFileSync(join("ui", imp), "utf8");
const key = (r: CssRule) => `${r.context}|${r.selector}|${r.declarations.join(";")}`;
const baseline = parseCss(readFileSync("tests/fixtures/ui-style-baseline.css", "utf8"));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("ui/style.css", () => {
  it("only imports the modules, in order", () => {
    expect(uiCssImports()).toEqual(ORDER);
  });

  it("imports nothing from another origin and nothing outside the modules", () => {
    for (const imp of uiCssImports()) expect(imp).not.toMatch(/\/\/|:/);
    expect(readUiCss()).not.toMatch(/@import|url\(\s*["']?https?:/);
    expect(walk("ui").filter((f) => f.endsWith(".css")).filter((f) => !f.startsWith(join("ui", "css")) && !f.startsWith(join("ui", "kit")))).toEqual([join("ui", "style.css"), join("ui", "tokens.css")]);
    for (const html of ["ui/index.html", "ui/user/index.html"]) {
      const text = readFileSync(html, "utf8");
      expect(text.match(/<link[^>]*stylesheet[^>]*>/g)?.length, html).toBe(3); // /tokens.css, /style.css, then /kit/kit.css
      expect(text, html).toContain('href="/style.css"');
      expect(text, html).not.toContain("<style");
    }
  });
});

describe("the module split", () => {

  // Update tests/fixtures/ui-style-baseline.css in the same commit when a rule is changed on purpose.
  it("has the same rule set as the old single file", () => {
    const now = parseCss(readUiCss());
    const before = baseline.map(key);
    expect(new Set(before).size).toBe(before.length);
    expect(now.map(key).sort()).toEqual(before.sort());
  });

  it("keeps the old order inside each module", () => {
    const pos = new Map(baseline.map((r, i) => [key(r), i]));
    for (const imp of ORDER) {
      // Rules outside @media: their baseline positions must increase. (@media blocks sit next to the rules they change.)
      const at = parseCss(file(imp))
        .filter((r) => r.context === "" && r.selector !== ":root")
        .map((r) => pos.get(key(r)));
      expect(at.every((p) => p !== undefined), imp).toBe(true);
      const flat = at as number[];
      expect(flat, imp).toEqual([...flat].sort((a, b) => a - b));
    }
  });

  it("keeps rules that override each other in their old order", () => {
    const idx = (text: string, needle: string, from = 0) => {
      const i = text.indexOf(needle, from);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const runs = file("/css/pages/runs.css");
    expect(idx(runs, ".tl { border")).toBeLessThan(idx(runs, ".tl, .tx-tool {"));
    // A max-width rule comes after the base rule of each of its selectors, in the same file.
    for (const imp of ORDER) {
      const rules = parseCss(file(imp));
      rules.forEach((r, i) => {
        if (!r.context.startsWith("@media (max-width")) return;
        for (const sel of r.selector.split(",").map((s) => s.trim())) {
          const base = rules.findIndex((b) => b.context === "" && b.selector.split(",").map((s) => s.trim()).includes(sel));
          if (base >= 0) expect(base, `${imp} ${sel}`).toBeLessThan(i);
        }
      });
    }
  });

  it("has no token values: they live in ui/tokens.css", () => {
    expect(parseCss(file("/css/tokens.css"))).toEqual([]);
    expect(readUiCss()).not.toMatch(/:root/);
  });

  it("uses a layer token for every z-index, and the width token", () => {
    const css = readUiCss();
    const z = [...css.matchAll(/z-index:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(z.length).toBeGreaterThan(0);
    for (const v of z) expect(v, v).toMatch(/^(var\(--layer-[\w-]+\)|calc\(var\(--layer-[\w-]+\) \+ \d+\))$/);
    const rules = parseCss(css);
    const decl = (sel: string) => rules.find((r) => r.selector === sel)!.declarations;
    expect(decl(".start-form")).toContain("max-width: var(--size-form)");
    expect(decl(".modal")).toContain("width: min(var(--size-form), 100%)");
  });

  it("keeps shared component classes out of the page files and the template file", () => {
    const shared = sharedSelectors(file("/css/components.css"));
    for (const name of Object.keys(OWNED_BY_PAGE)) shared.classes.delete(name);
    for (const imp of ["/css/templates.css", ...ORDER.filter((i) => i.includes("/pages/"))]) expect(competingSelectors(file(imp), shared), imp).toEqual([]);
  });

  it("needs the allow-list: without it the page files that own a base rule are flagged", () => {
    const shared = sharedSelectors(file("/css/components.css"));
    const flagged = ORDER.filter((i) => i.includes("/pages/")).flatMap((imp) => competingSelectors(file(imp), shared));
    for (const name of Object.keys(OWNED_BY_PAGE)) expect(flagged.some((s) => s.includes(`.${name}`)), name).toBe(true);
    expect(flagged.filter((s) => !Object.keys(OWNED_BY_PAGE).some((n) => s.includes(`.${n}`)))).toEqual([]);
  });

  it("has no z-index in templates.css", () => {
    expect(file("/css/templates.css")).not.toContain("z-index");
  });

  it("starts every module with a header comment", () => {
    for (const imp of ORDER) {
      const text = file(imp);
      expect(text.startsWith("/*"), imp).toBe(true);
      const head = text.slice(0, text.indexOf("*/"));
      expect(head, imp).toContain(imp.split("/").pop()!);
      expect(head, imp).toContain("Belongs here:");
      expect(head, imp).toContain("Does not belong here:");
    }
  });
});

describe("competingSelectors", () => {
  const shared = sharedSelectors(readFileSync("ui/css/components.css", "utf8"));
  const flag = (css: string) => competingSelectors(css, shared);
  it("derives the shared names from components.css", () => {
    for (const c of ["card", "btn", "block-card", "state-error", "modal-head"]) expect(shared.classes.has(c), c).toBe(true);
    expect(shared.classes.has("d")).toBe(false);
    expect(shared.classes.has("pill-x")).toBe(false);
    expect([...shared.controls].sort()).toEqual(["button", "input", "select", "textarea"]);
    expect([...shared.ids]).toEqual(["#toast"]);
  });
  it("flags a selector that competes with a shared component", () => {
    for (const s of [".card.x", "button.small", ".scf-card", ".skeleton", ".state-error p", ".stale-note", ".modal-head", ".filter-bar", "#toast.show", "input"]) {
      expect(flag(`${s} { color: red; }`), s).toEqual([s]);
    }
    expect(flag(".btn, .y { color: red; }")).toEqual([".btn"]);
    expect(flag("@media (max-width: 700px) { .card { color: red; } }")).toEqual([".card"]);
  });
  it("leaves alone a selector scoped under a page class and an unshared class", () => {
    expect(flag(".page-board .card { color: red; }")).toEqual([]);
    expect(flag(".board-card { color: red; }")).toEqual([]);
    expect(flag("@keyframes spin { to { opacity: 0; } }")).toEqual([]);
  });
});

describe("the css test helper", () => {
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-css-"));
    mkdirSync(join(dir, "css"));
    return dir;
  };
  it("throws on an import with no file", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "style.css"), '@import url("/css/a.css");\n');
      expect(() => readUiCss(dir)).toThrow(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("throws on a css file that is not imported", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "style.css"), '@import url("/css/a.css");\n');
      writeFileSync(join(dir, "css", "a.css"), "a { color: red; }\n");
      writeFileSync(join(dir, "css", "b.css"), "b { color: red; }\n");
      expect(() => readUiCss(dir)).toThrow(/not imported/);
      rmSync(join(dir, "css", "b.css"));
      expect(readUiCss(dir)).toContain("a { color: red; }");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("throws on a line that is not an import", () => {
    expect(() => importsOf('@import url("/css/a.css");\na { color: red; }\n')).toThrow(/not an @import/);
    expect(() => importsOf('@import url("https://x.test/a.css");\n')).toThrow(/not an @import/);
  });
  it("parses css", () => {
    const rules = parseCss(`/* c { x: y } */
:root {
  --a: 1;
  --b: 2;
}
@media (max-width: 760px) {
  .a, .b { color: red; }
}
@keyframes spin { to { transform: rotate(360deg); } }
`);
    expect(rules).toEqual([
      { context: "", selector: ":root", declarations: ["--a: 1", "--b: 2"] },
      { context: "@media (max-width: 760px)", selector: ".a, .b", declarations: ["color: red"] },
      { context: "", selector: "@keyframes spin", declarations: ["to { transform: rotate(360deg); }"] },
    ]);
  });
});
