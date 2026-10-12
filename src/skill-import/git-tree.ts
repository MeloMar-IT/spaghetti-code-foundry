import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceTree, TreeEntry } from "../skills/import-plan.js";
import type { SkillLibrarySource } from "../skills/sources.js";

// Reads one approved commit of a remote repository without a checkout: a bare temporary repository, a depth-1 fetch of
// that commit, then `ls-tree` and `cat-file` only. Git runs with its own empty HOME and none of the caller's GIT_*
// variables, configuration or credentials. Errors carry a fixed code, never git's text.

export const GIT_COMMANDS = ["init", "fetch", "ls-tree", "cat-file"] as const;
export const GIT_TREE_LIMITS = { timeoutMs: 120_000, repoBytes: 268_435_456, listBytes: 8_388_608, pollMs: 200 } as const;
export type GitTreeErrorCode = "no-git" | "fetch-failed" | "no-commit" | "too-large" | "timeout" | "interrupted" | "bad-listing" | "read-failed";

export class GitTreeError extends Error {
  readonly code: GitTreeErrorCode;
  constructor(code: GitTreeErrorCode) {
    super(code);
    this.name = "GitTreeError";
    this.code = code;
  }
}

export interface GitTree extends SourceTree {
  /** Removes the temporary folder. Safe to call again. */
  close(): void;
}
export interface GitTreeOptions {
  /** Tests: a local path, fetched as file://. */
  remote?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  repoBytes?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPTIONS = ["-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "fetch.fsckObjects=true", "-c", "fetch.unpackLimit=1", "-c", "pack.threads=1", "-c", "core.hooksPath=/dev/null"];
const argv = (cmd: (typeof GIT_COMMANDS)[number], ...rest: string[]): string[] => [...OPTIONS, cmd, ...rest];
const DROPPED = new Set(["SSH_ASKPASS", "NETRC", "XDG_CONFIG_HOME"]);
const enoent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** The environment git gets: nothing of the caller's git setup, an empty HOME inside the temporary folder. */
export function gitEnv(base: NodeJS.ProcessEnv, tmp: string, local: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("GIT_") && !DROPPED.has(k) && v !== undefined) env[k] = v;
  return {
    ...env,
    HOME: join(tmp, "home"),
    GIT_DIR: join(tmp, "repo"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
    GIT_ALLOW_PROTOCOL: local ? "file" : "https",
  };
}

/** The first failure of a synchronous git call as an error, else nothing. A timeout and a missing git win. */
function failure(r: SpawnSyncReturns<Buffer>, own: GitTreeErrorCode): GitTreeError | undefined {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return new GitTreeError("timeout");
  if (code === "ENOENT") return new GitTreeError("no-git");
  if (r.error || r.status !== 0) return new GitTreeError(own);
  return undefined;
}

/** Sum of the sizes of everything below `dir`. A vanished entry counts as nothing; any other error is thrown. */
function treeBytes(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (enoent(e)) return 0;
    throw e;
  }
  let total = 0;
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if (enoent(e)) continue;
      throw e;
    }
    total += st.size;
    if (st.isDirectory()) total += treeBytes(p);
  }
  return total;
}

const HEADER = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseRecord(rec: Buffer): TreeEntry {
  const tab = rec.indexOf(0x09);
  if (tab < 0) throw new GitTreeError("bad-listing");
  const m = rec.subarray(0, tab).toString("latin1").match(HEADER);
  if (!m) throw new GitTreeError("bad-listing");
  const [, mode, type, id, size] = m as unknown as [string, string, string, string, string];
  let path: string;
  try {
    path = utf8.decode(rec.subarray(tab + 1));
  } catch {
    throw new GitTreeError("bad-listing");
  }
  if (path === "") throw new GitTreeError("bad-listing");
  if (type === "blob" && (mode === "100644" || mode === "100755") && size !== "-") return { path, kind: "file", size: Number(size), id };
  if (type === "blob" && mode === "120000") return { path, kind: "symlink", size: size === "-" ? undefined : Number(size), id };
  if (type === "commit" && mode === "160000") return { path, kind: "submodule", id };
  return { path, kind: "other", id };
}

/** Fetches the commit into `<tmp>/repo`. Settles once; the process group is gone when it does. */
function fetchCommit(args: string[], env: NodeJS.ProcessEnv, repo: string, limits: { timeoutMs: number; repoBytes: number; pollMs: number }, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((done, fail) => {
    let child: ChildProcess | undefined;
    let hit: GitTreeErrorCode | undefined;
    let settled = false;
    const killGroup = () => {
      const pid = child?.pid;
      if (typeof pid !== "number" || pid <= 1) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
    };
    const trip = (code: GitTreeErrorCode) => {
      if (hit) return;
      hit = code;
      killGroup();
    };
    const sizeProblem = (): GitTreeErrorCode | undefined => {
      try {
        return treeBytes(repo) > limits.repoBytes ? "too-large" : undefined;
      } catch {
        return "fetch-failed";
      }
    };
    const timer = setTimeout(() => trip("timeout"), limits.timeoutMs);
    const poll = setInterval(() => {
      const p = sizeProblem();
      if (p) trip(p);
    }, limits.pollMs);
    const onAbort = () => trip("interrupted");
    const settle = (code?: GitTreeErrorCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      killGroup();
      if (code) fail(new GitTreeError(code));
      else done();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn("git", argv("fetch", ...args), { env, detached: true, stdio: "ignore" });
    } catch {
      settle("fetch-failed");
      return;
    }
    child.on("error", (e) => settle(hit ?? (enoent(e) ? "no-git" : "fetch-failed")));
    child.on("exit", (status) => {
      if (hit) return settle(hit);
      if (status !== 0) return settle("fetch-failed");
      settle(sizeProblem());
    });
    if (signal?.aborted) trip("interrupted");
  });
}

/** Fetches `commit` of `source.repository` into a private bare repository and opens it for reading. */
export async function openGitTree(source: Pick<SkillLibrarySource, "repository">, commit: string, opts: GitTreeOptions = {}): Promise<GitTree> {
  if (!COMMIT_RE.test(commit)) throw new GitTreeError("no-commit");
  if (opts.signal?.aborted) throw new GitTreeError("interrupted");
  const timeoutMs = opts.timeoutMs ?? GIT_TREE_LIMITS.timeoutMs;
  const repoBytes = opts.repoBytes ?? GIT_TREE_LIMITS.repoBytes;
  const pollMs = opts.pollMs ?? GIT_TREE_LIMITS.pollMs;
  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), "scf-skill-fetch-"));
  } catch {
    throw new GitTreeError("fetch-failed");
  }
  const close = () => {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // nothing more to do
    }
  };
  try {
    mkdirSync(join(tmp, "repo"), { mode: 0o700 });
    mkdirSync(join(tmp, "home"), { mode: 0o700 });
    const env = gitEnv(opts.env ?? process.env, tmp, opts.remote !== undefined);
    const run = { env, timeout: timeoutMs, killSignal: "SIGKILL" } as const;
    const format = commit.length === 64 ? "sha256" : "sha1";
    const init = spawnSync("git", argv("init", "--quiet", "--bare", "--template=", "--object-format=" + format), { ...run, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 65536 });
    const initFailure = failure(init, "fetch-failed");
    if (initFailure) throw initFailure;
    const url = opts.remote !== undefined ? "file://" + resolve(opts.remote) : source.repository;
    await fetchCommit(["--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--no-auto-gc", "--", url, commit], env, join(tmp, "repo"), { timeoutMs, repoBytes, pollMs }, opts.signal);
    const type = spawnSync("git", argv("cat-file", "-t", commit), { ...run, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 65536 });
    const typeFailure = failure(type, "no-commit");
    if (typeFailure) throw typeFailure;
    if (type.stdout.toString("latin1").trim() !== "commit") throw new GitTreeError("no-commit");

    return {
      close,
      list(path: string): TreeEntry[] {
        const rest = ["-r", "-z", "-l", "--full-tree", commit, ...(path === "." ? [] : ["--", path])];
        const r = spawnSync("git", argv("ls-tree", ...rest), { ...run, stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_TREE_LIMITS.listBytes });
        const f = failure(r, "bad-listing");
        if (f) throw f;
        const out: TreeEntry[] = [];
        let from = 0;
        for (let i = r.stdout.indexOf(0, from); i >= 0; i = r.stdout.indexOf(0, from)) {
          out.push(parseRecord(r.stdout.subarray(from, i)));
          from = i + 1;
        }
        if (from < r.stdout.length) throw new GitTreeError("bad-listing");
        return out;
      },
      read(entries: readonly TreeEntry[]): Uint8Array[] {
        if (entries.length === 0) return [];
        let want = 1024;
        for (const e of entries) {
          if (!COMMIT_RE.test(e.id) || !Number.isSafeInteger(e.size) || (e.size as number) < 0) throw new GitTreeError("read-failed");
          want += (e.size as number) + 128;
        }
        const input = entries.map((e) => e.id + "\n").join("");
        const r = spawnSync("git", argv("cat-file", "--batch"), { ...run, input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: want });
        const f = failure(r, "read-failed");
        if (f) throw f;
        const buf = r.stdout;
        const out: Uint8Array[] = [];
        let at = 0;
        for (const e of entries) {
          const nl = buf.indexOf(0x0a, at);
          if (nl < 0 || nl - at > 200) throw new GitTreeError("read-failed");
          if (buf.subarray(at, nl).toString("latin1") !== `${e.id} blob ${e.size}`) throw new GitTreeError("read-failed");
          const start = nl + 1;
          const end = start + (e.size as number);
          if (end + 1 > buf.length || buf[end] !== 0x0a) throw new GitTreeError("read-failed");
          out.push(Uint8Array.from(buf.subarray(start, end)));
          at = end + 1;
        }
        return out;
      },
    };
  } catch (e) {
    close();
    throw e instanceof GitTreeError ? e : new GitTreeError("fetch-failed");
  }
}
