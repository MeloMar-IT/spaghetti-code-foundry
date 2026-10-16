import { z } from "zod";
import { ACTIONS, AboutSchema } from "./contract.js";

/** What an approved action ended as, read back from the run. */
export const OUTCOME_RESULTS = ["done", "queued", "start-failed", "missing", "unconfirmed", "dequeued", "stopped", "stopping", "not-done"] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];
/** The status of the run as the server saw it when it read it back. */
export const SEEN = ["running", "succeeded", "failed", "cancelled", "stopped", "waiting", "missing", "unknown"] as const;
export type Seen = (typeof SEEN)[number];
/** A reply keeps its newest outcomes only. */
export const OUTCOMES_KEPT = 10;

export const OutcomeSchema = z
  .object({
    action: z.string().refine((id) => ACTIONS.some((a) => a.id === id)),
    about: AboutSchema,
    result: z.enum(OUTCOME_RESULTS),
    words: z.string().min(1).max(500),
    recovery: z.string().min(1).max(500),
    seen: z.enum(SEEN),
    at: z.iso.datetime(),
  })
  .strict();
export type Outcome = z.infer<typeof OutcomeSchema>;
