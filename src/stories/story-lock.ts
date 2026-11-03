import { randomBytes } from "node:crypto";
import { closeSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const LOCK_FILE = ".lock";
export const GUARD_FILE = ".lock.takeover";
/** A lock or guard without a readable holder is stale when it is older than this. */
const OLD_MS = 5000;

export interface StoryLockOptions {
  waitMs: number;
  pollMs: number;
  alive: (pid: number) => boolean;
  /** Test hook: runs between the first read of a stale lock and its takeover. */
  onStale?: (content: string) => void | Promise<void>;
}

/** Is this process there? EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";
const isExists = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "EEXIST";

/** The mtime age of a plain file in ms; undefined when it is gone. A link or other kind rejects. */
function ageOf(file: string, what: string): number | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw new Error(`${what} is a link or not a plain file`);
    return Date.now() - st.mtimeMs;
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

/** The text of a plain file (a link is never followed); undefined when there is none. */
function readContent(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    return st.isFile() ? readFileSync(file, "utf8") : undefined;
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

/** Creates the file exclusively; false when it exists. */
function createExclusive(file: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (e) {
    if (isExists(e)) return false;
    throw e;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Removes `file` only if `same` accepts its content. The file is first moved to a name of its own with one rename, so the
 * check and the removal are the same step: a file that another writer put in its place in the meantime is put back.
 * Returns true when the file was removed.
 */
function claim(file: string, tag: string, same: (content: string) => boolean): boolean {
  const tomb = `${file}.${tag}.claimed`;
  try {
    renameSync(file, tomb);
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
  const st = lstatSync(tomb);
  if (st.isFile() && same(readFileSync(tomb, "utf8"))) {
    rmSync(tomb, { force: true });
    return true;
  }
  // Put it back. A link (or symlink) fails when a newer file is there already; that file is kept.
  try {
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(tomb), file);
    else linkSync(tomb, file);
  } catch (e) {
    if (!isExists(e)) throw e;
  }
  rmSync(tomb, { force: true });
  return false;
}

const pidOf = (content: string): number | undefined => {
  const m = /^(\d+) \S+/.exec(content);
  return m ? Number(m[1]) : undefined;
};

/**
 * Runs `fn` while this process holds `<folder>/.lock` (created with `wx`, holding `<pid> <token>`). Only one writer at a time.
 * A stale lock (dead PID) is removed only by the holder of the exclusive guard `.lock.takeover`, and only if it still has
 * the content seen as stale. A stale guard (older than 5 s) is removed the same way. Every removal goes through `claim`, so a
 * live lock or guard that replaced the stale one is never removed. `fn` runs synchronously; `held()` checks the token.
 */
export async function withStoryLock<T>(folder: string, o: StoryLockOptions, fn: (held: () => boolean) => T): Promise<T> {
  const lock = join(folder, LOCK_FILE);
  const guard = join(folder, GUARD_FILE);
  const token = randomBytes(8).toString("hex");
  const mine = `${process.pid} ${token}\n`;
  const end = Date.now() + Math.max(0, o.waitMs);
  const held = (): boolean => readContent(lock) === mine;

  const busy = (content: string | undefined): Error =>
    new Error(`the stories are locked by process ${content === undefined ? "?" : (pidOf(content) ?? "?")}; try again, or delete .scf/stories/.lock if no Foundry is running`);

  const takeOver = async (seen: string): Promise<boolean> => {
    await o.onStale?.(seen);
    if (!createExclusive(guard, mine)) {
      // Another writer holds the guard. A guard left by a crash is removed (only the content seen as old), then the caller retries.
      const held = readContent(guard);
      const age = ageOf(guard, ".lock.takeover");
      if (held !== undefined && age !== undefined && age > OLD_MS) claim(guard, token, (c) => c === held);
      return false;
    }
    try {
      claim(lock, token, (c) => c === seen);
      // Only a free name is taken: a live lock that is still there makes this fail.
      return createExclusive(lock, mine);
    } finally {
      claim(guard, token, (c) => c === mine);
    }
  };

  for (;;) {
    ageOf(lock, ".lock");
    if (createExclusive(lock, mine)) break;
    const seen = readContent(lock);
    if (seen !== undefined) {
      const pid = pidOf(seen);
      const age = ageOf(lock, ".lock");
      const stale = pid !== undefined ? !o.alive(pid) : age !== undefined && age > OLD_MS;
      if (stale && (await takeOver(seen))) break;
      if (Date.now() >= end) throw busy(seen);
    } else if (Date.now() >= end) {
      throw busy(seen);
    }
    await sleep(Math.max(1, Math.min(o.pollMs, end - Date.now())));
  }
  try {
    return fn(held);
  } finally {
    claim(lock, token, (c) => c === mine);
  }
}
