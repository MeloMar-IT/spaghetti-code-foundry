import { createHash } from "node:crypto";
import { boundReasons, byteCmp, SkillImportError, type SourceTree, type TreeEntry } from "./import-plan.js";
import {
  COPYRIGHT_LINE_RE, LICENCE_FILE_RE, LICENCE_FINGERPRINTS, LICENCE_FULL_TEXTS, LICENCE_LIMITS, LICENCE_POLICY, LICENCE_TEMPLATES,
  LICENCE_TITLES, NOTICE_FILE_RE, OWNER_DENY_WORDS, OWNER_LINE_RE, OWNER_MAX_WORDS, OWNER_PARAGRAPH_MAX_LINES, REFERENCE_PREFIXES, REFERENCE_SUFFIXES, REJECT_MARKERS, normalizeLicenceText,
} from "./licence-rules.js";
import { relativePathProblem } from "./schema.js";
import { hasUnsafeChar, shownValue } from "./sources.js";

export { normalizeLicenceText } from "./licence-rules.js";

// Finds and judges the licence evidence of an imported skill: which licence files govern it, which licence each holds,
// and whether the source's policy accepts it. Pure: no file system, no process, no clock. Fails closed: text that is
// not recognised exactly is "ambiguous", never accepted.

export type LicenceStatus = "allowed" | "review" | "rejected" | "missing" | "ambiguous";
export interface LicenceEvidenceFile {
  /** Upstream path. */
  path: string;
  /** "." for the root. */
  dir: string;
  kind: "licence" | "notice";
  /** Absent when `problem` is set. */
  content?: Uint8Array;
  problem?: string;
}
/** The files come from one listing of one approved commit; `repositoryKey` and `commit` name it. */
export interface LicenceEvidence {
  repositoryKey: string;
  commit: string;
  files: LicenceEvidenceFile[];
}
export interface LicenceFileRecord {
  path: string;
  sha256: string;
  bytes: number;
  licence: string;
}
export interface LicenceVerdict {
  status: LicenceStatus;
  /** Bounded; empty for "allowed". Never repeats file content. */
  reasons: string[];
  licences: string[];
  declared?: string;
  governedBy?: string;
  licenceFiles: LicenceFileRecord[];
  /** Licence and notice files that must stay with the package, by upstream path. */
  attribution: { path: string; content: Uint8Array }[];
  authorNotice: string[];
}

const lastSeg = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const inside = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function decode(content: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_SLOT = " (?:[^ ]+ ){1,12}";
const TEMPLATES = LICENCE_TEMPLATES.map((t) => ({
  id: t.id,
  re: new RegExp("^" + t.text.split("{name}").map((part) => normalizeLicenceText(part).split(" ").map(escapeRe).join(" ")).join(NAME_SLOT) + "$"),
  tail: t.tail,
}));

const TEMPLATE_HEADS = LICENCE_TEMPLATES.map((t) => normalizeLicenceText(t.text).split(" ").slice(0, 12).join(" "));

const sha256Text = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** True for a line that only names the owner of the copyright. A sentence that starts like one is not. */
function isOwnerLine(line: string): boolean {
  const m = OWNER_LINE_RE.exec(line);
  if (!m) return false;
  const owner = m[1]!.replace(/\ball rights reserved\.?$/i, "").replace(/\b(?:\p{L}|inc|ltd|llc|co|corp|jr|sr)\.(?=\s|$)/giu, " ").trim();
  if (owner === "" || /[.!?;:]\s*\S/.test(owner) || /[^\p{L}\p{N} ,.&'’@<>()_-]/u.test(owner)) return false;
  const words = normalizeLicenceText(owner).split(" ");
  return words.length <= OWNER_MAX_WORDS && !words.some((w) => OWNER_DENY_WORDS.includes(w));
}
const lines = (text: string) => text.split(/\r\n|\r|\n/);
/** Owner notices are left out: a short paragraph of its own as a whole (it may be wrapped), any other line by itself. */
function withoutOwnerLines(text: string): string {
  return text
    .split(/(\r?\n[ \t]*\r?\n)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const ls = lines(part);
      if (ls.length <= OWNER_PARAGRAPH_MAX_LINES && isOwnerLine(ls.map((l) => l.trim()).join(" "))) return "";
      return ls.filter((l) => !isOwnerLine(l)).join("\n");
    })
    .join("");
}

const NOTICE_START = /(?:copyright\s*(?:\(c\)|©)|\(c\)|©|copyright(?=\s+\d{4}))\s*(?:\d{4}(?:\s*[-–,]\s*\d{4})*\s*[,.]?\s*)?/giu;
const MAX_NOTICES = 3;

/**
 * True when `test` accepts the text with its owner notices left out. A notice is `Copyright (c) <year>` and up to
 * OWNER_MAX_WORDS words that pass `isOwnerLine`, wherever the line breaks fall. Bounded: at most MAX_NOTICES notices,
 * each tried with 0 to OWNER_MAX_WORDS words; more notices than that are never accepted.
 */
function acceptsWithoutOwners(text: string, test: (stripped: string) => boolean): boolean {
  if (test(withoutOwnerLines(text))) return true;
  const starts = [...text.matchAll(NOTICE_START)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (starts.length === 0 || starts.length > MAX_NOTICES) return false;
  const rec = (i: number, cuts: readonly (readonly [number, number])[], lastEnd: number): boolean => {
    if (i === starts.length) {
      let out = "";
      let at = 0;
      for (const [a, b] of cuts) {
        out += text.slice(at, a) + " ";
        at = b;
      }
      return test(withoutOwnerLines(out + text.slice(at)));
    }
    if (rec(i + 1, cuts, lastEnd)) return true;
    const s = starts[i]!;
    if (s.start < lastEnd) return false;
    const word = /\s*\S+/y;
    let end = s.end;
    for (let k = 1; k <= OWNER_MAX_WORDS; k++) {
      word.lastIndex = end;
      const m = word.exec(text);
      if (!m) break;
      end += m[0].length;
      if (isOwnerLine(text.slice(s.start, end).replace(/\s+/g, " ")) && rec(i + 1, [...cuts, [s.start, end]], end)) return true;
    }
    return false;
  };
  return rec(0, [], 0);
}

/** Replaces a whole-word phrase of a normalised text. */
function replacePhrase(norm: string, from: string, to: string): string {
  return (" " + norm + " ").split(" " + from + " ").join(" " + to + " ").replace(/ {2,}/g, " ").trim();
}

/** The long licences: the head up to the cut and the rest (owner lines left out) must be the known texts. */
function fullTextId(text: string): string | undefined {
  for (const f of LICENCE_FULL_TEXTS) {
    const m = f.cut.exec(text);
    if (!m) continue;
    const cut = m.index + m[0].length;
    const forms = (n: string) => (f.wordForms ?? []).reduce((acc, [from, to]) => replacePhrase(acc, from, to), n);
    const head = sha256Text(forms(normalizeLicenceText(text.slice(0, cut))));
    if (!f.heads.includes(head)) continue;
    const tailOk = (rest: string) => {
      let tailNorm = normalizeLicenceText(rest);
      if (f.placeholder) tailNorm = replacePhrase(tailNorm, f.placeholder, "");
      return f.tails.includes(sha256Text(forms(tailNorm)));
    };
    if (acceptsWithoutOwners(text.slice(cut), tailOk)) return f.id;
  }
  return undefined;
}

/** The short licence whose complete text the normalised text is (a title line aside). */
function templateId(body: string): string | undefined {
  let bare = body;
  for (const t of LICENCE_TITLES) if (bare.startsWith(t + " ")) bare = bare.slice(t.length + 1);
  for (const t of TEMPLATES) {
    const stripped = t.tail && bare.endsWith(" " + t.tail) ? bare.slice(0, -t.tail.length - 1) : bare;
    if (t.re.test(stripped)) return t.id;
  }
  return undefined;
}

/**
 * One licence per file. A licence must match a complete known text (a title and owner lines aside); a text with an
 * added, changed or removed sentence is not identified. `markers` are source-available terms found anywhere in the file.
 */
export function identifyLicence(content: Uint8Array): { id?: string; markers: string[] } {
  const text = decode(content);
  if (text === undefined) return { markers: [] };
  const whole = normalizeLicenceText(text);
  const full = fullTextId(text);
  if (full !== undefined) return { id: full, markers: [] };
  const body = normalizeLicenceText(withoutOwnerLines(text));
  const found: { id?: string } = {};
  acceptsWithoutOwners(text, (rest) => (found.id = templateId(normalizeLicenceText(rest))) !== undefined);
  if (found.id !== undefined) return { id: found.id, markers: [] };
  const markers = REJECT_MARKERS.filter((m) => (" " + whole + " ").includes(" " + m + " "));
  // A short licence written into the text as well means the file holds more than one licence.
  if (TEMPLATE_HEADS.some((h) => body.includes(h))) return { markers };
  const hits = LICENCE_FINGERPRINTS.filter((f) => f.all.every((p) => body.includes(p)) && !(f.none ?? []).some((p) => body.includes(p)));
  return hits.length === 1 ? { id: hits[0]!.id, markers } : { markers };
}
function entryProblem(e: TreeEntry): string | undefined {
  if (e.kind === "symlink") return "a symbolic link";
  if (e.kind === "submodule") return "a submodule";
  if (e.kind !== "file") return "not a regular file";
  if (typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size < 0) return "has no size";
  if (e.size > LICENCE_LIMITS.fileBytes) return `is larger than ${LICENCE_LIMITS.fileBytes} bytes`;
  return undefined;
}

/**
 * Lists the commit once and reads the licence and notice files that can apply to a skill: in a skill root, below it, or in
 * a folder above it. Errors of `tree` pass through.
 */
export function collectLicenceEvidence(origin: { repositoryKey: string; commit: string }, roots: readonly string[], tree: SourceTree): LicenceEvidence {
  const wanted: { e: TreeEntry; dir: string; kind: "licence" | "notice" }[] = [];
  for (const e of tree.list(".")) {
    if (relativePathProblem(e.path) !== undefined || hasUnsafeChar(e.path)) continue;
    const name = lastSeg(e.path);
    const kind = LICENCE_FILE_RE.test(name) ? "licence" : NOTICE_FILE_RE.test(name) ? "notice" : undefined;
    if (!kind) continue;
    const dir = dirOf(e.path);
    if (!roots.some((r) => inside(r, dir) || inside(dir, r))) continue;
    wanted.push({ e, dir, kind });
  }
  if (wanted.length > LICENCE_LIMITS.files) throw new SkillImportError("too-many-entries", `the source holds more than ${LICENCE_LIMITS.files} licence or notice files`);
  wanted.sort((a, b) => byteCmp(a.e.path, b.e.path));
  const files: LicenceEvidenceFile[] = wanted.map(({ e, dir, kind }) => {
    const problem = entryProblem(e);
    return problem ? { path: e.path, dir, kind, problem } : { path: e.path, dir, kind };
  });
  const readable = wanted.filter((w) => entryProblem(w.e) === undefined);
  if (readable.reduce((n, w) => n + (w.e.size ?? 0), 0) > LICENCE_LIMITS.totalBytes) throw new SkillImportError("too-large", `the licence and notice files hold more than ${LICENCE_LIMITS.totalBytes} bytes`);
  if (readable.length > 0) {
    const got = tree.read(readable.map((w) => w.e));
    const ok = Array.isArray(got) && got.length === readable.length;
    readable.forEach((w, i) => {
      const target = files.find((f) => f.path === w.e.path)!;
      const b = ok ? got[i] : undefined;
      if (b instanceof Uint8Array && b.byteLength === w.e.size) target.content = b;
      else target.problem = "content does not match the listing";
    });
  }
  return { repositoryKey: origin.repositoryKey, commit: origin.commit, files };
}

const RANK: Record<LicenceStatus, number> = { missing: 4, ambiguous: 3, rejected: 2, review: 1, allowed: 0 };
const KNOWN = new Map(Object.keys(LICENCE_POLICY).map((id) => [id.toLowerCase(), id]));

/** Why the `license:` text of SKILL.md is not acceptable next to the evidence, or undefined. */
function declaredProblem(declared: string, fileIds: ReadonlySet<string>, applicable: readonly LicenceEvidenceFile[]): { status: LicenceStatus; text: string } | undefined {
  const norm = " " + normalizeLicenceText(declared) + " ";
  if (REJECT_MARKERS.some((m) => norm.includes(" " + m + " "))) return { status: "rejected", text: "SKILL.md declares a source-available licence" };
  const parts = declared.split(/\s+(?:and|or)\s+/i).map((p) => p.replace(/^\(+|\)+$/g, "").trim().toLowerCase());
  if (parts.every((p) => KNOWN.has(p))) {
    const wrong = parts.map((p) => KNOWN.get(p)!).find((id) => !fileIds.has(id));
    return wrong ? { status: "ambiguous", text: `SKILL.md names ${wrong}, the licence files do not` } : undefined;
  }
  // Only a plain pointer to a licence file of the skill; any other word next to it is a term that is not checked.
  const plain = normalizeLicenceText(declared);
  const refers = applicable.some((f) => {
    const name = normalizeLicenceText(lastSeg(f.path));
    return REFERENCE_PREFIXES.some((pre) => REFERENCE_SUFFIXES.some((suf) => plain === [pre, name, suf].filter((w) => w !== "").join(" ")));
  });
  if (refers) return undefined;
  return { status: "ambiguous", text: "SKILL.md names a licence that is not supported or does not point to a licence file of the skill" };
}

/**
 * The licence files that govern a skill are those of the nearest folder (the skill root, then each folder above it up to
 * ".") that holds one, plus every licence file inside the skill. Every one must be identified, accepted by policy and
 * listed in `allow`. Notice files of every folder from the skill root up to "." and inside the skill must stay readable.
 */
export function evaluateLicence(input: { root: string; declared?: string; allow: readonly string[]; evidence: LicenceEvidence }): LicenceVerdict {
  const { root, allow, evidence } = input;
  const declared = input.declared?.trim() || undefined;
  const chain: string[] = [];
  for (let d = root; ; d = dirOf(d)) {
    chain.push(d);
    if (d === ".") break;
  }
  const licenceIn = (dir: string) => evidence.files.filter((f) => f.kind === "licence" && f.dir === dir);
  const governedBy = chain.find((d) => licenceIn(d).length > 0);
  const innerDir = (f: LicenceEvidenceFile) => f.dir !== root && inside(root, f.dir);
  const applicable = governedBy === undefined ? [] : [...licenceIn(governedBy), ...evidence.files.filter((f) => f.kind === "licence" && innerDir(f))];
  const notices = evidence.files.filter((f) => f.kind === "notice" && (chain.includes(f.dir) || inside(root, f.dir)));

  const found: { status: LicenceStatus; text: string }[] = [];
  const add = (status: LicenceStatus, text: string) => found.push({ status, text });
  const records: LicenceFileRecord[] = [];
  const ids = new Set<string>();
  if (governedBy === undefined) add("missing", `${shownValue(root)}: no licence file for this skill or a folder above it`);
  for (const f of applicable) {
    const at = shownValue(f.path);
    if (f.problem !== undefined || f.content === undefined) {
      add("ambiguous", `${at}: ${f.problem ?? "cannot be read"}`);
      continue;
    }
    const { id, markers } = identifyLicence(f.content);
    if (markers.length > 0) add("rejected", `${at}: holds a source-available term (${markers[0]})`);
    if (id === undefined) {
      if (markers.length === 0) add("ambiguous", `${at}: the licence is not recognised`);
      continue;
    }
    ids.add(id);
    records.push({ path: f.path, sha256: sha(f.content), bytes: f.content.byteLength, licence: id });
    const p = LICENCE_POLICY[id];
    if (p === "review") add("review", `${at}: ${id} needs review`);
    else if (p !== "allowed") add("rejected", `${at}: ${id} is not an accepted licence`);
    else if (!allow.includes(id)) add("rejected", `${at}: ${id} is not in licence.allow of the source`);
  }
  for (const n of notices) if (n.problem !== undefined || n.content === undefined) add("ambiguous", `${shownValue(n.path)}: notice file is ${n.problem ?? "not readable"}`);
  if (declared !== undefined && governedBy !== undefined) {
    const d = declaredProblem(declared, ids, applicable);
    if (d) add(d.status, d.text);
  }

  const status = found.reduce<LicenceStatus>((s, f) => (RANK[f.status] > RANK[s] ? f.status : s), "allowed");
  const reasons = boundReasons(found.filter((f) => f.status === status).map((f) => f.text).concat(found.filter((f) => f.status !== status).map((f) => f.text)));
  const attribution = [...applicable, ...notices]
    .filter((f): f is LicenceEvidenceFile & { content: Uint8Array } => f.content !== undefined)
    .map((f) => ({ path: f.path, content: f.content }))
    .filter((f, i, a) => a.findIndex((g) => g.path === f.path) === i)
    .sort((a, b) => byteCmp(a.path, b.path));
  const notice: string[] = [];
  for (const a of attribution) {
    const text = decode(a.content);
    if (text === undefined) continue;
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!COPYRIGHT_LINE_RE.test(line)) continue;
      const shown = shownValue(line.trim()).slice(0, LICENCE_LIMITS.noticeChars);
      if (!notice.includes(shown)) notice.push(shown);
    }
  }
  return {
    status,
    reasons: status === "allowed" ? [] : reasons,
    licences: [...ids].sort(byteCmp),
    ...(declared === undefined ? {} : { declared }),
    ...(governedBy === undefined ? {} : { governedBy }),
    licenceFiles: records.sort((a, b) => byteCmp(a.path, b.path)),
    attribution,
    authorNotice: notice.slice(0, LICENCE_LIMITS.noticeLines),
  };
}
