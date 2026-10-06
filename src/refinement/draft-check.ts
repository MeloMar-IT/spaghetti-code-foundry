import type { Draft } from "./draft.js";

// Only types come from draft.ts: it imports this file for its schema, so no value may cross back.
const LS_PS = String.fromCharCode(0x2028, 0x2029);
const oneLine = (t: string): string => t.replace(new RegExp(`\\s*[\\n${LS_PS}]\\s*`, "g"), " ");

/** The fields of a draft that are checked and reviewed: everything but the notes for the builder (and the list of what it depends on). */
export const REMARK_FIELDS = ["title", "who", "what", "why", "criteria", "outOfScope"] as const;
export type RemarkField = (typeof REMARK_FIELDS)[number];

/** A remark found by the code checks: no AI call, computed from the text on every read. */
export interface CodeRemark {
  field: RemarkField;
  /** For `criteria`: the id of the criterion. */
  item?: string;
  kind: "vague" | "plan";
  /** The word or the sign that was found. */
  word: string;
  text: string;
}

/** Words that say nothing a person could check. Matched as whole words, in any case. */
export const VAGUE_WORDS = ["fast", "quick", "quickly", "easy", "easily", "simple", "intuitive", "user-friendly", "flexible", "robust", "scalable", "efficient", "seamless", "modern", "and so on", "etc"] as const;

const VAGUE = new RegExp(`(?<![\\p{L}\\p{N}_-])(${VAGUE_WORDS.join("|")})(?![\\p{L}\\p{N}_-])`, "giu");

const PLAN_SENTENCE = "belongs in the build step";

// ---- what reads like a plan ------------------------------------------------------------------------

/** A path with a folder and a file extension (lowercase letters and digits): `src/a/b.ts`, `config/app.properties`. It starts at the start of a word, so it costs a linear scan. */
const PATH = /(?<![\w./:@-])[\w.-]+(?:\/[\w.-]+)*\/[\w-]+(?:\.[\w-]+)*\.[a-z][a-z0-9]{0,11}(?![\w/-])/;
/** A call with empty brackets: `save()`. */
const EMPTY_CALL = /(?<![\w.$])[A-Za-z_$][\w$]*\(\)/;
/** A call with arguments: only when the name is camelCase, snake_case or dotted, so "user(s)" is not code. */
const CALL = /(?<![\w.$])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\([^()\n]{0,60}\)/g;
const CODE_NAME = /[a-z][A-Z]|_|\./;
const BUILD_VERB = /\b(add|create|write|implement|define|build|install|register|call|edit|update|change|modify|run|migrate|refactor)\b/i;
const BUILD_NOUN = /\b(tables?|columns?|endpoints?|routes?|classes|class|functions?|methods?|modules?|migrations?|indexe?s|schemas?|services?|components?|handlers?|scripts?|packages?|quer(?:y|ies)|apis?|databases?)\b/i;

/** Text with the spans a person put in backticks and the web addresses blanked: names in backticks are meant, never flagged. */
function masked(t: string): string {
  return t.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)).replace(/https?:\/\/\S+/gi, (m) => " ".repeat(m.length));
}

const isBuildStep = (t: string): boolean => BUILD_VERB.test(t) && BUILD_NOUN.test(t);

/**
 * Build steps: "First add a table, then call it" (the then may come in a later sentence: "First edit the schema. Then update the
 * handler."), or a numbered list with two items that each name a build verb and a technical thing.
 */
function buildSteps(t: string): string | undefined {
  const parts = t.split(/(?<=[.!?;\n])/);
  for (let i = 0; i < parts.length; i++) {
    const first = /\bfirst\b/i.exec(parts[i]!);
    if (!first || !isBuildStep(parts[i]!.slice(first.index))) continue;
    const from = parts[i]!.slice(first.index) + parts.slice(i + 1).join("");
    const next = /\b(then|next)\b/i.exec(from);
    if (next) return from.slice(0, next.index + next[0].length).trim().slice(0, 60);
  }
  const numbered = t.split("\n").map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1]).filter((x): x is string => x !== undefined && isBuildStep(x));
  return numbered.length >= 2 ? numbered[0]!.trim() : undefined;
}

/** The first sign that a text reads like an implementation plan, or undefined. Pure. */
export function planSign(raw: string): string | undefined {
  if (raw.includes("```")) return "code block";
  const t = masked(raw);
  const path = PATH.exec(t);
  if (path) return path[0];
  const empty = EMPTY_CALL.exec(t);
  if (empty) return empty[0];
  for (const m of t.matchAll(CALL)) if (CODE_NAME.test(m[1]!)) return m[0];
  return buildSteps(t);
}

/** The vague words in a text, each once, in the order found. Pure. */
export function vagueWords(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(VAGUE)) {
    const w = m[1]!.toLowerCase();
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

const shown = (w: string) => (w.length > 60 ? `${[...w].slice(0, 60).join("")}…` : w);

/** The remarks of the code checks for a text of one field (and one criterion). */
export function checkText(field: RemarkField, text: string, item?: string): CodeRemark[] {
  const at = { field, ...(item !== undefined ? { item } : {}) };
  const out: CodeRemark[] = vagueWords(text).map((word) => ({ ...at, kind: "vague" as const, word, text: `"${word}" is vague: say what can be seen or measured.` }));
  const sign = planSign(text);
  if (sign !== undefined) out.push({ ...at, kind: "plan", word: shown(oneLine(sign)), text: `This reads like an implementation plan ("${shown(oneLine(sign))}"); it ${PLAN_SENTENCE}.` });
  return out;
}

/** The remarks of the code checks for a draft: every field but the notes for the builder; criteria in list order. */
export function draftRemarks(d: Draft): CodeRemark[] {
  const out: CodeRemark[] = [];
  for (const field of ["title", "who", "what", "why"] as const) {
    const f = d[field];
    if (f) out.push(...checkText(field, f.text));
  }
  for (const c of d.criteria) out.push(...checkText("criteria", c.text, c.id));
  if (d.outOfScope) out.push(...checkText("outOfScope", d.outOfScope.text));
  return out;
}
