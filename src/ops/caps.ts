import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";

/** A temporary limit on how many runs may work at once, set by a helper process. It ends by itself at `until`. */
export interface Cap { runs: number; until: string; why: string }

/** Who set it ("load", "limits") → the cap. Kept in <data folder>/governor/caps.json. */
export type Caps = Record<string, Cap>;

export const capsPath = (home = process.env.FACTORY_HOME ?? FACTORY_HOME) => join(home, "governor", "caps.json");

export function loadCaps(path = capsPath()): Caps {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Caps;
    return Object.fromEntries(Object.entries(raw).filter(([, c]) => c && Number.isInteger(c.runs) && c.runs >= 1 && typeof c.until === "string"));
  } catch {
    return {};
  }
}

/** Set or (with undefined) remove the cap of one helper. */
export function setCap(who: string, cap: Cap | undefined, path = capsPath()) {
  const caps = loadCaps(path);
  if (cap) caps[who] = cap;
  else delete caps[who];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(caps, null, 2));
  renameSync(path + ".tmp", path);
}

/**
 * How many runs may work at once: the configured number, lowered by the caps that still hold. A cap
 * past its `until` is ignored, so a helper that stopped can never hold the Foundry down. Never below 1.
 */
export function runLimit(configured: number, now = new Date(), path = capsPath()): number {
  const live = Object.values(loadCaps(path)).filter((c) => Date.parse(c.until) > now.getTime()).map((c) => c.runs);
  // a cap only lowers: the configured number is never raised, also not from 0 (nothing starts) to 1
  return live.length ? Math.min(configured, Math.max(1, Math.min(...live))) : configured;
}
