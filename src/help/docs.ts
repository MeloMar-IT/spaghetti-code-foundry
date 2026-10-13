import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HelpRole } from "./contract.js";
import type { Source } from "./turn.js";

/**
 * The documentation Ask SCF may quote: a fixed list of the product's own files, read from the folder the Foundry is
 * installed in. Never a file of a repository that is worked on, never the network, no model. The files are cut into
 * sections by their headings; a question finds sections by the words it shares with them. The index carries the
 * version of the installed Foundry and the hash of every file, so an index that no longer fits the files is noticed.
 */

export interface HelpDoc {
  /** The path inside the install, with forward slashes. */
  path: string;
  title: string;
  roles: readonly HelpRole[];
  /** For a guide with numbered chapters ("## 3. …"): the chapters a user may be shown. Every other chapter is for administrators. */
  userChapters?: readonly number[];
}

const AU: readonly HelpRole[] = ["admin", "user"];
/** The approved documents. A chapter about settings, models, costs, watchers, accounts or the monitor is not for a user. */
export const HELP_DOCS: readonly HelpDoc[] = [
  { path: "docs/USER_GUIDE.md", title: "User guide", roles: AU, userChapters: [1, 2, 3, 10, 12, 14] },
  { path: "docs/FLOW_AUTHORING.md", title: "Flow authoring reference", roles: ["admin"] },
];

/** The most document sources of one question, and the longest excerpt of one (the limit of a turn). */
export const DOC_SOURCES = 4;
export const DOC_EXCERPT_MAX = 1200;
/** A file larger than this is not indexed: it is not one of ours. */
export const DOC_FILE_MAX = 4_000_000;
const QUESTION_WORDS = 24;

export interface DocSection {
  /** The id a reply cites: stable for the same document and heading. */
  id: string;
  doc: string;
  docTitle: string;
  /** The headings above and of the section, outermost first. */
  trail: string[];
  /** The anchor of the heading in the document. */
  anchor: string;
  roles: readonly HelpRole[];
  paragraphs: string[];
  headWords: Set<string>;
  words: Set<string>;
}

export interface DocFileStamp { path: string; sha256: string; bytes: number; mtimeMs: number; sections: number }

export interface DocIndex {
  /** The version of the installed Foundry the index was built for. */
  version: string;
  builtAt: string;
  files: DocFileStamp[];
  /** Approved documents that could not be read. */
  missing: string[];
  sections: DocSection[];
  /** In how many sections a word stands. */
  df: Map<string, number>;
}

const STOP = new Set("the and for are but not you your with that this what when where which who why how can does did was were will would should could has have had from into than then them they there here its our out one two all any about want need get use using used also may must more most some such only just like make made over under after before again very been being".split(" "));

/** The words of a text that count for a match: lower case, three letters or more, a plural "s" taken off. */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,39}/g) ?? []) {
    for (const part of raw.split(/[_-]/)) {
      if (part.length < 3 || STOP.has(part)) continue;
      out.push(part.length > 3 && part.endsWith("s") && !part.endsWith("ss") ? part.slice(0, -1) : part);
    }
  }
  return out;
}

/** The anchor of a heading as a Markdown viewer makes it. */
export const anchorOf = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");

const versionOf = (root: string): string => {
  try {
    const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && /^[\w.+-]{1,40}$/.test(v) ? v : "unknown";
  } catch {
    return "unknown";
  }
};

/** Cuts one document into its sections: a heading of level 2 to 4 starts one; a heading inside a code block does not. */
export function sectionsOf(doc: HelpDoc, text: string): DocSection[] {
  const out: DocSection[] = [];
  const trail: string[] = [];
  let chapter: number | undefined;
  let lines: string[] = [];
  let open: { trail: string[]; roles: readonly HelpRole[] } | undefined;
  let fenced = false;
  const close = () => {
    if (!open) return;
    const paragraphs = lines.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    lines = [];
    const heading = open.trail[open.trail.length - 1]!;
    if (!paragraphs.length) return;
    const anchor = anchorOf(heading);
    out.push({
      id: `doc-${createHash("sha256").update(`${doc.path}\n${open.trail.join("\n")}`).digest("hex").slice(0, 12)}`,
      doc: doc.path, docTitle: doc.title, trail: open.trail, anchor, roles: open.roles, paragraphs,
      headWords: new Set(wordsOf(open.trail.join(" "))), words: new Set(wordsOf(paragraphs.join(" "))),
    });
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = fenced ? null : /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) {
      if (open) lines.push(line);
      continue;
    }
    close();
    const level = h[1]!.length - 2;
    const heading = h[2]!.replace(/[`*]/g, "").slice(0, 150);
    trail.length = level;
    for (let i = 0; i < level; i++) trail[i] ??= "";
    trail[level] = heading;
    if (level === 0) chapter = /^(\d{1,3})\.\s/.test(heading) ? Number(/^(\d{1,3})\./.exec(heading)![1]) : undefined;
    const roles: readonly HelpRole[] = doc.userChapters ? (chapter !== undefined && doc.userChapters.includes(chapter) ? doc.roles : doc.roles.filter((r) => r === "admin")) : doc.roles;
    open = { trail: trail.filter(Boolean), roles };
  }
  close();
  return out;
}

/** Reads the approved documents under `root` and builds the index. A document that cannot be read is listed as missing. */
export function buildDocIndex(root: string, docs: readonly HelpDoc[] = HELP_DOCS): DocIndex {
  const index: DocIndex = { version: versionOf(root), builtAt: new Date().toISOString(), files: [], missing: [], sections: [], df: new Map() };
  const seen = new Set<string>();
  for (const doc of docs) {
    let text: string;
    let mtimeMs: number;
    try {
      const file = join(root, ...doc.path.split("/"));
      const st = statSync(file);
      if (!st.isFile() || st.size > DOC_FILE_MAX) throw new Error("not a document");
      text = readFileSync(file, "utf8");
      mtimeMs = st.mtimeMs;
    } catch {
      index.missing.push(doc.path);
      continue;
    }
    const sections = sectionsOf(doc, text).filter((s) => !seen.has(s.id) && (seen.add(s.id), true));
    index.files.push({ path: doc.path, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), mtimeMs, sections: sections.length });
    index.sections.push(...sections);
  }
  for (const s of index.sections) for (const w of new Set([...s.words, ...s.headWords])) index.df.set(w, (index.df.get(w) ?? 0) + 1);
  return index;
}

/**
 * Why an index no longer fits what is installed, in fixed words; empty when it fits. Checked: the version of the
 * Foundry, and every document (present, same content).
 */
export function docIndexProblems(index: DocIndex, root: string, docs: readonly HelpDoc[] = HELP_DOCS): string[] {
  const out: string[] = [];
  const now = versionOf(root);
  if (now !== index.version) out.push(`the documentation index is for version ${index.version}, the installed version is ${now}`);
  for (const doc of docs) {
    const had = index.files.find((f) => f.path === doc.path);
    let sha: string | undefined;
    try {
      sha = createHash("sha256").update(readFileSync(join(root, ...doc.path.split("/")), "utf8")).digest("hex");
    } catch {
      sha = undefined;
    }
    if (sha === undefined) out.push(`${doc.path} is missing from the install`);
    else if (!had) out.push(`${doc.path} is not in the documentation index`);
    else if (had.sha256 !== sha) out.push(`${doc.path} changed since the documentation index was built`);
  }
  return out;
}

/** The part of a section that fits the question best: from its best paragraph on, at most `DOC_EXCERPT_MAX` characters. */
function excerptOf(s: DocSection, asked: readonly string[]): string {
  let best = 0;
  let bestScore = -1;
  s.paragraphs.forEach((p, i) => {
    const have = new Set(wordsOf(p));
    const score = asked.filter((w) => have.has(w)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  let text = "";
  for (const p of s.paragraphs.slice(best)) {
    if (text && text.length + p.length + 2 > DOC_EXCERPT_MAX) break;
    text = text ? `${text}\n\n${p}` : p;
  }
  return text.length > DOC_EXCERPT_MAX ? `${text.slice(0, DOC_EXCERPT_MAX - 2)} …` : text;
}

/**
 * The sections that fit a question, best first, as sources a reply may cite. A section counts when the question
 * shares a word with its headings, or two words with its text; a word that stands in fewer sections weighs more, a
 * word of a heading three times. Same question, same index: same answer. Only sections of the asker's role.
 */
export function searchDocs(index: DocIndex, question: string, role: HelpRole, limit = DOC_SOURCES): Source[] {
  const asked = [...new Set(wordsOf(String(question).slice(0, 4000)))].slice(0, QUESTION_WORDS);
  if (!asked.length || limit < 1) return [];
  const n = index.sections.length || 1;
  const weight = (w: string) => Math.log(1 + n / (index.df.get(w) ?? n));
  const hits: { s: DocSection; score: number; at: number }[] = [];
  index.sections.forEach((s, at) => {
    if (!s.roles.includes(role)) return;
    let score = 0;
    let head = 0;
    let body = 0;
    for (const w of asked) {
      if (s.headWords.has(w)) {
        head++;
        score += 3 * weight(w);
      } else if (s.words.has(w)) {
        body++;
        score += weight(w);
      }
    }
    if (head + body >= Math.min(2, asked.length) && (head > 0 || body >= 2 || asked.length === 1)) hits.push({ s, score, at });
  });
  hits.sort((a, b) => b.score - a.score || a.at - b.at);
  return hits.slice(0, Math.min(limit, DOC_SOURCES)).map(({ s }) => ({
    id: s.id,
    kind: "doc" as const,
    title: `${s.docTitle}: ${s.trail.join(" › ")}`.slice(0, 300),
    ref: `${s.doc}#${s.anchor} (SCF ${index.version})`.slice(0, 300),
    excerpt: excerptOf(s, asked),
  }));
}

export interface DocStatus {
  version: string;
  builtAt: string | null;
  documents: { path: string; sections: number }[];
  sections: number;
  /** What is wrong with the documentation of this install, in fixed words. Empty when all is well. */
  problems: string[];
  /** How often an index that no longer fitted was built again since the server started. */
  rebuilt: number;
  /** Why it was last built again: what did not fit. */
  rebuiltBecause: string[];
}

/**
 * The index of one install, kept in memory. Before every use the files are compared with the index (version, size
 * and time; the content when those differ): an index that no longer fits is reported and built again. A document
 * that is missing gives no source; the rest still does.
 */
export class HelpDocs {
  private index?: DocIndex;
  private rebuilt = 0;
  private told = new Set<string>();
  private last: string[] = [];
  private because: string[] = [];
  constructor(private root: string, private log?: (msg: string) => void, private docs: readonly HelpDoc[] = HELP_DOCS) {}

  private quickSame(index: DocIndex): boolean {
    if (versionOf(this.root) !== index.version || index.missing.length) return false;
    return index.files.every((f) => {
      try {
        const st = statSync(join(this.root, ...f.path.split("/")));
        return st.size === f.bytes && st.mtimeMs === f.mtimeMs;
      } catch {
        return false;
      }
    });
  }

  private report(problems: string[]): void {
    this.last = problems;
    for (const p of this.told) if (!problems.includes(p)) this.told.delete(p);
    for (const p of problems) {
      if (this.told.has(p)) continue;
      this.told.add(p);
      this.log?.(`help: ${p}`);
    }
  }

  /** The index that fits the install now. An index that did not fit is reported, counted and replaced. */
  current(): DocIndex {
    if (this.index && this.quickSame(this.index)) return this.index;
    const before = this.index;
    const next = buildDocIndex(this.root, this.docs);
    const key = (i: DocIndex) => JSON.stringify([i.version, i.files.map((f) => [f.path, f.sha256]), i.missing]);
    if (before && key(before) !== key(next)) {
      this.rebuilt++;
      this.because = docIndexProblems(before, this.root, this.docs);
      for (const p of this.because) this.log?.(`help: ${p}; the index was built again`);
    }
    this.index = next;
    this.report(docIndexProblems(next, this.root, this.docs));
    return next;
  }

  /** The sources for a question; none when the documents cannot be read. Never throws. */
  sources(question: string, role: HelpRole): Source[] {
    try {
      return searchDocs(this.current(), question, role);
    } catch {
      this.report(["the documentation of this install cannot be read"]);
      return [];
    }
  }

  status(): DocStatus {
    let index: DocIndex | undefined;
    try {
      index = this.current();
    } catch {
      this.report(["the documentation of this install cannot be read"]);
    }
    return { version: index?.version ?? versionOf(this.root), builtAt: index?.builtAt ?? null, documents: (index?.files ?? []).map((f) => ({ path: f.path, sections: f.sections })), sections: index?.sections.length ?? 0, problems: [...this.last], rebuilt: this.rebuilt, rebuiltBecause: [...this.because] };
  }
}
