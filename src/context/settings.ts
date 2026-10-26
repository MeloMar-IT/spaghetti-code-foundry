import { z } from "zod";
import { CONTEXT_CLASSIFICATIONS, CONTEXT_CONSUMERS, CONTEXT_MAX_AGE_SECONDS_LIMIT, CONTEXT_MAX_ENTRIES, type ContextConsumer } from "./schema.js";
import type { ContextSelectorSettings } from "./select.js";

/**
 * The `context:` section of config.yaml: the limits and the privacy of the context a run is given. The keys are read
 * from the next step (#696 part 2) on; until then no run behaves differently. Every message is fixed and never has the
 * value in it, and an error is reported at `context.<field>`.
 */

const M_SOURCES = `must be a whole number from 1 to ${CONTEXT_MAX_ENTRIES}`;
const M_BYTES = "must be a whole number of bytes, at least 1";
const M_CLASS = `must be one of ${CONTEXT_CLASSIFICATIONS.join(", ")}`;
const M_CONSUMERS = `must be a list of ${CONTEXT_CONSUMERS.join(", ")}: at least one, each at most once`;
const M_AGE = `must be null or a whole number of seconds from 1 to ${CONTEXT_MAX_AGE_SECONDS_LIMIT}`;

const wholeBytes = () => z.number({ error: M_BYTES }).int({ error: M_BYTES }).min(1, { error: M_BYTES });

const isConsumerList = (v: unknown[]): boolean =>
  v.length >= 1 && v.length <= CONTEXT_CONSUMERS.length && v.every((c) => (CONTEXT_CONSUMERS as readonly unknown[]).includes(c)) && new Set(v).size === v.length;

export const ContextSettingsSchema = z
  .object({
    max_sources: z.number({ error: M_SOURCES }).int({ error: M_SOURCES }).min(1, { error: M_SOURCES }).max(CONTEXT_MAX_ENTRIES, { error: M_SOURCES }).default(200),
    max_source_bytes: wholeBytes().default(262_144),
    max_total_bytes: wholeBytes().default(2_097_152),
    classification: z.enum(CONTEXT_CLASSIFICATIONS, { error: M_CLASS }).default("internal"),
    max_classification: z.enum(CONTEXT_CLASSIFICATIONS, { error: M_CLASS }).default("restricted"),
    // A plain list checked once, so an error is at `context.consumers`, not at an item.
    consumers: z
      .array(z.unknown(), { error: M_CONSUMERS })
      .refine(isConsumerList, { error: M_CONSUMERS })
      .transform((v) => v as ContextConsumer[])
      .default(() => [...CONTEXT_CONSUMERS]),
    task_max_age_seconds: z.number({ error: M_AGE }).int({ error: M_AGE }).min(1, { error: M_AGE }).max(CONTEXT_MAX_AGE_SECONDS_LIMIT, { error: M_AGE }).nullable().default(null),
  })
  // Not .strict(): that reports one issue at `context`. This reports one per unknown key, at `context.<key>`.
  .catchall(z.custom<never>(() => false, { error: "is not a context setting" }))
  .superRefine((s, ctx) => {
    // Checked even when a field above failed, so only for values that are valid on their own: one line per mistake.
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
    if (ok(s.max_source_bytes) && ok(s.max_total_bytes) && s.max_source_bytes > s.max_total_bytes) ctx.addIssue({ code: "custom", path: ["max_source_bytes"], message: "must not be above max_total_bytes" });
  });
export type ContextSettings = z.output<typeof ContextSettingsSchema>;

export type ContextSelectorInputSettings = Pick<ContextSelectorSettings, "budget" | "classification" | "maxClassification" | "consumers" | "taskMaxAgeSeconds">;

/** The settings as the selector takes them. */
export function contextSelectorInput(s: ContextSettings): ContextSelectorInputSettings {
  return {
    budget: { maxSources: s.max_sources, maxSourceBytes: s.max_source_bytes, maxTotalBytes: s.max_total_bytes },
    classification: s.classification,
    maxClassification: s.max_classification,
    consumers: [...s.consumers],
    taskMaxAgeSeconds: s.task_max_age_seconds,
  };
}
