import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import { acquireLock, releaseLock, removeTree } from "../home-migrate.js";
import { byteCmp, IMPORT_LIMITS, importDigest, parseImportRecord, prepareImport, SkillImportError, type ImportRecord, type SourceTree } from "./import-plan.js";
import { LicenceStoreProblem, prepareLicences, readPlain, readStagedLicences } from "./import-licences.js";
import { collectLicenceEvidence, type LicenceEvidence } from "./licence.js";
import { skillDigest } from "./package.js";
import { SKILL_ID_RE, SKILL_LIMITS } from "./schema.js";
import { approvedRefProblem, shownValue, type SkillLibrarySource } from "./sources.js";

// Stages checked skill folders into <data folder>/skill-quarantine/<source id>/<commit>/ (import.json, files/, and licences.json with licences/ for the licence evidence).
// Nothing in the quarantine is run or loaded; the registry never scans it. `scf skills scan` reads it (readStagedImport). One lock: <data folder>/skill-quarantine.lock.

export const QUARANTINE_DIR = "skill-quarantine";
export const IMPORT_RECORD_FILE = "import.json";
const LOCK_NAME = "skill-quarantine.lock";
const TMP_RE = /^\.tmp-[0-9a-f]{16}$/;

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

interface Node {
  children: Map<string, Node>;
  bytes?: Uint8Array;
}
function expectedTree(recordText: string, files: Map<string, Uint8Array>, extra?: Map<string, Uint8Array>): Node {
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
  if (extra) for (const [p, b] of extra) add(p, b);
  return root;
}

const enoent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** The first difference between a folder and the import it should hold, or undefined. Read errors are thrown. */
function folderProblem(dir: string, recordText: string, files: Map<string, Uint8Array>, extra?: Map<string, Uint8Array>): string | undefined {
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
  return check(dir, "", expectedTree(recordText, files, extra));
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

/** Checks and stages the skills of an approved revision: `prepareImport` (reads, no lock), then `publishImport`. */
export function stageImport(
  source: SkillLibrarySource,
  tree: SourceTree,
  opts: { home?: string; limits?: { recordBytes?: number } } = {},
): { record: ImportRecord; dir: string; state: "staged" | "unchanged" } {
  const prep = prepareImport(source, tree, { limits: opts.limits });
  const licences = collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), tree);
  return publishImport({ ...prep, licences }, { home: opts.home });
}

/**
 * Writes a prepared import under skill-quarantine.lock: temp folder, verify, containment check, one rename.
 * With `licences`, licences.json and licences/ are part of the same folder and the same rename.
 * The same import again is "unchanged". A record whose source id or commit would make an unsafe path is refused.
 */
export function publishImport(
  prep: { record: ImportRecord; recordText: string; files: Map<string, Uint8Array>; licences?: LicenceEvidence },
  opts: { home?: string } = {},
): { record: ImportRecord; dir: string; state: "staged" | "unchanged" } {
  const { record, recordText, files } = prep;
  if (typeof record.source !== "string" || !SKILL_ID_RE.test(record.source) || approvedRefProblem(record.commit)) {
    throw new SkillImportError("not-usable", "the import record is not usable: bad source id or commit");
  }
  if (prep.licences !== undefined && (prep.licences.repositoryKey !== record.repositoryKey || prep.licences.commit !== record.commit)) {
    throw new SkillImportError("not-usable", "the licence evidence is for another repository or commit");
  }
  const extra = prep.licences === undefined ? undefined : prepareLicences(prep.licences).entries;
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
    try {
      st = lstatSync(dest);
    } catch (e) {
      if (!enoent(e)) throw e;
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw new SkillImportError("cannot-write", "the import folder is not a plain folder");
      const diff = folderProblem(dest, recordText, files, extra);
      if (diff === undefined) return { record, dir: dest, state: "unchanged" };
      if (extra !== undefined && folderProblem(dest, recordText, files) === undefined) {
        throw new SkillImportError("conflict", `${dest} was staged before licence evidence was kept. Remove that folder, then import again.`);
      }
      throw new SkillImportError("conflict", `${dest} already holds a different import of this commit (${diff}). Remove that folder, then import again.`);
    }
    const tmp = join(sourceDir, ".tmp-" + randomBytes(8).toString("hex"));
    try {
      mkdirSync(tmp, { mode: 0o700 });
      writeFileSync(join(tmp, IMPORT_RECORD_FILE), recordText, { flag: "wx", mode: 0o600 });
      const made = new Set<string>([tmp]);
      const all: [string, Uint8Array][] = [...[...files].map(([p, b]): [string, Uint8Array] => ["files/" + p, b]), ...(extra ?? [])];
      for (const [path, bytes] of all) {
        const file = join(tmp, path);
        const missing: string[] = [];
        for (let p = dirname(file); !made.has(p); p = dirname(p)) missing.push(p);
        for (const p of missing.reverse()) {
          mkdirSync(p, { mode: 0o700 });
          made.add(p);
        }
        writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      }
      if (folderProblem(tmp, recordText, files, extra) !== undefined) throw new SkillImportError("cannot-write", "the file system changed what was written");
      if (importStoreSettings.realpath(tmp) !== tmp) throw new SkillImportError("cannot-write", "the import folder is no longer inside the quarantine");
      importStoreSettings.rename(tmp, dest);
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
  | {
      state: "ok";
      dir: string;
      record: ImportRecord;
      recordText: string;
      files: Map<string, Uint8Array>;
      /** Absent for an import staged before licence evidence was kept. */
      licences?: LicenceEvidence;
    };

class Invalid extends Error {}
const refuse = (what: string): never => {
  throw new Invalid(what);
};
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
    let fileCount = 0;
    let folderCount = 0;
    let total = 0;
    const found: [string, Uint8Array][] = [];
    const walk = (path: string, rel: string): void => {
      for (const name of readdirSync(path).sort(byteCmp)) {
        const p = join(path, name);
        const r = rel === "" ? name : `${rel}/${name}`;
        const st = lstatSync(p);
        if (st.isSymbolicLink()) refuse(`${shownValue(r)} is a link`);
        if (st.isDirectory()) {
          if (++folderCount > maxFolders) refuse("the folder holds more folders than the import can have");
          walk(p, r);
        } else if (st.isFile()) {
          if (++fileCount > maxFiles) refuse("the folder holds more files than import.json lists");
          if (Buffer.byteLength(r) > SKILL_LIMITS.pathChars) refuse(`${shownValue(r)} has a path that is too long`);
          if (st.size > SKILL_LIMITS.fileBytes) refuse(`${shownValue(r)} is too large`);
          total += st.size;
          if (total > IMPORT_LIMITS.totalBytes) refuse("the folder holds more bytes than an import can have");
          const got = readPlain(p, st.size);
          if (got === "link") refuse(`${shownValue(r)} is a link`);
          if (got === "other") refuse(`${shownValue(r)} changed while it was read`);
          found.push([r, got as Buffer]);
        } else refuse(`${shownValue(r)} is not a regular file`);
      }
    };
    const fst = lstatSync(join(dir, "files"));
    if (fst.isSymbolicLink()) refuse("files is a link");
    if (!fst.isDirectory()) refuse("files is not a folder");
    walk(join(dir, "files"), "");

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
    const lic = readStagedLicences(dir, { repositoryKey: record.repositoryKey, commit: record.commit });
    const problem = folderProblem(dir, recordText, files, lic.state === "ok" ? lic.entries : undefined);
    if (problem !== undefined) return { state: "invalid", problem };
    return { state: "ok", dir, record, recordText, files, ...(lic.state === "ok" ? { licences: lic.evidence } : {}) };
  } catch (e) {
    if (e instanceof Invalid || e instanceof LicenceStoreProblem) return { state: "invalid", problem: e.message };
    const c = (e as NodeJS.ErrnoException | undefined)?.code;
    const code = typeof c === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(c) ? c : "error";
    return { state: "invalid", problem: `the staged import cannot be read (${code})` };
  }
}
