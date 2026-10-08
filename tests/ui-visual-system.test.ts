import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ui/tokens.css is the one place for colours, type, spacing and density (#322). This test reads the files as text,
// computes every contrast ratio and keeps ui/style.css free of raw values. It does not check how the pages look.

const read = (p: string) => readFileSync(p, "utf8");

type Theme = "light" | "dark";
type Decl = { light: string; dark: string };
type Tokens = {
  base: Map<string, Decl>;
  compact: Map<string, string>;
  reduced: Map<string, string>;
  other: string[];
  /** Every declaration in order, so a duplicate is not collapsed by the Maps. */
  baseNames: string[];
  compactNames: string[];
};
type Pair = { fg: string; bg: string; min: number | "exempt" };
type PairResult = Pair & { light: number; dark: number; pass: boolean };

/** "light-dark(a, b)" → {light:a, dark:b}; any other value → both. Throws on a malformed light-dark(. */
function splitValue(value: string): Decl {
  const v = value.trim();
  if (v.startsWith("light-dark(")) {
    const m = /^light-dark\(([^,()]+), ([^,()]+)\)$/.exec(v);
    if (!m) throw new Error(`malformed light-dark(): ${v}`);
    return { light: m[1]!.trim(), dark: m[2]!.trim() };
  }
  return { light: v, dark: v };
}

const declarations = (body: string): [string, string][] => [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]);

/** Parses tokens.css: the first `:root {}` block, the compact block, the reduced-motion block. */
function parseTokens(source: string): Tokens {
  let css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const take = (re: RegExp): string => {
    const m = re.exec(css);
    if (!m) return "";
    css = css.replace(m[0], "");
    return m[1]!;
  };
  const base = new Map<string, Decl>();
  const baseDecls = declarations(take(/:root\s*\{([^}]*)\}/));
  for (const [k, v] of baseDecls) base.set(k, splitValue(v));
  const compactDecls = declarations(take(/:root\[data-density="compact"\]\s*\{([^}]*)\}/));
  const compact = new Map<string, string>(compactDecls);
  const reduced = new Map<string, string>(declarations(take(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/)));
  const other = declarations(css).map(([k]) => k);
  return { base, compact, reduced, other, baseNames: baseDecls.map(([k]) => k), compactNames: compactDecls.map(([k]) => k) };
}

/** Follows var(--x) until a hex colour; throws when a name is unknown or the value is not #rgb/#rrggbb. */
function resolve(t: Tokens, name: string, theme: Theme): string {
  const decl = t.base.get(name);
  if (!decl) throw new Error(`unknown token ${name}`);
  const value = decl[theme];
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolve(t, ref[1]!, theme);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`${name} is not a hex colour: ${value}`);
  const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
  return `#${h.toLowerCase()}`;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function ratio(a: string, b: string): number {
  const full = (h: string) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h);
  const [l1, l2] = [luminance(full(a)), luminance(full(b))].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

function checkPairs(t: Tokens, pairs: Pair[]): PairResult[] {
  return pairs.map((p) => {
    const light = ratio(resolve(t, p.fg, "light"), resolve(t, p.bg, "light"));
    const dark = ratio(resolve(t, p.fg, "dark"), resolve(t, p.bg, "dark"));
    return { ...p, light, dark, pass: p.min === "exempt" || (light >= p.min && dark >= p.min) };
  });
}
const failures = (rs: PairResult[]) => rs.filter((r) => !r.pass);

const SEMANTICS = ["neutral", "accent", "success", "warning", "danger", "info", "running", "waiting", "disabled"];
const TEXT_ON = ["--color-bg", "--color-surface", "--color-surface-2"];
const PAIRS: Pair[] = [
  ...["--color-text", "--color-text-muted"].flatMap((fg) => TEXT_ON.map((bg) => ({ fg, bg, min: 4.5 }))),
  ...SEMANTICS.flatMap((s) => {
    const min = s === "disabled" ? ("exempt" as const) : 4.5;
    return [{ fg: `--color-${s}`, bg: `--color-${s}-soft`, min }, { fg: `--color-${s}`, bg: "--color-surface", min }];
  }),
  { fg: "--color-on-accent", bg: "--color-accent", min: 4.5 },
  { fg: "--color-on-danger", bg: "--color-danger", min: 4.5 },
  ...["--color-border-strong", "--color-focus"].flatMap((fg) => ["--color-bg", "--color-surface"].map((bg) => ({ fg, bg, min: 3 }))),
  ...["text", "ok", "fail", "step", "dim"].map((s) => ({ fg: `--color-log-${s}`, bg: "--color-log-bg", min: 4.5 })),
];

/** The full token inventory by group; the CSS must define exactly these (plus the legacy names). */
const GROUPS: Record<string, string[]> = {
  colour: [
    "bg", "surface", "surface-2", "border", "border-strong", "text", "text-muted", "focus", "overlay", "on-accent", "on-danger", "step-shell",
    "log-bg", "log-text", "log-ok", "log-fail", "log-step", "log-dim",
    ...SEMANTICS, ...SEMANTICS.map((s) => `${s}-soft`),
  ].map((n) => `--color-${n}`),
  typography: [
    "--font-sans", "--font-mono", "--text-micro", "--text-meta", "--text-small", "--text-code", "--text-body", "--text-table", "--text-table-head",
    "--text-section", "--text-page", "--text-display", "--leading-body", "--leading-tight", "--weight-regular", "--weight-medium", "--weight-bold",
  ],
  spacing: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map((n) => `--space-${n}`),
  sizing: ["--size-icon", "--size-icon-sm", "--size-sidebar", "--size-form", "--size-bar"],
  borders: ["--border-width", "--radius-none", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-pill", "--radius-round"],
  elevation: ["--shadow-sm", "--shadow-md", "--shadow-lg"],
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
const style = read("ui/style.css");
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
    expect(results).toHaveLength(35);
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
    const files = ["ui/style.css", ...readdirSync("ui").filter((f) => f.endsWith(".js")).map((f) => `ui/${f}`), ...readdirSync("ui/user").filter((f) => f.endsWith(".js")).map((f) => `ui/user/${f}`)];
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
    expect(rule(style, "input:focus, select:focus, textarea:focus")).toMatch(/outline: 2px solid var\(--color-focus\)[^;]*;\s*border-color: var\(--color-focus\)/);
    expect(rule(style, "a:focus-visible, button:focus-visible, summary:focus-visible, [tabindex]:focus-visible")).toContain("var(--color-focus)");
  });
});

describe("pages", () => {
  it("load /tokens.css before /style.css", () => {
    for (const p of ["ui/index.html", "ui/user/index.html"]) {
      const hrefs = [...read(p).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs, p).toEqual(["/tokens.css", "/style.css"]);
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
