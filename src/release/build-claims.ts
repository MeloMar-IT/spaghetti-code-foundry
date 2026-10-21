import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubKey } from "../auth/repo-url.js";
import { FACTORY_HOME } from "../flow/load.js";

/**
 * What the automatic release build remembers per repository and branch, in <data folder>/release-builds/<hash>/:
 *   state.json          the commit main pointed to at the last check, and the build this watcher queued and has not settled yet
 *   commits/<ab>/<sha>  one small file per commit that must never be built again (kept for good, so the list can grow without limit
 *                       and is never rewritten). The text in it is the run that claimed the commit, or empty.
 * The folder name is a hash, so any valid repository and branch name gives a short name.
 */
export interface ReleaseBuildState {
  version: 1;
  repo: string;
  branch: string;
  head: string;
  /** `submission` is made before the job is queued and travels with the run; `runId` is there once the queue answered. */
  pending?: { runId?: string; submission?: string; head: string; at: string };
}

export const releaseBuildsDir = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "release-builds");
const SHA = /^[0-9a-f]{40,64}$/;
export const validCommit = (sha: unknown): sha is string => typeof sha === "string" && SHA.test(sha);
const identity = (repo: string, branch: string) => `${githubKey(repo)}#${branch}`;
const dirOf = (repo: string, branch: string) => join(releaseBuildsDir(), createHash("sha256").update(identity(repo, branch)).digest("hex"));
const commitFile = (repo: string, branch: string, sha: string) => {
  if (!validCommit(sha)) throw new Error("not a commit id");
  return join(dirOf(repo, branch), "commits", sha.slice(0, 2), sha);
};

export const hasCommit = (repo: string, branch: string, sha: string): boolean => existsSync(commitFile(repo, branch, sha));

/** Remembers a commit as handled. True when it was new. Atomic: of two writers, one gets true. */
export function markCommit(repo: string, branch: string, sha: string, by = ""): boolean {
  const file = commitFile(repo, branch, sha);
  mkdirSync(join(file, ".."), { recursive: true });
  try {
    writeFileSync(file, by, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** A run takes the commit it is about to build. True when it may build it (new, or already taken by this run, as after a resume). */
export function claimCommit(repo: string, branch: string, sha: string, runId: string): boolean {
  if (markCommit(repo, branch, sha, runId)) return true;
  try {
    return readFileSync(commitFile(repo, branch, sha), "utf8") === runId;
  } catch {
    return false;
  }
}

function parseState(text: string, repo: string, branch: string): ReleaseBuildState | undefined {
  try {
    const j = JSON.parse(text) as Partial<ReleaseBuildState> | null;
    if (!j || typeof j !== "object" || j.version !== 1 || j.repo !== githubKey(repo) || j.branch !== branch || !validCommit(j.head)) return undefined;
    const p = j.pending;
    if (p !== undefined) {
      if (!p || typeof p !== "object" || !validCommit(p.head) || typeof p.at !== "string") return undefined;
      if (p.runId !== undefined && (typeof p.runId !== "string" || !/^[\w-]+$/.test(p.runId))) return undefined;
      if (p.submission !== undefined && (typeof p.submission !== "string" || !/^[\w-]+$/.test(p.submission))) return undefined;
    }
    return j as ReleaseBuildState;
  } catch {
    return undefined;
  }
}

/** The stored state; undefined when there is none or the file is broken. */
export function readReleaseState(repo: string, branch: string): ReleaseBuildState | undefined {
  try {
    return parseState(readFileSync(join(dirOf(repo, branch), "state.json"), "utf8"), repo, branch);
  } catch {
    return undefined;
  }
}

/** Written to a temporary file and renamed, so a reader never sees half a file. */
export function writeReleaseState(repo: string, branch: string, head: string, pending?: ReleaseBuildState["pending"]): ReleaseBuildState {
  const state: ReleaseBuildState = { version: 1, repo: githubKey(repo), branch, head, ...(pending ? { pending } : {}) };
  const dir = dirOf(repo, branch);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return state;
}
