import type { Step } from "../flow/schema.js";
import { runChangedPaths, ensurePathsBase } from "./diff.js";
import type { Engine, Scope } from "./execute.js";
import { sandboxedRun } from "./os-sandbox.js";
import { shortEnvRun } from "./short-env.js";

/** The Docker image a sandboxed shell step of this flow runs in, if any. */
export const shellImage = (scope: Scope, engine: Engine): string | undefined => scope.flow.sandbox.docker_image ?? engine.config.sandbox.docker_image;

/**
 * The `sandboxed` fact of a step at `step.before`: only a shell step has one. It matches how the step is run: the OS sandbox
 * (a user's run with the short environment) or a Docker image. A refused sandbox does not count as "on".
 */
export function shellSandboxed(engine: Engine, scope: Scope, step: Pick<Step, "type"> & { sandbox?: boolean }): boolean | undefined {
  if (step.type !== "shell") return undefined;
  return (sandboxedRun(engine.summary.owner, engine.config) === "on" && shortEnvRun(engine.summary.owner)) || Boolean(step.sandbox && shellImage(scope, engine));
}

/**
 * The `paths` fact of a step at `step.after`: the files the run changed, or undefined when that cannot be known.
 * Only worked out when a pack asks for it; otherwise it only makes sure the empty-workspace base is read. Never throws.
 */
export async function stepAfterPaths(engine: Engine): Promise<string[] | undefined> {
  try {
    const opts = { signal: engine.signal };
    if (engine.policy?.needsFact("step.after", "paths")) return await runChangedPaths(engine.summary, opts);
    await ensurePathsBase(engine.summary, opts);
  } catch {
    // not known
  }
  return undefined;
}
