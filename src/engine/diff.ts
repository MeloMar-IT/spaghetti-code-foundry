import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** The only settings a git call of the diff gets: nothing from the server's environment or the machine's git files. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
  for (const k of ["PATH", "HOME", "TMPDIR"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

const SAFE_OPTIONS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null"];

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
