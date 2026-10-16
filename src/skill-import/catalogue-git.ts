import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFromUrl } from "../skills/source-update.js";

// The local git and gh calls of `scf skills update`, all against the catalogue repository (the clone in the current folder and
// its `origin`). Argument arrays only, never a shell. They are synchronous: the caller yields and checks for an interrupt after
// each one. git runs with the user's own configuration (credentials and hooks are what a push needs); its text, and the text of
// gh, never leaves this module: a failure is a fixed code.

export const CATALOGUE_GIT_COMMANDS = ["config", "rev-parse", "symbolic-ref", "fetch", "ls-tree", "cat-file", "hash-object", "read-tree", "update-index", "write-tree", "commit-tree", "push", "ls-remote"] as const;
export const CATALOGUE_LIMITS = { timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024, fileBytes: 262_144 } as const;
export type CatalogueErrorCode =
  | "no-git"
  | "not-a-repository"
  | "no-origin"
  | "no-default-branch"
  | "fetch-failed"
  | "read-failed"
  | "commit-failed"
  | "push-failed"
  | "delete-failed"
  | "no-gh"
  | "gh-failed"
  | "timeout";

export class CatalogueError extends Error {
  readonly code: CatalogueErrorCode;
  constructor(code: CatalogueErrorCode) {
    super(code);
    this.name = "CatalogueError";
    this.code = code;
  }
}

export interface CatalogueContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type GitCommand = (typeof CATALOGUE_GIT_COMMANDS)[number];
const DROPPED = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_PREFIX)$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const HEX_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const URL_RE = /^https:\/\/\S{1,300}$/;

function baseEnv(env: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !DROPPED.test(k)) out[k] = v;
  return { ...out, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", ...extra };
}

/** Maps the failure of a process call to a code; undefined when it succeeded. */
function failure(r: SpawnSyncReturns<Buffer>, missing: CatalogueErrorCode, own: CatalogueErrorCode): CatalogueError | undefined {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return new CatalogueError("timeout");
  if (code === "ENOENT") return new CatalogueError(missing);
  if (r.error || r.status !== 0) return new CatalogueError(own);
  return undefined;
}

function git(ctx: CatalogueContext, cmd: GitCommand, rest: string[], own: CatalogueErrorCode, o: { input?: Buffer; extraEnv?: NodeJS.ProcessEnv } = {}): Buffer {
  const r = spawnSync("git", [cmd, ...rest], {
    cwd: ctx.cwd,
    env: baseEnv(ctx.env, o.extraEnv),
    input: o.input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: CATALOGUE_LIMITS.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: CATALOGUE_LIMITS.maxBuffer,
  });
  const f = failure(r, "no-git", own);
  if (f) throw f;
  return r.stdout;
}

const text = (b: Buffer) => b.toString("utf8").trim();

/** The folder of the current directory below the top of the clone, with a trailing slash ("" at the top). Fails outside a work tree. */
export function showPrefix(ctx: CatalogueContext): string {
  const prefix = git(ctx, "rev-parse", ["--show-prefix"], "not-a-repository").toString("utf8").replace(/\n$/, "");
  if (/[\0\n\\"]/.test(prefix)) throw new CatalogueError("not-a-repository");
  return prefix;
}

/** `owner/name` of the repository `origin` points at, from the address in the configuration; undefined when it cannot be read. */
export function originRepo(ctx: CatalogueContext): string | undefined {
  const url = text(git(ctx, "config", ["--get", "remote.origin.url"], "no-origin"));
  return repoFromUrl(url);
}

/** The default branch of `origin`, from `origin/HEAD`. */
export function defaultBranch(ctx: CatalogueContext): string {
  const ref = text(git(ctx, "symbolic-ref", ["--short", "refs/remotes/origin/HEAD"], "no-default-branch"));
  const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  if (!BRANCH_RE.test(name)) throw new CatalogueError("no-default-branch");
  return name;
}

/** Fetches the branch of `origin` and returns its commit. Writes only the remote-tracking ref of that branch and objects. */
export function fetchBase(ctx: CatalogueContext, branch: string): string {
  if (!BRANCH_RE.test(branch)) throw new CatalogueError("fetch-failed");
  git(ctx, "fetch", ["--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], "fetch-failed");
  const commit = text(git(ctx, "rev-parse", ["--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], "fetch-failed"));
  if (!HEX_RE.test(commit)) throw new CatalogueError("fetch-failed");
  return commit;
}

export interface Blob {
  mode: string;
  sha: string;
  content: Buffer;
}

/** A regular file of a commit, or undefined when the commit has no such path. A link, a folder or a large file is refused. */
export function readBlob(ctx: CatalogueContext, commit: string, path: string): Blob | undefined {
  // `path` is relative to the top of the clone, whatever folder the command runs in
  const listing = git(ctx, "ls-tree", ["-z", "--full-tree", commit, "--", path], "read-failed").toString("utf8");
  if (listing === "") return undefined;
  const m = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]*)\0$/.exec(listing);
  if (!m || m[3] !== path) throw new CatalogueError("read-failed");
  const content = git(ctx, "cat-file", ["blob", m[2]!], "read-failed");
  if (content.length > CATALOGUE_LIMITS.fileBytes) throw new CatalogueError("read-failed");
  return { mode: m[1]!, sha: m[2]!, content };
}

/**
 * A commit on top of `base` that holds `path` with `content` and is otherwise the tree of `base`. Made with a temporary index:
 * the working copy, its index and every ref stay as they are.
 */
export function commitFile(ctx: CatalogueContext, base: string, path: string, content: Buffer, mode: string, message: string): string {
  const sha = text(git(ctx, "hash-object", ["-w", "--stdin"], "commit-failed", { input: content }));
  if (!HEX_RE.test(sha)) throw new CatalogueError("commit-failed");
  let tmp: string | undefined;
  try {
    tmp = mkdtempSync(join(tmpdir(), "scf-skill-update-"));
    const extraEnv = { GIT_INDEX_FILE: join(tmp, "index") };
    // the index paths are relative to the top of the clone: run from there
    const top = text(git(ctx, "rev-parse", ["--show-toplevel"], "commit-failed"));
    const at = { ...ctx, cwd: top };
    git(at, "read-tree", [base], "commit-failed", { extraEnv });
    git(at, "update-index", ["--add", "--cacheinfo", `${mode},${sha},${path}`], "commit-failed", { extraEnv });
    const tree = text(git(at, "write-tree", [], "commit-failed", { extraEnv }));
    if (!HEX_RE.test(tree)) throw new CatalogueError("commit-failed");
    const commit = text(git(ctx, "commit-tree", [tree, "-p", base, "-m", message], "commit-failed"));
    if (!HEX_RE.test(commit)) throw new CatalogueError("commit-failed");
    return commit;
  } catch (e) {
    throw e instanceof CatalogueError ? e : new CatalogueError("commit-failed");
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // a temporary folder is left behind
      }
    }
  }
}

/** Creates `branch` on `origin` at `commit`. The empty lease makes the push create-only: an existing branch is never changed. */
export function pushNewBranch(ctx: CatalogueContext, branch: string, commit: string): void {
  if (!BRANCH_RE.test(branch) || !HEX_RE.test(commit)) throw new CatalogueError("push-failed");
  git(ctx, "push", ["--quiet", `--force-with-lease=refs/heads/${branch}:`, "origin", `${commit}:refs/heads/${branch}`], "push-failed");
}

/** The commit `branch` holds on `origin`, or undefined when there is no such branch. */
export function remoteBranchHead(ctx: CatalogueContext, branch: string): string | undefined {
  if (!BRANCH_RE.test(branch)) throw new CatalogueError("delete-failed");
  const out = text(git(ctx, "ls-remote", ["--quiet", "origin", `refs/heads/${branch}`], "delete-failed"));
  if (out === "") return undefined;
  const m = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/.exec(out);
  if (!m || m[2] !== branch) throw new CatalogueError("delete-failed");
  return m[1];
}

/**
 * Deletes `branch` on `origin` only while it still holds `commit`, then checks. True when the branch no longer holds `commit`
 * (it is gone, or it is someone else's); false when it still does or cannot be checked.
 */
export function deleteOwnBranch(ctx: CatalogueContext, branch: string, commit: string): boolean {
  if (!BRANCH_RE.test(branch) || !HEX_RE.test(commit)) return false;
  try {
    git(ctx, "push", ["--quiet", `--force-with-lease=refs/heads/${branch}:${commit}`, "origin", `:refs/heads/${branch}`], "delete-failed");
  } catch {
    // the check below tells whether the branch is still there
  }
  try {
    return remoteBranchHead(ctx, branch) !== commit;
  } catch {
    return false;
  }
}

const ghBin = (env: NodeJS.ProcessEnv) => env.FACTORY_GH_BIN || "gh";

function gh(ctx: CatalogueContext, args: string[], input?: string): string {
  const r = spawnSync(ghBin(ctx.env), args, {
    cwd: ctx.cwd,
    env: { ...ctx.env, GH_PROMPT_DISABLED: "1" },
    input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout: CATALOGUE_LIMITS.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: CATALOGUE_LIMITS.maxBuffer,
    encoding: "utf8",
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") throw new CatalogueError("timeout");
  if (code === "ENOENT") throw new CatalogueError("no-gh");
  if (r.error || r.status !== 0) throw new CatalogueError("gh-failed");
  return r.stdout;
}

/** The address of the open pull request whose head is `branch`, if there is one. */
export function openPullRequest(ctx: CatalogueContext, repo: string, branch: string): string | undefined {
  const out = gh(ctx, ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url,headRefName,state", "--limit", "20"]);
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    throw new CatalogueError("gh-failed");
  }
  if (!Array.isArray(list)) throw new CatalogueError("gh-failed");
  for (const p of list as { url?: unknown; headRefName?: unknown; state?: unknown }[]) {
    if (p && p.headRefName === branch && typeof p.state === "string" && p.state.toUpperCase() === "OPEN" && typeof p.url === "string" && URL_RE.test(p.url)) return p.url;
  }
  return undefined;
}

const PR_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]{1,10}$/;
const OPEN_PULL_REQUESTS_LIMIT = 1000;

/**
 * The open pull requests whose head is `prefix` plus 12 lower-case hex digits (the update branches of one source), in the order
 * of gh. gh pages through the repository up to a fixed limit; the filter is local.
 */
export function openSourcePullRequests(ctx: CatalogueContext, repo: string, prefix: string): { url: string; branch: string; createdAt?: string }[] {
  if (!BRANCH_RE.test(prefix)) throw new CatalogueError("gh-failed");
  const out = gh(ctx, ["pr", "list", "--repo", repo, "--state", "open", "--json", "url,headRefName,state,createdAt", "--limit", String(OPEN_PULL_REQUESTS_LIMIT)]);
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    throw new CatalogueError("gh-failed");
  }
  if (!Array.isArray(list)) throw new CatalogueError("gh-failed");
  const found = new Map<string, { branch: string; createdAt?: string }>();
  for (const p of list as { url?: unknown; headRefName?: unknown; state?: unknown; createdAt?: unknown }[]) {
    if (!p || typeof p.headRefName !== "string" || typeof p.url !== "string" || typeof p.state !== "string") continue;
    if (p.state.toUpperCase() !== "OPEN" || !p.headRefName.startsWith(prefix)) continue;
    if (!/^[0-9a-f]{12}$/.test(p.headRefName.slice(prefix.length))) continue;
    if (!URL_RE.test(p.url) || !PR_URL_RE.test(p.url) || found.has(p.url)) continue;
    found.set(p.url, { branch: p.headRefName, ...(typeof p.createdAt === "string" ? { createdAt: p.createdAt } : {}) });
  }
  return [...found].map(([url, v]) => ({ url, ...v }));
}

/** The title and the text of a pull request, as GitHub holds them. */
export function pullRequestText(ctx: CatalogueContext, repo: string, url: string): { title: string; body: string } {
  if (!URL_RE.test(url)) throw new CatalogueError("gh-failed");
  const out = gh(ctx, ["pr", "view", url, "--repo", repo, "--json", "title,body"]);
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    throw new CatalogueError("gh-failed");
  }
  const o = v as { title?: unknown; body?: unknown } | null;
  if (!o || typeof o.title !== "string" || typeof o.body !== "string") throw new CatalogueError("gh-failed");
  return { title: o.title, body: o.body };
}

/** Changes the title and the text of an open pull request; the body goes in on standard input. */
export function editPullRequest(ctx: CatalogueContext, o: { repo: string; url: string; title: string; body: string }): void {
  if (!URL_RE.test(o.url)) throw new CatalogueError("gh-failed");
  gh(ctx, ["pr", "edit", o.url, "--repo", o.repo, "--title", o.title, "--body-file", "-"], o.body);
}

/** Opens the pull request; the body goes in on standard input. Returns its address. */
export function createPullRequest(ctx: CatalogueContext, o: { repo: string; base: string; head: string; title: string; body: string }): string {
  const out = gh(ctx, ["pr", "create", "--repo", o.repo, "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], o.body);
  const url = out.trim().split("\n").at(-1)?.trim() ?? "";
  if (!URL_RE.test(url)) throw new CatalogueError("gh-failed");
  return url;
}

const REVIEWER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

/** Asks a GitHub user or team (`@octocat`, `@acme/skills`) to review an open pull request. */
export function requestReviewer(ctx: CatalogueContext, o: { repo: string; url: string; reviewer: string }): void {
  const handle = o.reviewer.replace(/^@/, "");
  if (!URL_RE.test(o.url) || !REVIEWER_RE.test(handle)) throw new CatalogueError("gh-failed");
  gh(ctx, ["pr", "edit", o.url, "--repo", o.repo, "--add-reviewer", handle]);
}

/** Who was asked to review a pull request (`requested`) and who did (`reviewed`): user logins and team names. */
export function pullRequestReviewers(ctx: CatalogueContext, repo: string, url: string): { requested: string[]; reviewed: string[] } {
  if (!URL_RE.test(url)) throw new CatalogueError("gh-failed");
  const out = gh(ctx, ["pr", "view", url, "--repo", repo, "--json", "reviewRequests,reviews"]);
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    throw new CatalogueError("gh-failed");
  }
  const o = v as { reviewRequests?: unknown; reviews?: unknown } | null;
  if (!o || !Array.isArray(o.reviewRequests) || !Array.isArray(o.reviews)) throw new CatalogueError("gh-failed");
  const requested: string[] = [];
  for (const r of o.reviewRequests as { login?: unknown; slug?: unknown; organization?: { login?: unknown } }[]) {
    if (!r) continue;
    if (typeof r.login === "string") requested.push(r.login);
    if (typeof r.slug === "string") {
      requested.push(r.slug);
      if (typeof r.organization?.login === "string") requested.push(`${r.organization.login}/${r.slug}`);
    }
  }
  const reviewed: string[] = [];
  for (const r of o.reviews as { author?: { login?: unknown } }[]) {
    if (typeof r?.author?.login === "string") reviewed.push(r.author.login);
  }
  return { requested, reviewed };
}
