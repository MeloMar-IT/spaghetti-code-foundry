import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookLiterals } from "./helpers/ui-css.js";

// Look tokens (#850): fonts, radii and shadows in ui/**/*.css come from ui/tokens.css. Unit tests that read files only.

/** Literals that are allowed, keyed "<path>|<selector>|<property>", each with the reason. */
const ALLOW: Record<string, string> = {
  "ui/css/components.css|.card.selected|box-shadow": "a selection ring drawn as a spread shadow, not elevation; its colour is a token",
  "ui/css/pages/board.css|.board-card.chain|box-shadow": "a selection ring drawn as a spread shadow, not elevation; its colour is a token",
};

function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
    else if (name.endsWith(ext)) out.push(p.split("\\").join("/"));
  }
  return out;
}

const cssFiles = filesUnder("ui", ".css").filter((f) => f !== "ui/tokens.css");
const read = (f: string) => readFileSync(f, "utf8");

function scan(): string[] {
  const keys: string[] = [];
  for (const f of cssFiles) for (const l of lookLiterals(read(f))) keys.push(`${f}|${l.selector}|${l.property}`);
  return keys;
}

const flagged = (css: string) => lookLiterals(css).length;

describe("lookLiterals", () => {
  it.each([
    "a { border-radius: 4px; }",
    "a { border-top-left-radius: 3px; }",
    "a { box-shadow: 0 1px 2px #000; }",
    "a { box-shadow: none; }",
    "a { font-family: Arial, sans-serif; }",
    "a { font: 12px Georgia; }",
    "a { font: var(--text-body) Georgia, var(--sans); }",
    "a { border-radius: var(--radius-sm, 4px); }",
    "a { border-radius: var(--space-md); }",
    "a { font-family: var(--shadow-low); }",
    "a { border-radius: unset; }",
    "a { border-radius: initial; }",
    "@media (max-width: 700px) { a { border-radius: 4px; } }",
    "@supports (display: grid) { a { box-shadow: 0 1px #000; } }",
    "@keyframes k { to { border-radius: 4px; } }",
    "@media print { @supports (display: grid) { a { font-family: Arial; } } }",
  ])("flags %s", (css) => {
    expect(flagged(css)).toBe(1);
  });

  it.each([
    "a { border-radius: var(--radius-md); }",
    "a { border-radius: var(--card-radius); }",
    "a { border-radius: var(--radius-xl) var(--radius-xl) var(--radius-none) var(--radius-none); }",
    "a { font-family: inherit; }",
    "a { border-radius: inherit; }",
    "a { font: var(--text-body)/var(--leading-body) var(--sans); }",
    "a { font: 600 12px var(--font-body), var(--font-mono); }",
    "a { font: inherit; }",
    "a { font: var(--weight-regular) var(--text-small)/var(--leading-body) var(--sans); }",
    "a { font-family: var(--font-display); }",
    "a { box-shadow: var(--shadow-high) !important; }",
    "a { box-shadow: var(--shadow-none); }",
    "@keyframes spin { to { transform: rotate(360deg); } }",
    "a { font-size: 12px; }",
  ])("passes %s", (css) => {
    expect(lookLiterals(css)).toEqual([]);
  });

  it("flags a literal before or after a nested rule of the same block", () => {
    expect(flagged(".card { border-radius: 4px; &:hover { color: red; } }")).toBe(1);
    expect(flagged(".card { &:hover { color: red; } border-radius: 4px; }")).toBe(1);
    expect(flagged(".card { border-radius: 4px; &:hover { border-radius: 2px; } }")).toBe(2);
    expect(flagged(".card { &:hover { color: red; } border-radius: var(--radius-md); }")).toBe(0);
  });

  it("reports the selector and the property", () => {
    expect(lookLiterals("@media print { .x, .y { border-radius: 4px; } }")).toEqual([
      { selector: ".x, .y", property: "border-radius", value: "4px" },
    ]);
  });
});

describe("ui/**/*.css", () => {
  it("scans the css and kit folders", () => {
    expect(cssFiles).toContain("ui/css/components.css");
    expect(cssFiles).toContain("ui/kit/overlays.css");
    expect(cssFiles).not.toContain("ui/tokens.css");
  });

  it("has no look literal that is not on the allow-list", () => {
    expect(scan().filter((k) => !(k in ALLOW))).toEqual([]);
  });

  it("has an allow-list entry for exactly the literals found, each with a reason", () => {
    expect([...new Set(scan())].sort()).toEqual(Object.keys(ALLOW).sort());
    for (const [k, reason] of Object.entries(ALLOW)) expect(reason.trim().length, k).toBeGreaterThan(0);
  });
});

describe("ui/tokens.css defaults", () => {
  const tokens = read("ui/tokens.css");
  const value = (name: string) => new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(tokens)?.[1]?.trim();

  it("defines every look token", () => {
    for (const n of ["font-body", "font-display", "font-mono", "radius-sm", "radius-md", "radius-lg", "radius-pill", "shadow-none", "shadow-low", "shadow-high",
      "space-2xs", "space-xs", "space-sm", "space-md", "space-lg", "space-xl", "space-2xl", "space-3xl", "space-4xl"]) {
      expect(value(`--${n}`), n).toBeDefined();
    }
  });

  it("keeps the old look", () => {
    expect(value("--font-body")).toBe('-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif');
    expect(value("--font-display")).toBe("var(--font-body)");
    expect(value("--font-sans")).toBe("var(--font-body)");
    expect(value("--shadow-none")).toBe("none");
    expect(value("--shadow-low")).toBe("0 4px 12px rgb(0 0 0 / .12)");
    expect(value("--shadow-high")).toBe("0 20px 60px rgb(0 0 0 / .25)");
    expect(value("--shadow-md")).toBe("var(--shadow-low)");
    expect(value("--shadow-lg")).toBe("var(--shadow-high)");
    expect([value("--radius-sm"), value("--radius-md"), value("--radius-lg"), value("--radius-pill")]).toEqual(["6px", "8px", "10px", "999px"]);
  });

  it("uses --font-display for h1 and h2", () => {
    const reset = read("ui/css/reset.css");
    expect(reset).toMatch(/^h1 \{ font-family: var\(--font-display\);/m);
    expect(reset).toMatch(/^h2 \{ font-family: var\(--font-display\);/m);
  });

  it("keeps ui/css/tokens.css as a comment that names fonts, radii and shadows", () => {
    const text = read("ui/css/tokens.css");
    expect(text).toMatch(/fonts/);
    expect(text).toMatch(/radii/);
    expect(text).toMatch(/shadows/);
    expect(text.replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
  });
});

describe("no third party", () => {
  it("has no @font-face, remote url() or remote @import in any ui css file", () => {
    for (const f of filesUnder("ui", ".css")) {
      const text = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text, f).not.toMatch(/@font-face/i);
      expect(text, f).not.toMatch(/url\(\s*["']?\s*(?:https?:|\/\/)/i);
      expect(text, f).not.toMatch(/@import\s+(?:url\(\s*)?["']?\s*(?:https?:|\/\/)/i);
    }
  });

  it("has no url() in a font token", () => {
    for (const m of read("ui/tokens.css").matchAll(/^\s*--font-[\w-]+:\s*([^;]+);/gm)) expect(m[1]).not.toMatch(/url\(/i);
  });

  it("loads only same-origin files from the html pages", () => {
    for (const f of filesUnder("ui", ".html")) {
      const text = read(f);
      const refs = [...text.matchAll(/<link\b[^>]*\bhref="([^"]*)"/gi), ...text.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)].map((m) => m[1]!);
      for (const r of refs) expect(r, `${f}: ${r}`).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
      for (const r of refs) expect(r, `${f}: ${r}`).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
  });
});
