import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { isSafeRelativePath } from "../evidence/identity.js";

/**
 * One repository at one commit, as the context selector sees it: the list of what the commit holds, and the bytes of
 * a file of that commit. Nothing else of the repository can be reached through it.
 *
 * `openRepositoryAt` reads through git only (`ls-tree` and `cat-file` of the given commit), never through the
 * working tree. So a file that was changed, added or left behind in the folder and is not part of the commit cannot
 * get into a bundle, a link is seen as a link and is never followed, and no path outside the repository can be named.
 */

export type RepositoryEntryKind = "file" | "symlink" | "submodule" | "other";

export interface RepositoryEntry {
  /** Relative to the repository root, with `/` between parts. Always a safe relative path. */
  path: string;
  kind: RepositoryEntryKind;
  /** The size in bytes of a file or of the text of a link; 0 for anything else. Known before the file is read. */
  bytes: number;
}

export interface RepositorySnapshot {
  /** The full commit id everything is read at. */
  readonly commit: string;
  /** Everything the commit holds, each path once. */
  readonly entries: readonly RepositoryEntry[];
  /** How many paths of the commit are not in `entries` because they cannot be named safely (see `isSafeRelativePath`). */
  readonly unlisted: number;
  /** The bytes of a file in `entries`. Throws for a path that is not a file of the commit. */
  read(path: string): Uint8Array;
}

export type ContextRepositoryErrorCode = "no-git" | "not-a-repository" | "no-commit" | "too-large" | "timeout" | "bad-listing" | "read-failed";

/** Reading the repository failed. The message is a fixed code: never git's text, a path or a value. */
export class ContextRepositoryError extends Error {
  constructor(readonly code: ContextRepositoryErrorCode) {
    super(`context repository: ${code}`);
    this.name = "ContextRepositoryError";
  }
}

export const REPOSITORY_LIMITS = { timeoutMs: 30_000, listBytes: 67_108_864, entries: 500_000 } as const;
export interface OpenRepositoryOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The most bytes the list of the commit may have. */
  listBytes?: number;
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Settings git is always given: no hooks, no file-system monitor program, no pager. */
const OPTIONS = ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * The environment git runs in: none of the caller's `GIT_*` variables, no user or system configuration, no prompt,
 * no replaced objects, no fetching of missing objects (so no network), and no looking for a repository above `top`.
 */
function gitEnv(base: NodeJS.ProcessEnv, top: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: dirname(top),
    LC_ALL: "C",
  };
}

function failure(r: SpawnSyncReturns<Buffer>, own: ContextRepositoryErrorCode): ContextRepositoryError | undefined {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return new ContextRepositoryError("timeout");
  if (code === "ENOENT") return new ContextRepositoryError("no-git");
  if (code === "ENOBUFS") return new ContextRepositoryError("too-large");
  if (r.error || r.status !== 0) return new ContextRepositoryError(own);
  return undefined;
}

const HEADER = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Listed extends RepositoryEntry {
  id: string;
}

/** One record of `git ls-tree -r -l -z`; undefined for a path that cannot be named safely. Throws for a record that is not one. */
function parseRecord(rec: Buffer): Listed | undefined {
  const tab = rec.indexOf(0x09);
  const m = tab < 0 ? null : rec.subarray(0, tab).toString("latin1").match(HEADER);
  if (!m) throw new ContextRepositoryError("bad-listing");
  const [, mode, type, id, size] = m as unknown as [string, string, string, string, string];
  let path: string;
  try {
    path = utf8.decode(rec.subarray(tab + 1));
  } catch {
    return undefined;
  }
  if (!isSafeRelativePath(path)) return undefined;
  const bytes = size === "-" ? 0 : Number(size);
  if (!Number.isSafeInteger(bytes)) throw new ContextRepositoryError("bad-listing");
  if (type === "blob" && (mode === "100644" || mode === "100755")) return { path, kind: "file", bytes, id };
  if (type === "blob" && mode === "120000") return { path, kind: "symlink", bytes, id };
  if (type === "commit" && mode === "160000") return { path, kind: "submodule", bytes: 0, id };
  return { path, kind: "other", bytes: 0, id };
}

/**
 * Opens the repository in folder `dir` at `commit` (a full commit id, never a branch or a tag). `dir` must itself be
 * the repository (its root, or a bare repository): a repository in a folder above it is not used.
 * Throws ContextRepositoryError.
 */
export function openRepositoryAt(dir: string, commit: string, opts: OpenRepositoryOptions = {}): RepositorySnapshot {
  if (!COMMIT.test(commit)) throw new ContextRepositoryError("no-commit");
  let top: string;
  try {
    top = realpathSync(dir);
  } catch {
    throw new ContextRepositoryError("not-a-repository");
  }
  const env = gitEnv(opts.env ?? process.env, top);
  const timeout = opts.timeoutMs ?? REPOSITORY_LIMITS.timeoutMs;
  const git = (maxBuffer: number, ...args: string[]) => spawnSync("git", [...OPTIONS, ...args], { cwd: top, env, timeout, maxBuffer, stdio: ["ignore", "pipe", "ignore"] });

  // The folder must be the repository itself: its root (the prefix inside the work tree is empty) or a bare one.
  const where = git(4096, "rev-parse", "--is-bare-repository", "--show-prefix");
  let err = failure(where, "not-a-repository");
  if (err) throw err;
  const [bare, prefix = ""] = where.stdout.toString("utf8").split("\n");
  if (bare !== "true" && prefix !== "") throw new ContextRepositoryError("not-a-repository");

  // With "^{commit}" git must open the object: it fails for an id that is not there or is not a commit.
  const named = git(4096, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
  err = failure(named, "no-commit");
  if (err || named.stdout.toString("latin1").trim() !== commit) throw err ?? new ContextRepositoryError("no-commit");

  const list = git(opts.listBytes ?? REPOSITORY_LIMITS.listBytes, "ls-tree", "-r", "-l", "-z", "--full-tree", commit);
  err = failure(list, "bad-listing");
  if (err) throw err;
  const byPath = new Map<string, Listed>();
  let unlisted = 0;
  let from = 0;
  const out = list.stdout;
  while (from < out.length) {
    const end = out.indexOf(0x00, from);
    if (end < 0) throw new ContextRepositoryError("bad-listing");
    const entry = parseRecord(out.subarray(from, end));
    if (!entry) unlisted++;
    else if (byPath.has(entry.path)) throw new ContextRepositoryError("bad-listing");
    else byPath.set(entry.path, entry);
    if (byPath.size + unlisted > REPOSITORY_LIMITS.entries) throw new ContextRepositoryError("too-large");
    from = end + 1;
  }

  const entries: RepositoryEntry[] = [...byPath.values()].map(({ path, kind, bytes }) => ({ path, kind, bytes }));
  return {
    commit,
    entries,
    unlisted,
    read(path) {
      const entry = byPath.get(path);
      if (!entry || entry.kind !== "file") throw new ContextRepositoryError("read-failed");
      // By object id, never by path: the id comes from the list of this commit, so this is the file of this commit.
      const blob = git(entry.bytes + 1, "cat-file", "blob", entry.id);
      const bad = failure(blob, "read-failed");
      if (bad) throw bad;
      if (blob.stdout.length !== entry.bytes) throw new ContextRepositoryError("read-failed");
      return blob.stdout;
    },
  };
}
