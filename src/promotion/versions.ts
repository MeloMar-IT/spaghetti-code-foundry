import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataHome, StoreError, withAuthLock } from "../auth/store.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import { writeAtomic } from "../engine/policy-store.js";
import { Sha256Schema } from "../evidence/identity.js";
import { countVersions, emptyVersionBook, type SeenHash, type VersionBook } from "./components.js";

/**
 * `<home>/promotions/versions.json`: the different hashes seen so far of each counted component, in the order they were
 * first seen. The place in the list is the version. Only `scf components record` writes it, under the data-folder lock.
 * Reasons are fixed text: they never hold a machine path or file content.
 */

export const PROMOTIONS_FOLDER = "promotions";
export const VERSIONS_FILE = "versions.json";
export const MAX_VERSIONS_BYTES = 4 << 20;

const WHAT = `${PROMOTIONS_FOLDER}/${VERSIONS_FILE}`;
const unique = (l: string[]) => new Set(l).size === l.length;

export const VersionBookSchema = z
  .object({
    version: z.literal(1),
    components: z.record(
      z.string().regex(/^(model-routes|tool-profile|context-selector)\/[a-z0-9][a-z0-9._-]{0,99}$/),
      z.array(Sha256Schema).min(1).refine(unique, "names the same hash twice"),
    ),
  })
  .strict();

export type Serialized = { ok: true; text: string } | { ok: false; reason: string };

/** The text of a book, only when the reader would accept it. */
export function serializeVersionBook(book: VersionBook, maxBytes = MAX_VERSIONS_BYTES): Serialized {
  if (!VersionBookSchema.safeParse(book).success) return { ok: false, reason: `${WHAT} would not be valid; nothing was recorded` };
  const text = JSON.stringify(book, null, 2) + "\n";
  if (Buffer.byteLength(text) > maxBytes) return { ok: false, reason: `${WHAT} would be larger than 4 MiB; nothing was recorded` };
  return { ok: true, text };
}

/** Is `<home>/promotions` missing (undefined), a plain folder (true) or anything else, a link included (false)? */
export function folderState(dir: string): boolean | undefined {
  try {
    return lstatSync(dir).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return false;
  }
}

export type VersionBookRead = { ok: true; book: VersionBook } | { ok: false; reason: string };

/** Reads the book. A missing folder or file is an empty book; a link, a large or a bad file is a reason. Never writes. */
export function readVersionBook(home = dataHome()): VersionBookRead {
  const dir = join(home, PROMOTIONS_FOLDER);
  const state = folderState(dir);
  if (state === undefined) return { ok: true, book: emptyVersionBook() };
  if (!state) return { ok: false, reason: `${PROMOTIONS_FOLDER} is a link or not a folder` };
  const read = readPolicyFile(join(dir, VERSIONS_FILE), MAX_VERSIONS_BYTES);
  if ("problem" in read) {
    if (read.problem === "missing") return { ok: true, book: emptyVersionBook() };
    if (read.problem === "not-file") return { ok: false, reason: `${WHAT} is a link or not a plain file` };
    if (read.problem === "too-large") return { ok: false, reason: `${WHAT} is larger than 4 MiB` };
    return { ok: false, reason: `${WHAT} could not be read` };
  }
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    json = undefined;
  }
  const res = VersionBookSchema.safeParse(json);
  if (!res.success) return { ok: false, reason: `${WHAT} is not valid; it is not changed, fix or restore it` };
  return { ok: true, book: res.data };
}

/** Makes `<home>/promotions` (mode 0700) when it is missing. A link or a file in its place is a reason. */
export function openPromotionsFolder(home: string): { ok: true; dir: string } | { ok: false; reason: string } {
  const dir = join(home, PROMOTIONS_FOLDER);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory()) return { ok: false, reason: `${PROMOTIONS_FOLDER} is a link or not a folder` };
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return { ok: true, dir };
}

export type RecordResult = { ok: true; versions: number[]; recorded: number } | { ok: false; reason: string };

/**
 * Gives every hash its version, adding the new ones to the book. Runs under the lock of the data folder, `dataHome()`,
 * which is also the folder that is read. Nothing is written when nothing is new, or when the result could not be read back.
 */
export function recordVersions(seen: readonly SeenHash[], o: { waitMs?: number } = {}): RecordResult {
  try {
    return withAuthLock(() => {
      const home = dataHome();
      const read = readVersionBook(home);
      if (!read.ok) return read;
      const counted = countVersions(read.book, seen);
      if (!counted.changed) return { ok: true as const, versions: counted.versions, recorded: 0 };
      const out = serializeVersionBook(counted.book);
      if (!out.ok) return out;
      const folder = openPromotionsFolder(home);
      if (!folder.ok) return folder;
      writeAtomic(join(folder.dir, VERSIONS_FILE), out.text);
      return { ok: true as const, versions: counted.versions, recorded: counted.added };
    }, o.waitMs);
  } catch (e) {
    if (e instanceof StoreError && e.kind === "locked") return { ok: false, reason: "another scf command holds the data-folder lock; try again" };
    return { ok: false, reason: `${WHAT} could not be written` };
  }
}
