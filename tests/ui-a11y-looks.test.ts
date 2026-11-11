import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAIRS, checkPairs, failures, lookCssImports, luminance, parseLook, parseTokens, ratio, readUiCss, resolve, tokenNames, withLook, type Decl } from "./helpers/ui-css.js";

// The Calm and Midnight looks (#852) are token files. This test reads them as text and runs the contrast check once per look.

const read = (p: string) => readFileSync(p, "utf8");
const base = parseTokens(read("ui/tokens.css"));
const defined = tokenNames();
const lookFile = (look: string) => read(`ui/css/looks/${look}.css`);
const looks = { calm: parseLook(lookFile("calm"), "calm"), midnight: parseLook(lookFile("midnight"), "midnight") };
const px = (m: Map<string, Decl>, n: string) => parseFloat(m.get(n)!.light);
const SPACES = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map((n) => `--space-${n}`);
const RADII = ["sm", "md", "lg", "xl"].map((n) => `--radius-${n}`);
const MUST = [...SPACES, ...RADII, "--font-body", "--font-display", "--font-mono", "--font-numeric", "--shadow-low", "--shadow-high",
  ...["bg", "surface", "surface-2", "border", "border-strong", "text", "text-muted", "accent", "accent-soft", "on-accent"].map((n) => `--color-${n}`)];

/** Hue in degrees (0–360) of a #rrggbb colour. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe.each(["calm", "midnight"] as const)("look %s", (look) => {
  const l = looks[look];
  const tokens = withLook(base, l);

  it("sets only custom properties that ui/tokens.css defines, with no color-scheme", () => {
    for (const n of l.keys()) expect(defined.has(n), n).toBe(true);
    expect(l.has("color-scheme")).toBe(false);
    for (const m of lookFile(look).matchAll(/var\((--[\w-]+)/g)) expect(defined.has(m[1]!), m[1]).toBe(true);
    expect(lookFile(look)).not.toMatch(/color-scheme|content\s*:|:root|@media/);
  });

  it("sets spacing, fonts, radii, shadows and the main colours", () => {
    for (const n of MUST) expect(l.has(n), n).toBe(true);
  });

  it("writes each colour as light-dark() with two different values", () => {
    for (const [n, d] of l) {
      if (!n.startsWith("--color-") || n.startsWith("--color-log-") || n === "--color-overlay") continue;
      expect(d.light, n).toMatch(/^#[0-9a-f]{6}$/i);
      expect(d.dark, n).toMatch(/^#[0-9a-f]{6}$/i);
      expect(d.light, n).not.toBe(d.dark);
    }
  });

  it("passes the 35 contrast pairs in light and dark", () => {
    const results = checkPairs(tokens, PAIRS);
    expect(results).toHaveLength(35);
    expect(failures(results).map((r) => `${r.fg} on ${r.bg}: ${r.light.toFixed(2)} / ${r.dark.toFixed(2)}`)).toEqual([]);
  });
});

describe("Calm", () => {
  const c = looks.calm;
  const t = withLook(base, c);
  it("is light and airy with an indigo accent", () => {
    expect(luminance(resolve(t, "--color-bg", "light"))).toBeGreaterThanOrEqual(0.9);
    for (const theme of ["light", "dark"] as const) {
      const h = hue(resolve(t, "--color-accent", theme));
      expect(h, theme).toBeGreaterThanOrEqual(225);
      expect(h, theme).toBeLessThanOrEqual(255);
    }
  });
  it("uses a sans body font, 12–16 px radii and hairline borders", () => {
    expect(c.get("--font-body")!.light).toMatch(/sans-serif$/);
    expect(c.get("--font-body")!.light).not.toContain("monospace");
    for (const n of RADII) expect(px(c, n), n).toBeGreaterThanOrEqual(12), expect(px(c, n), n).toBeLessThanOrEqual(16);
    for (const theme of ["light", "dark"] as const) expect(ratio(resolve(t, "--color-border", theme), resolve(t, "--color-surface", theme)), theme).toBeLessThan(1.5);
  });
});

describe("Midnight", () => {
  const m = looks.midnight;
  const t = withLook(base, m);
  it("is near-black with a lime accent and black text on it (dark)", () => {
    expect(luminance(resolve(t, "--color-bg", "dark"))).toBeLessThanOrEqual(0.01);
    const h = hue(resolve(t, "--color-accent", "dark"));
    expect(h).toBeGreaterThanOrEqual(70);
    expect(h).toBeLessThanOrEqual(100);
    expect(luminance(resolve(t, "--color-on-accent", "dark"))).toBeLessThanOrEqual(0.01);
    expect(ratio(resolve(t, "--color-on-accent", "dark"), resolve(t, "--color-accent", "dark"))).toBeGreaterThanOrEqual(4.5);
  });
  it("uses a mono font, 10–14 px radii and tighter spacing", () => {
    expect(m.get("--font-mono")!.light).toContain("monospace");
    expect(m.get("--font-mono")!.light).not.toBe(m.get("--font-body")!.light);
    for (const n of RADII) expect(px(m, n), n).toBeGreaterThanOrEqual(10), expect(px(m, n), n).toBeLessThanOrEqual(14);
    for (const n of SPACES) expect(px(m, n), n).toBeLessThanOrEqual(parseFloat(base.base.get(n)!.light));
    const sum = (f: (n: string) => number) => SPACES.reduce((s, n) => s + f(n), 0);
    expect(sum((n) => px(m, n))).toBeLessThan(sum((n) => parseFloat(base.base.get(n)!.light)));
  });
  it("keeps each density token between the compact and the comfortable value", () => {
    for (const [n, d] of m) {
      const compact = base.compact.get(n);
      if (compact === undefined) continue;
      const [lo, hi] = [parseFloat(compact), parseFloat(base.base.get(n)!.light)];
      expect(parseFloat(d.light), n).toBeGreaterThanOrEqual(lo);
      expect(parseFloat(d.light), n).toBeLessThanOrEqual(hi);
    }
  });
  it("sets every token that Calm sets", () => {
    for (const n of looks.calm.keys()) expect(m.has(n), n).toBe(true);
  });
});

describe("numbers use the numeric font", () => {
  const dash = read("ui/css/pages/dashboard.css");
  const decl = (selector: string) => {
    const m = new RegExp(`^${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "m").exec(dash);
    if (!m) throw new Error(`no rule ${selector}`);
    return m[1]!;
  };
  it("sets the tile values, today counts and chart axes in --font-numeric", () => {
    for (const s of [".tile-value", ".today-count", ".chart .axis"]) expect(decl(s), s).toContain("font-family: var(--font-numeric)");
  });
  it("makes Midnight's numbers mono and Calm's the body font", () => {
    expect(looks.midnight.get("--font-numeric")!.light).toBe("var(--font-mono)");
    expect(looks.calm.get("--font-numeric")!.light).toBe("var(--font-body)");
  });
});

describe("loading", () => {
  it("imports calm first, then midnight, and every look file", () => {
    expect(lookCssImports()).toEqual(["/css/looks/calm.css", "/css/looks/midnight.css"]);
    expect(readdirSync("ui/css/looks").filter((f) => f.endsWith(".css")).sort()).toEqual(["calm.css", "midnight.css"]);
  });
  it("links /tokens.css, /looks.css, /style.css in that order on every page", () => {
    for (const p of ["ui/index.html", "ui/user/index.html", "ui/accessibility.html"]) {
      const hrefs = [...read(p).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((x) => x[1]);
      expect(hrefs.indexOf("/tokens.css"), p).toBeGreaterThanOrEqual(0);
      expect(hrefs.indexOf("/looks.css"), p).toBe(hrefs.indexOf("/tokens.css") + 1);
      expect(hrefs.indexOf("/style.css"), p).toBe(hrefs.indexOf("/looks.css") + 1);
    }
  });
  it("keeps the pill glyph rules, so status is not colour alone", () => {
    expect(readUiCss()).toContain(":not(:has(> .ico))::before");
  });
});

describe("parseLook and withLook", () => {
  it("throws for a second rule, a non-custom declaration or a missing block", () => {
    expect(() => parseLook('html[data-look="x"] { --a: 1px; } .pill { color: red; }', "x")).toThrow();
    expect(() => parseLook('html[data-look="x"] { color: red; }', "x")).toThrow(/not a custom property/);
    expect(() => parseLook('html[data-look="y"] { --a: 1px; }', "x")).toThrow(/no block/);
  });
  it("reads a selector list and light-dark() values", () => {
    const m = parseLook('html[data-look="x"], html[data-look] { --a: light-dark(#fff, #000); }', "x");
    expect(m.get("--a")).toEqual({ light: "#fff", dark: "#000" });
  });
  it("overrides only the names given", () => {
    const t = withLook(parseTokens(":root { --a: #111111; --b: #222222; }"), new Map([["--a", { light: "#333333", dark: "#333333" }]]));
    expect(t.base.get("--a")!.light).toBe("#333333");
    expect(t.base.get("--b")!.light).toBe("#222222");
  });
});
