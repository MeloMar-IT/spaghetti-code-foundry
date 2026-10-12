import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import { acquireLock, releaseLock, removeTree } from "../home-migrate.js";
import { byteCmp, prepareImport, SkillImportError, type ImportRecord, type SourceTree } from "./import-plan.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";

// Stages checked skill folders into <data folder>/skill-quarantine/<source id>/<commit>/ (import.json and files/).
// Nothing in the quarantine is run or loaded; the registry never scans it. One lock: <data folder>/skill-quarantine.lock.

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
function expectedTree(recordText: string, files: Map<string, Uint8Array>): Node {
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
  return root;
}

const enoent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** The first difference between a folder and the import it should hold, or undefined. Read errors are thrown. */
function folderProblem(dir: string, recordText: string, files: Map<string, Uint8Array>): string | undefined {
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
  return check(dir, "", expectedTree(recordText, files));
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

/**
 * Checks and stages the skills of an approved revision. Reads the tree first (no lock held), then writes under
 * skill-quarantine.lock: temp folder, verify, containment check, one rename. The same import again is "unchanged".
 */
export function stageImport(
  source: SkillLibrarySource,
  tree: SourceTree,
  opts: { home?: string; limits?: { recordBytes?: number } } = {},
): { record: ImportRecord; dir: string; state: "staged" | "unchanged" } {
  const prep = prepareImport(source, tree, { limits: opts.limits });
  const { record, recordText, files } = prep;
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
    const sourceDir = join(q, source.id);
    privateDir(q, QUARANTINE_DIR);
    privateDir(sourceDir, `${QUARANTINE_DIR}/${source.id}`);
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
      const diff = folderProblem(dest, recordText, files);
      if (diff === undefined) return { record, dir: dest, state: "unchanged" };
      throw new SkillImportError("conflict", `${dest} already holds a different import of this commit (${diff}). Remove that folder, then import again.`);
    }
    const tmp = join(sourceDir, ".tmp-" + randomBytes(8).toString("hex"));
    try {
      mkdirSync(tmp, { mode: 0o700 });
      writeFileSync(join(tmp, IMPORT_RECORD_FILE), recordText, { flag: "wx", mode: 0o600 });
      mkdirSync(join(tmp, "files"), { mode: 0o700 });
      const made = new Set<string>([join(tmp, "files")]);
      for (const [path, bytes] of files) {
        const file = join(tmp, "files", path);
        const missing: string[] = [];
        for (let p = dirname(file); !made.has(p); p = dirname(p)) missing.push(p);
        for (const p of missing.reverse()) {
          mkdirSync(p, { mode: 0o700 });
          made.add(p);
        }
        writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      }
      if (folderProblem(tmp, recordText, files) !== undefined) throw new SkillImportError("cannot-write", "the file system changed what was written");
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
