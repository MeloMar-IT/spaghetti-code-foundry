import { basename } from "node:path";

// The name of a connected local repository. This file imports nothing but Node.js built-ins, so `stories/store.ts` can use it in a
// process that has no node_modules (the story tool in a container).

/** A local repository is known by this string, never by a GitHub `owner/name`. */
export const LOCAL_NAME_RE = /^local:[a-z0-9][a-z0-9._-]{0,39}-[0-9a-f]{8}$/;
export const isLocalRepoName = (name: string): boolean => typeof name === "string" && LOCAL_NAME_RE.test(name);

/** `local:<slug>-<first 8 hex of the record id>`. */
export function localRepoName(rec: { id: string; url: string }): string {
  let slug = basename(rec.url)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40);
  if (!slug) slug = "repo";
  return "local:" + slug + "-" + rec.id.slice(0, 8).toLowerCase();
}
