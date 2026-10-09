import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SKILL_FOLDERS,
  SKILL_LIMITS,
  SkillFrontmatterSchema,
  SkillManifestSchema,
  relativePathProblem,
  type SkillFile,
  type SkillFolder,
  type SkillPackage,
} from "./schema.js";

export interface SkillIssue {
  path: string;
  reason: string;
}

export class SkillPackageError extends Error {
  readonly issues: SkillIssue[];
  constructor(source: string, issues: SkillIssue[]) {
    super(`${source}: invalid skill package` + issues.map((i) => `\n  - ${i.path}: ${i.reason}`).join(""));
    this.name = "SkillPackageError";
    this.issues = issues;
  }
}

export interface SkillEntry {
  /** Relative path, forward slashes. */
  path: string;
  /** Default "file". */
  kind?: "file" | "directory" | "symlink" | "other";
  /** File bytes. The size is always taken from here, never from a caller's claim. */
  content?: Uint8Array;
  /** Only for a file whose content was deliberately not read (too large). Ignored when content is given. */
  size?: number;
}

/** First bytes of what `skillDigest` hashes. */
export const SKILL_DIGEST_HEADER = "scf-skill-package-v1\n";

/**
 * The digest of a package: SHA-256 over the header, then every file sorted by path (byte order) as
 * `uint32 BE path length, path (UTF-8), uint32 BE content length, content`. The order of `entries` does not matter.
 * Covers paths and raw bytes only: not file modes, empty folders or `.DS_Store`.
 */
export function skillDigest(entries: readonly { path: string; content: Uint8Array }[]): string {
  const h = createHash("sha256");
  h.update(SKILL_DIGEST_HEADER);
  const len = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const sorted = entries.map((e) => ({ path: Buffer.from(e.path, "utf8"), content: e.content })).sort((a, b) => Buffer.compare(a.path, b.path));
  for (const e of sorted) {
    h.update(len(e.path.length));
    h.update(e.path);
    h.update(len(e.content.byteLength));
    h.update(e.content);
  }
  return "sha256:" + h.digest("hex");
}

const SKILL_MD = "SKILL.md";
const MANIFEST = "skill.yaml";
const REVIEW_MD = "REVIEW.md";
const PACKAGE = "(package)";
const IGNORED = ".DS_Store";

/** Split SKILL.md into its YAML frontmatter and the body. Throws an Error with the reason. */
export function splitFrontmatter(text: string): { data: unknown; body: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") throw new Error("must start with a `---` frontmatter block");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("frontmatter is not closed with `---`");
  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, end).join("\n"));
  } catch (e) {
    throw new Error(`invalid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter must be a map of keys and values");
  return { data, body: lines.slice(end + 1).join("\n") };
}

const dotted = (path: PropertyKey[]) => path.map(String).join(".");

/** One precise issue per problem; an unknown-keys issue names every offending key. */
function zodIssues(
  file: string,
  fallback: string,
  error: { issues: readonly { path: PropertyKey[]; message: string; code: string; keys?: string[] }[] },
): SkillIssue[] {
  return error.issues.flatMap((i) =>
    i.code === "unrecognized_keys" && i.keys
      ? i.keys.map((k) => ({ path: `${file}: ${dotted([...i.path, k])}`, reason: "unknown key" }))
      : [{ path: `${file}: ${dotted(i.path) || fallback}`, reason: i.message }],
  );
}

function sizeOf(e: SkillEntry): number | undefined {
  if (e.content) return e.content.byteLength;
  return typeof e.size === "number" && Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : undefined;
}

function fileLimit(path: string): number {
  if (path === SKILL_MD) return SKILL_LIMITS.skillMdBytes;
  if (path === MANIFEST) return SKILL_LIMITS.manifestBytes;
  if (path === REVIEW_MD) return SKILL_LIMITS.reviewMdBytes;
  return SKILL_LIMITS.fileBytes;
}

function decode(e: SkillEntry): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(e.content);
}

export function parseSkillPackage(entries: readonly SkillEntry[], source = PACKAGE, dirName?: string): SkillPackage {
  const issues: SkillIssue[] = [];
  const add = (path: string, reason: string) => issues.push({ path, reason });

  // 1. Entries
  const kept: SkillEntry[] = [];
  const seen = new Map<string, string>();
  for (const e of entries) {
    const path = e.path;
    if (path.split("/").pop() === IGNORED) continue;
    const kind = e.kind ?? "file";
    const problem = relativePathProblem(path);
    if (problem) {
      add(path, problem);
      continue;
    }
    if (path.length > SKILL_LIMITS.pathChars) add(path, `path is longer than ${SKILL_LIMITS.pathChars} characters`);
    if (path.split("/").length > SKILL_LIMITS.pathSegments) add(path, `path has more than ${SKILL_LIMITS.pathSegments} segments`);
    const key = path.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      add(path, `duplicate entry (same as ${other})`);
      continue;
    }
    seen.set(key, path);
    if (kind === "symlink") {
      add(path, "unsupported entry (symbolic link)");
      continue;
    }
    if (kind === "other") {
      add(path, "unsupported entry (not a regular file or folder)");
      continue;
    }
    const top = path.split("/")[0]!;
    const nested = path.includes("/");
    const isFolder = (SKILL_FOLDERS as readonly string[]).includes(top);
    const topFile = !nested && kind === "file" && (path === SKILL_MD || path === MANIFEST || path === REVIEW_MD);
    if (!topFile && !isFolder) {
      add(path, `unsupported entry (allowed at the top: ${SKILL_MD}, ${MANIFEST}, ${REVIEW_MD}, ${SKILL_FOLDERS.join(", ")})`);
      continue;
    }
    if (kind === "directory") continue;
    if (!nested && isFolder) {
      add(path, "unsupported entry (a folder name used as a file)");
      continue;
    }
    const size = sizeOf(e);
    if (size === undefined) {
      add(path, "invalid size");
      continue;
    }
    const limit = fileLimit(path);
    if (size > limit) {
      add(path, `file is larger than ${limit} bytes`);
      continue;
    }
    if (!e.content) {
      add(path, "file content is missing");
      continue;
    }
    kept.push(e);
  }

  // 2. Totals
  const counted = entries.filter((e) => e.path.split("/").pop() !== IGNORED);
  const total = counted.reduce((n, e) => n + (e.kind && e.kind !== "file" ? 0 : (sizeOf(e) ?? 0)), 0);
  const fileCount = counted.filter((e) => (e.kind ?? "file") === "file").length;
  if (counted.filter((e) => e.kind === "directory").length > SKILL_LIMITS.files) add(PACKAGE, `more than ${SKILL_LIMITS.files} folders`);
  if (fileCount > SKILL_LIMITS.files) add(PACKAGE, `more than ${SKILL_LIMITS.files} files`);
  if (total > SKILL_LIMITS.totalBytes) add(PACKAGE, `package is larger than ${SKILL_LIMITS.totalBytes} bytes`);

  const find = (p: string) => kept.find((e) => e.path === p);

  // 3. SKILL.md
  let fm: ReturnType<typeof SkillFrontmatterSchema.parse> | undefined;
  let body = "";
  const md = find(SKILL_MD);
  if (!md) {
    if (!seen.has(SKILL_MD.toLowerCase())) add(SKILL_MD, "missing");
  } else {
    try {
      const split = splitFrontmatter(decode(md));
      body = split.body.trim();
      const r = SkillFrontmatterSchema.safeParse(split.data);
      if (r.success) fm = r.data;
      else issues.push(...zodIssues(SKILL_MD, "frontmatter", r.error));
      if (!body) add(SKILL_MD, "no instructions after the frontmatter");
    } catch (e) {
      add(SKILL_MD, e instanceof TypeError ? "is not valid UTF-8 text" : (e as Error).message);
    }
  }

  // 4. skill.yaml
  let manifest: ReturnType<typeof SkillManifestSchema.parse> | undefined;
  const mf = find(MANIFEST);
  if (!mf) {
    if (!seen.has(MANIFEST.toLowerCase())) add(MANIFEST, "missing");
  } else {
    try {
      const raw: unknown = parseYaml(decode(mf));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) add(MANIFEST, "must be a map of keys and values");
      else {
        const r = SkillManifestSchema.safeParse(raw);
        if (r.success) manifest = r.data;
        else issues.push(...zodIssues(MANIFEST, "manifest", r.error));
      }
    } catch (e) {
      add(MANIFEST, e instanceof TypeError ? "is not valid UTF-8 text" : `invalid YAML: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // 4b. REVIEW.md (optional)
  let review: string | undefined;
  const rv = find(REVIEW_MD);
  if (rv) {
    try {
      const text = decode(rv).trim();
      if (text) review = text;
      else add(REVIEW_MD, "is empty");
    } catch {
      add(REVIEW_MD, "is not valid UTF-8 text");
    }
  }

  // 5. Cross checks
  if (review !== undefined && manifest && manifest.roles.length && !manifest.roles.includes("reviewer"))
    add(REVIEW_MD, `needs the reviewer role in ${MANIFEST} (or no roles)`);
  if (fm && manifest && fm.name !== manifest.id) add(`${SKILL_MD}: name`, `must equal the id in ${MANIFEST} (${manifest.id})`);
  if (fm && dirName !== undefined && fm.name !== dirName) add(`${SKILL_MD}: name`, `must equal the folder name (${dirName})`);
  if (manifest && manifest.risk === "low") {
    const hasScripts = kept.some((e) => e.path.startsWith("scripts/"));
    if (manifest.tool_profile.shell) add(`${MANIFEST}: risk`, "must be medium or high when tool_profile.shell is true");
    else if (hasScripts) add(`${MANIFEST}: risk`, "must be medium or high when the package has scripts");
  }

  if (issues.length || !fm || !manifest) throw new SkillPackageError(source, issues);

  const files = Object.fromEntries(SKILL_FOLDERS.map((f) => [f, [] as SkillFile[]])) as Record<SkillFolder, SkillFile[]>;
  for (const e of kept) {
    const folder = e.path.split("/")[0] as SkillFolder;
    if (files[folder]) files[folder].push({ path: e.path, size: e.content!.byteLength, content: e.content! });
  }
  for (const f of SKILL_FOLDERS) files[f].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const pkg: SkillPackage = {
    ...manifest,
    capabilities: [...manifest.capabilities].sort(),
    roles: [...manifest.roles].sort(),
    conflicts: [...manifest.conflicts].sort(),
    dependencies: [...manifest.dependencies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    description: fm.description.trim(),
    instructions: body,
    digest: skillDigest(kept.map((e) => ({ path: e.path, content: e.content! }))),
    files,
  };
  if (review !== undefined) pkg.review = review;
  if (fm.license !== undefined) pkg.license = fm.license.trim();
  if (fm.compatibility !== undefined) pkg.compatibility = fm.compatibility;
  if (fm.metadata !== undefined) pkg.metadata = fm.metadata;
  if (fm["allowed-tools"] !== undefined) pkg.allowedTools = fm["allowed-tools"];
  return pkg;
}

/** Read a regular file without following a link: open with O_NOFOLLOW, check the open descriptor, read from it. */
export function readRegular(path: string, limit: number): Uint8Array | "link" | "other" | "large" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP" ? "link" : "other";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return "other";
    if (st.size > limit) return "large";
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

export function loadSkillPackage(dir: string): SkillPackage {
  let isDir = false;
  try {
    isDir = lstatSync(dir).isDirectory() || lstatSync(resolve(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new SkillPackageError(dir, [{ path: PACKAGE, reason: "not a folder" }]);

  const entries: SkillEntry[] = [];
  const realRoot = realpathSync(dir);
  // Node has no openat(): a parent folder swapped for a link during the walk is caught by checking
  // that the real path stays inside the package before and after each read.
  const inside = (p: string) => {
    try {
      const r = realpathSync(p);
      return r === realRoot || r.startsWith(realRoot + sep);
    } catch {
      return false;
    }
  };
  let files = 0;
  let folders = 0;
  // The two manifest files come first so a truncated walk never hides them.
  const rank = (n: string, top: boolean) => (top && (n === SKILL_MD || n === MANIFEST) ? 0 : 1);
  const walk = (abs: string, rel: string) => {
    const list = readdirSync(abs, { withFileTypes: true }).sort(
      (a, b) => rank(a.name, !rel) - rank(b.name, !rel) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const d of list) {
      if (files > SKILL_LIMITS.files || folders > SKILL_LIMITS.files) return;
      if (d.name === IGNORED) continue;
      const path = rel ? `${rel}/${d.name}` : d.name;
      const full = join(abs, d.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) entries.push({ path, kind: "symlink" });
      else if (st.isDirectory()) {
        entries.push({ path, kind: "directory" });
        folders++;
        // Do not descend into folders that are not part of the format.
        if ((rel || (SKILL_FOLDERS as readonly string[]).includes(d.name)) && inside(full)) walk(full, path);
      } else if (st.isFile()) {
        files++;
        const limit = fileLimit(path);
        if (st.size > limit) entries.push({ path, size: st.size });
        else {
          const r = inside(dirname(full)) ? readRegular(full, limit) : "link";
          if (typeof r !== "string" && !inside(full)) entries.push({ path, kind: "symlink" });
          else if (r === "link") entries.push({ path, kind: "symlink" });
          else if (r === "other") entries.push({ path, kind: "other" });
          else if (r === "large") entries.push({ path, size: limit + 1 });
          else entries.push({ path, content: r });
        }
      } else entries.push({ path, kind: "other" });
    }
  };
  walk(dir, "");
  return parseSkillPackage(entries, dir, basename(resolve(dir)));
}
