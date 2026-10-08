import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importsOf, parseCss, readUiCss, uiCssImports, type CssRule } from "./helpers/ui-css.js";

// ui/style.css only imports the modules under ui/css/ (#337). These tests keep the split honest.

const ORDER = [
  "tokens", "reset", "layout", "components", "utilities",
  "pages/shell", "pages/editor", "pages/runs", "pages/dashboard", "pages/turn", "pages/board", "pages/start", "pages/refinement",
].map((n) => `/css/${n}.css`);
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
    expect(walk("ui").filter((f) => f.endsWith(".css")).filter((f) => !f.startsWith(join("ui", "css")))).toEqual([join("ui", "style.css")]);
    for (const html of ["ui/index.html", "ui/user/index.html"]) {
      const text = readFileSync(html, "utf8");
      expect(text.match(/<link[^>]*stylesheet[^>]*>/g)?.length, html).toBe(1);
      expect(text, html).toContain('href="/style.css"');
      expect(text, html).not.toContain("<style");
    }
  });
});

describe("the module split", () => {
  const tokenValue = (name: string) => /:root\s*\{[^}]*\}/.exec(file("/css/tokens.css"))![0].match(new RegExp(`${name}:\\s*([^;]+);`))![1]!;
  const unvar = (s: string) => s.replace(/var\((--[zw]-[\w-]+)\)/g, (_, n: string) => tokenValue(n));
  const TOKENS =["--z-sticky", "--z-modal", "--z-toast", "--w-form", "--w-modal", "--w-modal-wide"];

  // Update tests/fixtures/ui-style-baseline.css in the same commit when a rule is changed on purpose.
  it("has the same rule set as the old single file", () => {
    const now = parseCss(readUiCss()).map((r) => {
      if (r.context === "" && r.selector === ":root") r = { ...r, declarations: r.declarations.filter((d) => !TOKENS.some((t) => d.startsWith(`${t}:`))) };
      return { ...r, declarations: r.declarations.map(unvar) };
    });
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
        .map((r) => ({ ...r, declarations: r.declarations.map(unvar) }))
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
    const comp = file("/css/components.css");
    expect(idx(comp, ".pill.who-a-time-limit { background: #3b2f12")).toBeLessThan(idx(comp, ".pill.who-a-time-limit { background: #fef3c7"));
    const turn = file("/css/pages/turn.css");
    expect(idx(turn, ".slow-note { color: #fbbf24")).toBeLessThan(idx(turn, ".slow-note { color: #92400e"));
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

  it("has the tokens, with today's values, only in the light theme", () => {
    const rules = parseCss(file("/css/tokens.css"));
    const light = rules.find((r) => r.context === "" && r.selector === ":root")!;
    const dark = rules.find((r) => r.context.includes("dark") && r.selector === ":root")!;
    expect(light.declarations).toEqual(expect.arrayContaining(["--z-sticky: 10", "--z-modal: 50", "--z-toast: 60", "--w-form: 640px", "--w-modal: 640px", "--w-modal-wide: 900px"]));
    expect(dark.declarations.filter((d) => /^--[zw]-/.test(d))).toEqual([]);
    expect(dark.declarations.filter((d) => d.startsWith("--")).length).toBe(17);
    expect(dark.declarations).toContain("color-scheme: dark");
  });

  it("uses a z-index token everywhere, and the width tokens", () => {
    const css = readUiCss();
    const z = [...css.matchAll(/z-index:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(z.sort()).toEqual(["var(--z-modal)", "var(--z-sticky)", "var(--z-toast)"]);
    const rules = parseCss(css);
    const decl = (sel: string) => rules.find((r) => r.selector === sel)!.declarations;
    expect(decl(".start-form")).toContain("max-width: var(--w-form)");
    expect(decl(".modal")).toContain("width: min(var(--w-modal), 100%)");
    expect(decl(".modal:has(.block-grid)")).toContain("width: min(var(--w-modal-wide), 100%)");
  });

  it("keeps shared component classes out of the page files", () => {
    const comp = /^(?:(?:a|button)?\.(?:pill|card|table|table-box|modal|backdrop|badge|btn|field|seg|tabs|chips|chip|spinner|empty|errors|toolbar|status|small-select|checks)(?![\w-])|button|input|select|textarea|#toast)/;
    for (const imp of ORDER.filter((i) => i.includes("/pages/"))) {
      for (const r of parseCss(file(imp))) for (const s of r.selector.split(",").map((x) => x.trim())) expect(comp.test(s), `${imp}: ${s}`).toBe(false);
    }
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
