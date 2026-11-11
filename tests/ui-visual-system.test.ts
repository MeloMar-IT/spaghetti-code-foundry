import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAIRS, SEMANTICS, checkPairs, failures, parseTokens, ratio, readUiCss, resolve, splitValue } from "./helpers/ui-css.js";

// ui/tokens.css is the one place for colours, type, spacing and density (#322). This test reads the files as text,
// computes every contrast ratio and keeps ui/style.css free of raw values. It does not check how the pages look.

const read = (p: string) => readFileSync(p, "utf8");

/** The full token inventory by group; the CSS must define exactly these (plus the legacy names). */
const GROUPS: Record<string, string[]> = {
  colour: [
    "bg", "surface", "surface-2", "border", "border-strong", "text", "text-muted", "focus", "overlay", "on-accent", "on-danger", "step-shell",
    "log-bg", "log-text", "log-ok", "log-fail", "log-step", "log-dim",
    ...SEMANTICS, ...SEMANTICS.map((s) => `${s}-soft`),
  ].map((n) => `--color-${n}`),
  typography: [
    "--font-body", "--font-display", "--font-sans", "--font-mono", "--font-numeric", "--text-micro", "--text-meta", "--text-small", "--text-code", "--text-body", "--text-table", "--text-table-head",
    "--text-section", "--text-page", "--text-heading", "--font-label", "--label-case","--text-display", "--leading-body", "--leading-tight", "--weight-regular", "--weight-medium", "--weight-bold",
  ],
  spacing: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map((n) => `--space-${n}`),
  sizing: ["--size-icon", "--size-icon-sm", "--size-sidebar", "--size-form", "--size-bar", "--size-touch", "--size-touch-min"],
  borders: ["--border-width", "--radius-none", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-pill", "--radius-round"],
  components: ["--pill-pad-y", "--pill-pad-x", "--pill-gap", "--pill-radius", "--card-radius", "--button-radius", "--table-radius", "--focus-width", "--focus-offset"],
  elevation: ["--shadow-none", "--shadow-low", "--shadow-high", "--shadow-sm", "--shadow-md", "--shadow-lg"],
  motion: ["--motion-fast", "--motion-base", "--motion-slow"],
  density: ["--control-pad-y", "--control-pad-x", "--cell-pad-y", "--cell-pad-x", "--card-pad", "--stack-gap", "--page-pad-y", "--page-pad-x"],
  layering: ["--layer-sticky", "--layer-menu", "--layer-overlay", "--layer-toast"],
  legacy: [
    "--bg", "--panel", "--panel-2", "--border", "--text", "--muted", "--accent", "--accent-soft", "--ok", "--ok-soft", "--fail", "--fail-soft",
    "--run", "--run-soft", "--claude", "--route", "--shell", "--radius", "--mono", "--sans",
  ],
};
const DENSITY = ["--text-body", "--text-table", "--control-pad-y", "--control-pad-x", "--cell-pad-y", "--cell-pad-x", "--card-pad", "--stack-gap", "--page-pad-y", "--page-pad-x", "--size-bar"];

const tokens = parseTokens(read("ui/tokens.css"));
const style = readUiCss(); // ui/style.css only imports the modules under ui/css/ (#337)
const sorted = (xs: Iterable<string>) => [...xs].sort();

/** The body of the first rule that starts a line with the selector (indent = the leading spaces). */
function rule(css: string, selector: string, indent = ""): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${indent}${esc} \\{([^}]*)\\}`, "m").exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

describe("helpers", () => {
  it("computes contrast like WCAG 2", () => {
    expect(ratio("#000000", "#ffffff")).toBe(21);
    expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(ratio("#fff", "#ffffff")).toBe(ratio("#ffffff", "#fff"));
  });

  it("splits light-dark values", () => {
    expect(splitValue("light-dark(#fff, #000)")).toEqual({ light: "#fff", dark: "#000" });
    expect(splitValue("12px")).toEqual({ light: "12px", dark: "12px" });
  });

  it("rejects a malformed light-dark(", () => {
    for (const v of ["light-dark(#fff)", "light-dark(#fff, #000", "light-dark(#fff, #000, #111)"]) expect(() => splitValue(v), v).toThrow();
  });

  it("throws for an unknown token", () => {
    expect(() => resolve(tokens, "--nope", "light")).toThrow(/unknown token/);
  });

  it("reports a failing pair, and only when it is under its threshold", () => {
    const t = parseTokens(":root { --a: #777777; --b: #ffffff; }");
    const pair = { fg: "--a", bg: "--b" };
    expect(failures(checkPairs(t, [{ ...pair, min: 4.5 }])).map((r) => r.fg)).toEqual(["--a"]);
    expect(failures(checkPairs(t, [{ ...pair, min: 3 }]))).toEqual([]);
    expect(failures(checkPairs(t, [{ ...pair, min: "exempt" }]))).toEqual([]);
  });
});

describe("ui/tokens.css", () => {
  it("defines exactly the token inventory, in the base block", () => {
    const expected = Object.values(GROUPS).flat();
    expect(sorted(tokens.base.keys())).toEqual(sorted([...expected, "--size-bar"].filter((n, i, a) => a.indexOf(n) === i)));
    for (const [group, names] of Object.entries(GROUPS)) for (const n of names) expect(tokens.base.has(n), `${group}: ${n}`).toBe(true);
  });

  it("writes every colour of the colour group as light-dark() or a fixed value", () => {
    for (const s of SEMANTICS) for (const n of [`--color-${s}`, `--color-${s}-soft`]) {
      const d = tokens.base.get(n)!;
      expect(d.light, n).not.toBe(d.dark);
    }
    expect(read("ui/tokens.css")).toMatch(/--color-accent: light-dark\(/);
  });

  it("has the seven type levels", () => {
    for (const n of ["page", "section", "body", "meta", "code", "table", "table-head"]) expect(tokens.base.has(`--text-${n}`), n).toBe(true);
  });

  it("defines every density token twice (root and compact) and nowhere else", () => {
    expect(sorted(tokens.compact.keys())).toEqual(sorted(DENSITY));
    for (const n of DENSITY) expect(tokens.base.has(n), n).toBe(true);
    expect(tokens.other).toEqual([]);
    for (const n of DENSITY) {
      expect(tokens.baseNames.filter((x) => x === n), `${n} in root`).toHaveLength(1);
      expect(tokens.compactNames.filter((x) => x === n), `${n} in compact`).toHaveLength(1);
    }
  });

  it("declares no token twice in the root block", () => {
    expect(tokens.baseNames.filter((n, i, a) => a.indexOf(n) !== i)).toEqual([]);
  });

  it("counts a repeated declaration", () => {
    const t = parseTokens(":root { --a: 1px; --a: 2px; }");
    expect(t.baseNames).toEqual(["--a", "--a"]);
  });

  it("sets the three motion tokens to 0s under reduced motion", () => {
    expect(Object.fromEntries(tokens.reduced)).toEqual({ "--motion-fast": "0s", "--motion-base": "0s", "--motion-slow": "0s" });
  });

  it("lets the theme be forced and otherwise follows the system", () => {
    const css = read("ui/tokens.css");
    expect(css).toContain("color-scheme: light dark");
    expect(css).toContain(':root[data-theme="light"] { color-scheme: light; }');
    expect(css).toContain(':root[data-theme="dark"] { color-scheme: dark; }');
  });

  it("only uses defined variables", () => {
    for (const m of read("ui/tokens.css").matchAll(/var\((--[\w-]+)/g)) expect(tokens.base.has(m[1]!), m[1]).toBe(true);
  });

  it("passes every contrast pair, in both themes", () => {
    const results = checkPairs(tokens, PAIRS);
    expect(results).toHaveLength(34);
    expect(failures(results).map((r) => `${r.fg} on ${r.bg}: ${r.light.toFixed(2)} / ${r.dark.toFixed(2)}`)).toEqual([]);
  });
});

describe("ui/style.css", () => {
  it("has no raw colour, z-index, font-size or border-radius", () => {
    const bodies = [...style.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!).join("\n");
    expect(bodies).not.toMatch(/#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i);
    expect(style).not.toMatch(/z-index:\s*-?\d/);
    expect(style).not.toMatch(/font-size:\s*\.?\d/);
    expect(style).not.toMatch(/\bfont:[^;}]*\d(?:px|rem|em)/);
    expect(style).not.toMatch(/border-radius:\s*\.?\d/);
  });

  it("does not mention density, theme, :root or the system colour scheme", () => {
    for (const s of ["data-density", "data-theme", ":root", "prefers-color-scheme"]) expect(style, s).not.toContain(s);
  });

  it("only uses variables that tokens.css defines", () => {
    for (const m of style.matchAll(/var\((--[\w-]+)/g)) expect(tokens.base.has(m[1]!), `ui/css: ${m[1]}`).toBe(true);
    const files = [...readdirSync("ui").filter((f) => f.endsWith(".js")).map((f) => `ui/${f}`), ...readdirSync("ui/user").filter((f) => f.endsWith(".js")).map((f) => `ui/user/${f}`)];
    for (const f of files) for (const m of read(f).matchAll(/var\((--[\w-]+)/g)) expect(tokens.base.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
  });

  it("uses the density tokens in the shared rules", () => {
    const expectIn = (body: string, ...parts: string[]) => { for (const p of parts) expect(body, p).toContain(p); };
    expectIn(rule(style, "body"), "var(--text-body)");
    expectIn(rule(style, ".top"), "var(--size-bar)");
    expectIn(rule(style, "main"), "var(--page-pad-y)", "var(--page-pad-x)");
    expectIn(rule(style, "main", "  "), "min(var(--page-pad-y)", "min(var(--page-pad-x)");
    expectIn(rule(style, "button, .btn"), "var(--control-pad-y)", "var(--control-pad-x)");
    expectIn(rule(style, "input, select, textarea"), "var(--control-pad-y)", "var(--control-pad-x)");
    expectIn(rule(style, ".table th, .table td"), "var(--cell-pad-y)", "var(--cell-pad-x)", "var(--text-table)");
    expectIn(rule(style, ".table th"), "var(--text-table-head)");
    expectIn(rule(style, ".card"), "var(--card-pad)", "var(--stack-gap)");
    expectIn(rule(style, ".tile"), "var(--card-pad)");
    expectIn(rule(style, ".user-display .top"), "var(--size-bar)", "flex-wrap: wrap");
  });

  it("draws the focus indicators with --color-focus", () => {
    expect(rule(style, "input:focus-visible, select:focus-visible, textarea:focus-visible")).toMatch(/outline: 2px solid var\(--color-focus\)[^;]*;\s*border-color: var\(--color-focus\)/);
    expect(rule(style, "a:focus-visible, button:focus-visible, summary:focus-visible, [tabindex]:focus-visible")).toContain("var(--color-focus)");
  });
});

describe("the component tokens", () => {
  const kit = (f: string) => read(`ui/kit/${f}.css`);

  it("are used by the pill, card, button, table and focus rules, and by the kit", () => {
    const expectIn = (body: string, ...parts: string[]) => { for (const p of parts) expect(body, p).toContain(p); };
    expectIn(rule(style, ".pill"), "var(--pill-pad-y) var(--pill-pad-x)", "var(--pill-gap)", "var(--pill-radius)");
    expectIn(rule(style, ".card"), "var(--card-radius)");
    expectIn(rule(style, "button, .btn"), "var(--button-radius)");
    expectIn(rule(style, ".table"), "var(--table-radius)");
    expectIn(rule(style, "a:focus-visible, button:focus-visible, summary:focus-visible, [tabindex]:focus-visible"), "var(--focus-width)", "var(--focus-offset)");
    expectIn(rule(kit("display"), ".scf-card"), "var(--card-radius)");
    expectIn(rule(kit("display"), ".scf-badge"), "var(--pill-pad-y) var(--pill-pad-x)", "var(--pill-radius)", "var(--pill-gap)");
    expectIn(rule(kit("display"), ".scf-table-box"), "var(--table-radius)");
    expectIn(rule(kit("actions"), ".scf-btn"), "var(--button-radius)");
  });

  it("draw the focus ring of the kit with the width and offset tokens", () => {
    for (const f of ["actions", "display", "forms"]) {
      const lines = kit(f).split("\n").filter((l) => l.includes(":focus-visible") && l.includes("outline:"));
      expect(lines.length, f).toBeGreaterThan(0);
      for (const l of lines) expect(l, `${f}: ${l}`).toContain("var(--focus-width)");
    }
  });
});

describe("status pills show a glyph, not colour alone", () => {
  const glyphRules = [...style.matchAll(/^\.pill:is\(([^)]*)\):not\(:has\(> \.ico\)\)::before \{ content: "(.)"; content: "\2" \/ ""; \}$/gm)];
  const classesWithGlyph = new Map(glyphRules.flatMap((m) => m[1]!.split(",").map((c) => [c.trim().slice(1), m[2]!] as const)));

  it("has a glyph rule with empty alt text that skips a pill with an icon", () => {
    expect(glyphRules.length).toBeGreaterThanOrEqual(7);
    expect(style).toContain(":not(:has(> .ico))::before");
  });

  it("covers every status class a pill is drawn with", () => {
    // the semantic tones (statusMark and kit helpers), the fixed status classes of the CSS and the refinement states
    const want = ["sem-success", "sem-danger", "sem-warning", "sem-running", "sem-waiting", "sem-info", "sem-disabled",
      "ok", "fail", "locked", "approval", "kind-done", "kind-running", "state-active", "state-error", "state-ready", "state-published",
      "ready-met", "ready-not-met", "who-you", "who-something-is-wrong", "who-a-time-limit", "state-exploring", "state-drafting", "state-dropped"];
    for (const c of want) expect(classesWithGlyph.has(c), c).toBe(true);
    // a status without a glyph is only a neutral or accent label
    for (const c of ["sem-neutral", "sem-accent"]) expect(classesWithGlyph.has(c), c).toBe(false);
  });

  it("uses the same glyph for the same meaning", () => {
    expect(classesWithGlyph.get("sem-success")).toBe(classesWithGlyph.get("ok"));
    expect(classesWithGlyph.get("sem-danger")).toBe(classesWithGlyph.get("fail"));
    expect(classesWithGlyph.get("sem-warning")).toBe(classesWithGlyph.get("locked"));
  });

  it("gives the kit badge tones a glyph with empty alt text", () => {
    const css = read("ui/kit/display.css");
    for (const tone of ["ok", "fail", "warn", "run", "neutral"]) expect(css, tone).toMatch(new RegExp(`\\.scf-badge--${tone}::before \\{ content: "(.)"; content: "\\1" / ""; \\}`));
  });
});

describe("pages", () => {
  it("load /tokens.css, /looks.css, /style.css, then /kit/kit.css", () => {
    for (const p of ["ui/index.html", "ui/user/index.html"]) {
      const hrefs = [...read(p).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs, p).toEqual(["/tokens.css", "/looks.css", "/style.css", "/kit/kit.css"]);
    }
  });
});

describe("docs/ui-redesign/visual-system-demo.html", () => {
  const demo = read("docs/ui-redesign/visual-system-demo.html");
  const badEmails = (text: string) => (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).filter((e) => !e.endsWith("@example.test"));

  it("links only the real tokens and style files", () => {
    expect([...demo.matchAll(/<link [^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual(["../../ui/tokens.css", "../../ui/style.css"]);
    expect(demo).not.toContain("<style");
    expect(demo).not.toMatch(/<script[^>]*\ssrc=/);
  });

  it("has fake data only", () => {
    expect(demo).not.toMatch(/https?:\/\//);
    expect(demo).not.toMatch(/\/Users\/|\/home\//);
    expect(badEmails(demo)).toEqual([]);
  });

  it("shows a data-heavy table and a conversational talk with switches", () => {
    expect(demo).toContain('class="table"');
    expect(demo).toContain('class="talk"');
    expect(demo).toContain("dataset.theme");
    expect(demo).toContain("dataset.density");
  });

  it("uses only classes that ui/style.css has", () => {
    const classes = new Set([...demo.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/).filter(Boolean)));
    for (const c of classes) expect(style, c).toMatch(new RegExp(`\\.${c}(?![\\w-])`));
  });

  it("is not part of the published package", () => {
    const files: string[] = JSON.parse(read("package.json")).files ?? [];
    expect(files.some((f) => f.includes("docs/ui-redesign"))).toBe(false);
  });
});
