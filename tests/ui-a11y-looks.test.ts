import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAIRS, checkPairs, failures, lookAreaRules, lookCssImports, lookTokenCss, luminance, parseLook, parseTokens, ratio, readUiCss, resolve, tokenNames, withLook, type Decl } from "./helpers/ui-css.js";

// The Calm, Midnight (#852), Friendly and Bento (#853) looks are token files. This test reads them as text and runs the contrast check once per look.

const read = (p: string) => readFileSync(p, "utf8");
const base = parseTokens(read("ui/tokens.css"));
const defined = tokenNames();
const lookFile = (look: string) => read(`ui/css/looks/${look}.css`);
const looks = { calm: parseLook(lookFile("calm"), "calm"), midnight: parseLook(lookFile("midnight"), "midnight"),
  friendly: parseLook(lookFile("friendly"), "friendly"), editorial: parseLook(lookFile("editorial"), "editorial"), bento: parseLook(lookFile("bento"), "bento") };
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

describe.each(["midnight", "friendly", "editorial", "bento"] as const)("look %s", (look) => {
  it("sets every token that Calm sets", () => {
    for (const n of looks.calm.keys()) expect(looks[look].has(n), n).toBe(true);
  });
});

describe.each(["calm", "midnight", "friendly", "editorial", "bento"] as const)("look %s", (look) => {
  const l = looks[look];
  const tokens = withLook(base, l);

  it("keeps the focus ring width and offset", () => {
    expect(l.has("--focus-width")).toBe(false);
    expect(l.has("--focus-offset")).toBe(false);
  });

  it("sets only custom properties that ui/tokens.css defines, with no color-scheme", () => {
    for (const n of l.keys()) expect(defined.has(n), n).toBe(true);
    expect(l.has("color-scheme")).toBe(false);
    for (const m of lookFile(look).matchAll(/var\((--[\w-]+)/g)) expect(defined.has(m[1]!), m[1]).toBe(true);
    expect(lookTokenCss(lookFile(look))).not.toMatch(/color-scheme|content\s*:|:root|@media/);
  });

  it("has no area rule, except Editorial's Administration rule", () => {
    expect(lookAreaRules(lookFile(look), look)).toEqual(look === "editorial" ? [{ area: "administration", scheme: "dark" }] : []);
  });

  it("sets spacing, fonts, radii, shadows and the main colours", () => {
    for (const n of MUST) expect(l.has(n), n).toBe(true);
  });

  it("writes each colour as light-dark() with two different values", () => {
    for (const [n, d] of l) {
      // Editorial's orange is the same in both modes (black text on it in both), so its soft fill is exempt.
      if (!n.startsWith("--color-") || n.startsWith("--color-log-") || n === "--color-overlay" || (look === "editorial" && n === "--color-waiting-soft")) continue;
      expect(d.light, n).toMatch(/^#[0-9a-f]{6}$/i);
      expect(d.dark, n).toMatch(/^#[0-9a-f]{6}$/i);
      expect(d.light, n).not.toBe(d.dark);
    }
  });

  it("passes the 34 contrast pairs in light and dark", () => {
    const results = checkPairs(tokens, PAIRS);
    expect(results).toHaveLength(34);
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
});

const between = (v: number, lo: number, hi: number, msg: string) => {
  expect(v, msg).toBeGreaterThanOrEqual(lo);
  expect(v, msg).toBeLessThanOrEqual(hi);
};

describe("Friendly", () => {
  const f = looks.friendly;
  const t = withLook(base, f);
  it("has a cream ground, a teal accent and an apricot highlight", () => {
    expect(luminance(resolve(t, "--color-bg", "light"))).toBeGreaterThanOrEqual(0.85);
    for (const theme of ["light", "dark"] as const) {
      between(hue(resolve(t, "--color-bg", theme)), 25, 60, `bg ${theme}`);
      between(hue(resolve(t, "--color-accent", theme)), 160, 190, `accent ${theme}`);
      between(hue(resolve(t, "--color-accent-soft", theme)), 20, 40, `accent-soft ${theme}`);
    }
  });
  it("uses a rounded font, 20–28 px radii and pill buttons", () => {
    expect(f.get("--font-body")!.light).toMatch(/^ui-rounded,.*sans-serif$/);
    expect(f.get("--font-body")!.light).not.toContain("monospace");
    for (const n of RADII) between(px(f, n), 20, 28, n);
    expect(f.get("--button-radius")!.light).toBe("var(--radius-pill)");
    expect(read("ui/css/components.css")).toContain("border-radius: var(--button-radius)");
  });
  it("has soft shadows", () => {
    const alphas = [...f.get("--shadow-low")!.light.matchAll(/ \.(\d+)\)/g)].map((m) => parseFloat(`0.${m[1]}`));
    expect(alphas.length).toBeGreaterThan(0);
    for (const a of alphas) expect(a).toBeLessThanOrEqual(0.1);
  });
});

describe("Bento", () => {
  const b = looks.bento;
  const t = withLook(base, b);
  it("has a sage ground and a green accent", () => {
    for (const theme of ["light", "dark"] as const) {
      between(hue(resolve(t, "--color-bg", theme)), 80, 140, `bg ${theme}`);
      between(hue(resolve(t, "--color-accent", theme)), 90, 150, `accent ${theme}`);
    }
  });
  it("has yellow tiles in light and charcoal tiles in dark", () => {
    for (const n of ["--color-surface", "--color-surface-2"]) between(hue(resolve(t, n, "light")), 45, 65, n);
    const dark = resolve(t, "--color-surface", "dark");
    expect(luminance(dark)).toBeLessThanOrEqual(0.03);
    const ch = [1, 3, 5].map((i) => parseInt(dark.slice(i, i + 2), 16));
    expect(Math.max(...ch) - Math.min(...ch)).toBeLessThanOrEqual(16);
  });
  it("uses 24 px tiles; the card and legacy radius follow --radius-lg", () => {
    expect(px(b, "--radius-lg")).toBe(24);
    expect(px(b, "--radius-xl")).toBe(24);
    expect(base.base.get("--card-radius")!.light).toBe("var(--radius-lg)");
    expect(base.base.get("--radius")!.light).toBe("var(--radius-lg)");
    expect(b.has("--card-radius")).toBe(false);
    expect(b.has("--radius")).toBe(false);
  });
});

/** Chroma (0–1, HSV-style) of a #rrggbb colour. */
function chroma(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...c) - Math.min(...c);
}
const isOrange = (hex: string) => { const h = hue(hex); return h >= 10 && h <= 40 && chroma(hex) >= 0.25; };

describe("Editorial", () => {
  const e = looks.editorial;
  const t = withLook(base, e);
  const css = (f: string) => read(`ui/${f}`);
  const rule = (src: string, sel: string) => {
    const m = new RegExp(`^${sel.replace(/[.>]/g, "\\$&")} \\{([^}]*)\\}`, "m").exec(src);
    if (!m) throw new Error(`no rule ${sel}`);
    return m[1]!;
  };

  it("is white and near-black in light, black and white in dark", () => {
    expect(resolve(t, "--color-bg", "light")).toBe("#ffffff");
    expect(luminance(resolve(t, "--color-text", "light"))).toBeLessThanOrEqual(0.01);
    expect(luminance(resolve(t, "--color-bg", "dark"))).toBeLessThanOrEqual(0.005);
    expect(luminance(resolve(t, "--color-text", "dark"))).toBeGreaterThanOrEqual(0.9);
  });
  it("has square corners and rings instead of soft shadows", () => {
    for (const n of ["sm", "md", "lg", "xl", "pill"]) expect(e.get(`--radius-${n}`)!.light).toBe("0");
    for (const n of ["--shadow-low", "--shadow-high"]) expect(e.get(n)!.light).toMatch(/^0 0 0 [12]px var\(--color-[\w-]+\)$/);
    expect(e.get("--shadow-sm")!.light).toBe("none");
  });
  it("has near-black borders in light and near-white in dark", () => {
    for (const n of ["--color-border", "--color-border-strong"]) {
      expect(luminance(resolve(t, n, "light")), n).toBeLessThanOrEqual(0.02);
      expect(luminance(resolve(t, n, "dark")), n).toBeGreaterThanOrEqual(0.7);
    }
  });
  it("uses a grotesk display font from the system", () => {
    const f = e.get("--font-display")!.light;
    expect(f).toContain("Helvetica");
    expect(f).toMatch(/sans-serif$/);
    expect(f).not.toMatch(/monospace/);
    expect(f).not.toBe(e.get("--font-body")!.light);
    expect(f).not.toMatch(/url\(|http/);
  });
  it("makes headings at least twice the base page size, in h1 and the kit page header", () => {
    const sizes = [...e.get("--text-heading")!.light.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]!));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(2 * parseFloat(base.base.get("--text-page")!.light));
    expect(css("css/reset.css")).toMatch(/^h1 \{[^}]*font-size: var\(--text-heading\)/m);
    expect(rule(css("kit/product.css"), ".scf-page-header__title")).toContain("font-size: var(--text-heading)");
  });
  it("sets labels in mono capitals, in the app and the kit", () => {
    expect(e.get("--font-label")!.light).toBe("var(--font-mono)");
    expect(e.get("--label-case")!.light).toBe("uppercase");
    const reset = css("css/reset.css"), comp = css("css/components.css");
    expect(rule(reset, "h3")).toContain("font-family: var(--font-label)");
    expect(rule(css("css/pages/shell.css"), ".subnav-head")).toContain("font-family: var(--font-label)");
    for (const s of [".field > span", ".table th"]) {
      expect(rule(comp, s), s).toContain("font-family: var(--font-label)");
      expect(rule(comp, s), s).toContain("text-transform: var(--label-case)");
    }
    for (const [f, s] of [["kit/forms.css", ".scf-field__label"], ["kit/display.css", ".scf-table__th"]] as const) {
      expect(rule(css(f), s), s).toContain("font-family: var(--font-label)");
      expect(rule(css(f), s), s).toContain("text-transform: var(--label-case)");
    }
  });
  it("uses orange only for what needs the person", () => {
    for (const theme of ["light", "dark"] as const) {
      // Near-black text on the #ff4f00 fill, in both modes (the pill and the approval badge).
      expect(resolve(t, "--color-waiting-soft", theme), theme).toBe("#ff4f00");
      expect(luminance(resolve(t, "--color-waiting", theme)), theme).toBeLessThanOrEqual(0.01);
      expect(ratio(resolve(t, "--color-waiting", theme), resolve(t, "--color-waiting-soft", theme)), theme).toBeGreaterThanOrEqual(4.5);
    }
    for (const n of t.base.keys()) {
      if (!n.startsWith("--color-") || ["--color-overlay", "--color-waiting", "--color-waiting-soft"].includes(n)) continue;
      for (const theme of ["light", "dark"] as const) {
        const v = resolve(t, n, theme);
        if (/^#[0-9a-f]{6}$/i.test(v)) expect(isOrange(v), `${n} ${theme} ${v}`).toBe(false);
      }
    }
  });
  it("keeps automatic routing off the orange tokens", () => {
    expect(e.get("--route")!.light).not.toMatch(/waiting/);
    for (const theme of ["light", "dark"] as const) expect(isOrange(resolve(t, "--route", theme))).toBe(false);
    expect(base.base.get("--route")!.light).toBe("var(--color-waiting)");
  });
  it("leaves the other looks and the base unchanged", () => {
    expect(base.base.get("--text-heading")!.light).toBe("var(--text-page)");
    expect(base.base.get("--font-label")!.light).toBe("var(--font-body)");
    expect(base.base.get("--label-case")!.light).toBe("none");
    for (const l of ["calm", "midnight", "friendly", "bento"] as const)
      for (const n of ["--text-heading", "--font-label", "--label-case", "--route"]) expect(looks[l].has(n), `${l} ${n}`).toBe(false);
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
  it("imports calm, midnight, friendly, editorial, then bento, and every look file", () => {
    expect(lookCssImports()).toEqual(["calm", "midnight", "friendly", "editorial", "bento"].map((n) => `/css/looks/${n}.css`));
    expect(readdirSync("ui/css/looks").filter((f) => f.endsWith(".css")).sort()).toEqual(["bento.css", "calm.css", "editorial.css", "friendly.css", "midnight.css"]);
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
  it("ignores an area rule in parseLook and returns it from lookAreaRules", () => {
    const src = 'html[data-look="x"] { --a: 1px; }\nhtml[data-look="x"][data-area="admin"] { color-scheme: dark; }';
    expect(parseLook(src, "x").get("--a")).toEqual({ light: "1px", dark: "1px" });
    expect(lookAreaRules(src, "x")).toEqual([{ area: "admin", scheme: "dark" }]);
    expect(lookTokenCss(src)).not.toContain("data-area");
  });
  it("throws for an area rule of another look or a second rule with other declarations", () => {
    expect(() => lookAreaRules('html[data-look="y"][data-area="a"] { color-scheme: dark; }', "x")).toThrow(/another look/);
    expect(() => parseLook('html[data-look="x"] { --a: 1px; } html[data-look="x"][data-area="a"] { color: red; }', "x")).toThrow();
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
