import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_BUILD_FLOW, RELEASE_BUILD_VAR } from "../release/auto-build.js";
import { claimCommit, validCommit } from "../release/build-claims.js";
import { readPlainFile } from "./os-sandbox.js";

/**
 * A release-build run that a watcher started by itself takes the commit its `resolve` step found, in the server's own data folder
 * (a sandboxed step cannot write there, so the server does it after the step). A commit that was built, tried or skipped before is
 * not built again: the plan becomes a "skip" plan, which `build` and `upload` leave alone. Returns a log line, or undefined.
 */
export function claimAfterResolve(o: { flow: string; stepId: string; ok: boolean; runDir: string; runId: string; vars: Record<string, string> }): string | undefined {
  if (o.flow !== RELEASE_BUILD_FLOW || o.stepId !== "resolve" || !o.ok || !o.vars[RELEASE_BUILD_VAR]) return undefined;
  const planFile = join(o.runDir, "release", "plan.json");
  let sha: unknown;
  try {
    sha = (JSON.parse(readPlainFile(planFile)) as { sha?: unknown }).sha;
  } catch {
    return undefined; // no usable plan: the build step reports it
  }
  if (!validCommit(sha)) return undefined;
  if (claimCommit(o.vars.github_repo ?? "", o.vars.ref || "main", sha, o.runId)) return `  commit ${sha.slice(0, 7)} taken by this run`;
  writeFileSync(planFile, JSON.stringify({ sha, skip: "this commit was handled before" }, null, 2));
  return `  commit ${sha.slice(0, 7)} was handled before: nothing is built or uploaded`;
}
