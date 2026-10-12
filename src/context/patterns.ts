import { ContextOwnerSchema } from "./schema.js";

/**
 * Reading the three kinds of repository text the selector must understand: path patterns, an ownership file
 * (`CODEOWNERS`) and the "generated" marks (`.gitattributes` and a header line). Pure: text in, answers out.
 *
 * The text comes from the repository, so nothing here trusts it: a pattern is matched part by part with a table
 * (never turned into a regular expression), lines and patterns have a length limit, and a line that is not understood
 * is skipped.
 */

export const PATTERN_MAX = 512;
const PARTS_MAX = 64;

/**
 * How a pattern that matched a folder treats what is inside it.
 * - `file`: the pattern must match the whole path (`.gitattributes`: a pattern never matches through a folder).
 * - `owners`: the rules of `CODEOWNERS` on GitHub: `docs/` and `docs` also match everything below that folder, but a
 *   pattern whose last part has a `*` (such as `docs/*`) matches only that level.
 */
export type PatternMode = "file" | "owners";

/** One part of a path against one part of a pattern: `*` is any run of characters, `?` is one. No `/` is ever in a part. */
function matchPart(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

type End = "exact" | "inside" | "exact-or-inside";

/**
 * The parts of a pattern against the parts of a path. `**` is any number of parts (none too), but at least one when it
 * is the last part. A table, so it cannot run away on a hostile pattern.
 */
function matchParts(pattern: readonly string[], path: readonly string[], end: End): boolean {
  const rows = pattern.length + 1;
  const cols = path.length + 1;
  const memo = new Int8Array(rows * cols); // 0 unknown, 1 yes, 2 no
  const at = (i: number, j: number): boolean => {
    const key = i * cols + j;
    if (memo[key] !== 0) return memo[key] === 1;
    let ok: boolean;
    if (i === pattern.length) ok = end === "exact" ? j === path.length : end === "inside" ? j < path.length : true;
    else if (pattern[i] === "**") {
      if (i === pattern.length - 1) ok = j < path.length;
      else {
        ok = false;
        for (let k = j; k <= path.length && !ok; k++) ok = at(i + 1, k);
      }
    } else ok = j < path.length && matchPart(pattern[i] as string, path[j] as string) && at(i + 1, j + 1);
    memo[key] = ok ? 1 : 2;
    return ok;
  };
  return at(0, 0);
}

/**
 * A test for one path pattern in the spelling `.gitignore` uses, as far as `CODEOWNERS` and `.gitattributes` share
 * it: `*`, `?`, `**`, a `/` at the start (from the root only) and at the end (a folder). Returns undefined for a
 * pattern that is not understood (`[…]`, `\`, `!`, a quote, too long): such a line is skipped, never guessed.
 * The path given to the test is relative to the folder the pattern file is about, with `/` between parts.
 */
export function compilePattern(pattern: string, mode: PatternMode): ((path: string) => boolean) | undefined {
  if (pattern.length < 1 || pattern.length > PATTERN_MAX || /[[\]\\!"]/.test(pattern)) return undefined;
  const folder = pattern.endsWith("/");
  let body = folder ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  const parts = body.split("/");
  if (body === "" || parts.some((p) => p === "" || p === "." || p === "..") || parts.length > PARTS_MAX) return undefined;
  if (parts.some((p) => p.includes("**") && p !== "**")) return undefined;
  const all = (anchored ? parts : ["**", ...parts]).filter((p, i, list) => !(p === "**" && list[i - 1] === "**"));
  let end: End;
  if (mode === "file") {
    if (folder) return undefined;
    end = "exact";
  } else end = folder ? "inside" : (parts[parts.length - 1] as string).includes("*") ? "exact" : "exact-or-inside";
  return (path: string) => matchParts(all, path.split("/"), end);
}

const LINE_MAX = 4096;
const lines = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.length <= LINE_MAX);

export interface OwnershipRules {
  /** The owners of a path: those of the last line that matches it, sorted, each once. Empty: no owner is known. */
  ownersOf(path: string): string[];
  /** How many owners were left out because they are not a host handle (an e-mail address, for example), or were above the limit of a line. */
  dropped: number;
}

export const OWNERS_PER_SOURCE_MAX = 20;

/**
 * Reads a `CODEOWNERS` file. A line is a pattern and then its owners; `#` starts a comment; the last line that matches
 * a path decides. Only host handles are kept (`@user`, `@organisation/team`): an owner given as an e-mail address
 * cannot be written in a bundle and is counted in `dropped`. The address itself is never kept.
 */
export function parseOwnership(text: string): OwnershipRules {
  const rules: { test: (path: string) => boolean; owners: string[] }[] = [];
  let dropped = 0;
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern, ...rest] = line.split(/\s+/) as [string, ...string[]];
    const test = compilePattern(pattern, "owners");
    if (!test) continue;
    const comment = rest.findIndex((t) => t.startsWith("#"));
    const named = [...new Set(comment < 0 ? rest : rest.slice(0, comment))];
    const handles = named.filter((o) => ContextOwnerSchema.safeParse(o).success).sort();
    const kept = handles.slice(0, OWNERS_PER_SOURCE_MAX);
    dropped += named.length - kept.length;
    rules.push({ test, owners: kept });
  }
  return {
    dropped,
    ownersOf(path) {
      for (let i = rules.length - 1; i >= 0; i--) if ((rules[i] as (typeof rules)[number]).test(path)) return [...(rules[i] as (typeof rules)[number]).owners];
      return [];
    },
  };
}

const GENERATED_ATTRIBUTE = "linguist-generated";

/**
 * What one `.gitattributes` file says about `linguist-generated` for a path relative to the folder of that file:
 * true or false when its last matching line sets or unsets it, undefined when no line speaks about the path.
 */
export function parseGeneratedAttributes(text: string): (path: string) => boolean | undefined {
  const rules: { test: (path: string) => boolean; generated: boolean }[] = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern, ...attributes] = line.split(/\s+/) as [string, ...string[]];
    let generated: boolean | undefined;
    for (const a of attributes) {
      if (a === GENERATED_ATTRIBUTE || a === `${GENERATED_ATTRIBUTE}=true`) generated = true;
      else if (a === `-${GENERATED_ATTRIBUTE}` || a === `!${GENERATED_ATTRIBUTE}` || a === `${GENERATED_ATTRIBUTE}=false`) generated = false;
    }
    if (generated === undefined) continue;
    const test = compilePattern(pattern, "file");
    if (test) rules.push({ test, generated });
  }
  return (path) => {
    for (let i = rules.length - 1; i >= 0; i--) if ((rules[i] as (typeof rules)[number]).test(path)) return (rules[i] as (typeof rules)[number]).generated;
    return undefined;
  };
}

/** How many lines at the top of a file are looked at for a "generated" header. */
export const GENERATED_HEADER_LINES = 5;
const COMMENT_START = /^\s*(?:#|\/\/|\/\*|--|;|<!--)/;
const GENERATED_WORDS = /\bgenerated by\b|@generated\b|\bdo not edit\b|\bautomatically generated\b|\bauto-generated\b/i;

/**
 * True when one of the first lines of a file is a comment that says the file is generated: "Generated by …",
 * "@generated", "DO NOT EDIT", "automatically generated" or "auto-generated". Only a comment line counts, so a
 * sentence in a document does not.
 */
export function hasGeneratedHeader(text: string): boolean {
  const head = text.slice(0, GENERATED_HEADER_LINES * LINE_MAX).split(/\r?\n/, GENERATED_HEADER_LINES);
  return head.some((l) => l.length <= LINE_MAX && COMMENT_START.test(l) && GENERATED_WORDS.test(l));
}
