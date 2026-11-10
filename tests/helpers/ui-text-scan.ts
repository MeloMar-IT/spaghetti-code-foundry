// A small scanner for the text a UI file shows: the string literals of a .js file and the text of a .html file.
// TypeScript 7 has no JS compiler API here, so this is a character tokenizer.

export interface Found { text: string; line: number }

const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

export function jsStrings(source: string): Found[] {
  const out: Found[] = [];
  const src = source;
  let line = 1;
  const lineAt = (i: number) => 1 + (src.slice(0, i).match(/\n/g) || []).length;
  void line;

  /** Tokenize src[from..] until the closing brace of a `${` (depth 0), or the end. Returns the end index. */
  function code(from: number, untilBrace: boolean): number {
    let i = from, depth = 0, last = "";
    let lastWord = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1, text = "";
        while (j < src.length && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") { text += src[j + 1] ?? ""; j += 2; } else text += src[j++]; }
        out.push({ text, line: lineAt(i) });
        i = j + 1; last = c; lastWord = ""; continue;
      }
      if (c === "`") { i = template(i); last = "`"; lastWord = ""; continue; }
      if (c === "/") {
        if (last === "" || REGEX_AFTER.includes(last) || REGEX_WORDS.has(lastWord)) {
          let j = i + 1, cls = false;
          while (j < src.length && src[j] !== "\n") {
            if (src[j] === "\\") { j += 2; continue; }
            if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false;
            else if (src[j] === "/" && !cls) break;
            j++;
          }
          j++;
          while (/[a-z]/i.test(src[j] ?? "")) j++;
          i = j; last = ")"; lastWord = ""; continue;
        }
        last = "/"; lastWord = ""; i++; continue;
      }
      if (untilBrace) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) return i; depth--; }
      }
      if (/\s/.test(c)) { i++; continue; }
      if (/[A-Za-z_$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j] ?? "")) j++; lastWord = src.slice(i, j); last = "a"; i = j; continue; }
      if (/\d/.test(c)) { let j = i; while (/[\w.]/.test(src[j] ?? "")) j++; i = j; last = "0"; lastWord = ""; continue; }
      last = c; lastWord = ""; i++;
    }
    return i;
  }

  /** At a backtick: read the template, return the index after its closing backtick. */
  function template(start: number): number {
    let i = start + 1, text = "";
    const at = lineAt(start);
    const inner: number[] = [];
    void inner;
    const pending: Found[] = [];
    const saved = out.length;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { text += src[i + 1] ?? ""; i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") { text += "{}"; i = code(i + 2, true) + 1; continue; }
      text += src[i++];
    }
    void pending;
    out.splice(saved, 0, { text, line: at });
    return i + 1;
  }

  code(0, false);
  return out;
}

export function htmlTexts(html: string): Found[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<script[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<style[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));
  const out: Found[] = [];
  const lineAt = (i: number) => 1 + (clean.slice(0, i).match(/\n/g) || []).length;
  const re = /<[^>]*>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const s = m[0];
    if (s.startsWith("<")) {
      for (const a of s.matchAll(/\b(aria-label|title|placeholder|alt)\s*=\s*("([^"]*)"|'([^']*)')/g)) out.push({ text: a[3] ?? a[4] ?? "", line: lineAt(m.index) });
    } else if (s.trim()) out.push({ text: s.replace(/\s+/g, " ").trim(), line: lineAt(m.index) });
  }
  return out;
}
