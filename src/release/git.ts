import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeFor, type SyncStories } from "../stories/store.js";

// The few git and gh calls of `scf release-build init --write`, against the clone in `cwd` and its `origin`. Argument arrays only,
// never a shell; every call has a time limit and is killed with SIGKILL when it runs over. A failure is a fixed code: the text of
// git and gh never leaves this module.

export type GitErrorCode = "no-git" | "no-default-branch" | "read-failed" | "commit-failed" | "push-failed" | "delete-failed" | "no-gh" | "gh-failed" | "timeout";

export class GitError extends Error {
  readonly code: GitErrorCode;
  constructor(code: GitErrorCode) {
    super(code);
    this.name = "GitError";
    this.code = code;
  }
}

export interface GitContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class Interrupted extends Error {}

const LIMITS = { timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024, fileBytes: 262_144 } as const;
const DROPPED = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_PREFIX)$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const HEX_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const URL_RE = /^https:\/\/\S{1,300}$/;

function baseEnv(env: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !DROPPED.test(k)) out[k] = v;
  return { ...out, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", ...extra };
}

function failure(r: SpawnSyncReturns<Buffer | string>, missing: GitErrorCode, own: GitErrorCode): GitError | undefined {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return new GitError("timeout");
  if (code === "ENOENT") return new GitError(missing);
  if (r.error || r.status !== 0) return new GitError(own);
  return undefined;
}

function git(ctx: GitContext, args: string[], own: GitErrorCode, o: { input?: Buffer; extraEnv?: NodeJS.ProcessEnv } = {}): Buffer {
  const r = spawnSync("git", args, {
    cwd: ctx.cwd,
    env: baseEnv(ctx.env, o.extraEnv),
    input: o.input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: LIMITS.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: LIMITS.maxBuffer,
  });
  const f = failure(r, "no-git", own);
  if (f) throw f;
  return r.stdout;
}

const text = (b: Buffer) => b.toString("utf8").trim();

/** A local git call that returns its output, or undefined on any failure. */
export function tryGit(ctx: GitContext, args: string[]): Buffer | undefined {
  try {
    return git(ctx, args, "read-failed");
  } catch {
    return undefined;
  }
}

/** The default branch of `origin`, from `origin/HEAD`. */
export function defaultBranch(ctx: GitContext): string {
  const ref = text(git(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], "no-default-branch"));
  const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  if (!BRANCH_RE.test(name)) throw new GitError("no-default-branch");
  return name;
}

/** The text of a regular file of a commit, or undefined when there is no such path. A link, a folder or a large file is refused. */
export function readBlobText(ctx: GitContext, commit: string, path: string): string | undefined {
  const listing = git(ctx, ["ls-tree", "-z", "--full-tree", commit, "--", path], "read-failed").toString("utf8");
  if (listing === "") return undefined;
  const m = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]*)\0$/.exec(listing);
  if (!m || m[3] !== path) throw new GitError("read-failed");
  const content = git(ctx, ["cat-file", "blob", m[2]!], "read-failed");
  if (content.length > LIMITS.fileBytes) throw new GitError("read-failed");
  return content.toString("utf8");
}

/** A commit on top of `base` that adds `path`. Made with a temporary index: the working copy, its index and every ref stay as they are. */
export function commitFile(ctx: GitContext, base: string, path: string, content: Buffer, message: string): string {
  const sha = text(git(ctx, ["hash-object", "-w", "--stdin"], "commit-failed", { input: content }));
  if (!HEX_RE.test(sha)) throw new GitError("commit-failed");
  let tmp: string | undefined;
  try {
    tmp = mkdtempSync(join(tmpdir(), "scf-release-init-idx-"));
    const extraEnv = { GIT_INDEX_FILE: join(tmp, "index") };
    const top = text(git(ctx, ["rev-parse", "--show-toplevel"], "commit-failed"));
    const at = { ...ctx, cwd: top };
    git(at, ["read-tree", base], "commit-failed", { extraEnv });
    git(at, ["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`], "commit-failed", { extraEnv });
    const tree = text(git(at, ["write-tree"], "commit-failed", { extraEnv }));
    if (!HEX_RE.test(tree)) throw new GitError("commit-failed");
    const commit = text(git(ctx, ["commit-tree", tree, "-p", base, "-m", message], "commit-failed"));
    if (!HEX_RE.test(commit)) throw new GitError("commit-failed");
    return commit;
  } catch (e) {
    throw e instanceof GitError ? e : new GitError("commit-failed");
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Creates `branch` on `origin` at `commit`. The empty lease makes the push create-only: an existing branch is never changed. */
export function pushNewBranch(ctx: GitContext, branch: string, commit: string): void {
  if (!BRANCH_RE.test(branch) || !HEX_RE.test(commit)) throw new GitError("push-failed");
  git(ctx, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:`, "origin", `${commit}:refs/heads/${branch}`], "push-failed");
}

/** The commit `branch` holds on `origin`, or undefined when there is no such branch. */
export function remoteBranchHead(ctx: GitContext, branch: string): string | undefined {
  if (!BRANCH_RE.test(branch)) throw new GitError("delete-failed");
  const out = text(git(ctx, ["ls-remote", "--quiet", "origin", `refs/heads/${branch}`], "delete-failed"));
  if (out === "") return undefined;
  const m = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/.exec(out);
  if (!m || m[2] !== branch) throw new GitError("delete-failed");
  return m[1];
}

/** Deletes `branch` on `origin` only while it still holds `commit`. True when the branch no longer holds `commit`. */
export function deleteOwnBranch(ctx: GitContext, branch: string, commit: string): boolean {
  if (!BRANCH_RE.test(branch) || !HEX_RE.test(commit)) return false;
  try {
    git(ctx, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${commit}`, "origin", `:refs/heads/${branch}`], "delete-failed");
  } catch {
    // the check below tells whether the branch is still there
  }
  try {
    return remoteBranchHead(ctx, branch) !== commit;
  } catch {
    return false;
  }
}

function gh(ctx: GitContext, args: string[], input?: string): string {
  const r = spawnSync(ctx.env.FACTORY_GH_BIN || "gh", args, {
    cwd: ctx.cwd,
    env: { ...ctx.env, GH_PROMPT_DISABLED: "1" },
    input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: LIMITS.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: LIMITS.maxBuffer,
    encoding: "utf8",
  });
  const f = failure(r, "no-gh", "gh-failed");
  if (f) throw f;
  return r.stdout;
}

/** The store, on this module's gh. An input the store refuses counts as a failed gh call: no text leaves this module. */
function stories<T>(ctx: GitContext, repo: string, call: (s: SyncStories) => T): T {
  try {
    return call(storeFor(repo).sync((args, input) => gh(ctx, args, input)));
  } catch (e) {
    throw e instanceof GitError ? e : new GitError("gh-failed");
  }
}

/** The address of the open pull request whose head is `branch`, if there is one. */
export function openPullRequest(ctx: GitContext, repo: string, branch: string): string | undefined {
  const out = stories(ctx, repo, (s) => s.listChanges({ state: "open", limit: 20, head: branch, fields: "url,headRefName,state" }));
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    throw new GitError("gh-failed");
  }
  if (!Array.isArray(list)) throw new GitError("gh-failed");
  for (const p of list as { url?: unknown; headRefName?: unknown; state?: unknown }[]) {
    if (p && p.headRefName === branch && typeof p.state === "string" && p.state.toUpperCase() === "OPEN" && typeof p.url === "string" && URL_RE.test(p.url)) return p.url;
  }
  return undefined;
}

/** Opens the pull request; the body goes in on standard input. Returns its address. */
export function createPullRequest(ctx: GitContext, o: { repo: string; base: string; head: string; title: string; body: string }): string {
  const out = stories(ctx, o.repo, (s) => s.openChange({ base: o.base, head: o.head, title: o.title, body: o.body }));
  const url = out.trim().split("\n").at(-1)?.trim() ?? "";
  if (!URL_RE.test(url)) throw new GitError("gh-failed");
  return url;
}

/** A signal that came in while a synchronous call ran is delivered by the next event-loop turns. */
export const tickFor =
  (signal: AbortSignal) =>
  async (): Promise<void> => {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    if (signal.aborted) throw new Interrupted();
  };

/** Runs `fn` with a signal that SIGINT and SIGTERM abort. */
export async function withSignal(fn: (signal: AbortSignal) => Promise<number>): Promise<number> {
  const aborter = new AbortController();
  const onSignal = () => aborter.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await fn(aborter.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
