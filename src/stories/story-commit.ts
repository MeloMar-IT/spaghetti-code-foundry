import { spawnSync } from "node:child_process";

// One git commit per story change, on the branch that is checked out. Synchronous on purpose: it runs inside the story lock.
// Argument arrays only (no shell), no GIT_* variable from the environment, a time limit with SIGKILL on every call.
// The story text never reaches an argument: the message holds only the number and a fixed word.
// The user's own git settings (identity, excludes, attributes) stay on; only hooks and fsmonitor are switched off.

export type StoryChange = "created" | "edited" | "labels" | "comment" | "status" | "closed" | "reopened";

export const storyCommitMessage = (story: number, change: StoryChange): string => `scf: story #${story} ${change}`;

/** The story file is saved, but git did not commit it. */
export class StoryCommitError extends Error {
  constructor(readonly story: number, readonly files: readonly string[], readonly reason: string, readonly branch?: string) {
    super(`story #${story} is saved in ${files.join(", ")}, but git did not commit it${branch ? ` on branch ${branch}` : ""}: ${reason}`);
    this.name = "StoryCommitError";
  }
}

const OPTIONS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--literal-pathspecs"];
const CALL_MS = 15_000;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/**
 * Commits `files` (relative to `dir`) with one message. Does nothing when they equal what git already has.
 * `budgetMs` is the time left for all git calls together. Throws `StoryCommitError`.
 */
export function commitStory(dir: string, story: number, files: readonly string[], change: StoryChange, o: { budgetMs?: number } = {}): void {
  const end = Date.now() + (o.budgetMs ?? Infinity);
  const env = gitEnv();
  let branch: string | undefined;
  const fail = (reason: string): never => { throw new StoryCommitError(story, files, reason, branch); };
  const git = (args: string[]): { ok: boolean; out: string; err: string } => {
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
  };
  const run = (args: string[]): string => {
    const r = git(args);
    if (r.ok) return r.out;
    const err = r.err.split("\n").map((l) => l.trim()).find(Boolean) ?? "git failed";
    return fail(err.slice(0, 200));
  };

  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) fail(`${dir} is not in a git repository`);
  const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!head.ok || !head.out.trim()) fail("HEAD is detached; check out a branch");
  branch = head.out.trim();
  run(["add", "--", ...files]);
  if (!run(["status", "--porcelain", "-z", "--", ...files])) return;
  run(["commit", "--quiet", "--only", "-m", storyCommitMessage(story, change), "--", ...files]);
}
