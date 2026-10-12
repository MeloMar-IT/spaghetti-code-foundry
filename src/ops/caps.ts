import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";

/** A temporary limit on how many runs may work at once, set by a helper process. It ends by itself at `until`. */
export interface Cap { runs: number; until: string; why: string }

/** Who set it ("load", "limits") → the cap. */
export type Caps = Record<string, Cap>;

/**
 * The caps file of installs before each helper had its own file: <data folder>/governor/caps.json. It is still
 * read, so an upgrade does not lose a cap that holds. The caps themselves are next to it, one file per helper:
 * <data folder>/governor/caps/<who>.json — two helpers never write the same file.
 */
export const capsPath = (home = process.env.FACTORY_HOME ?? FACTORY_HOME) => join(home, "governor", "caps.json");
const capsDir = (path: string) => join(dirname(path), "caps");
const usable = (c: Cap | undefined): c is Cap => !!c && Number.isInteger(c.runs) && c.runs >= 1 && typeof c.until === "string";
const read = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
/** Written under a name of this process and moved in place: a reader never sees half a file, two writers never share a temp file. */
function writeWhole(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function loadCaps(path = capsPath()): Caps {
  const old = read<Caps>(path);
  const caps: Caps = old && typeof old === "object" ? Object.fromEntries(Object.entries(old).filter(([, c]) => usable(c))) : {};
  let names: string[] = [];
  try {
    names = readdirSync(capsDir(path));
  } catch {
    // no helper set a cap yet
  }
  for (const name of names) {
    if (!/^[\w-]+\.json$/.test(name)) continue;
    const c = read<Cap>(join(capsDir(path), name));
    // a helper's own file is newer than what the old shared file says about it
    if (usable(c)) caps[name.slice(0, -5)] = c;
    else delete caps[name.slice(0, -5)];
  }
  return caps;
}

/** Set or (with undefined) remove the cap of one helper. Only that helper's file is written. */
export function setCap(who: string, cap: Cap | undefined, path = capsPath()) {
  if (!/^[\w-]+$/.test(who)) throw new Error(`not a helper name: ${who}`);
  const file = join(capsDir(path), `${who}.json`);
  if (cap) {
    mkdirSync(capsDir(path), { recursive: true });
    writeWhole(file, JSON.stringify(cap, null, 2));
  } else rmSync(file, { force: true });
  // The old shared file: take this helper's entry out once, so it cannot come back when the helper lifts its cap.
  const old = read<Caps>(path);
  if (!old || typeof old !== "object" || !(who in old)) return;
  delete old[who];
  try {
    if (Object.keys(old).length) writeWhole(path, JSON.stringify(old, null, 2));
    else rmSync(path, { force: true });
  } catch {
    // another helper cleaned it at the same moment
  }
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
