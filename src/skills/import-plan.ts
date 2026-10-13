import { createHash } from "node:crypto";
import { skillDigest, splitFrontmatter } from "./package.js";
import { relativePathProblem, SKILL_DIGEST_RE, SKILL_ID_RE, SKILL_LIMITS } from "./schema.js";
import { approvedRefProblem, hasUnsafeChar, shownValue, type SkillLibrarySource } from "./sources.js";

// Plans and prepares the import of portable SKILL.md folders from an approved source revision. Pure: no file system,
// no process. `planImport` decides from the listing alone; `prepareImport` reads content of planned skills only.

export const IMPORT_DIGEST_HEADER = "scf-skill-import-v1\n";
/** Per-skill limits are SKILL_LIMITS from schema.ts. */
export const IMPORT_LIMITS = { skills: 500, treeEntries: 20000, totalBytes: 67108864, recordBytes: 1048576, reasons: 3, reasonChars: 200 } as const;

export interface TreeEntry {
  path: string;
  kind: "file" | "symlink" | "submodule" | "other";
  size?: number;
  id: string;
}
export interface SourceTree {
  /** Every entry below an upstream folder ("." is the root), recursive. No content is read. */
  list(path: string): TreeEntry[];
  /** The bytes of file entries, in the same order. */
  read(entries: readonly TreeEntry[]): Uint8Array[];
}
export interface RejectedSkill {
  root: string;
  reasons: string[];
}
/** Files are sorted by path (byte order), `.DS_Store` is left out. */
export interface PlannedSkill {
  root: string;
  files: TreeEntry[];
  bytes: number;
}
export type ImportErrorCode = "not-usable" | "too-many-entries" | "too-many-skills" | "too-large" | "nothing-staged" | "cannot-write" | "conflict" | "locked";
export class SkillImportError extends Error {
  readonly code: ImportErrorCode;
  readonly rejected: RejectedSkill[];
  constructor(code: ImportErrorCode, message: string, rejected: RejectedSkill[] = []) {
    super(message);
    this.name = "SkillImportError";
    this.code = code;
    this.rejected = rejected;
  }
}
export interface ImportRecord {
  schema: 1;
  source: string;
  repository: string;
  repositoryKey: string;
  commit: string;
  paths: string[];
  adapter: "agent-skills";
  digest: string;
  skills: { root: string; name: string; digest: string; files: number; bytes: number }[];
  rejected: RejectedSkill[];
}

/** UTF-8 byte order, the order `skillDigest` uses. Never `a < b`: that is UTF-16 order. */
export const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const fold = (s: string) => s.normalize("NFC").toLowerCase().normalize("NFC");
const lastSeg = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Keeps the first IMPORT_LIMITS.reasons, cuts each to reasonChars, adds "and <n> more". */
export function boundReasons(reasons: readonly string[]): string[] {
  const cut = (r: string) => (r.length > IMPORT_LIMITS.reasonChars ? r.slice(0, IMPORT_LIMITS.reasonChars - 1) + "…" : r);
  const out = reasons.slice(0, IMPORT_LIMITS.reasons).map(cut);
  if (reasons.length > IMPORT_LIMITS.reasons) out.push(`and ${reasons.length - IMPORT_LIMITS.reasons} more`);
  return out;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return p === "/" ? "." : "/";
  return p.slice(0, i);
}
const inside = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");
const relOf = (root: string, p: string) => (root === "." ? p : p.slice(root.length + 1));

type Names = Map<string, { spelled: string; file: boolean }>;
/** Why the file path cannot live next to the names already taken. Changes nothing. */
function nameClash(taken: Names, path: string): "twice" | "clash" | undefined {
  const segs = path.split("/");
  for (let i = 1; i < segs.length; i++) {
    const dir = segs.slice(0, i).join("/");
    const e = taken.get(fold(dir));
    if (e && (e.file || e.spelled !== dir)) return "clash";
  }
  const e = taken.get(fold(path));
  if (!e) return undefined;
  return e.file && e.spelled === path ? "twice" : "clash";
}
/** Records the file path and every folder above it. */
function takeName(taken: Names, path: string): void {
  const segs = path.split("/");
  for (let i = 1; i < segs.length; i++) {
    const dir = segs.slice(0, i).join("/");
    if (!taken.has(fold(dir))) taken.set(fold(dir), { spelled: dir, file: false });
  }
  taken.set(fold(path), { spelled: path, file: true });
}

const KIND_RANK: Record<string, number> = { file: 0, symlink: 1, submodule: 2, other: 3 };
const sizeKey = (e: TreeEntry) => (typeof e.size === "number" ? e.size : -1);
const entryKey = (e: TreeEntry) => `${e.path}\0${e.kind}\0${e.size}\0${e.id}`;

/** Why one file of a skill is not acceptable, or undefined. `full` is the upstream path, `rel` the path inside the skill. */
function entryProblem(e: TreeEntry, full: string, rel: string): string | undefined {
  if (e.kind === "symlink") return "a symbolic link";
  if (e.kind === "submodule") return "a submodule";
  if (e.kind !== "file") return "not a regular file";
  if (relativePathProblem(full) || relativePathProblem(rel)) return "path leaves the repository or is not a plain relative path";
  if (hasUnsafeChar(full)) return "holds a control or invisible character";
  if (full.includes(":")) return 'holds a ":"';
  if (full.split("/").some((s) => s.toLowerCase() === ".git")) return "holds a .git folder";
  if (Buffer.byteLength(full) > SKILL_LIMITS.pathChars) return `path is longer than ${SKILL_LIMITS.pathChars} bytes`;
  if (rel.split("/").length > SKILL_LIMITS.pathSegments) return `path is deeper than ${SKILL_LIMITS.pathSegments} folders`;
  if (typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size < 0) return "has no size";
  const max = rel === "SKILL.md" ? SKILL_LIMITS.skillMdBytes : SKILL_LIMITS.fileBytes;
  if (e.size > max) return `is larger than ${max} bytes`;
  return undefined;
}

/**
 * Listing only: it reads no content. Collisions between skills are decided in prepareImport, so a caller of
 * planImport alone does not see them. The order of the listing does not matter.
 */
export function planImport(paths: readonly string[], list: (path: string) => TreeEntry[]): { skills: PlannedSkill[]; rejected: RejectedSkill[] } {
  const raw: TreeEntry[] = [];
  const earlier = new Set<string>();
  let count = 0;
  for (const declared of paths) {
    const got = list(declared);
    const mine: string[] = [];
    for (const e of got) {
      if (++count > IMPORT_LIMITS.treeEntries) throw new SkillImportError("too-many-entries", `the source lists more than ${IMPORT_LIMITS.treeEntries} entries`);
      if (relativePathProblem(e.path) === undefined && !inside(declared, e.path)) throw new SkillImportError("not-usable", "the tree returned an entry outside the listed path");
      const k = entryKey(e);
      if (!earlier.has(k)) raw.push(e);
      mine.push(k);
    }
    for (const k of mine) earlier.add(k);
  }

  const keyed = raw.map((e) => ({ e, b: Buffer.from(e.path, "utf8") }));
  keyed.sort((x, y) => Buffer.compare(x.b, y.b) || (KIND_RANK[x.e.kind] ?? 9) - (KIND_RANK[y.e.kind] ?? 9) || sizeKey(x.e) - sizeKey(y.e) || byteCmp(String(x.e.id), String(y.e.id)));
  const sorted = keyed.map((k) => k.e);

  // Roots: the outermost folder with a regular SKILL.md in it.
  const isSkillMd = (e: TreeEntry) => e.kind === "file" && lastSeg(e.path) === "SKILL.md";
  const cands = new Set<string>();
  // A malformed path never takes part in finding roots: it cannot swallow a valid sibling.
  const wellFormed = (e: TreeEntry) => relativePathProblem(e.path) === undefined;
  for (const e of sorted) if (isSkillMd(e) && wellFormed(e)) cands.add(parentOf(e.path));
  const outermost = (c: string): string => {
    let best = c;
    let cur = c;
    while (cur !== ".") {
      cur = parentOf(cur);
      if (cands.has(cur)) best = cur;
    }
    return best;
  };
  const roots = new Set<string>();
  for (const c of cands) if (outermost(c) === c) roots.add(c);
  const inner = new Map<string, string>();
  for (const e of sorted) {
    if (!isSkillMd(e) || !wellFormed(e)) continue;
    const c = parentOf(e.path);
    const r = outermost(c);
    if (r !== c && !inner.has(r)) inner.set(r, relOf(r, e.path));
  }
  const noRoot = paths.filter((d) => ![...roots].some((r) => inside(d, r)));
  // Malformed SKILL.md entries outside every valid root get a rejected root of their own.
  const badRoots = new Set<string>();
  for (const e of sorted) if (isSkillMd(e) && !wellFormed(e) && !roots.has(parentOf(e.path))) badRoots.add(parentOf(e.path));
  if (roots.size + badRoots.size + noRoot.length > IMPORT_LIMITS.skills) throw new SkillImportError("too-many-skills", `the source holds more than ${IMPORT_LIMITS.skills} skills`);

  const owned = new Map<string, TreeEntry[]>();
  for (const r of roots) owned.set(r, []);
  const badOwned = new Map<string, TreeEntry[]>();
  for (const r of badRoots) badOwned.set(r, []);
  for (const e of sorted) {
    if (lastSeg(e.path) === ".DS_Store") continue;
    const ok = wellFormed(e);
    let cur = parentOf(e.path);
    for (;;) {
      const o = owned.get(cur) ?? (ok ? undefined : badOwned.get(cur));
      if (o) {
        o.push(e);
        break;
      }
      if (cur === ".") break;
      cur = parentOf(cur);
    }
  }

  const skills: { raw: string; s: PlannedSkill }[] = [];
  const rejected: { raw: string; r: RejectedSkill }[] = [];
  for (const [root, files] of [...owned, ...badOwned]) {
    const head: string[] = [];
    const innerRel = inner.get(root);
    if (innerRel !== undefined) head.push(`${shownValue(innerRel)}: a second SKILL.md inside the skill`);
    if (files.length > SKILL_LIMITS.files) head.push(`more than ${SKILL_LIMITS.files} files`);
    const taken: Names = new Map();
    const reasons: string[] = [];
    let bytes = 0;
    const good: TreeEntry[] = [];
    for (const e of files) {
      const rel = relOf(root, e.path);
      let why = entryProblem(e, e.path, rel);
      if (!why) {
        const c = nameClash(taken, rel);
        if (c === "twice") why = "is listed twice";
        else if (c) why = "collides with another path on a case-insensitive disk";
      }
      if (why) {
        reasons.push(`${shownValue(rel)}: ${why}`);
        continue;
      }
      takeName(taken, rel);
      bytes += e.size!;
      good.push(e);
    }
    if (bytes > SKILL_LIMITS.totalBytes) head.push(`larger than ${SKILL_LIMITS.totalBytes} bytes in total`);
    const all = [...head, ...reasons];
    if (all.length === 0) skills.push({ raw: root, s: { root, files: good, bytes } });
    else rejected.push({ raw: root, r: { root: shownValue(root), reasons: boundReasons(all) } });
  }
  for (const d of noRoot) rejected.push({ raw: d, r: { root: shownValue(d), reasons: ["no SKILL.md below this path"] } });
  const by = (a: { raw: string }, b: { raw: string }) => byteCmp(a.raw, b.raw);
  return { skills: skills.sort(by).map((x) => x.s), rejected: rejected.sort(by).map((x) => x.r) };
}

/** `sha256:` over the header and one `<root>\t<skill digest>\n` line per skill, in byte order of the root. */
export function importDigest(skills: readonly { root: string; digest: string }[]): string {
  const h = createHash("sha256");
  h.update(IMPORT_DIGEST_HEADER);
  for (const s of [...skills].sort((a, b) => byteCmp(a.root, b.root))) h.update(`${s.root}\t${s.digest}\n`, "utf8");
  return "sha256:" + h.digest("hex");
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const plainText = (v: unknown, max: number): v is string => isStr(v) && v.length >= 1 && v.length <= max && !hasUnsafeChar(v);
const plainPath = (v: unknown): v is string => isStr(v) && (v === "." || (relativePathProblem(v) === undefined && !hasUnsafeChar(v)));

/**
 * Checks the form of the text of import.json. Pure. It does not prove who wrote the record: a fresh record is built
 * from checked fields and the text must equal its written form. Problems are fixed sentences and never repeat a value.
 */
export function parseImportRecord(text: string): { record: ImportRecord } | { problem: string } {
  const bad = (what: string) => ({ problem: `import.json: ${what}` });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "import.json is not valid JSON" };
  }
  if (!isRec(raw)) return bad("is not an object");
  if (raw.schema !== 1) return bad("schema is not 1");
  if (!isStr(raw.source) || !SKILL_ID_RE.test(raw.source)) return bad("source is not a source id");
  if (!isStr(raw.commit) || approvedRefProblem(raw.commit)) return bad("commit is not a full commit id");
  if (raw.adapter !== "agent-skills") return bad("adapter is not agent-skills");
  if (!plainText(raw.repository, 2048)) return bad("repository is not usable");
  if (!plainText(raw.repositoryKey, 2048)) return bad("repositoryKey is not usable");
  if (!Array.isArray(raw.paths) || raw.paths.length < 1 || raw.paths.length > 200 || !raw.paths.every(plainPath)) return bad("paths is not usable");
  if (!isStr(raw.digest) || !SKILL_DIGEST_RE.test(raw.digest)) return bad("digest is not a digest");
  if (!Array.isArray(raw.skills) || raw.skills.length < 1 || raw.skills.length > IMPORT_LIMITS.skills) return bad("skills is not a list of 1 to 500 skills");
  const skills: ImportRecord["skills"] = [];
  const roots = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const [i, e] of raw.skills.entries()) {
    if (!isRec(e)) return bad(`skills[${i}] is not an object`);
    if (!plainPath(e.root) || roots.has(e.root)) return bad(`skills[${i}].root is not usable or is used twice`);
    if (!isStr(e.name) || !SKILL_ID_RE.test(e.name)) return bad(`skills[${i}].name is not a skill name`);
    if (!isStr(e.digest) || !SKILL_DIGEST_RE.test(e.digest)) return bad(`skills[${i}].digest is not a digest`);
    if (!isInt(e.files, 1, SKILL_LIMITS.files)) return bad(`skills[${i}].files is not a count`);
    if (!isInt(e.bytes, 0, SKILL_LIMITS.totalBytes)) return bad(`skills[${i}].bytes is not a size`);
    roots.add(e.root);
    files += e.files;
    bytes += e.bytes;
    skills.push({ root: e.root, name: e.name, digest: e.digest, files: e.files, bytes: e.bytes });
  }
  if (files > IMPORT_LIMITS.treeEntries) return bad("skills hold more files than an import can have");
  if (bytes > IMPORT_LIMITS.totalBytes) return bad("skills hold more bytes than an import can have");
  if (!Array.isArray(raw.rejected) || raw.rejected.length > IMPORT_LIMITS.skills) return bad("rejected is not usable");
  const rejected: RejectedSkill[] = [];
  for (const [i, e] of raw.rejected.entries()) {
    if (!isRec(e) || !isStr(e.root) || e.root.length > 100 || hasUnsafeChar(e.root)) return bad(`rejected[${i}].root is not usable`);
    const r = e.reasons;
    if (!Array.isArray(r) || r.length > IMPORT_LIMITS.reasons + 1 || !r.every((x) => isStr(x) && x.length <= IMPORT_LIMITS.reasonChars && !hasUnsafeChar(x))) {
      return bad(`rejected[${i}].reasons is not usable`);
    }
    rejected.push({ root: e.root, reasons: [...(r as string[])] });
  }
  const record: ImportRecord = {
    schema: 1,
    source: raw.source,
    repository: raw.repository as string,
    repositoryKey: raw.repositoryKey as string,
    commit: raw.commit,
    paths: [...(raw.paths as string[])],
    adapter: "agent-skills",
    digest: raw.digest,
    skills,
    rejected,
  };
  if (JSON.stringify(record, null, 2) + "\n" !== text) return bad("is not in the form scf writes");
  if (importDigest(skills) !== record.digest) return bad("digest does not match the skills");
  return { record };
}

/** The name, or a fixed text for why SKILL.md is not usable. Never repeats parser text or file content. */
function skillMdProblem(bytes: Uint8Array): { name: string } | { problem: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { problem: "SKILL.md: is not UTF-8" };
  }
  let data: Record<string, unknown>;
  try {
    data = splitFrontmatter(text).data as Record<string, unknown>;
  } catch {
    return { problem: "SKILL.md: has no valid frontmatter" };
  }
  const { name, description } = data;
  if (!isStr(name) || !SKILL_ID_RE.test(name)) return { problem: "SKILL.md: name must be a lower-case slug of 1–64 characters" };
  if (!isStr(description) || description.trim().length < 1 || description.trim().length > 1024) return { problem: "SKILL.md: description must be 1 to 1024 characters" };
  return { name };
}

/** Plans, reads, checks and digests in memory. Writes nothing. Errors of `tree` pass through. */
export function prepareImport(
  source: SkillLibrarySource,
  tree: SourceTree,
  opts: { limits?: { recordBytes?: number } } = {},
): { record: ImportRecord; recordText: string; files: Map<string, Uint8Array> } {
  const refusal = (what: string) => new SkillImportError("not-usable", `the source cannot be imported: ${what}`);
  if (source.status !== "enabled") throw refusal("status is not enabled");
  const commit = source.ref?.approved;
  if (!isStr(commit) || approvedRefProblem(commit)) throw refusal("ref.approved is not a full commit id");
  if (source.adapter !== "agent-skills") throw refusal("adapter is not agent-skills");
  if (!isStr(source.id) || !SKILL_ID_RE.test(source.id)) throw refusal("id is not a valid source id");

  const plan = planImport(source.paths, (p) => tree.list(p));
  if (plan.skills.reduce((n, s) => n + s.bytes, 0) > IMPORT_LIMITS.totalBytes) throw new SkillImportError("too-large", `the skills hold more than ${IMPORT_LIMITS.totalBytes} bytes`);

  const rejected: { raw: string; r: RejectedSkill }[] = plan.rejected.map((r) => ({ raw: r.root, r }));
  const taken: Names = new Map();
  const staged: { root: string; name: string; digest: string; files: number; bytes: number }[] = [];
  const out: [string, Uint8Array][] = [];
  const reject = (root: string, reason: string) => rejected.push({ raw: root, r: { root: shownValue(root), reasons: [reason] } });
  for (const skill of plan.skills) {
    const rel = (e: TreeEntry) => relOf(skill.root, e.path);
    const clash = skill.files.find((e) => nameClash(taken, e.path));
    if (clash) {
      reject(skill.root, `${shownValue(rel(clash))}: collides with a path of an earlier skill on a case-insensitive disk`);
      continue;
    }
    const got = tree.read(skill.files);
    if (!Array.isArray(got) || got.length !== skill.files.length || got.some((b, i) => !(b instanceof Uint8Array) || b.byteLength !== skill.files[i]!.size)) {
      reject(skill.root, `${shownValue(rel(skill.files[0]!))}: content does not match the listing`);
      continue;
    }
    const mdAt = skill.files.findIndex((e) => rel(e) === "SKILL.md");
    const md = skillMdProblem(got[mdAt]!);
    if ("problem" in md) {
      reject(skill.root, md.problem);
      continue;
    }
    for (const e of skill.files) takeName(taken, e.path);
    skill.files.forEach((e, i) => out.push([e.path, got[i]!]));
    staged.push({
      root: skill.root,
      name: md.name,
      digest: skillDigest(skill.files.map((e, i) => ({ path: rel(e), content: got[i]! }))),
      files: skill.files.length,
      bytes: skill.bytes,
    });
  }
  const sortedRejected = rejected.sort((a, b) => byteCmp(a.raw, b.raw)).map((x) => x.r);
  if (staged.length === 0) throw new SkillImportError("nothing-staged", "no skill could be staged", sortedRejected);

  staged.sort((a, b) => byteCmp(a.root, b.root));
  const record: ImportRecord = {
    schema: 1,
    source: source.id,
    repository: source.repository,
    repositoryKey: source.repositoryKey,
    commit,
    paths: [...source.paths],
    adapter: "agent-skills",
    digest: importDigest(staged),
    skills: staged,
    rejected: sortedRejected,
  };
  const recordText = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(recordText) > (opts.limits?.recordBytes ?? IMPORT_LIMITS.recordBytes)) throw new SkillImportError("too-large", "the import record is too large");
  out.sort((a, b) => byteCmp(a[0], b[0]));
  return { record, recordText, files: new Map(out) };
}
