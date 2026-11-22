import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flowDir, parseFlow } from "../flow/load.js";
import type { Flow } from "../flow/schema.js";

// A run resumes the flow it was saved with, not the file on disk. A run saved from the shipped issue-gitflow before
// push_develop pushed only the tested commit would keep the unguarded steps. Such a run is upgraded to the current three steps.
// Only an exact copy of the shipped flow before this change is upgraded (matched by the digest of its three step scripts).
// Any other copy of issue-gitflow (an override with the same name) keeps its steps, and is refused if it pushes develop unchecked.
const STEPS = ["merge_develop", "test_develop", "push_develop"] as const;
/** sha256 of the JSON array of the scripts of merge_develop, test_develop and push_develop as shipped before the tested-commit check. */
export const HISTORICAL_GITFLOW_DIGEST = "f3d808b5b09741c6d63d341459f6f662b4997052da95d3e70f9b9449801eeda9";
const MARKER = "develop-tested";

function scripts(flow: Flow): (string | undefined)[] {
  return STEPS.map((id) => {
    const s = flow.steps.find((x) => x.id === id);
    return s && s.type === "shell" ? s.run : undefined;
  });
}

const digestOf = (runs: (string | undefined)[]): string => createHash("sha256").update(JSON.stringify(runs)).digest("hex");

/** The text that makes a saved flow refuse an unchecked push, or undefined when the flow is fine. */
export function gitflowRefusal(flow: Flow): string | undefined {
  if (flow.name !== "issue-gitflow") return undefined;
  const push = scripts(flow)[2];
  if (push === undefined || push.includes(MARKER)) return undefined;
  return "this run uses a copy of issue-gitflow that pushes develop without checking the tested commit, so it cannot be resumed. " +
    "Start a new run for the issue, or use the shipped issue-gitflow flow.";
}

/** True when the saved flow is the shipped issue-gitflow from before the tested-commit check, and its steps were replaced (the caller saves the run). */
export function upgradeGitflowSteps(flow: Flow, builtinDir: string = flowDir("builtin", "")): boolean {
  if (flow.name !== "issue-gitflow") return false;
  if (digestOf(scripts(flow)) !== HISTORICAL_GITFLOW_DIGEST) return false;
  let current: Flow;
  try {
    current = parseFlow(readFileSync(join(builtinDir, "issue-gitflow.yaml"), "utf8"));
  } catch {
    return false; // the shipped file cannot be read: leave the run as it is
  }
  const fresh = STEPS.map((id) => current.steps.find((s) => s.id === id));
  if (fresh.some((s) => !s)) return false;
  flow.steps = flow.steps.map((s) => {
    const i = STEPS.indexOf(s.id as (typeof STEPS)[number]);
    return i < 0 ? s : structuredClone(fresh[i]!);
  });
  return true;
}
