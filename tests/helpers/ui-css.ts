import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The UI stylesheet is split into modules (#337): ui/style.css only imports them. Tests that look at the CSS text read it
// through readUiCss() (files) or fetchUiCss() (HTTP) instead of reading ui/style.css directly.

export interface CssRule { context: string; selector: string; declarations: string[] }

const IMPORT_LINE = /^@import url\("(\/css\/[\w\-/]+\.css)"\);$/;

/** The "/css/…" paths of the entry file, in order. Throws when a line is not `@import url("/css/<path>.css");`. */
export function importsOf(entryText: string): string[] {
  const out: string[] = [];
  for (const line of entryText.split("\n")) {
    if (line.trim() === "") continue;
    const m = IMPORT_LINE.exec(line);
    if (!m) throw new Error(`ui/style.css: not an @import line: ${line}`);
    out.push(m[1]!);
  }
  return out;
}

/** The "/css/…" paths of ui/style.css, in order. */
export function uiCssImports(uiDir = "ui"): string[] {
  return importsOf(readFileSync(join(uiDir, "style.css"), "utf8"));
}

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFilesUnder(p));
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

/** The joined text of the imported modules ("\n" between files). Throws on an import with no file, and on a .css file
 *  under ui/css/ (recursive) that is not imported. */
export function readUiCss(uiDir = "ui"): string {
  const imports = uiCssImports(uiDir);
  const parts: string[] = [];
  for (const imp of imports) {
    const file = join(uiDir, imp);
    if (!existsSync(file)) throw new Error(`ui/style.css imports ${imp}, but ${file} does not exist`);
    parts.push(readFileSync(file, "utf8"));
  }
  const imported = new Set(imports.map((i) => join(uiDir, i)));
  const cssDir = join(uiDir, "css");
  if (existsSync(cssDir)) {
    for (const f of cssFilesUnder(cssDir)) if (!imported.has(f)) throw new Error(`${relative(".", f)} is not imported by ui/style.css`);
  }
  return parts.join("\n");
}

/** The same over HTTP: /style.css, then every import. Throws unless each answers 200 with text/css. */
export async function fetchUiCss(base: string): Promise<string> {
  const get = async (p: string) => {
    const r = await fetch(base + p);
    if (r.status !== 200) throw new Error(`${p}: status ${r.status}`);
    if (!(r.headers.get("content-type") ?? "").includes("text/css")) throw new Error(`${p}: content-type is ${r.headers.get("content-type")}`);
    return r.text();
  };
  const entry = await get("/style.css");
  const parts = [entry];
  for (const imp of importsOf(entry)) parts.push(await get(imp));
  return parts.join("\n");
}

/** Rules of plain CSS. Comments are dropped and white space collapsed. context is "" or the @media prelude.
 *  @keyframes is one rule (selector = prelude, one declaration = its body). @import is skipped. */
export function parseCss(text: string): CssRule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const rules: CssRule[] = [];
  const decls = (body: string) => body.split(";").map(norm).filter(Boolean);
  const scan = (s: string, context: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf("{", i);
      const semi = s.indexOf(";", i);
      if (semi >= 0 && (open < 0 || semi < open)) {
        i = semi + 1; // an @import line
        continue;
      }
      if (open < 0) break;
      const prelude = norm(s.slice(i, open));
      let depth = 1;
      let j = open + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      const body = s.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) scan(body, prelude);
      else if (prelude.startsWith("@keyframes")) rules.push({ context, selector: prelude, declarations: [norm(body)] });
      else rules.push({ context, selector: prelude, declarations: decls(body) });
      i = j;
    }
  };
  scan(src, "");
  return rules;
}

// Which selectors belong to the shared components (ui/css/components.css), so the page and template files stay out of them.

export interface SharedSelectors { classes: Set<string>; controls: Set<string>; ids: Set<string> }

const CONTROLS = ["button", "input", "select", "textarea"];

/** The selectors of one rule, split on commas outside brackets. */
const splitSelectors = (selector: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of selector) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
};

/** The first compound of a selector: `(...)` groups removed, then the text up to the first space, `>`, `+` or `~`. */
function firstCompound(selector: string): string {
  let s = selector;
  for (let prev = ""; prev !== s;) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, "");
  }
  return s.trim().split(/[\s>+~]/)[0] ?? "";
}

const leadingClass = (compound: string): string | undefined => /\.([\w-]+)/.exec(compound)?.[1];

/** From components.css: the leading class of the first compound of every selector; the bare controls; `#toast`. */
export function sharedSelectors(componentsCss: string): SharedSelectors {
  const classes = new Set<string>();
  for (const rule of parseCss(componentsCss)) {
    if (rule.selector.startsWith("@")) continue;
    for (const sel of splitSelectors(rule.selector)) {
      const cls = leadingClass(firstCompound(sel));
      if (cls) classes.add(cls);
    }
  }
  return { classes, controls: new Set(CONTROLS), ids: new Set(["#toast"]) };
}

/**
 * The selectors of `cssText` that compete with a shared component: any `.scf-` class, a bare control, a shared id, or a
 * first compound whose leading class is shared. `@keyframes` is skipped; rules inside `@media` are checked.
 */
export function competingSelectors(cssText: string, shared: SharedSelectors): string[] {
  const out: string[] = [];
  for (const rule of parseCss(cssText)) {
    if (rule.selector.startsWith("@")) continue;
    for (const sel of splitSelectors(rule.selector)) {
      const compound = firstCompound(sel);
      const tag = /^[a-z][\w-]*/i.exec(compound)?.[0];
      const cls = leadingClass(compound);
      const id = /^[a-z]*(#[\w-]+)/i.exec(compound)?.[1];
      if (sel.includes(".scf-") || (tag && shared.controls.has(tag)) || (id && shared.ids.has(id)) || (cls && shared.classes.has(cls))) out.push(sel);
    }
  }
  return out;
}

// Checks for the component kit (ui/kit/, #325).

const COLOR_NAMES = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
  "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta " +
  "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink " +
  "deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey " +
  "honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
  "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
  "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
  "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
  "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle " +
  "tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
const COLOR_FN = /(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const TOKEN_PREFIXES = ["--color-", "--font-", "--text-", "--leading-", "--weight-", "--space-", "--size-", "--border-", "--radius-", "--shadow-",
  "--motion-", "--control-", "--cell-", "--card-", "--stack-", "--page-", "--layer-"];
const COMPOUND = /^(\.scf-[a-z0-9_-]+)+(\[[a-z-]+(="[^"]*")?\]|:[a-z-]+)*$/;

/** Problems in kit CSS: an id selector, a bare tag, a class not starting with scf-, a colour literal (hex, function or
 *  any CSS colour keyword), a var() not in `tokens` or without a token prefix. `tokens` = names defined in ui/tokens.css. */
export function kitCssProblems(text: string, tokens: Set<string>): string[] {
  const out: string[] = [];
  for (const rule of parseCss(text)) {
    if (rule.selector.startsWith("@")) continue;
    for (const sel of rule.selector.split(",")) {
      for (const compound of sel.trim().split(/\s*[>+~]\s*|\s+/)) {
        if (!COMPOUND.test(compound)) out.push(`selector "${sel.trim()}": "${compound}" is not an .scf- class compound`);
      }
    }
    for (const decl of rule.declarations) {
      const value = decl.slice(decl.indexOf(":") + 1);
      const bare = value.replace(/var\([^)]*\)/g, "");
      if (/#[0-9a-f]{3,8}\b/i.test(bare) || COLOR_FN.test(bare) || (bare.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => COLOR_NAMES.has(w))) {
        out.push(`${rule.selector}: colour literal in "${decl}"`);
      }
      for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!tokens.has(m[1]!) || !TOKEN_PREFIXES.some((p) => m[1]!.startsWith(p))) out.push(`${rule.selector}: ${m[1]} is not a kit token`);
      }
    }
  }
  return out;
}

/** Problems in a kit module's source: a style key (`style:`, `"style":`, shorthand `style,` or `style }`), `style =`, `.style`. */
export function kitSourceProblems(source: string): string[] {
  const out: string[] = [];
  const patterns: [RegExp, string][] = [
    [/["']?\bstyle["']?\s*:/, "style key"],
    [/\bstyle\s*[,}]/, "shorthand style"],
    [/\bstyle\s*=(?!=)/, "style assignment"],
    [/\.style\b/, ".style access"],
  ];
  source.split("\n").forEach((line, i) => {
    for (const [re, what] of patterns) if (re.test(line)) out.push(`line ${i + 1}: ${what}`);
  });
  return out;
}

/** The "/kit/…" paths of ui/kit/kit.css, in order; throws on any other line. */
export function kitCssImports(uiDir = "ui"): string[] {
  const out: string[] = [];
  for (const line of readFileSync(join(uiDir, "kit", "kit.css"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const m = /^@import url\("(\/kit\/[\w-]+\.css)"\);$/.exec(line);
    if (!m) throw new Error(`ui/kit/kit.css: not an @import line: ${line}`);
    out.push(m[1]!);
  }
  return out;
}

/** Names of the custom properties that ui/tokens.css defines. */
export function tokenNames(uiDir = "ui"): Set<string> {
  return new Set([...readFileSync(join(uiDir, "tokens.css"), "utf8").matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]!));
}
