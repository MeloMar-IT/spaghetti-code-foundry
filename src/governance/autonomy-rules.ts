import { appendFileSync } from "node:fs";

/**
 * What each autonomy level allows. This file imports only `node:` modules on purpose: the tools (`tools/story`,
 * `tools/daily-branch`) load it from `dist/` inside a Docker container, which mounts no `node_modules`. The schema
 * side of the levels (zod) is in `autonomy.ts`, which re-exports this.
 */
const LEVELS = ["observe", "plan-only", "guarded-write", "delivery-handoff"] as const;

export type AutonomyAction = "agent-write" | "repo-access" | "push" | "pull-request";

/** The reason code of a denial in the evidence. */
export const AUTONOMY_DENIED = "autonomy.denied";
/** The policy a denial names in the evidence. */
export const AUTONOMY_POLICY = { id: "foundry.autonomy", version: "1" };
export const AUTONOMY_NEXT_STEP = "promote the repository or flow";

/** The lowest level that allows an action. */
const LOWEST: Record<AutonomyAction, number> = { "repo-access": 1, "agent-write": 2, push: 3, "pull-request": 3 };

const WHAT: Record<AutonomyAction, string> = {
  "agent-write": "a writing agent step",
  "repo-access": "a repo_access shell step",
  push: "a push",
  "pull-request": "a pull request",
};

/** Does this level refuse the action? A string that is not a level reads as `observe`. */
export function autonomyRefuses(level: string, action: AutonomyAction): boolean {
  return LEVELS.indexOf(level as (typeof LEVELS)[number]) < LOWEST[action];
}

/** The fixed sentence of a refusal. `level` is used as given (the pre-push hook passes the shell text `$FACTORY_NO_PUSH`). */
export function autonomyRefusal(level: string, action: AutonomyAction): string {
  return `autonomy ${level} does not allow ${WHAT[action]}; next step: ${AUTONOMY_NEXT_STEP}`;
}

/**
 * For a tool that opens or merges a pull request: the refusal sentence when the step runs below `delivery-handoff`
 * (the engine sets `FACTORY_NO_PUSH` to the level then), otherwise undefined. A refusal is also noted in
 * `FACTORY_PUSH_LOG`, so the engine fails the step and records it even when the step swallows the exit code.
 */
export function pullRequestRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const flag = env.FACTORY_NO_PUSH;
  if (!flag) return undefined;
  const level = LEVELS.includes(flag as (typeof LEVELS)[number]) ? flag : "observe";
  const log = env.FACTORY_PUSH_LOG;
  if (log) {
    try {
      appendFileSync(log, "-\t\t\t\tpull-request\n");
    } catch {
      // the refusal still stands; only its record is lost
    }
  }
  return autonomyRefusal(level, "pull-request");
}
