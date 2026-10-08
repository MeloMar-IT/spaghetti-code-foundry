import { randomUUID } from "node:crypto";
import { DraftsSchema, EpicSchema, type Draft } from "./draft.js";

/**
 * Reading an issue of the repository as a story draft. The story format is the one `preview()` writes. What the import cannot place in a
 * field is kept in the notes, under its own heading, so that nothing a person wrote is lost. A text is "not in the story format" (and
 * `parseStory` answers undefined) when the "As …, I want …, so that …" sentence is missing, is not one line or has a delimiter twice,
 * when there is no "Acceptance criteria" section, or when a field does not fit its limit.
 */

/** The fields of a draft as an issue text gives them. A part is missing when the text has "…" for it. */
export interface StoryFields {
  title: string;
  who?: string;
  what?: string;
  why?: string;
  criteria: string[];
  outOfScope?: string;
  notes?: string;
  /** Issue numbers. */
  dependsOn: number[];
  /** From a line `**Epic:** #N` exactly. */
  epic?: number;
}

const MARKER_END = /<!--\s*(?:claude-factory|spaghetti-code-foundry)[\s\S]*?-->/g;
const MARKER_OPEN = /<!--\s*(?:claude-factory|spaghetti-code-foundry)[\s\S]*$/;
const REFINED_NOTE = /^\s*Refined in Spaghetti Code Foundry by\b/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const TITLE_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The issue text without hidden Foundry markers, the "Refined in Spaghetti Code Foundry by …" note (with the rule above it) and control characters; `\n` line ends. */
export function cleanBody(body: string): string {
  const text = body.replace(/\r\n?/g, "\n").replace(MARKER_END, "").replace(MARKER_OPEN, "").replace(BAD_CHARS, "");
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (REFINED_NOTE.test(line)) {
      // The rule that goes with the note, and the empty lines between them, go too.
      while (out.length && out[out.length - 1]!.trim() === "") out.pop();
      if (out.length && out[out.length - 1]!.trim() === "---") out.pop();
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** The issue title on one line, without control characters. */
export const cleanTitle = (title: string): string => title.replace(TITLE_CHARS, " ").replace(/ {2,}/g, " ").trim();

/** The idea of a session from an issue: the title, then the cleaned text. */
export function ideaOf(title: string, body: string): string {
  const t = cleanTitle(title);
  const b = cleanBody(body);
  return b ? `${t}\n\n${b}` : t;
}

interface Section {
  heading: string;
  lines: string[];
}

/** The text before the first `### ` heading, and the sections. A heading inside a code fence is not one. */
export function splitSections(text: string): { before: string[]; sections: Section[] } {
  const before: string[] = [];
  const sections: Section[] = [];
  // The open fence: its character and how many it has. Only the same character, at least as many, closes it.
  let fence: { ch: string; len: number } | undefined;
  for (const line of text.split("\n")) {
    const f = /^\s{0,3}(```+|~~~+)/.exec(line)?.[1];
    if (f) {
      if (fence === undefined) fence = { ch: f[0]!, len: f.length };
      else if (f[0] === fence.ch && f.length >= fence.len && /^\s{0,3}(```+|~~~+)\s*$/.test(line)) fence = undefined;
    }
    const h = fence === undefined && f === undefined ? /^### +(.*?)\s*#*\s*$/.exec(line) : null;
    if (h) sections.push({ heading: h[1]!.trim(), lines: [] });
    else (sections.length ? sections[sections.length - 1]!.lines : before).push(line);
  }
  return { before, sections };
}

const body = (lines: string[]) => lines.join("\n").trim();
const kept = (heading: string, lines: string[]) => `### ${heading}\n${body(lines)}`.trim();
const SENTENCE = /^As (.+?), I want (.+?), so that (.+)$/;
const count = (s: string, part: string) => s.split(part).length - 1;
const BULLET = /^[-*] +(?:\[[ xX]\] +)?(.*\S)\s*$/;
const NONE = /^None \(can be built on its own\)\.?$/;
const DEP = /^[-*] +#([1-9][0-9]*)$/;
const EPIC = /^\*\*Epic:\*\* #([1-9][0-9]*)$/;
const CRITERIA = "acceptance criteria";

/** One part of the sentence: "…" means the part is empty. */
const part = (t: string): string | undefined => (t.trim() === "…" ? undefined : t.trim());

/**
 * The draft fields of an issue in the story format, or undefined. A final "." of the reason is dropped (the preview adds it again).
 * Unknown sections, loose paragraphs, text in a "Depends on" section that is not `- #N`, and further sections of a known name go to the
 * notes, in the order they have in the issue. "Accepted anyway" is not imported.
 */
export function parseStory(title: string, text: string): StoryFields | undefined {
  const clean = cleanBody(text);
  const { before, sections } = splitSections(clean);
  const extras: string[] = [];

  // The sentence: the first paragraph of the text before the first heading that is one line and has the three parts.
  const paragraphs = body(before).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let epic: number | undefined;
  let sentence: RegExpExecArray | null = null;
  for (const p of paragraphs) {
    if (!sentence && !p.includes("\n")) {
      const m = SENTENCE.exec(p);
      if (m) {
        if (count(p, ", I want ") !== 1 || count(p, ", so that ") !== 1) return undefined;
        sentence = m;
        continue;
      }
    }
    const e = epic === undefined ? EPIC.exec(p) : null;
    if (e) {
      const n = Number(e[1]);
      if (EpicSchema.safeParse(n).success) {
        epic = n;
        continue;
      }
    }
    extras.push(p);
  }
  if (!sentence) return undefined;

  let criteria: string[] | undefined;
  let outOfScope: string | undefined;
  let notes: string | undefined;
  let dependsOn: number[] | undefined;
  const deps: number[] = [];
  let acceptedSeen = false;
  for (const s of sections) {
    const name = s.heading.toLowerCase();
    if (name === CRITERIA && criteria === undefined) {
      criteria = [];
      const loose: string[] = [];
      for (const line of s.lines) {
        const b = BULLET.exec(line);
        if (b) criteria.push(b[1]!.trim());
        else if (line.trim()) loose.push(line);
      }
      if (loose.length) extras.push(kept(s.heading, loose));
    } else if (name === "out of scope" && outOfScope === undefined) {
      outOfScope = body(s.lines) || undefined;
    } else if (name === "notes for the builder" && notes === undefined) {
      notes = body(s.lines) || undefined;
    } else if (name === "depends on" && dependsOn === undefined) {
      dependsOn = deps;
      const loose: string[] = [];
      for (const line of s.lines) {
        const d = DEP.exec(line.trim());
        if (d && Number.isSafeInteger(Number(d[1]))) {
          if (!deps.includes(Number(d[1]))) deps.push(Number(d[1]));
        } else if (line.trim() && !NONE.test(line.trim())) loose.push(line.trim());
      }
      if (loose.length) extras.push(kept(s.heading, loose));
    } else if (name === "accepted anyway" && !acceptedSeen) {
      // Not imported: the readiness check of the new session decides what is accepted.
      acceptedSeen = true;
    } else extras.push(kept(s.heading, s.lines));
  }
  if (criteria === undefined) return undefined;

  const story: StoryFields = {
    title: cleanTitle(title),
    ...(part(sentence[1]!) !== undefined ? { who: part(sentence[1]!)! } : {}),
    ...(part(sentence[2]!) !== undefined ? { what: part(sentence[2]!)! } : {}),
    ...(() => {
      const why = part(sentence[3]!.replace(/\.$/, ""));
      return why !== undefined ? { why } : {};
    })(),
    criteria,
    ...(outOfScope !== undefined ? { outOfScope } : {}),
    ...(() => {
      const all = [...(notes !== undefined ? [notes] : []), ...extras].join("\n\n");
      return all ? { notes: all } : {};
    })(),
    dependsOn: deps,
    ...(epic !== undefined ? { epic } : {}),
  };
  // Every field must fit its limit; if not, the text is not taken as a story.
  const ok = DraftsSchema.safeParse([draftFromStory(story)]).success && story.title !== "";
  return ok ? story : undefined;
}

/** A draft with the fields of the story, each marked as typed by a person. */
export function draftFromStory(s: StoryFields): Draft {
  const typed = (t: string) => ({ text: t, from: "typed" as const });
  return {
    id: randomUUID(),
    ...(s.title ? { title: typed(s.title) } : {}),
    ...(s.who !== undefined ? { who: typed(s.who) } : {}),
    ...(s.what !== undefined ? { what: typed(s.what) } : {}),
    ...(s.why !== undefined ? { why: typed(s.why) } : {}),
    criteria: s.criteria.map((c) => ({ id: randomUUID(), text: c, from: "typed" as const })),
    ...(s.outOfScope !== undefined ? { outOfScope: typed(s.outOfScope) } : {}),
    dependsOn: s.dependsOn.map((issue) => ({ id: randomUUID(), issue, from: "typed" as const })),
    ...(s.notes !== undefined ? { notes: typed(s.notes) } : {}),
  };
}
