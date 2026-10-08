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
