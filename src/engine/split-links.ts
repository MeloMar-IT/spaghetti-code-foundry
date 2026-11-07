/**
 * The split parts of an issue, kept apart from the refinement sessions (#786). A session is dropped and then removed
 * after 30 days, which would take its parts out of the spending of the issue family. A replacement writes its link here
 * once, and the family accounting reads it next to the sessions. File: `<data>/split-links.json`, `{ "github:owner/name#5": [6, 7] }`.
 */
import { join } from "node:path";
import { readPolicyFile } from "./policy-hooks.js";
import { writeAtomic } from "./policy-store.js";

export const SPLIT_LINKS_FILE = "split-links.json";
const MAX_PARENTS = 5000;
const MAX_PARTS = 500;
const FILE_MAX_BYTES = 4 * 1024 * 1024;
const PARENT_KEY = /^github:[^#\s]+#[1-9]\d{0,9}$/;

const fileOf = (home: string): string => join(home, SPLIT_LINKS_FILE);

/** The recorded parts per parent issue. `{}` when the file is missing, invalid or a link. */
export function readSplitLinks(home: string): Record<string, number[]> {
  const r = readPolicyFile(fileOf(home), FILE_MAX_BYTES);
  if (!("text" in r)) return {};
  try {
    const doc = JSON.parse(r.text) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      if (PARENT_KEY.test(k) && Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && n > 0)) out[k] = v as number[];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Records that issue `parent` of `repo` was replaced by `parts`. Merges with what is there and keeps the newest 5000 parents.
 * THROWS when the file cannot be written: the caller must not treat the family as complete then.
 */
export function rememberSplit(home: string, repo: string, parent: number, parts: readonly number[]): void {
  const key = `github:${repo.toLowerCase()}#${parent}`;
  if (!PARENT_KEY.test(key)) return;
  const all = readSplitLinks(home);
  const merged = [...new Set([...(all[key] ?? []), ...parts])].filter((n) => n > 0 && n !== parent).slice(0, MAX_PARTS);
  delete all[key];
  all[key] = merged; // re-inserted last: the newest
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PARENTS))) delete all[k];
  writeAtomic(fileOf(home), JSON.stringify(all, null, 2));
}
