import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FACTORY_HOME } from "../flow/load.js";

/** What the analyst set for one step: a model spec, an effort, or both. */
const Override = z.object({
  model: z.string().min(1).max(120).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});
export type Override = z.infer<typeof Override>;

/** flow name → step id → override. Kept in <data folder>/analyst/overrides.json. */
const Overrides = z.record(z.string(), z.record(z.string(), Override));
export type Overrides = z.infer<typeof Overrides>;

export const overridesPath = (home = process.env.FACTORY_HOME ?? FACTORY_HOME) => join(home, "analyst", "overrides.json");

/** The stored overrides; none when the file is missing or cannot be read, so a bad file never stops a run. */
export function loadOverrides(path = overridesPath()): Overrides {
  if (!existsSync(path)) return {};
  try {
    return Overrides.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

export function saveOverrides(o: Overrides, path = overridesPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(o, null, 2));
  renameSync(path + ".tmp", path);
}

/** Read at the start of every agent step, so a change takes effect at the next step, also in a running run. */
export function stepOverride(flow: string, step: string, path = overridesPath()): Override {
  return loadOverrides(path)[flow]?.[step] ?? {};
}
