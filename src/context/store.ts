import { closeSync, lstatSync, mkdirSync, openSync, rmdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "../evidence/identity.js";
import { contextBundleRef, isSourceText, serializeContextBundle } from "./bundle.js";
import type { ContextBundle } from "./schema.js";
import { CONTEXT_BUNDLE_FILE, CONTEXT_SOURCES_DIR } from "./version.js";

/**
 * Writing a context bundle into a folder: the text of every source under `context/`, then `context.json`.
 * The engine calls it once per issue run, just before the first agent step (see engine/run-context.ts).
 */

export type ContextStoreErrorCode = "no-folder" | "exists" | "texts-do-not-match" | "write-failed";

/** The bundle was not written. The message is a fixed code: never a path of this machine. */
export class ContextStoreError extends Error {
  constructor(readonly code: ContextStoreErrorCode) {
    super(`context store: ${code}`);
    this.name = "ContextStoreError";
  }
}

/** Hooks for tests. */
export interface ContextStoreHooks {
  /** Runs after the "exists" check, before the first folder is made. */
  afterCheck?: () => void;
  /** Runs after each file is opened and recorded, context.json included. */
  afterOpen?: (path: string) => void;
}

const isFolder =(path: string): boolean => {
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
 * - On a failure, everything it made is removed again, last first and never recursively; files and folders it did not
 *   make stay.
 * Throws ContextSchemaError for a bundle that is not valid, else ContextStoreError.
 */
export function writeContextBundle(folder: string, bundle: ContextBundle, texts: ReadonlyMap<string, Uint8Array>, hooks: ContextStoreHooks = {}): ArtifactRef {
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
  // Everything this call makes, in order, so a failure can take it away again and nothing else.
  const made: { path: string; folder: boolean }[] = [];
  const makeFolder = (path: string) => {
    mkdirSync(path, { mode: 0o700 }); // not recursive: fails when something appeared in between
    made.push({ path, folder: true });
  };
  const writeNew = (path: string, data: Uint8Array) => {
    const fd = openSync(path, "wx", 0o600);
    try {
      made.push({ path, folder: false });
      hooks.afterOpen?.(path);
      for (let at = 0; at < data.length; ) at += writeSync(fd, data, at, data.length - at);
    } finally {
      closeSync(fd);
    }
  };
  try {
    hooks.afterCheck?.();
    makeFolder(sourcesDir);
    for (const s of bundle.sources) {
      // content.path is "context/<name>" by the schema, and may name a file in a folder below it.
      const parts = s.content.path.split("/");
      for (let i = 2; i < parts.length; i++) {
        const dir = join(folder, ...parts.slice(0, i));
        if (!isFolder(dir)) makeFolder(dir);
      }
      writeNew(join(folder, ...parts), texts.get(s.content.path) as Uint8Array);
    }
    writeNew(bundleFile, Buffer.from(text, "utf8"));
  } catch {
    for (const m of made.reverse()) {
      try {
        if (m.folder) rmdirSync(m.path);
        else rmSync(m.path);
      } catch {
        // not empty (a foreign file is in it) or already gone: leave it
      }
    }
    throw new ContextStoreError("write-failed");
  }
  return contextBundleRef(bundle);
}
