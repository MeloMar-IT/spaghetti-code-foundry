import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { readRegular, skillDigest } from "./package.js";
import { RELEASE_FILE, readRelease, type ReleaseFileEntry, type ReleaseManifestV2, type ReleaseRead, type ReleaseSkillV2 } from "./release.js";
import { SKILL_LIMITS } from "./schema.js";

export const ATTRIBUTION_DIR = ".attribution";
/** Same number as MAX_SKILL_BYTES_TOTAL in registry.ts. */
export const MAX_VERIFY_BYTES = 64 * 1024 * 1024;
const IGNORED = ".DS_Store";
const PACKAGE_DEPTH = 6;
const ATTRIBUTION_DEPTH = 7;
const ATTRIBUTION_FOLDERS = 1000;

export type ReleaseVerification = { ok: true; manifest: ReleaseManifestV2; digest: string } | { ok: false; reason: string };

/** A problem found while checking. Its text never holds a path, a file name or file content. */
class Problem extends Error {}
const fail = (reason: string): never => {
  throw new Problem(reason);
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const code = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error");

/** The real path of `p` is `base` or below it. Node has no openat(), so this is checked before descending and before and after each read. */
const inside = (p: string, base: string): boolean => {
  try {
    const r = realpathSync(p);
    return r === base || r.startsWith(base + sep);
  } catch {
    return false;
  }
};

interface Budget {
  files: number;
  folders: number;
  depth: number;
}

/** The regular files below `base` as relative paths. A link, a special entry or a folder that leaves `base` is a problem; so is running out of budget. */
function walk(base: string, budget: Budget, label: string): string[] {
  const out: string[] = [];
  let folders = 0;
  const go = (abs: string, rel: string, level: number) => {
    let list: string[];
    try {
      list = readdirSync(abs).sort(cmp);
    } catch (e) {
      return fail(`${label} cannot be listed (${code(e)})`);
    }
    for (const name of list) {
      const full = join(abs, name);
      const path = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(full);
      } catch (e) {
        return fail(`${label} cannot be read (${code(e)})`);
      }
      if (st.isSymbolicLink()) fail(`${label} holds a link`);
      else if (st.isDirectory()) {
        if (++folders > budget.folders || level + 1 > budget.depth) fail(`${label} has too many folders or is nested too deep`);
        if (!inside(full, base)) fail(`${label} holds a folder that leaves it`);
        go(full, path, level + 1);
      } else if (st.isFile()) {
        if (name === IGNORED) continue;
        if (out.length >= budget.files) fail(`${label} holds more files than listed`);
        out.push(path);
      } else fail(`${label} holds a special file`);
    }
  };
  go(base, "", 0);
  return out;
}

/** The content of a listed file, or a problem when it is not the listed one. */
function readListed(base: string, f: ReleaseFileEntry, label: string): Uint8Array {
  const full = join(base, ...f.path.split("/"));
  if (!inside(dirname(full), base)) return fail(`${label} has a listed file that leaves it`);
  let r: ReturnType<typeof readRegular>;
  try {
    r = readRegular(full, f.bytes);
  } catch (e) {
    return fail(`${label} has a listed file that cannot be read (${code(e)})`);
  }
  if (r === "link") return fail(`${label} has a listed file that is a link`);
  if (r === "other") return fail(`${label} has a listed file that is missing or not a regular file`);
  if (r === "large" || r.byteLength !== f.bytes) return fail(`${label} has a listed file with another size`);
  if (!inside(full, base)) return fail(`${label} has a listed file that leaves it`);
  if (createHash("sha256").update(r).digest("hex") !== f.sha256) return fail(`${label} has a listed file with another SHA-256`);
  return r;
}

/** `base` is a real folder (not a link) inside the real root. */
function realFolder(path: string, label: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return fail(`${label} cannot be read (${code(e)})`);
  }
  if (!st.isDirectory()) fail(`${label} is not a folder`);
}

function sameFiles(found: string[], listed: ReleaseFileEntry[], label: string): void {
  const want = new Set(listed.map((f) => f.path));
  const have = new Set(found);
  if (found.some((p) => !want.has(p))) fail(`${label} holds a file that is not listed`);
  if (listed.some((f) => !have.has(f.path))) fail(`${label} is missing a listed file`);
}

function checkSkill(realRoot: string, s: ReleaseSkillV2): void {
  const label = `skill ${s.id}`;
  const base = join(realRoot, s.id);
  realFolder(base, `${label}: the package folder`);
  sameFiles(walk(base, { files: s.files.length, folders: SKILL_LIMITS.files, depth: PACKAGE_DEPTH }, `${label}: the package`), s.files, `${label}: the package`);
  const contents = [...s.files].sort((a, b) => cmp(a.path, b.path)).map((f) => ({ path: f.path, content: readListed(base, f, `${label}: the package`) }));
  if (skillDigest(contents) !== s.digest) fail(`${label}: the package digest is not the listed one`);
  if (s.attribution.length) {
    const abase = join(realRoot, ATTRIBUTION_DIR, s.id);
    realFolder(abase, `${label}: the attribution folder`);
    // The tree is checked for links before any file in it is read.
    sameFiles(walk(abase, { files: s.attribution.length, folders: ATTRIBUTION_FOLDERS, depth: ATTRIBUTION_DEPTH }, `${label}: attribution`), s.attribution, `${label}: attribution`);
    for (const f of [...s.attribution].sort((a, b) => cmp(a.path, b.path))) readListed(abase, f, `${label}: attribution`);
  }
}

function check(realRoot: string, m: ReleaseManifestV2): void {
  // The folder itself: the manifest, the attribution folder, one folder per skill, and nothing else.
  const ids = new Set(m.skills.map((s) => s.id));
  let names: string[];
  try {
    names = readdirSync(realRoot);
  } catch (e) {
    return fail(`the release folder cannot be listed (${code(e)})`);
  }
  for (const name of names) {
    let st;
    try {
      st = lstatSync(join(realRoot, name));
    } catch (e) {
      return fail(`the release folder cannot be read (${code(e)})`);
    }
    const ok = name === RELEASE_FILE || name === IGNORED ? st.isFile() : name === ATTRIBUTION_DIR || ids.has(name) ? st.isDirectory() : false;
    if (!ok) fail("the release folder holds an entry that is not part of the release");
  }

  for (const s of [...m.skills].sort((a, b) => cmp(a.id, b.id))) checkSkill(realRoot, s);

  if (names.includes(ATTRIBUTION_DIR)) {
    const files = m.skills.reduce((n, s) => n + s.attribution.length, 0);
    const found = walk(join(realRoot, ATTRIBUTION_DIR), { files, folders: ATTRIBUTION_FOLDERS, depth: ATTRIBUTION_DEPTH }, "the attribution folder");
    const want = new Set(m.skills.flatMap((s) => s.attribution.map((f) => `${s.id}/${f.path}`)));
    if (found.some((p) => !want.has(p))) fail("the attribution folder holds a file that is not listed");
  } else if (m.skills.some((s) => s.attribution.length)) fail("the attribution folder is missing");
}

/**
 * Offline check of a schema-2 release folder: every listed file is there with its exact size and SHA-256, every package digest
 * recomputes, and nothing else is in a package or in `.attribution/`. Opens no connection, starts no process, and follows no link
 * below the folder (the folder itself is resolved once). The reason names at most a skill id.
 */
export function verifyRelease(root: string, read: ReleaseRead = readRelease(root)): ReleaseVerification {
  if (read.state === "none") return { ok: false, reason: "not a catalogue release (no catalogue-release.json)" };
  if (read.state === "invalid") return { ok: false, reason: `the release manifest ${read.reason}` };
  const m = read.manifest;
  if (m.schema !== 2) return { ok: false, reason: "the release manifest is schema 1: it lists no files to verify" };
  // Before anything is read: the sizes the manifest claims.
  const listed = m.skills.reduce((n, s) => n + [...s.files, ...s.attribution].reduce((k, f) => k + f.bytes, 0), 0);
  if (listed > MAX_VERIFY_BYTES) return { ok: false, reason: `the release lists more than ${MAX_VERIFY_BYTES / 1048576} MiB` };
  try {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch (e) {
      return { ok: false, reason: `the release folder cannot be read (${code(e)})` };
    }
    check(realRoot, m);
  } catch (e) {
    if (e instanceof Problem) return { ok: false, reason: e.message };
    return { ok: false, reason: `the release cannot be checked (${code(e)})` };
  }
  return { ok: true, manifest: m, digest: read.digest };
}
