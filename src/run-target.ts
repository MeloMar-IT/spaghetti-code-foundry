import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { validGithubName } from "./auth/repo-url.js";

const OWNER_NAME = /^[^/\s]+\/[^/\s]+$/;

/** True when `value` is written like a GitHub repository ("owner/name") and not like a path we know. */
export const looksLikeGithubRepo = (value: string) => OWNER_NAME.test(value) && validGithubName(value);

/**
 * What `scf run … --repo X --ref Y` means: a folder (as always), or for a flow with `workspace: empty` a GitHub repository
 * "owner/name" (when no such folder exists), which sets the variable github_repo. `--ref` sets the variable ref.
 */
export function runTarget(o: {
  repoArg?: string;
  ref?: string;
  vars: Record<string, string>;
  cwd: string;
  workspace: string | undefined;
  exists?: (p: string) => boolean;
}): { repo: string; vars: Record<string, string> } {
  const exists = o.exists ?? existsSync;
  const vars = { ...o.vars };
  const set = (name: string, value: string, flag: string) => {
    if (vars[name] !== undefined && vars[name] !== value) throw new Error(`${flag} "${value}" conflicts with --var ${name}=${vars[name]}; use one of them`);
    vars[name] = value;
  };
  let repo = resolve(o.cwd, o.repoArg ?? ".");
  if (o.repoArg !== undefined && !exists(repo)) {
    if (looksLikeGithubRepo(o.repoArg) && o.workspace === "empty") {
      repo = resolve(o.cwd);
      set("github_repo", o.repoArg, "--repo");
    } else if (looksLikeGithubRepo(o.repoArg)) {
      throw new Error(`repo not found: ${repo}. "${o.repoArg}" looks like a GitHub repository, but only a flow that clones it itself (workspace: empty, e.g. release-build) takes owner/name; use --var github_repo=${o.repoArg} or a folder`);
    } else throw new Error(`repo not found: ${repo}`);
  }
  if (o.ref !== undefined) {
    if (!o.ref.trim()) throw new Error("--ref is empty; give a branch, tag or commit");
    set("ref", o.ref.trim(), "--ref");
  }
  return { repo, vars };
}
