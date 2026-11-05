import { z } from "zod";
import { WORKSPACE_ID_RE } from "../workspaces/list.js";

/**
 * The shape of a usage event. Kept apart from the builders in events.ts: this file imports nothing from the engine, so the
 * hub and the plugin loader can use it without an import cycle through config.ts.
 */

const ID = z.string().min(1).max(200).regex(/^[\w.:-]+$/);
const LABEL = z.string().min(1).max(200).regex(/^[\w./:-]+$/);
const COUNT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const USD = z.number().nonnegative().finite();
const ISSUE = z.number().int().min(1).max(9_999_999_999);
export const REASON_KINDS = ["none", "code", "factory", "limit", "decision"] as const;

const base = {
  id: ID,
  time: z.string().datetime(),
  runId: ID,
  repository: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/).optional(),
  issue: ISSUE.optional(),
  /** The workspace id of the run (#816); "default" when it has none. */
  workspace: z.string().regex(WORKSPACE_ID_RE),
};

export const UsageEventSchema = z.discriminatedUnion("name", [
  z.object({ ...base, name: z.literal("run.started") }).strict(),
  z
    .object({ ...base, name: z.literal("run.finished"), status: z.enum(["succeeded", "failed", "cancelled"]), reason: z.enum(REASON_KINDS), durationMs: COUNT, costUsd: USD })
    .strict(),
  z
    .object({
      ...base,
      name: z.literal("step.finished"),
      step: LABEL,
      stepType: z.string().min(1).max(40).regex(/^[\w-]+$/),
      ok: z.boolean(),
      agent: z.string().min(1).max(40).regex(/^[\w-]+$/).optional(),
      provider: LABEL.optional(),
      model: LABEL.optional(),
      tokensIn: COUNT.optional(),
      tokensCached: COUNT.optional(),
      tokensOut: COUNT.optional(),
      costUsd: USD.nullable(),
      durationMs: COUNT,
      earlierCostUsd: USD,
    })
    .strict(),
  z.object({ ...base, name: z.literal("issue.done") }).strict(),
  z.object({ ...base, name: z.literal("issue.split"), parent: ISSUE.optional(), parts: z.array(ISSUE).max(100) }).strict(),
  z.object({ ...base, name: z.literal("issue.failed") }).strict(),
]);

export type UsageEvent = z.infer<typeof UsageEventSchema>;
/** What `api.onUsage` takes. The event is a frozen copy. */
export type UsageHandler = (event: Readonly<UsageEvent>) => void | Promise<void>;
