import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "../evidence/identity.js";
import { contextBundleRef, isSourceText, serializeContextBundle } from "./bundle.js";
import type { ContextBundle } from "./schema.js";
import { CONTEXT_BUNDLE_FILE, CONTEXT_SOURCES_DIR } from "./version.js";

/**
 * Writing a context bundle into a folder: the text of every source under `context/`, then `context.json`.
 * Nothing calls this yet: giving a run its context is the next step (#153).
 */

export type ContextStoreErrorCode = "no-folder" | "exists" | "texts-do-not-match" | "write-failed";

/** The bundle was not written. The message is a fixed code: never a path of this machine. */
export class ContextStoreError extends Error {
  constructor(readonly code: ContextStoreErrorCode) {
    super(`context store: ${code}`);
    this.name = "ContextStoreError";
  }
}

const isFolder = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory(); // lstat: a link to a folder is not a folder here
  } catch {
    return false;
  }
};
const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Writes `bundle` and the text of its sources into `folder` (the run folder) and returns how evidence names
 * `context.json`.
 *
 * - Everything is checked before the first byte is written: the bundle is valid, `texts` has exactly one text per
 *   source and each has the size and the SHA-256 the bundle records.
 * - Nothing is ever replaced: a folder that already has `context.json` or `context/` is refused, and every file is
 *   made new (a file or link that is in the way makes the write fail).
 * - `context.json` is written last, so a bundle is never there without its texts.
 * Throws ContextSchemaError for a bundle that is not valid, else ContextStoreError.
 */
export function writeContextBundle(folder: string, bundle: ContextBundle, texts: ReadonlyMap<string, Uint8Array>): ArtifactRef {
  const text = serializeContextBundle(bundle);
  if (texts.size !== bundle.sources.length) throw new ContextStoreError("texts-do-not-match");
  for (const s of bundle.sources) {
    const data = texts.get(s.content.path);
    if (data === undefined || !isSourceText(s, data)) throw new ContextStoreError("texts-do-not-match");
  }
  if (!isFolder(folder)) throw new ContextStoreError("no-folder");
  const sourcesDir = join(folder, CONTEXT_SOURCES_DIR);
  const bundleFile = join(folder, CONTEXT_BUNDLE_FILE);
  if (exists(sourcesDir) || exists(bundleFile)) throw new ContextStoreError("exists");
  try {
    mkdirSync(sourcesDir, { mode: 0o700 }); // not recursive: fails when something appeared in between
    for (const s of bundle.sources) {
      // content.path is "context/<name>" by the schema, and may name a file in a folder below it.
      const parts = s.content.path.split("/");
      for (let i = 2; i < parts.length; i++) {
        const dir = join(folder, ...parts.slice(0, i));
        if (!isFolder(dir)) mkdirSync(dir, { mode: 0o700 });
      }
      writeFileSync(join(folder, ...parts), texts.get(s.content.path) as Uint8Array, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(bundleFile, text, { flag: "wx", mode: 0o600 });
  } catch {
    throw new ContextStoreError("write-failed");
  }
  return contextBundleRef(bundle);
}
