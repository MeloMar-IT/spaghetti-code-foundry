import { z } from "zod";

/**
 * Autonomy levels: how far a run may go, lowest first. A repository and a flow each have a stored maximum (see
 * `autonomy-store.ts`); a run gets the lower of the two. Nothing reads the level to allow or refuse anything yet (#643).
 */
export const AUTONOMY_LEVELS = ["observe", "plan-only", "guarded-write", "delivery-handoff"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS);

/** What a repository or flow without an entry gets, and what a run without an `autonomy` field reads as. */
export const DEFAULT_LEVEL: AutonomyLevel = "delivery-handoff";
/** What a repository gets when it is connected through the API. */
export const NEW_REPO_LEVEL: AutonomyLevel = "guarded-write";
export const SYSTEM_CONNECT = "system:connect";

/** Who set a level: an account id or a fixed `system:<actor>` string. */
export const AutonomyBySchema = z.union([z.uuid(), z.string().regex(/^system:[a-z][a-z0-9-]{0,39}$/)]);

/** The lower of two levels. */
export function lowerLevel(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_LEVELS.indexOf(a) <= AUTONOMY_LEVELS.indexOf(b) ? a : b;
}

/** The level one step up, or null at the top. */
export function nextLevel(level: AutonomyLevel): AutonomyLevel | null {
  return AUTONOMY_LEVELS[AUTONOMY_LEVELS.indexOf(level) + 1] ?? null;
}

/** The levels where a run may write or deliver: a move to one of them needs a second person (#646). */
export const SENSITIVE_LEVELS: readonly AutonomyLevel[] = ["guarded-write", "delivery-handoff"];
export const isSensitiveLevel = (level: AutonomyLevel): boolean => SENSITIVE_LEVELS.includes(level);

/** The level of a run, its two sources, and the flow's. `repository` is absent when the run has no connected repository. */
export interface RunAutonomy {
  level: AutonomyLevel;
  repository?: AutonomyLevel;
  flow: AutonomyLevel;
}

export const RunAutonomySchema = z.object({ level: AutonomyLevelSchema, repository: AutonomyLevelSchema.optional(), flow: AutonomyLevelSchema }).strict();

/** The level a stored run has: no field is `delivery-handoff` (an older run); a field that is not valid is `observe`. */
export function autonomyOfRun(run: { autonomy?: unknown }): AutonomyLevel {
  if (run.autonomy === undefined) return DEFAULT_LEVEL;
  const res = RunAutonomySchema.safeParse(run.autonomy);
  return res.success ? res.data.level : "observe";
}

/** The live-log line. */
export function autonomyLine(a: RunAutonomy): string {
  const repo = a.repository !== undefined ? `repository ${a.repository}` : "no repository";
  return `autonomy: ${a.level} (${repo}, flow ${a.flow})`;
}
