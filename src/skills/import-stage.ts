import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import { acquireLock, releaseLock, removeTree } from "../home-migrate.js";
import { addLicenceEvidence, collectImportEvidence, importLicenceFiles } from "./import-evidence.js";
import { evidenceFromRecord, LICENCE_DIR, LICENCE_RECORD_BYTES, LICENCE_RECORD_FILE, parseLicenceRecord, prepareLicenceEvidence, type LicenceRecord } from "./import-licence.js";
import { byteCmp, IMPORT_LIMITS, importDigest, parseImportRecord, prepareImport, SkillImportError, type ImportRecord, type PreparedImport, type SourceTree } from "./import-plan.js";
import type { LicenceEvidence } from "./licence.js";
import { LICENCE_LIMITS } from "./licence-rules.js";
import { skillDigest } from "./package.js";
import { SKILL_ID_RE, SKILL_LIMITS } from "./schema.js";
import { approvedRefProblem, shownValue, type SkillLibrarySource } from "./sources.js";

// Stages checked skill folders into <data folder>/skill-quarantine/<source id>/<commit>/ (import.json and files/, and
// licence.json with licence/<upstream path> for the licence and notice files of the same commit; import.json lists
// them too when it records retrievedAt).
// An import made before licence.json (or retrievedAt) existed is replaced on the next import of the same commit; the old
// folder waits as <source id>/.old-<commit> until the new one is verified, and the next import restores or removes it.
// Nothing in the quarantine is run or loaded; the registry never scans it. `scf skills scan` reads it (readStagedImport). One lock: <data folder>/skill-quarantine.lock.

export const QUARANTINE_DIR = "skill-quarantine";
export const IMPORT_RECORD_FILE = "import.json";
const LOCK_NAME = "skill-quarantine.lock";
const TMP_RE = /^\.tmp-[0-9a-f]{16}$/;
const BACKUP_PREFIX = ".old-";

/** Test hooks: lock wait, the rename used to publish, and the resolver of the containment check. */
export const importStoreSettings: { waitMs: number; rename: (from: string, to: string) => void; realpath: (p: string) => string } = {
  waitMs: 10_000,
  rename: renameSync,
  realpath: realpathSync,
};

export const quarantineDir = (source: string, commit: string, home = dataHome()): string => join(home, QUARANTINE_DIR, source, commit);

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** True for the quarantine folder or a path inside it, as written or resolved. */
export function quarantinePath(p: string, home: string = dataHome()): boolean {
  const mine = [resolve(p), real(p)].filter((x): x is string => x !== undefined).map((x) => x.toLowerCase());
  const q = join(resolve(home), QUARANTINE_DIR);
  const rq = real(q);
  const rh = real(home);
  const forms = [q, rq, rh === undefined ? undefined : join(rh, QUARANTINE_DIR)].filter((x): x is string => x !== undefined).map((x) => x.toLowerCase());
  return mine.some((m) => forms.some((f) => m === f || m.startsWith(f + sep)));
}

/** The bytes of a regular file, "link" for a link, "other" for anything else. Every other error is thrown. */
function readPlain(path: string, size: number): Buffer | "link" | "other" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") return "link";
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== size) return "other";
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) return "other";
      off += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

interface Node {
  children: Map<string, Node>;
  bytes?: Uint8Array;
}
interface LicenceTree {
  recordText: string;
  files: Map<string, Uint8Array>;
}
function expectedTree(recordText: string, files: Map<string, Uint8Array>, licence?: LicenceTree): Node {
  const root: Node = { children: new Map() };
  const add = (path: string, bytes: Uint8Array) => {
    let n = root;
    for (const seg of path.split("/")) {
      let c = n.children.get(seg);
      if (!c) n.children.set(seg, (c = { children: new Map() }));
      n = c;
    }
    n.bytes = bytes;
  };
  add(IMPORT_RECORD_FILE, Buffer.from(recordText, "utf8"));
  for (const [p, b] of files) add("files/" + p, b);
  if (licence) {
    add(LICENCE_RECORD_FILE, Buffer.from(licence.recordText, "utf8"));
    root.children.set(LICENCE_DIR, { children: new Map() });
    for (const [p, b] of licence.files) add(`${LICENCE_DIR}/${p}`, b);
  }
  return root;
}

const enoent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** The first difference between a folder and the import it should hold, or undefined. Read errors are thrown. */
function folderProblem(dir: string, recordText: string, files: Map<string, Uint8Array>, licence?: LicenceTree): string | undefined {
  const shown = (rel: string, text: string) => `${rel === "" ? "the folder" : shownValue(rel)} ${text}`;
  const check = (path: string, rel: string, node: Node): string | undefined => {
    let st;
    try {
      st = lstatSync(path);
    } catch (e) {
      if (enoent(e)) return shown(rel, "is missing");
      throw e;
    }
    if (st.isSymbolicLink()) return shown(rel, "is a link");
    if (node.bytes === undefined) {
      if (!st.isDirectory()) return shown(rel, "is not a folder");
      const names = readdirSync(path).sort(byteCmp);
      if ((st.mode & 0o777) !== 0o700) return shown(rel, "has the wrong mode");
      for (const n of names) if (!node.children.has(n)) return shown(rel === "" ? n : `${rel}/${n}`, "is not part of the import");
      for (const n of [...node.children.keys()].sort(byteCmp)) {
        const p = check(join(path, n), rel === "" ? n : `${rel}/${n}`, node.children.get(n)!);
        if (p) return p;
      }
      return undefined;
    }
    if (!st.isFile()) return shown(rel, "is not a regular file");
    const got = readPlain(path, node.bytes.byteLength);
    if (got === "link") return shown(rel, "is a link");
    if (got === "other") return shown(rel, "changed");
    if (!got.equals(node.bytes)) return shown(rel, "changed");
    if ((st.mode & 0o777) !== 0o600) return shown(rel, "has the wrong mode");
    return undefined;
  };
  return check(dir, "", expectedTree(recordText, files, licence));
}

/** An existing folder must be a plain 0700 folder; a missing one is made. Nothing is ever changed. */
function privateDir(path: string, label: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (!enoent(e)) throw e;
    mkdirSync(path, { mode: 0o700 });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SkillImportError("cannot-write", `${label} is not a plain folder`);
  if ((st.mode & 0o777) !== 0o700) throw new SkillImportError("cannot-write", `${label} must have mode 0700; nothing was changed`);
}

function boundary(e: unknown): SkillImportError {
  if (e instanceof SkillImportError) return e;
  const c = (e as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof c === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(c) ? c : "error";
  return new SkillImportError("cannot-write", `the skill quarantine cannot be written (${code})`);
}

/** Writes `files` below `base` (0600 files, 0700 folders). `base` itself exists. */
function writeTree(base: string, files: Map<string, Uint8Array>): void {
  const made = new Set<string>([base]);
  for (const [path, bytes] of files) {
    const file = join(base, path);
    const missing: string[] = [];
    for (let p = dirname(file); !made.has(p); p = dirname(p)) missing.push(p);
    for (const p of missing.reverse()) {
      mkdirSync(p, { mode: 0o700 });
      made.add(p);
    }
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  }
}

/**
 * Puts back or removes the `.old-<commit>` backups of an interrupted replacement. Best effort: never throws, never
 * deletes anything it is not sure about. Runs under the lock, before the .tmp- cleanup.
 */
function recoverReplaced(sourceDir: string, source: string, home: string): void {
  let names: string[];
  try {
    names = readdirSync(sourceDir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(BACKUP_PREFIX)) continue;
    const commit = n.slice(BACKUP_PREFIX.length);
    if (approvedRefProblem(commit)) continue;
    try {
      const backup = join(sourceDir, n);
      const bst = lstatSync(backup);
      if (bst.isSymbolicLink() || !bst.isDirectory()) continue;
      const dest = join(sourceDir, commit);
      try {
        lstatSync(dest);
      } catch (e) {
        if (!enoent(e)) continue;
        renameSync(backup, dest);
        continue;
      }
      const read = readStagedImport(source, commit, { home });
      if (read.state === "ok" && read.licence !== undefined) removeTree(backup);
    } catch {
      // tried again by the next import
    }
  }
}

/** Swaps an old-form folder for the new one; the old one is kept as .old-<commit> until the new one is verified. */
function replaceFolder(sourceDir: string, tmp: string, dest: string, commit: string, verified: () => boolean): void {
  const backup = join(sourceDir, BACKUP_PREFIX + commit);
  let inTheWay = true;
  try {
    lstatSync(backup);
  } catch (e) {
    if (!enoent(e)) throw e;
    inTheWay = false;
  }
  if (inTheWay) throw new SkillImportError("cannot-write", `${backup} is in the way; remove it, then import again`);
  renameSync(dest, backup);
  try {
    importStoreSettings.rename(tmp, dest);
  } catch (first) {
    try {
      importStoreSettings.rename(backup, dest);
    } catch {
      throw new SkillImportError("cannot-write", `the earlier import is kept in ${BACKUP_PREFIX}${commit}; the next import of this source restores it`);
    }
    throw first;
  }
  if (!verified()) throw new SkillImportError("cannot-write", `the new import folder did not verify; the earlier import is kept in ${BACKUP_PREFIX}${commit}`);
  try {
    removeTree(backup);
  } catch {
    // the next import removes it
  }
}

/** Checks and stages the skills of an approved revision: `prepareImport` (reads, no lock), then `publishImport`. */
export function stageImport(
  source: SkillLibrarySource,
  tree: SourceTree,
  opts: { home?: string; limits?: { recordBytes?: number }; retrievedAt?: string; recoverable?: (e: unknown) => boolean } = {},
): { record: ImportRecord; dir: string; state: "staged" | "unchanged" } {
  const prep = prepareImport(source, tree, { limits: opts.limits });
  const licence = prepareLicenceEvidence(
    collectImportEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), tree, { recoverable: opts.recoverable }),
  );
  const full: PreparedImport = opts.retrievedAt !== undefined ? addLicenceEvidence(prep, licence, opts.retrievedAt, { limits: opts.limits }) : { ...prep, licence };
  return publishImport(full, { home: opts.home });
}

/** The import.json of an existing folder, or undefined when it cannot be read as one. */
function existingRecord(dest: string): { text: string; record: ImportRecord } | undefined {
  try {
    const rp = join(dest, IMPORT_RECORD_FILE);
    const st = lstatSync(rp);
    if (!st.isFile() || st.size > IMPORT_LIMITS.recordBytes) return undefined;
    const raw = readPlain(rp, st.size);
    if (typeof raw === "string") return undefined;
    const text = raw.toString("utf8");
    const parsed = parseImportRecord(text);
    return "problem" in parsed ? undefined : { text, record: parsed.record };
  } catch {
    return undefined;
  }
}

/** The existing import of the same commit, when it differs from the new one only by `retrievedAt`. */
function sameButTime(dest: string, record: ImportRecord, files: Map<string, Uint8Array>, licence?: LicenceTree): ImportRecord | undefined {
  if (record.retrievedAt === undefined) return undefined;
  const old = existingRecord(dest);
  if (!old || old.record.retrievedAt === undefined) return undefined;
  if (JSON.stringify({ ...record, retrievedAt: old.record.retrievedAt }, null, 2) + "\n" !== old.text) return undefined;
  try {
    return folderProblem(dest, old.text, files, licence) === undefined ? old.record : undefined;
  } catch {
    return undefined;
  }
}

/** True when the existing import is the same one staged before import.json recorded retrievedAt and licenceFiles. */
function recordedLater(dest: string, record: ImportRecord, files: Map<string, Uint8Array>, licence: LicenceTree): boolean {
  if (record.retrievedAt === undefined) return false;
  const old = existingRecord(dest);
  if (!old || old.record.retrievedAt !== undefined) return false;
  const { retrievedAt: _t, licenceFiles: _l, ...rest } = record;
  if (JSON.stringify(rest, null, 2) + "\n" !== old.text) return false;
  try {
    return folderProblem(dest, old.text, files, licence) === undefined || folderProblem(dest, old.text, files) === undefined;
  } catch {
    return false;
  }
}

/**
 * Writes a prepared import under skill-quarantine.lock: temp folder, verify, containment check, one rename.
 * The same import again is "unchanged". A record whose source id or commit would make an unsafe path is refused.
 */
export function publishImport(
  prep: PreparedImport,
  opts: { home?: string } = {},
): { record: ImportRecord; dir: string; state: "staged" | "unchanged" } {
  const { record, recordText, files, licence } = prep;
  if (record.licenceFiles !== undefined && licence === undefined) {
    throw new SkillImportError("not-usable", "the import record lists licence files that are not given");
  }
  if (typeof record.source !== "string" || !SKILL_ID_RE.test(record.source) || approvedRefProblem(record.commit)) {
    throw new SkillImportError("not-usable", "the import record is not usable: bad source id or commit");
  }
  if (licence && (licence.record.repositoryKey !== record.repositoryKey || licence.record.commit !== record.commit)) {
    throw new SkillImportError("not-usable", "the licence evidence is for another repository or commit");
  }
  const home = opts.home ?? dataHome();
  const lock = join(home, LOCK_NAME);
  let result: { record: ImportRecord; dir: string; state: "staged" | "unchanged" } | undefined;

  const until = Date.now() + importStoreSettings.waitMs;
  const body = () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!acquireLock(lock, Math.max(0, until - Date.now()))) throw new SkillImportError("locked", `${lock} is held by another scf process; try again, or delete this folder if no scf is running`);
    try {
      result = write();
    } finally {
      try {
        releaseLock(lock);
      } catch {
        // nothing more to do
      }
    }
  };
  const write = (): { record: ImportRecord; dir: string; state: "staged" | "unchanged" } => {
    const realHome = realpathSync(home);
    const q = join(realHome, QUARANTINE_DIR);
    const sourceDir = join(q, record.source);
    privateDir(q, QUARANTINE_DIR);
    privateDir(sourceDir, `${QUARANTINE_DIR}/${record.source}`);
    recoverReplaced(sourceDir, record.source, home);
    for (const n of readdirSync(sourceDir)) {
      if (TMP_RE.test(n)) {
        try {
          removeTree(join(sourceDir, n));
        } catch {
          // left for the next import
        }
      }
    }
    const dest = join(sourceDir, record.commit);
    let st;
    let replace = false;
    try {
      st = lstatSync(dest);
    } catch (e) {
      if (!enoent(e)) throw e;
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw new SkillImportError("cannot-write", "the import folder is not a plain folder");
      const diff = folderProblem(dest, recordText, files, licence);
      if (diff === undefined) return { record, dir: dest, state: "unchanged" };
      const old = sameButTime(dest, record, files, licence);
      if (old) return { record: old, dir: dest, state: "unchanged" };
      if (licence && (folderProblem(dest, recordText, files) === undefined || recordedLater(dest, record, files, licence))) replace = true;
      else throw new SkillImportError("conflict", `${dest} already holds a different import of this commit (${diff}). Remove that folder, then import again.`);
    }
    const tmp = join(sourceDir, ".tmp-" + randomBytes(8).toString("hex"));
    try {
      mkdirSync(tmp, { mode: 0o700 });
      writeFileSync(join(tmp, IMPORT_RECORD_FILE), recordText, { flag: "wx", mode: 0o600 });
      mkdirSync(join(tmp, "files"), { mode: 0o700 });
      writeTree(join(tmp, "files"), files);
      if (licence) {
        writeFileSync(join(tmp, LICENCE_RECORD_FILE), licence.recordText, { flag: "wx", mode: 0o600 });
        mkdirSync(join(tmp, LICENCE_DIR), { mode: 0o700 });
        writeTree(join(tmp, LICENCE_DIR), licence.files);
      }
      if (folderProblem(tmp, recordText, files, licence) !== undefined) throw new SkillImportError("cannot-write", "the file system changed what was written");
      if (importStoreSettings.realpath(tmp) !== tmp) throw new SkillImportError("cannot-write", "the import folder is no longer inside the quarantine");
      if (!replace) importStoreSettings.rename(tmp, dest);
      else replaceFolder(sourceDir, tmp, dest, record.commit, () => folderProblem(dest, recordText, files, licence) === undefined);
    } catch (e) {
      try {
        removeTree(tmp);
      } catch {
        // the next import removes it
      }
      throw e;
    }
    return { record, dir: dest, state: "staged" };
  };

  try {
    claimHomeWrite(
      lock,
      body,
      importStoreSettings.waitMs,
      (kind, detail) =>
        kind === "busy"
          ? new SkillImportError("locked", `${detail} is held by another scf process; try again in a moment`)
          : new SkillImportError("cannot-write", `the data folder moved to ${detail}; restart scf`),
    );
  } catch (e) {
    throw boundary(e);
  }
  return result!;
}

// --- read only below this line ---

export type StagedImportRead =
  | { state: "none" }
  | { state: "invalid"; problem: string }
  | { state: "ok"; dir: string; record: ImportRecord; recordText: string; files: Map<string, Uint8Array>; licence?: LicenceEvidence };

export type StagedLicenceRead = { state: "none"; message: string } | { state: "invalid"; problem: string } | { state: "ok"; evidence: LicenceEvidence };

class Invalid extends Error {}
const refuse = (what: string): never => {
  throw new Invalid(what);
};

interface WalkLimits {
  maxFiles: number;
  maxFolders: number;
  fileBytes: number;
  totalBytes: number;
}
/** Every file below `start`, as [path relative to start, bytes]. `prefix` is only shown in messages. Follows no link. */
function walkTree(start: string, prefix: string, lim: WalkLimits): [string, Uint8Array][] {
  let fileCount = 0;
  let folderCount = 0;
  let total = 0;
  const found: [string, Uint8Array][] = [];
  const walk = (path: string, rel: string): void => {
    for (const name of readdirSync(path).sort(byteCmp)) {
      const p = join(path, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const shown = shownValue(prefix + r);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) refuse(`${shown} is a link`);
      if (st.isDirectory()) {
        if (++folderCount > lim.maxFolders) refuse("the folder holds more folders than the import can have");
        walk(p, r);
      } else if (st.isFile()) {
        if (++fileCount > lim.maxFiles) refuse(prefix === "" ? "the folder holds more files than import.json lists" : "the folder holds more files than licence.json lists");
        if (Buffer.byteLength(r) > SKILL_LIMITS.pathChars) refuse(`${shown} has a path that is too long`);
        if (st.size > lim.fileBytes) refuse(`${shown} is too large`);
        total += st.size;
        if (total > lim.totalBytes) refuse("the folder holds more bytes than an import can have");
        const got = readPlain(p, st.size);
        if (got === "link") refuse(`${shown} is a link`);
        if (got === "other") refuse(`${shown} changed while it was read`);
        found.push([r, got as Buffer]);
      } else refuse(`${shown} is not a regular file`);
    }
  };
  walk(start, "");
  return found;
}

/** The evidence of an import, proven against licence.json; undefined for an import staged without it. Refuses through `refuse`. */
function readLicence(dir: string, record: ImportRecord): { recordText: string; files: Map<string, Uint8Array>; evidence: LicenceEvidence; record: LicenceRecord } | undefined {
  const recordPath = join(dir, LICENCE_RECORD_FILE);
  let st;
  try {
    st = lstatSync(recordPath);
  } catch (e) {
    if (enoent(e)) return undefined;
    throw e;
  }
  if (st.isSymbolicLink()) refuse(`${LICENCE_RECORD_FILE} is a link`);
  if (!st.isFile()) refuse(`${LICENCE_RECORD_FILE} is not a regular file`);
  if (st.size > LICENCE_RECORD_BYTES) refuse(`${LICENCE_RECORD_FILE} is too large`);
  const raw = readPlain(recordPath, st.size);
  if (raw === "link") refuse(`${LICENCE_RECORD_FILE} is a link`);
  if (raw === "other") refuse(`${LICENCE_RECORD_FILE} changed while it was read`);
  const recordText = (raw as Buffer).toString("utf8");
  const parsed = parseLicenceRecord(recordText);
  if ("problem" in parsed) return refuse(parsed.problem);
  const lrec = parsed.record;
  if (lrec.repositoryKey !== record.repositoryKey || lrec.commit !== record.commit) refuse("licence.json is for another repository or commit");
  const lpath = join(dir, LICENCE_DIR);
  const lst = lstatSync(lpath);
  if (lst.isSymbolicLink()) refuse("licence is a link");
  if (!lst.isDirectory()) refuse("licence is not a folder");
  const stored = new Map(lrec.files.filter((f) => f.problem === undefined).map((f) => [f.path, f]));
  const maxFolders = [...stored.keys()].reduce((n, p) => n + p.split("/").length - 1, 0);
  const found = walkTree(lpath, LICENCE_DIR + "/", { maxFiles: stored.size, maxFolders, fileBytes: LICENCE_LIMITS.fileBytes, totalBytes: LICENCE_LIMITS.totalBytes });
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of found) {
    const want = stored.get(path);
    if (!want) refuse(`${shownValue(LICENCE_DIR + "/" + path)} is not part of the import`);
    if (want!.bytes !== bytes.byteLength || want!.sha256 !== createHash("sha256").update(bytes).digest("hex")) refuse(`${shownValue(LICENCE_DIR + "/" + path)} changed`);
    files.set(path, bytes);
  }
  for (const path of stored.keys()) if (!files.has(path)) refuse(`${shownValue(LICENCE_DIR + "/" + path)} is missing`);
  return { recordText, files, evidence: evidenceFromRecord(lrec, files), record: lrec };
}
const within = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");
const segments = (root: string) => (root === "." ? 0 : root.split("/").length);

/**
 * Reads a staged import and proves it matches import.json: the folder is walked and compared both ways.
 * Follows no link, checks modes, takes no lock, writes nothing. Never throws for folder content.
 * A published import is one rename, so a reader sees a whole import or none.
 */
export function readStagedImport(source: string, commit: string, opts: { home?: string } = {}): StagedImportRead {
  if (!SKILL_ID_RE.test(source)) return { state: "invalid", problem: "the source id is not valid" };
  if (approvedRefProblem(commit)) return { state: "invalid", problem: "the commit is not a full commit id" };
  try {
    let home: string;
    try {
      home = realpathSync(opts.home ?? dataHome());
    } catch (e) {
      if (enoent(e)) return { state: "none" };
      throw e;
    }
    // each folder on the way: missing means none, a link or a file means invalid
    const dir = join(home, QUARANTINE_DIR, source, commit);
    for (const p of [join(home, QUARANTINE_DIR), join(home, QUARANTINE_DIR, source), dir]) {
      let st;
      try {
        st = lstatSync(p);
      } catch (e) {
        if (enoent(e)) return { state: "none" };
        throw e;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return { state: "invalid", problem: `${shownValue(p.slice(home.length + 1))} is not a plain folder` };
      if ((st.mode & 0o777) !== 0o700) return { state: "invalid", problem: `${shownValue(p.slice(home.length + 1))} has the wrong mode` };
    }

    const recordPath = join(dir, IMPORT_RECORD_FILE);
    let rst;
    try {
      rst = lstatSync(recordPath);
    } catch (e) {
      if (enoent(e)) return { state: "invalid", problem: `${IMPORT_RECORD_FILE} is missing` };
      throw e;
    }
    if (rst.isSymbolicLink()) return { state: "invalid", problem: `${IMPORT_RECORD_FILE} is a link` };
    if (!rst.isFile()) return { state: "invalid", problem: `${IMPORT_RECORD_FILE} is not a regular file` };
    if (rst.size > IMPORT_LIMITS.recordBytes) return { state: "invalid", problem: `${IMPORT_RECORD_FILE} is too large` };
    const raw = readPlain(recordPath, rst.size);
    if (raw === "link") return { state: "invalid", problem: `${IMPORT_RECORD_FILE} is a link` };
    if (raw === "other") return { state: "invalid", problem: `${IMPORT_RECORD_FILE} changed while it was read` };
    const recordText = raw.toString("utf8");
    const parsed = parseImportRecord(recordText);
    if ("problem" in parsed) return { state: "invalid", problem: parsed.problem };
    const record = parsed.record;
    if (record.source !== source || record.commit !== commit) return { state: "invalid", problem: `${IMPORT_RECORD_FILE} is for another source or commit` };

    // The most files and folders the record allows. Files are what the importer counts; a folder is made only as the
    // parent of a staged file, so it is a skill root, above one, or inside one on the way to a file.
    const maxFiles = record.skills.reduce((n, s) => n + s.files, 0);
    const maxFolders = record.skills.reduce((n, s) => n + segments(s.root) + (SKILL_LIMITS.pathSegments - 1) * s.files, 0);
    const fst = lstatSync(join(dir, "files"));
    if (fst.isSymbolicLink()) refuse("files is a link");
    if (!fst.isDirectory()) refuse("files is not a folder");
    const found = walkTree(join(dir, "files"), "", { maxFiles, maxFolders, fileBytes: SKILL_LIMITS.fileBytes, totalBytes: IMPORT_LIMITS.totalBytes });

    // every file lies in exactly one skill, and each skill matches its line of the record
    const perSkill = new Map<string, { path: string; content: Uint8Array }[]>(record.skills.map((s) => [s.root, []]));
    for (const [path, content] of found) {
      const roots = record.skills.filter((s) => within(s.root, path));
      if (roots.length !== 1) refuse(`${shownValue(path)} is not part of the import`);
      const root = roots[0]!.root;
      perSkill.get(root)!.push({ path: root === "." ? path : path.slice(root.length + 1), content });
    }
    for (const s of record.skills) {
      const mine = perSkill.get(s.root)!;
      if (mine.length !== s.files || mine.reduce((n, f) => n + f.content.byteLength, 0) !== s.bytes || skillDigest(mine) !== s.digest) refuse(`${shownValue(s.root)} changed`);
    }
    if (importDigest(record.skills) !== record.digest) refuse("the digest of import.json does not match its skills");

    const files = new Map(found.sort((a, b) => byteCmp(a[0], b[0])));
    const lic = readLicence(dir, record);
    // import.json lists the licence files of licence.json (both ways); an import without the list reads as before
    if (record.licenceFiles !== undefined) {
      if (!lic) refuse(`${LICENCE_RECORD_FILE} is missing`);
      if (JSON.stringify(record.licenceFiles) !== JSON.stringify(importLicenceFiles(lic!.record))) refuse(`${IMPORT_RECORD_FILE} lists other licence files than ${LICENCE_RECORD_FILE}`);
    }
    const problem = folderProblem(dir, recordText, files, lic);
    if (problem !== undefined) return { state: "invalid", problem };
    return lic ? { state: "ok", dir, record, recordText, files, licence: lic.evidence } : { state: "ok", dir, record, recordText, files };
  } catch (e) {
    if (e instanceof Invalid) return { state: "invalid", problem: e.message };
    const c = (e as NodeJS.ErrnoException | undefined)?.code;
    const code = typeof c === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(c) ? c : "error";
    return { state: "invalid", problem: `the staged import cannot be read (${code})` };
  }
}

/** The licence and notice files of a staged import, proven against licence.json. Same checks and same refusals as `readStagedImport`. */
export function readStagedLicence(source: string, commit: string, opts: { home?: string } = {}): StagedLicenceRead {
  const read = readStagedImport(source, commit, opts);
  if (read.state === "invalid") return read;
  if (read.state === "none") return { state: "none", message: `no staged import of ${source} at ${commit.slice(0, 12)}; run "scf skills import ${source}" first` };
  if (read.licence === undefined) return { state: "none", message: `this import was staged without its licence and notice files; run "scf skills import ${source}" again` };
  return { state: "ok", evidence: read.licence };
}
