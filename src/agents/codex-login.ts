import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { dataHome } from "../auth/store.js";
import { ownDir } from "../engine/os-sandbox.js";

/**
 * The Codex login of the person, lent to one Codex session at a time. The Foundry only borrows the file: the copy lives in
 * <runDir>/home/.codex/auth.json, and the record of the loan lives in the server's own folder (a boxed step can write
 * anywhere in the run folder, so a file there is never trusted). After the session the copy is returned: a token that
 * Codex refreshed is written back if the personal file is still what was lent, and the copy is removed.
 */

export const CODEX_LOGIN_FILE = "auth.json";
const HOME_REFUSED = "Codex isolation: ";
export const CODEX_NO_LOGIN = HOME_REFUSED + "no Codex login file can go into the clean Codex folder: sign in with `codex login` (a login kept in a file, not the keychain), set CODEX_API_KEY for the server, or use a local model";
export const CODEX_LOGIN_NOT_RETURNED = "the copy of the Codex login in this run could not be returned; the run does not go on until it is";
const COPY_FAILED = HOME_REFUSED + "the Codex login could not be copied into the clean Codex folder";
const MAX_LOGIN_BYTES = 65_536;

export type CodexLoginReturn = "none" | "removed" | "written-back" | "kept-personal" | "write-back-failed" | "not-removed";

interface LoanRecord {
  version: 1;
  runDir: string;
  source: string;
  sha256: string;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const loginsDir = () => join(dataHome(), "codex-logins");

/** Where the loan of this run is recorded: the server's folder, never the run folder. */
export function codexLoginRecord(runDir: string): string {
  return join(loginsDir(), basename(runDir) + ".json");
}

const copyPath = (runDir: string) => join(runDir, "home", ".codex", CODEX_LOGIN_FILE);
const copyTmpPath = (runDir: string) => join(runDir, "home", ".codex", "." + CODEX_LOGIN_FILE + ".tmp");
const personalTmp = (source: string, runDir: string) => join(dirname(source), `${CODEX_LOGIN_FILE}.scf-${basename(runDir)}.tmp`);
const lockPath = () => join(loginsDir(), "write-back.lock");

/** The bytes of a regular file of at most `max` bytes, opened without following a link; undefined for anything else. */
function readRegular(path: string, max: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes through a tmp file made new (0600) and renames it over `path`; the tmp file never stays. */
function writeAtomic(path: string, tmp: string, data: Buffer, beforeRename?: () => void): void {
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
    beforeRename?.();
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readRecord(runDir: string): LoanRecord | undefined {
  try {
    const raw = readRegular(codexLoginRecord(runDir), 4096);
    if (!raw) return undefined;
    const r = JSON.parse(raw.toString("utf8")) as Partial<LoanRecord>;
    if (r.version !== 1 || r.runDir !== runDir) return undefined;
    if (typeof r.source !== "string" || !isAbsolute(r.source) || basename(r.source) !== CODEX_LOGIN_FILE) return undefined;
    if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return undefined;
    return { version: 1, runDir, source: r.source, sha256: r.sha256 };
  } catch {
    return undefined;
  }
}

/** Are the run folder, its `home` and `home/.codex` real folders, none of them a link? A step may have replaced one with a link to the person's Codex folder; nothing is read or removed through such a path. */
function anchoredCodexDir(runDir: string): boolean {
  try {
    return [runDir, join(runDir, "home"), join(runDir, "home", ".codex")].every((p) => {
      const st = lstatSync(p, { throwIfNoEntry: false });
      return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
    });
  } catch {
    return false;
  }
}

const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** Removes the copy of the login; true when nothing is left at its path. */
function removeCopy(runDir: string): boolean {
  try {
    rmSync(copyPath(runDir), { force: true, recursive: true });
    return !exists(copyPath(runDir));
  } catch {
    return false;
  }
}

/** Is a process with this pid alive? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the write-back lock (a file made with `wx` that holds the pid; one whose pid is gone is taken over). */
function takeLock(): boolean {
  const path = lockPath();
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const pid = Number.parseInt(readRegular(path, 64)?.toString("utf8") ?? "", 10);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

/**
 * Copies the personal login file into the run's clean Codex folder (0600) and records the loan. A refusal means no login
 * can be lent; the session must not start (it never falls back to the personal folder). `personalCodexHome` is the folder
 * of the person's Codex.
 */
export function lendCodexLogin(runDir: string, personalCodexHome: string): { lent: true } | { refused: string } {
  const source = join(personalCodexHome, CODEX_LOGIN_FILE);
  const data = readRegular(source, MAX_LOGIN_BYTES);
  if (!data || data.length === 0) return { refused: CODEX_NO_LOGIN };
  const copy = copyPath(runDir);
  if (!anchoredCodexDir(runDir)) return { refused: COPY_FAILED };
  try {
    // an earlier write-back failed: the refreshed copy is kept, not overwritten by the personal file
    const rec = readRecord(runDir);
    const held = rec ? readRegular(copy, MAX_LOGIN_BYTES) : undefined;
    if (rec && held) {
      if (sha(held) !== rec.sha256) return { lent: true };
      if (sha(data) === rec.sha256 && rec.source === source) return { lent: true };
    }
    mkdirSync(dataHome(), { recursive: true });
    ownDir(loginsDir());
    const record: LoanRecord = { version: 1, runDir, source, sha256: sha(data) };
    writeAtomic(copy, copyTmpPath(runDir), data);
    try {
      writeAtomic(codexLoginRecord(runDir), codexLoginRecord(runDir) + ".tmp", Buffer.from(JSON.stringify(record)));
    } catch (e) {
      removeCopy(runDir);
      throw e;
    }
    return { lent: true };
  } catch {
    removeCopy(runDir);
    rmSync(codexLoginRecord(runDir), { force: true });
    return { refused: COPY_FAILED };
  }
}

function isJsonObject(b: Buffer): boolean {
  try {
    const v: unknown = JSON.parse(b.toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** Writes the refreshed copy over the personal file if that is still what was lent. */
function writeBack(runDir: string, rec: LoanRecord, fresh: Buffer, hooks: { beforeRename?: () => void }): "written-back" | "kept-personal" | "write-back-failed" {
  try {
    mkdirSync(dataHome(), { recursive: true });
    ownDir(loginsDir());
  } catch {
    return "write-back-failed";
  }
  if (!takeLock()) return "write-back-failed";
  const tmp = personalTmp(rec.source, runDir);
  try {
    const unchanged = () => {
      const now = readRegular(rec.source, MAX_LOGIN_BYTES);
      return now !== undefined && sha(now) === rec.sha256;
    };
    if (!unchanged()) return "kept-personal";
    writeAtomic(rec.source, tmp, fresh, () => {
      hooks.beforeRename?.();
      if (!unchanged()) throw new Error("changed");
    });
    return "written-back";
  } catch (e) {
    rmSync(tmp, { force: true });
    return (e as Error).message === "changed" ? "kept-personal" : "write-back-failed";
  } finally {
    rmSync(lockPath(), { force: true });
  }
}

/**
 * Returns the copy of the login after a session: a refreshed copy is written back (see `writeBack`), then the copy and the
 * record are removed. A failed write-back keeps both, so the refreshed login is not lost, and is tried again later.
 * Never throws.
 */
export function returnCodexLogin(runDir: string, hooks: { beforeRename?: () => void } = {}): CodexLoginReturn {
  try {
    const rec = readRecord(runDir);
    if (!anchoredCodexDir(runDir)) {
      // the copy cannot be reached without following a link: it is not there. Nothing is removed through the link; only the server's record goes.
      if (rec) {
        const t = personalTmp(rec.source, runDir);
        if (lstatSync(t, { throwIfNoEntry: false })?.isFile()) rmSync(t, { force: true });
      }
      rmSync(codexLoginRecord(runDir), { force: true });
      return "none";
    }
    try {
      rmSync(copyTmpPath(runDir), { force: true });
      if (rec) {
        const t = personalTmp(rec.source, runDir);
        if (lstatSync(t, { throwIfNoEntry: false })?.isFile()) rmSync(t, { force: true });
      }
    } catch {
      // the copy below decides the result
    }
    if (!rec) {
      // a copy with no valid record of ours was planted: it is not a login we lent
      rmSync(codexLoginRecord(runDir), { force: true });
      if (!exists(copyPath(runDir))) return "none";
      return removeCopy(runDir) ? "none" : "not-removed";
    }
    const copy = readRegular(copyPath(runDir), MAX_LOGIN_BYTES);
    let result: CodexLoginReturn = "removed";
    if (copy && sha(copy) !== rec.sha256 && isJsonObject(copy)) {
      const w = writeBack(runDir, rec, copy, hooks);
      if (w === "write-back-failed") return w;
      result = w;
    }
    if (!removeCopy(runDir)) return "not-removed";
    rmSync(codexLoginRecord(runDir), { force: true });
    return result;
  } catch {
    return "not-removed";
  }
}
