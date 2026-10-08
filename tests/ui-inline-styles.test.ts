import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss, readUiCss } from "./helpers/ui-css.js";

// Inline style only for values computed from data (#338, #340). Spacing, widths and text sizes are classes from
// ui/css/utilities.css. This guard lists every `style:` and `.style.` left in ui/**/*.js.

type Hit = { file: string; line: number; text: string };
type Allowed = { file: string; has: string; reason: string };

const STYLE_USE = /\bstyle\s*:|\.style\s*[.[]|setAttribute\(\s*["']style["']/;

/** Every file whose inline styles are gone. A new inline style in one of them fails the test. */
const CLEAN = [
  "ui/admin.js", "ui/models.js", "ui/watcher-form.js", "ui/admin-repos.js", "ui/users.js",
  "ui/dashboard.js", "ui/problems.js", "ui/monitor.js", "ui/next.js",
  "ui/runs.js", "ui/user/runs.js", "ui/repos.js", "ui/refinement.js", "ui/refinement-suggest.js", "ui/refinement-publish.js",
  "ui/refinement-talk.js", "ui/refinement-impact.js", "ui/refinement-ready.js",
];

/** Lines left in a clean file. Matched by the text of the line, not the line number. */
const ALLOW: Allowed[] = [
  { file: "ui/dashboard.js", has: "tip.style.left =", reason: "chart tip position, computed from the bar" },
  { file: "ui/dashboard.js", has: "tip.style.top =", reason: "chart tip position, computed from the bar" },
  { file: "ui/dashboard.js", has: 'class: "rate-fill", style: { width:', reason: "rate bar width, computed from the data" },
];

/** The editor files, cleaned by #339. #340 is done. Whichever of the two is built last removes this list; here that is #339. */
const NOT_CLEANED_YET = ["ui/app.js", "ui/editor.js", "ui/graph.js", "ui/step-types.js", "ui/library.js", "ui/refinement-import.js"];

/** Selector to declarations, as the utility vocabulary defines them in ui/css/utilities.css. */
const margin = (side: "top" | "bottom", names: Array<[string, string]>): Record<string, string[]> =>
  Object.fromEntries(names.map(([n, px]) => [n, [`margin-${side}: ${px}`]]));
const UTILITIES: Record<string, string[]> = {
  ".stack": ["display: grid", "gap: 12px"],
  ".stack.tight": ["gap: 6px"],
  ".row.tight": ["gap: 6px"],
  ".row.tighter": ["gap: 4px"],
  ".row.center": ["justify-content: center"],
  ".flush": ["margin: 0"],
  ".fit": ["width: auto"],
  ".full": ["width: 100%"],
  ".w-70": ["width: 70px"],
  ".w-80": ["width: 80px"],
  ".w-90": ["width: 90px"],
  ".maxw-520": ["max-width: 520px"],
  ".text-sm": ["font-size: var(--text-code)"],
  ".text-xs": ["font-size: var(--text-meta)"],
  ".text-2xs": ["font-size: calc(var(--text-micro) + 0.5px)"],
  ".text-3xs": ["font-size: var(--text-micro)"],
  ...Object.fromEntries(Object.entries(margin("top", [["mt-4", "4px"], ["mt-6", "6px"], ["mt-8", "8px"], ["mt-10", "10px"], ["mt-16", "16px"], ["mt-22", "22px"], ["mt-neg-6", "-6px"]])).map(([k, v]) => [`.${k}`, v])),
  ...Object.fromEntries(Object.entries(margin("bottom", [["mb-4", "4px"], ["mb-6", "6px"], ["mb-8", "8px"], ["mb-10", "10px"], ["mb-12", "12px"], ["mb-14", "14px"], ["mb-16", "16px"]])).map(([k, v]) => [`.${k}`, v])),
  ".mx-12": ["margin-left: 12px", "margin-right: 12px"],
  ".px-12": ["padding-left: 12px", "padding-right: 12px"],
  ".pre-wrap": ["white-space: pre-wrap"],
  ".wrap-anywhere": ["overflow-wrap: anywhere"],
  ".break-all": ["word-break: break-all"],
  ".select-all": ["user-select: all"],
  ".block": ["display: block"],
  ".span-all": ["grid-column: 1 / -1"],
  ".cols-2": ["grid-template-columns: 1fr 1fr"],
};

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith(".js") ? [p] : [];
  });
}

function inlineStyles(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  source.split("\n").forEach((text, i) => {
    if (STYLE_USE.test(text)) hits.push({ file, line: i + 1, text });
  });
  return hits;
}

/** Messages for everything the rule forbids; an empty list means the tree is clean. */
function problems(hits: Hit[], clean: string[], notYet: string[], allow: Allowed[]): string[] {
  const out: string[] = [];
  for (const h of hits) {
    if (notYet.includes(h.file)) continue;
    if (!clean.includes(h.file)) out.push(`${h.file}:${h.line}: inline style in a file that is on no list; use a utility class`);
    else if (!allow.some((a) => a.file === h.file && h.text.includes(a.has))) out.push(`${h.file}:${h.line}: inline style in a clean file; use a utility class`);
  }
  for (const a of allow) {
    const n = hits.filter((h) => h.file === a.file && h.text.includes(a.has)).length;
    if (n !== 1) out.push(`allow-list entry "${a.has}" in ${a.file} matches ${n} lines, expected 1`);
    if (!a.reason.trim()) out.push(`allow-list entry "${a.has}" in ${a.file} has no reason`);
  }
  for (const f of notYet) if (!hits.some((h) => h.file === f)) out.push(`${f} has no inline style left; remove it from the not-cleaned-yet list`);
  return out;
}

/** The class names in the string literals of every `class:` value, including conditional branches and templates. */
function classTokens(source: string): string[] {
  const out: string[] = [];
  const re = /\bclass\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = re.lastIndex;
    let depth = 0;
    while (i < source.length) {
      const c = source[i]!;
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
        const text = source.slice(i + 1, j).replace(/\$\{[^}]*\}/g, " ");
        out.push(...text.split(/\s+/).filter(Boolean));
        i = j + 1;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      i++;
    }
  }
  return out;
}

const looksLikeUtility = (t: string) => /^(mt|mb|mx|px|w|maxw|text)-/.test(t) || Object.keys(UTILITIES).some((s) => s === `.${t}`);

describe("the guard", () => {
  const hit = (file: string, text: string): Hit => ({ file, line: 1, text });

  it("finds style: objects, .style assignments and setAttribute, and ignores look-alikes", () => {
    expect(inlineStyles("a.js", 'h("p", { style: { margin: 0 } })')).toHaveLength(1);
    expect(inlineStyles("a.js", "el.style.left = x")).toHaveLength(1);
    expect(inlineStyles("a.js", 'el.style["x"] = 1')).toHaveLength(1);
    expect(inlineStyles("a.js", "el.setAttribute('style', 'a')")).toHaveLength(1);
    expect(inlineStyles("a.js", 'link.href = "/style.css"; const styled = 1;')).toEqual([]);
  });

  it("reports a new inline style in a clean file and in an unlisted file", () => {
    expect(problems([hit("ui/users.js", "style: {")], ["ui/users.js"], [], [])).toHaveLength(1);
    expect(problems([hit("ui/new.js", "style: {")], ["ui/users.js"], [], [])).toHaveLength(1);
    expect(problems([hit("ui/app.js", "style: {")], ["ui/users.js"], ["ui/app.js"], [])).toEqual([]);
  });

  it("reports an allow-list entry that is stale, ambiguous or has no reason, and a stale not-cleaned-yet file", () => {
    const entry = { file: "ui/users.js", has: "tip.style.left", reason: "computed" };
    expect(problems([], ["ui/users.js"], [], [entry])).toHaveLength(1);
    expect(problems([hit("ui/users.js", "tip.style.left = 1"), hit("ui/users.js", "tip.style.left = 2")], ["ui/users.js"], [], [entry])).toHaveLength(1);
    expect(problems([hit("ui/users.js", "tip.style.left = 1")], ["ui/users.js"], [], [{ ...entry, reason: " " }])).toHaveLength(1);
    expect(problems([], [], ["ui/app.js"], [])).toHaveLength(1);
  });

  it("reads the classes of conditional and template values", () => {
    expect(classTokens('h("p", { class: "row mt-5" })')).toEqual(["row", "mt-5"]);
    expect(classTokens('h("p", { class: dryRun ? "muted flush" : "status ok flush", id: "x" })')).toEqual(["muted", "flush", "status", "ok", "flush"]);
    expect(classTokens("h(\"p\", { class: `pill ${s} mb-4` })")).toEqual(["pill", "mb-4"]);
  });
});

describe("ui/**/*.js", () => {
  const files = jsFiles("ui");
  const hits = files.flatMap((f) => inlineStyles(f, readFileSync(f, "utf8")));

  it("has inline styles only where the lists allow them", () => {
    expect(problems(hits, CLEAN, NOT_CLEANED_YET, ALLOW)).toEqual([]);
  });

  it("leaves exactly the three computed values in the clean files", () => {
    const left = hits.filter((h) => CLEAN.includes(h.file));
    expect(left.map((h) => h.file)).toEqual(["ui/dashboard.js", "ui/dashboard.js", "ui/dashboard.js"]);
  });

  it("lists only files that exist", () => {
    for (const f of [...CLEAN, ...NOT_CLEANED_YET]) expect(files, f).toContain(f);
  });

  it("gives the checkbox row its own rule, and leaves the split label as it is", () => {
    const rules = parseCss(readFileSync("ui/css/components.css", "utf8")).filter((r) => r.selector === ".check-row");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.declarations).toEqual(["display: flex", "gap: 6px", "align-items: center"]);
    const split = readFileSync("ui/refinement-split.js", "utf8");
    expect(split).toContain('class: "check"');
    expect(split).not.toContain("check-row");
  });

  it("does not put .row on checkbox labels in the drafts, because `.drafts .row input` in pages/refinement.css stretches them", () => {
    for (const f of ["ui/refinement-impact.js", "ui/refinement-publish.js"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain('class: "check check-row"');
      expect(src, f).toContain('class: "fit"');
      expect(src, f).not.toMatch(/class: "check row/);
    }
  });

  it("uses the same classes on both run pages", () => {
    for (const f of ["ui/runs.js", "ui/user/runs.js"]) {
      const src = readFileSync(f, "utf8");
      for (const c of ["flush pre-wrap", "card mb-16", "seg tabs mb-12"]) expect(src, `${f}: ${c}`).toContain(`class: "${c}"`);
    }
  });

  it("does not use the stack class on a form that has no rule for it (ui/auth.js)", () => {
    expect(readFileSync("ui/auth.js", "utf8")).not.toContain('class: "stack"');
  });
});

describe("the utility classes", () => {
  const rules = parseCss(readFileSync("ui/css/utilities.css", "utf8"));

  it("have exactly the declarations of the inline style they replace", () => {
    for (const [selector, declarations] of Object.entries(UTILITIES)) {
      const found = rules.filter((r) => r.context === "" && r.selector === selector);
      expect(found, selector).toHaveLength(1);
      expect(found[0]!.declarations, selector).toEqual(declarations);
    }
  });

  it("put .flush before every margin class, so `flush mt-4` keeps the other margins at zero", () => {
    const at = (s: string) => rules.findIndex((r) => r.selector === s);
    for (const s of Object.keys(UTILITIES).filter((k) => /^\.(mt|mb|mx)-/.test(k))) expect(at(".flush"), s).toBeLessThan(at(s));
  });

  it("have a [hidden] rule in reset.css that wins over display rules", () => {
    const rule = parseCss(readFileSync("ui/css/reset.css", "utf8")).find((r) => r.selector === "[hidden]");
    expect(rule?.declarations).toEqual(["display: none !important"]);
  });

  it("exist in the stylesheet for every utility class the clean files use", () => {
    const selectors = parseCss(readUiCss()).flatMap((r) => r.selector.split(","));
    const defined = (t: string) => selectors.some((s) => new RegExp(`\\.${t.replace(/[-]/g, "\\-")}(?![\\w-])`).test(s));
    for (const f of CLEAN) {
      for (const t of new Set(classTokens(readFileSync(f, "utf8")).filter(looksLikeUtility))) expect(defined(t), `${f}: .${t}`).toBe(true);
    }
    expect(defined("mt-5")).toBe(false);
  });
});
