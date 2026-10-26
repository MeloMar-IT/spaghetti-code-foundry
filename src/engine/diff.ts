import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSafeRelativePath } from "../evidence/identity.js";
import type { RunSummary } from "./state.js";

const MAX_DIFF = 2_000_000;
const BUDGET_MS = 30_000;

export class DiffTimeout extends Error {
  constructor() {
    super("the diff took too long");
  }
}

export interface DiffOptions {
  /** The git program; tests put a script here. */
  gitBin?: string;
  /** One time limit for the whole diff. */
  budgetMs?: number;
}

/** The only settings a git call of the server gets: nothing from the server's environment or the machine's git files. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
  for (const k of ["PATH", "HOME", "TMPDIR"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export const SAFE_OPTIONS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null"];

/** Runs git with a clean environment and what is left of the time budget. */
function makeGit(bin: string, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  return (cwd: string, args: string[], extra?: Record<string, string>): string => {
    const left = deadline - Date.now();
    if (left <= 0) throw new DiffTimeout();
    try {
      return execFileSync(bin, [...SAFE_OPTIONS, ...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 50_000_000,
        env: cleanEnv(extra),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: left,
        killSignal: "SIGKILL",
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { signal?: string };
      if (err.code === "ETIMEDOUT" || err.signal === "SIGKILL") throw new DiffTimeout();
      throw e;
    }
  };
}

type Git = ReturnType<typeof makeGit>;

/** Where the run's changes start: recorded base, else merge-base with the remote default branch. */
function baseOf(s: RunSummary, cwd: string, git: Git): string | undefined {
  if (s.baseSha) return s.baseSha;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    try {
      return git(cwd, ["merge-base", "HEAD", ref]).trim();
    } catch (e) {
      if (e instanceof DiffTimeout) throw e;
      // try the next ref
    }
  }
  return undefined;
}

/**
 * Everything the run changed: commits since the base plus uncommitted and new files.
 * The index work runs in a private git folder that borrows the workspace's objects, so no setting, hook, filter or
 * monitor of the workspace is read or run, and the run's own index and repository are untouched.
 */
export function runDiff(s: RunSummary, opts: DiffOptions = {}): { base?: string; stat: string; patch: string; truncated: boolean } {
  const cwd = s.workdir;
  if (!cwd || !existsSync(join(cwd, ".git"))) return { stat: "", patch: "", truncated: false };
  const git = makeGit(opts.gitBin ?? "git", opts.budgetMs ?? BUDGET_MS);
  const base = baseOf(s, cwd, git);
  if (!base) return { stat: "", patch: "", truncated: false };
  // these two read the workspace's own git folder, but no index and no work-tree file
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const objects = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "objects"]).trim());
  // the private folder must hold objects in the same format as the workspace's, or it cannot read them through the alternates
  const format = git(cwd, ["rev-parse", "--show-object-format"]).trim();
  if (format !== "sha1" && format !== "sha256") throw new Error("the repository uses an object format the diff does not know");
  const tmp = mkdtempSync(join(tmpdir(), "factory-diff-"));
  try {
    const priv = join(tmp, "git");
    git(tmp, ["init", "--quiet", "--bare", "--template=", `--object-format=${format}`, priv]);
    mkdirSync(join(priv, "objects", "info"), { recursive: true });
    writeFileSync(join(priv, "objects", "info", "alternates"), `${objects}\n`);
    const env = { GIT_DIR: priv, GIT_WORK_TREE: cwd };
    git(cwd, ["read-tree", head], env);
    git(cwd, ["add", "-A"], env);
    const stat = git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat", base], env);
    let patch = git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", base], env);
    const truncated = patch.length > MAX_DIFF;
    if (truncated) patch = patch.slice(0, MAX_DIFF);
    return { base, stat, patch, truncated };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const MAX_PATHS = 5000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface PathsOptions extends DiffOptions {
  /** The run's cancel signal: the git calls stop when it fires. */
  signal?: AbortSignal;
  /** More changed files than this give no answer. Default 5000. */
  maxPaths?: number;
}

/**
 * Every call of the `paths` work: no transport and no lazy fetch, whatever the checkout's own config says.
 * `GIT_ALLOW_PROTOCOL` overrides every `protocol.<name>.allow` of the repository, so an empty list allows none.
 */
const NO_FETCH = ["-c", "protocol.allow=never"];
const NO_FETCH_ENV = { GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" };

/** Like makeGit, but async: it follows the cancel signal and never blocks the server. A caller cannot override the no-fetch settings. */
function makeAsyncGit(bin: string, budgetMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + budgetMs;
  return (cwd: string, args: string[], extra?: Record<string, string>, input?: string): Promise<string> => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new DiffTimeout());
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        bin,
        [...SAFE_OPTIONS, ...NO_FETCH, ...args],
        { cwd, encoding: "utf8", maxBuffer: 50_000_000, env: cleanEnv({ ...extra, ...NO_FETCH_ENV }), timeout: left, killSignal: "SIGKILL", signal },
        (err, stdout) => {
          if (!err) return resolvePromise(stdout);
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          reject(signal?.aborted ? new Error("cancelled") : e.killed || e.signal === "SIGKILL" ? new DiffTimeout() : err);
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  };
}

/**
 * The files the run changed since `base` (a full commit hash): commits, staged, unstaged, new and deleted files, each once, sorted.
 * The work tree is read through a private git folder that borrows the workspace's objects (as runDiff does), and the workspace's
 * own index is read (never written) and added, so a staged file that is ignored is still listed. Ignored files that were never
 * staged are not. Undefined when the answer is not known: bad base, missing objects, too many files, an unsafe name, too slow, cancelled.
 */
export async function changedPaths(cwd: string, base: string, opts: PathsOptions = {}): Promise<string[] | undefined> {
  if (!OBJECT_ID.test(base) || /^0+$/.test(base) || opts.signal?.aborted) return undefined;
  const git = makeAsyncGit(opts.gitBin ?? "git", opts.budgetMs ?? BUDGET_MS, opts.signal);
  let tmp: string | undefined;
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    const head = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
    if (!OBJECT_ID.test(head)) return undefined;
    const objects = resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "objects"])).trim());
    const format = (await git(cwd, ["rev-parse", "--show-object-format"])).trim();
    if (format !== "sha1" && format !== "sha256") return undefined;
    tmp = await mkdtemp(join(tmpdir(), "factory-paths-"));
    const priv = join(tmp, "git");
    await git(tmp, ["init", "--quiet", "--bare", "--template=", `--object-format=${format}`, priv]);
    await mkdir(join(priv, "objects", "info"), { recursive: true });
    await writeFile(join(priv, "objects", "info", "alternates"), `${objects}\n`);
    const env = { GIT_DIR: priv, GIT_WORK_TREE: cwd };
    await git(cwd, ["read-tree", head], env);
    // `add` can rebuild a missing blob and `diff --name-only` never reads blobs, so a missing blob would look like no change:
    // every blob of the base and the head must be there (headers only; a missing object is never fetched)
    const blobs = new Set<string>();
    for (const tree of [head, base]) {
      for (const rec of (await git(cwd, ["ls-tree", "-r", "-z", tree], env)).split("\0")) {
        const [meta] = rec.split("\t");
        const [, type, oid] = meta?.split(" ") ?? [];
        if (type === "blob" && oid) blobs.add(oid);
      }
    }
    if (blobs.size) {
      const checked = await git(cwd, ["cat-file", "--batch-check"], env, `${[...blobs].join("\n")}\n`);
      if (checked.split("\n").some((l) => l.endsWith(" missing"))) return undefined;
    }
    await git(cwd, ["add", "-A"], env);
    const diff = ["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base];
    const fromTree = await git(cwd, diff, env);
    const fromIndex = await git(cwd, diff);
    const all = new Set([...fromTree.split("\0"), ...fromIndex.split("\0")].filter(Boolean));
    if (all.size > (opts.maxPaths ?? MAX_PATHS)) return undefined;
    const list = [...all];
    if (!list.every(isSafeRelativePath)) return undefined;
    return list.sort();
  } catch {
    return undefined;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The folder the run's checkout is rooted at, or undefined when that cannot be trusted. Never searches upward in an empty workspace. */
export async function checkoutRoot(s: RunSummary, opts: PathsOptions = {}): Promise<string | undefined> {
  const dir = s.workdir;
  if (!dir) return undefined;
  if (s.flowDef?.workspace === "empty") return existsSync(join(dir, ".git")) ? dir : undefined;
  if (!s.baseSha) return undefined;
  try {
    const git = makeAsyncGit(opts.gitBin ?? "git", opts.budgetMs ?? BUDGET_MS, opts.signal);
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    if (!top) return undefined;
    const [realTop, realDir] = await Promise.all([realpath(top), realpath(dir)]);
    const rel = relative(realTop, realDir);
    return rel.startsWith("..") || isAbsolute(rel) ? undefined : realTop;
  } catch {
    return undefined;
  }
}

/** Where the changes of the run start: the recorded base, or in an empty workspace the HEAD read once after the first checkout. */
export const pathsBaseOf = (s: RunSummary): string | undefined => (s.flowDef?.workspace === "empty" ? s.pathsBaseSha : s.baseSha);

const baseReads = new WeakMap<RunSummary, Promise<void>>();

/**
 * Empty workspace: reads HEAD once, after the first step that left a checkout, as the base. Any failure (time, cancel, unborn HEAD,
 * bad output) marks the base lost for good, because a later HEAD would move the base forward. Never rejects.
 */
export function ensurePathsBase(s: RunSummary, opts: PathsOptions = {}): Promise<void> {
  const dir = s.workdir;
  if (s.flowDef?.workspace !== "empty" || !s.pathsTracked || s.pathsBaseSha || s.pathsBaseLost || !dir || !existsSync(join(dir, ".git"))) return Promise.resolve();
  let read = baseReads.get(s);
  if (!read) {
    read = (async () => {
      try {
        const git = makeAsyncGit(opts.gitBin ?? "git", opts.budgetMs ?? BUDGET_MS, opts.signal);
        const head = (await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim();
        if (OBJECT_ID.test(head) && !/^0+$/.test(head)) s.pathsBaseSha = head;
        else s.pathsBaseLost = true;
      } catch {
        s.pathsBaseLost = true;
      }
    })();
    baseReads.set(s, read);
  }
  return read;
}

/** The `paths` fact of a run now, or undefined when it cannot be known. Never throws. */
export async function runChangedPaths(s: RunSummary, opts: PathsOptions = {}): Promise<string[] | undefined> {
  try {
    if (s.pathsTracked !== true || s.pathsBaseLost) return undefined;
    const base = pathsBaseOf(s);
    if (!base) {
      await ensurePathsBase(s, opts);
      return undefined;
    }
    const root = await checkoutRoot(s, opts);
    return root ? await changedPaths(root, base, opts) : undefined;
  } catch {
    return undefined;
  }
}
