import { dependencies, dependencyText, type DepIssue } from "../queue/deps.js";
import { cleanBody, parseStory } from "./issue-import.js";

/**
 * Quick readiness checks of an open issue, by code only (no AI, no I/O). A text in the story format is read with `parseStory`; any other
 * text is read loosely, each check on its own. The marks are hints: nothing is blocked by them.
 */

export interface QuickChecks {
  /** Has an "Acceptance criteria" section with at least one item. */
  criteria: boolean;
  /** Has a complete "As …, I want …, so that …" sentence. */
  value: boolean;
  /** Every issue named under "Depends on" exists. */
  dependencies: boolean;
  /** No open questions are noted. */
  questions: boolean;
  /** "#N" under "Depends on" that were not found. */
  missing: number[];
  /** Entries under "Depends on" that name an issue by title only and match no known title. */
  unmatched: string[];
}

export interface BacklogIssue {
  number: number;
  title: string;
  body?: string | null;
}

const FENCE = /^\s{0,3}(```+|~~~+)/;
const HEADING = /^\s{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BOLD_LINE = /^\s*\*\*([^*]+)\*\*\s*$/;
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z ]*?)[ \t]*:[ \t]*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]+\S/;
const NOTHING = /^(?:[-*+][ \t]+)?(?:none|n\/a|nothing|no open questions|-)\.?$/i;

/** The heading name of a line: `## name`, `**name**`, `**name:**` or `name:`; undefined for any other line. */
function headingName(line: string): string | undefined {
  const h = HEADING.exec(line)?.[1] ?? BOLD_LINE.exec(line)?.[1] ?? LABEL_LINE.exec(line)?.[1];
  return h?.replace(/[*_:\s]+$/g, "").replace(/^[*_\s]+/g, "").trim();
}

/** The lines outside code fences, each with whether it is a heading line of any name. */
function plainLines(text: string): { line: string; head?: string }[] {
  const out: { line: string; head?: string }[] = [];
  let fence: { ch: string; len: number } | undefined;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f) {
      if (fence === undefined) fence = { ch: f[0]!, len: f.length };
      else if (f[0] === fence.ch && f.length >= fence.len && /^\s{0,3}(```+|~~~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const head = headingName(line);
    out.push(head !== undefined ? { line, head } : { line });
  }
  return out;
}

/** The lines under the heading(s) called `name`, up to the next heading; code fences are skipped. undefined when there is no such heading. */
function sectionLines(text: string, name: RegExp): string[] | undefined {
  let found: string[] | undefined;
  let inside = false;
  for (const { line, head } of plainLines(text)) {
    if (head !== undefined) {
      inside = name.test(head);
      if (inside) found ??= [];
      continue;
    }
    if (inside) found!.push(line);
  }
  return found;
}

const PLACEHOLDER = /^[\s….]*$|^[<[({]\s*[….]*\s*[>\])}]$/;
const realPart = (t: string) => !PLACEHOLDER.test(t.trim());
const SENTENCE = /^as\s+(.+?),?\s+i\s+want\s+(.+?),?\s+so\s+that\s+(.+)$/i;

/** Whether a paragraph outside code fences is, as a whole, a sentence with three real parts. */
function hasValueSentence(text: string): boolean {
  const paragraphs: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) paragraphs.push(cur.join(" "));
    cur = [];
  };
  for (const { line, head } of plainLines(text)) {
    if (head !== undefined) {
      // A heading is a boundary, not part of a sentence; a bold line may be the sentence itself.
      flush();
      paragraphs.push(line);
    } else if (!line.trim()) flush();
    else cur.push(line.replace(/^\s*(?:>|[-*+][ \t]+)/, ""));
  }
  flush();
  return paragraphs.some((p) => {
    const m = SENTENCE.exec(p.replace(/[*_]/g, "").replace(/\s+/g, " ").trim());
    return m !== null && [m[1]!, m[2]!, m[3]!.replace(/\.$/, "")].every(realPart);
  });
}

const CRITERIA = /^acceptance criteria$/i;
const OPEN_QUESTIONS = /^open questions?$/i;

/** What the "Depends on" text names: issue numbers, and the entries that name an issue by title only but match none of `titles`. */
export function dependencyRefs(issue: BacklogIssue, titles: DepIssue[] = []): { numbers: number[]; unmatched: string[] } {
  const body = issue.body ?? "";
  const text = dependencyText(body);
  if (!text) return { numbers: [], unmatched: [] };
  const numbers = dependencies(body, issue.number, titles);
  const unmatched: string[] = [];
  for (const raw of text.split(/[;\n]/)) {
    const item = raw.replace(/^\s*[-*+]\s*(\[[ x]\]\s*)?/i, "").trim();
    // Entries with a "#N" are numbers; "none" and the like are no dependency.
    if (/#\d+\b/.test(item) || /^(?:none|n\/a|nothing|no dependenc(?:y|ies))\b|^no[\s.]*$/i.test(item) || item.replace(/[^\p{L}\p{N}]+/gu, "").length < 3) continue;
    if (dependencies(`Depends on: ${item}`, 0, titles.filter((t) => t.number !== issue.number)).length === 0) unmatched.push(item.slice(0, 120));
  }
  return { numbers, unmatched };
}

/**
 * The four checks. `allNumbers` holds the numbers known to exist as issues (not pull requests). A "#N" not in it is missing; a title-only
 * entry that matches no title in `opts.titles` counts as not found.
 */
export function quickChecks(issue: BacklogIssue, allNumbers: ReadonlySet<number>, opts: { titles?: DepIssue[] } = {}): QuickChecks {
  const raw = issue.body ?? "";
  const text = cleanBody(raw);
  const story = parseStory(issue.title, raw);

  const criteria = story ? story.criteria.length > 0 : (sectionLines(text, CRITERIA) ?? []).some((l) => LIST_ITEM.test(l));
  const value = story ? story.who !== undefined && story.what !== undefined && story.why !== undefined : hasValueSentence(text);

  const refs = dependencyRefs({ ...issue, body: text }, opts.titles);
  const missing = refs.numbers.filter((n) => !allNumbers.has(n));

  const lines = sectionLines(text, OPEN_QUESTIONS) ?? [];
  const noted = lines.some((l) => l.trim() !== "" && !NOTHING.test(l.trim()));
  const unchecked = plainLines(text).some(({ line, head }) => head === undefined && /^\s*(?:[-*+]|\d+[.)])[ \t]+\[ \][ \t]+.*\?\s*$/.test(line));

  return {
    criteria,
    value,
    dependencies: missing.length === 0 && refs.unmatched.length === 0,
    questions: !noted && !unchecked,
    missing,
    unmatched: refs.unmatched,
  };
}
