import { randomUUID } from "node:crypto";
import { validGithubName, githubKey } from "../auth/repo-url.js";
import { validBranchName } from "../auth/repo-settings.js";
import { getRepo } from "../auth/repos.js";
import type { WatcherConfig } from "../config.js";
import { gh } from "../github.js";
import { RECIPE_PATH, storedReleaseRecipes } from "../release/recipe.js";
import { hasCommit, markCommit, readReleaseState, validCommit, writeReleaseState } from "../release/build-claims.js";

export { releaseBuildsDir } from "../release/build-claims.js";

/** A schedule watcher that builds release files looks at main at least this often. */
export const RELEASE_CHECK_MAX_MS = 5 * 60_000;
export const GH_TIMEOUT_MS = 60_000;

/** The check interval: at most 5 minutes for a schedule watcher with release_build, else `every`. */
export function releaseCheckEvery(cfg: Pick<WatcherConfig, "source" | "release_build">, every: number): number {
  return cfg.source === "schedule" && cfg.release_build ? Math.min(every, RELEASE_CHECK_MAX_MS) : every;
}

/** The repository's mainBranch setting for a repository watcher, else "main". Never throws. */
export function mainBranchOf(cfg: Pick<WatcherConfig, "repoId">): string {
  try {
    const b = cfg.repoId === undefined ? undefined : getRepo(cfg.repoId)?.settings?.mainBranch;
    return typeof b === "string" && validBranchName(b) ? b : "main";
  } catch {
    return "main";
  }
}

export const releaseBuildLock = (repo: string, branch: string): string => `release-build:${githubKey(repo)}#${branch}`;

export interface ReleaseJobs {
  /** The run id of the queued or running job with this lock key, or undefined. */
  busy(lockKey: string): string | undefined;
  /** Queues the build of the newest commit on the branch (the run carries `submission`) and returns its run id. May throw, also after the job was accepted. */
  queue(lockKey: string, submission: string): string;
  /** Did a job with this submission id get in: is it queued or running, or did a run with it start? */
  accepted(submission: string): boolean;
}
export interface ReleaseCheck {
  repo: string;
  branch: string;
  jobs: ReleaseJobs;
  /** Throws when the check was given up or the watcher stopped. */
  alive: () => void;
  timeoutMs?: number;
}
export type ReleaseCheckKind = "first" | "same" | "busy" | "no_recipe" | "queued";
export interface ReleaseCheckResult { kind: ReleaseCheckKind; head?: string; runId?: string; notes: string[] }

/** Checks of one repository and branch run one after the other (also those of different watchers). */
const chains = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

const firstLine = (e: unknown): string => {
  const err = e as { stderr?: Buffer | string; message?: string };
  return ((err.stderr ? String(err.stderr) : "").trim() || err.message || String(e)).split("\n")[0]!;
};
const notFound = (e: unknown): boolean => {
  const err = e as { stderr?: Buffer | string; message?: string };
  return /not found|HTTP 404/i.test(`${err.stderr ?? ""}${err.message ?? ""}`);
};
/** A branch name for the URL path: every part encoded, the separators kept. */
const urlBranch = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

async function readMain(repo: string, branch: string, timeoutMs: number): Promise<string> {
  let text: string;
  try {
    text = await gh(["api", `repos/${repo}/git/ref/heads/${urlBranch(branch)}`], undefined, timeoutMs);
  } catch (e) {
    throw new Error(`cannot read the newest commit of ${branch} in ${repo}: ${firstLine(e)}`, { cause: e });
  }
  let sha: unknown;
  try {
    sha = (JSON.parse(text) as { object?: { sha?: unknown } }).object?.sha;
  } catch {
    // handled below
  }
  if (!validCommit(sha)) throw new Error(`cannot read the newest commit of ${branch} in ${repo}: GitHub gave no commit id`);
  return sha;
}

/** Is there a release-build recipe: stored in the Foundry settings (no GitHub call), or the file at the commit. */
async function hasRecipe(repo: string, sha: string, timeoutMs: number): Promise<boolean> {
  if (storedReleaseRecipes(repo).texts.length > 0) return true;
  try {
    const text = await gh(["api", `repos/${repo}/contents/${RECIPE_PATH}?ref=${sha}`], undefined, timeoutMs);
    return (JSON.parse(text) as { type?: unknown }).type === "file";
  } catch (e) {
    if (notFound(e)) return false;
    throw new Error(`cannot look for the release-build recipe of ${repo} at ${sha.slice(0, 7)}: ${firstLine(e)}`, { cause: e });
  }
}

/**
 * One look at the main branch. A new commit that has a recipe gets one queued build of "the newest commit on the branch" (the flow
 * resolves the branch when it starts and claims the commit it finds, see release/build-claims.ts). Nothing is ever cancelled.
 * A queue that fails leaves a written-ahead note, so the next check finds the job by its lock key or reports that none was queued.
 */
export async function checkReleaseBuild(o: ReleaseCheck): Promise<ReleaseCheckResult> {
  const { repo, branch, jobs, alive } = o;
  if (!validGithubName(repo)) throw new Error(`"${repo}" is not a GitHub repository name`);
  if (!validBranchName(branch)) throw new Error(`"${branch}" is not a usable branch name`);
  const lock = releaseBuildLock(repo, branch);
  const timeoutMs = o.timeoutMs ?? GH_TIMEOUT_MS;
  return inOrder(lock, async () => {
    alive();
    const notes: string[] = [];
    let state = readReleaseState(repo, branch);
    const busyId = jobs.busy(lock);
    if (busyId) {
      if (state && state.pending?.runId !== busyId) {
        alive();
        writeReleaseState(repo, branch, state.head, { head: state.pending?.head ?? state.head, at: state.pending?.at ?? new Date().toISOString(), ...(state.pending?.submission ? { submission: state.pending.submission } : {}), runId: busyId });
      }
      return { kind: "busy", runId: busyId, notes };
    }
    if (state?.pending) {
      // The build this module queued is over: its commit is not built again. When the submission never got a run id and no
      // run carries its id, the job was never accepted: the commit stays open and is queued again below.
      alive();
      const p = state.pending;
      if (p.runId !== undefined || (p.submission !== undefined && jobs.accepted(p.submission))) markCommit(repo, branch, p.head);
      else notes.push(`the automatic release build of ${p.head.slice(0, 7)} was not queued; trying again`);
      state = writeReleaseState(repo, branch, state.head);
    }
    const head = await readMain(repo, branch, timeoutMs);
    alive();
    if (!state) {
      markCommit(repo, branch, head);
      writeReleaseState(repo, branch, head);
      return { kind: "first", head, notes };
    }
    if (hasCommit(repo, branch, head)) {
      if (state.head !== head) writeReleaseState(repo, branch, head);
      return { kind: "same", head, notes };
    }
    const recipe = await hasRecipe(repo, head, timeoutMs);
    alive();
    if (!recipe) {
      markCommit(repo, branch, head);
      writeReleaseState(repo, branch, head);
      return { kind: "no_recipe", head, notes };
    }
    const at = new Date().toISOString();
    const submission = randomUUID();
    writeReleaseState(repo, branch, head, { head, at, submission });
    const runId = jobs.queue(lock, submission);
    writeReleaseState(repo, branch, head, { head, at, submission, runId });
    return { kind: "queued", head, runId, notes };
  });
}
