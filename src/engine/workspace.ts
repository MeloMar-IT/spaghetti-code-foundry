import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { cleanEnv } from "./diff.js";

export interface Workspace {
  workdir: string;
  branch?: string;
}

// no hook and no monitor of the repository runs
const SAFE_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...SAFE_OPTIONS, ...args], { cwd, encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A file the queue puts into the workspace of a run (e.g. the pictures of a change request): `name` is `dir/file.ext`, `from` an absolute file. */
export interface RunInputFile {
  name: string;
  from: string;
}

/** The fixed reason of a run whose input files could not be copied. */
export const INPUT_FILES_MISSING = "INPUT_FILES_MISSING";
const INPUT_NAME = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[a-z0-9]{1,5}$/;

/** Copies the files into the workdir. Any problem throws Error(INPUT_FILES_MISSING). */
export function copyInputFiles(workdir: string, files: readonly RunInputFile[]): void {
  try {
    for (const f of files) {
      if (!INPUT_NAME.test(f.name) || !isAbsolute(f.from) || !lstatSync(f.from).isFile()) throw new Error("bad input file");
      const to = join(workdir, f.name);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(f.from, to, constants.COPYFILE_EXCL);
    }
  } catch {
    throw new Error(INPUT_FILES_MISSING);
  }
}

/** Removes `pictures/` from each workdir that exists. Never throws. */
export function removeRunPictureCopies(workdirs: readonly string[]): void {
  for (const w of workdirs) {
    try {
      if (existsSync(w)) rmSync(join(w, "pictures"), { recursive: true, force: true });
    } catch {
      // best effort: the copy goes with the workdir
    }
  }
}

export function repoRoot(dir: string): string | undefined {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

export function prepareWorkspace(
  mode: "worktree" | "inplace" | "empty",
  repo: string,
  runDir: string,
  runId: string,
): Workspace {
  if (mode === "inplace") return { workdir: repo };
  if (mode === "empty") {
    const workdir = join(runDir, "workspace");
    mkdirSync(workdir, { recursive: true });
    return { workdir };
  }

  const root = repoRoot(repo);
  if (!root) throw new Error(`workspace "worktree" needs a git repository, but ${repo} is not one`);
  try {
    git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`workspace "worktree" needs at least one commit in ${root}`);
  }
  const branch = `factory/${runId}`;
  const workdir = join(runDir, "workspace");
  git(root, ["worktree", "add", "-b", branch, workdir, "HEAD"]);
  return { workdir, branch };
}
