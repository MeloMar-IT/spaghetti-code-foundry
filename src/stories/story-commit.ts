import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One git commit per story change. By default it goes on the branch that is checked out; with `branch`, it goes on that
// branch only (a separate history built with git plumbing, in a temporary index), so the owner's HEAD, branch, index and
// working tree stay as they are. Synchronous on purpose: it runs inside the story lock.
// Argument arrays only (no shell), no GIT_* variable from the environment, a time limit with SIGKILL on every call.
// The story text never reaches an argument: the message holds only the number and a fixed word.
// The user's own git settings (identity, excludes, attributes) stay on; only hooks and fsmonitor are switched off.

export type StoryChange = "created" | "edited" | "labels" | "comment" | "status" | "closed" | "reopened" | "moved";

export const storyCommitMessage = (story: number, change: StoryChange): string => `scf: story #${story} ${change}`;

/** The branch a connected local repository keeps its story history on. */
export const STORIES_BRANCH = "scf/stories";

/** The story file is saved, but git did not commit it. */
export class StoryCommitError extends Error {
  constructor(readonly story: number, readonly files: readonly string[], readonly reason: string, readonly branch?: string) {
    super(`story #${story} is saved in ${files.join(", ")}, but git did not commit it${branch ? ` on branch ${branch}` : ""}: ${reason}`);
    this.name = "StoryCommitError";
  }
}

const OPTIONS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--literal-pathspecs"];
const CALL_MS = 15_000;

type Fail = (reason: string) => never;
interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** One git call. Fails (through `fail`) when git cannot run or the time left is used up; a non-zero exit is `ok: false`. */
function callGit(dir: string, env: NodeJS.ProcessEnv, end: number, fail: Fail, args: string[]): GitResult {
  const left = end - Date.now();
  if (left <= 0) return fail("out of time");
  const r = spawnSync("git", [...OPTIONS, ...args], {
    cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(CALL_MS, left), killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return fail(code === "ENOENT" ? "git is not installed" : code === "ETIMEDOUT" || r.signal ? "git took too long" : r.error.message);
  }
  if (r.signal) return fail("git took too long");
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** One git call that must succeed; returns its output. */
function runGit(dir: string, env: NodeJS.ProcessEnv, end: number, fail: Fail, args: string[]): string {
  const r = callGit(dir, env, end, fail, args);
  if (r.ok) return r.out;
  const err = r.err.split("\n").map((l) => l.trim()).find(Boolean) ?? "git failed";
  return fail(err.slice(0, 200));
}

/**
 * Commits `files` (relative to `dir`) with one message. Does nothing when they equal what git already has.
 * `budgetMs` is the time left for all git calls together. `branch`: commit on that branch instead of the checked-out one.
 * Throws `StoryCommitError`.
 */
export function commitStory(dir: string, story: number, files: readonly string[], change: StoryChange, o: { budgetMs?: number; branch?: string } = {}): void {
  const end = Date.now() + (o.budgetMs ?? Infinity);
  if (o.branch !== undefined) return commitOnBranch(dir, story, files, change, o.branch, end);
  const env = gitEnv();
  let branch: string | undefined;
  const fail: Fail = (reason) => {
    throw new StoryCommitError(story, files, reason, branch);
  };
  const run = (args: string[]): string => runGit(dir, env, end, fail, args);

  if (!callGit(dir, env, end, fail, ["rev-parse", "--is-inside-work-tree"]).ok) fail(`${dir} is not in a git repository`);
  const head = callGit(dir, env, end, fail, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!head.ok || !head.out.trim()) fail("HEAD is detached; check out a branch");
  branch = head.out.trim();
  run(["add", "--", ...files]);
  if (!run(["status", "--porcelain", "-z", "--", ...files])) return;
  run(["commit", "--quiet", "--only", "-m", storyCommitMessage(story, change), "--", ...files]);
}

/**
 * Commits `files` on `branch` only. The files are read from the working tree into a temporary index (GIT_INDEX_FILE), which
 * starts from the branch's own tree; the commit's parent is the branch tip, and the branch is moved with a checked old value.
 * Nothing of the owner's checkout (HEAD, its index, its working files) is changed.
 */
function commitOnBranch(dir: string, story: number, files: readonly string[], change: StoryChange, branch: string, end: number): void {
  const env = gitEnv();
  const fail: Fail = (reason) => {
    throw new StoryCommitError(story, files, reason, branch);
  };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}): string => runGit(dir, { ...env, ...extra }, end, fail, args);
  if (!callGit(dir, env, end, fail, ["rev-parse", "--is-inside-work-tree"]).ok) fail(`${dir} is not in a git repository`);
  const ref = `refs/heads/${branch}`;
  const scratch = mkdtempSync(join(tmpdir(), "scf-stories-index-"));
  try {
    const indexEnv = { GIT_INDEX_FILE: join(scratch, "index") };
    const tip = callGit(dir, env, end, fail, ["rev-parse", "--verify", "--quiet", ref]);
    const parent = tip.ok ? tip.out.trim() : "";
    // no branch yet and nothing on disk to record: no empty first commit
    if (!parent && !files.some((f) => existsSync(join(dir, f)))) return;
    run(parent ? ["read-tree", parent] : ["read-tree", "--empty"], indexEnv);
    for (const f of files) {
      if (existsSync(join(dir, f))) {
        const sha = run(["hash-object", "-w", "--", f]).trim();
        run(["update-index", "--add", "--cacheinfo", `100644,${sha},${f}`], indexEnv);
      } else {
        run(["update-index", "--force-remove", "--", f], indexEnv);
      }
    }
    const tree = run(["write-tree"], indexEnv).trim();
    if (parent && run(["rev-parse", `${parent}^{tree}`]).trim() === tree) return;
    const message = storyCommitMessage(story, change);
    const commit = run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]).trim();
    run(["update-ref", "-m", message, ref, commit, ...(parent ? [parent] : [])]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
