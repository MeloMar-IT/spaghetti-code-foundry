import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { ConfigSchema, parseConfigText } from "../src/config.js";
import { CONTEXT_CONSUMERS, CONTEXT_MAX_AGE_SECONDS_LIMIT } from "../src/context/schema.js";
import { ContextSelectorSettingsSchema } from "../src/context/select.js";
import { ContextSettingsSchema, contextSelectorInput } from "../src/context/settings.js";

const DEFAULTS = {
  max_sources: 200,
  max_source_bytes: 262_144,
  max_total_bytes: 2_097_152,
  classification: "internal",
  max_classification: "restricted",
  consumers: [...CONTEXT_CONSUMERS],
  task_max_age_seconds: null,
};

const errors = (context: unknown): string => {
  try {
    parseConfigText(stringify({ context }), "config.yaml");
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
const lines = (message: string) => message.split("\n").filter((l) => l.startsWith("  - context."));

const SOURCES = "must be a whole number from 1 to 1000";
const BYTES = "must be a whole number of bytes, at least 1";
const CONSUMERS = "must be a list of planner, coder, reviewer, tester: at least one, each at most once";
const AGE = "must be null or a whole number of seconds from 1 to 315360000";

describe("the context: settings", () => {
  it("has the defaults", () => {
    expect(ConfigSchema.parse({}).context).toEqual(DEFAULTS);
    expect(ContextSettingsSchema.parse({})).toEqual(DEFAULTS);
  });

  it("maps to what the selector takes", () => {
    const out = contextSelectorInput(ContextSettingsSchema.parse({}));
    expect(ContextSelectorSettingsSchema.parse(out)).toEqual({
      budget: { maxSources: 200, maxSourceBytes: 262_144, maxTotalBytes: 2_097_152 },
      classification: "internal",
      maxClassification: "restricted",
      consumers: [...CONTEXT_CONSUMERS],
      taskMaxAgeSeconds: null,
    });
    const custom = ContextSettingsSchema.parse({ max_sources: 1, max_source_bytes: 10, max_total_bytes: 10, classification: "public", consumers: ["coder"], task_max_age_seconds: 60 });
    expect(ContextSelectorSettingsSchema.parse(contextSelectorInput(custom))).toEqual({
      budget: { maxSources: 1, maxSourceBytes: 10, maxTotalBytes: 10 },
      classification: "public",
      maxClassification: "restricted",
      consumers: ["coder"],
      taskMaxAgeSeconds: 60,
    });
  });

  it("accepts the edges", () => {
    for (const max_sources of [1, 1000]) expect(ContextSettingsSchema.parse({ max_sources }).max_sources).toBe(max_sources);
    for (const task_max_age_seconds of [null, 1, CONTEXT_MAX_AGE_SECONDS_LIMIT]) expect(ContextSettingsSchema.parse({ task_max_age_seconds }).task_max_age_seconds).toBe(task_max_age_seconds);
    expect(ContextSettingsSchema.parse({ max_source_bytes: 5, max_total_bytes: 5 }).max_source_bytes).toBe(5);
  });

  // [field, value, the exact fixed message ("" when only the value must stay out of it)]
  const refused: [string, unknown, string][] = [
    ["max_sources", 0, SOURCES],
    ["max_sources", 1001, SOURCES],
    ["max_sources", 987654, SOURCES],
    ["max_sources", 1.5, SOURCES],
    ["max_sources", "abc", SOURCES],
    ["max_source_bytes", 0, BYTES],
    ["max_total_bytes", -1, BYTES],
    ["classification", "zz-secret-zz", "must be one of public, internal, confidential, restricted"],
    ["max_classification", "zz-secret-zz", "must be one of public, internal, confidential, restricted"],
    ["consumers", [], CONSUMERS],
    ["consumers", ["coder", "coder"], CONSUMERS],
    ["consumers", ["zz-secret-zz"], CONSUMERS],
    ["consumers", "coder", CONSUMERS],
    ["task_max_age_seconds", 0, AGE],
    ["task_max_age_seconds", CONTEXT_MAX_AGE_SECONDS_LIMIT + 1, AGE],
    ["zz_key", "zz-secret-zz", "is not a context setting"],
  ];
  it.each(refused)("refuses %s = %j with one fixed line", (field, value, message) => {
    const text = errors({ [field]: value });
    expect(lines(text)).toEqual([`  - context.${field}: ${message}`]);
    // the value is never echoed (the boundary values are part of the fixed messages, so only distinctive ones are checked)
    if (value === "zz-secret-zz" || value === 987654) expect(text).not.toContain(String(value));
    if (Array.isArray(value) && value[0] === "zz-secret-zz") expect(text).not.toContain("zz-secret-zz");
  });

  it("refuses a source above the total, without the numbers", () => {
    const text = errors({ max_source_bytes: 3000001, max_total_bytes: 3000000 });
    expect(lines(text)).toEqual(["  - context.max_source_bytes: must not be above max_total_bytes"]);
    expect(text).not.toContain("3000001");
    expect(text).not.toContain("3000000");
  });
});
