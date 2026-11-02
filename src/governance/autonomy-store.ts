import { join } from "node:path";
import { z } from "zod";
import { authLockHeld, dataHome, StoreError, withAuthLock } from "../auth/store.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import { writeAtomic } from "../engine/policy-store.js";
import { credentialProblem } from "../skills/credential-scan.js";
import { AutonomyBySchema, AutonomyLevelSchema, DEFAULT_LEVEL, lowerLevel, NEW_REPO_LEVEL, SYSTEM_CONNECT, type AutonomyLevel, type RunAutonomy } from "./autonomy.js";

/**
 * `<home>/autonomy.json`: the stored maximum autonomy level of each repository (by id) and each flow (by name). A repository
 * or flow without an entry is `delivery-handoff`. Written under the data-folder lock, through a temp file and one rename.
 * Messages never quote a value from the file or a reason.
 */

export const AUTONOMY_FILE = "autonomy.json";
export const MAX_AUTONOMY_BYTES = 1 << 20;
export const AUTONOMY_REASON_MAX = 200;
export type AutonomyKind = "repos" | "flows";

/** Bad input to a write. The message never quotes the input. */
export class AutonomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutonomyError";
  }
}

const hasControl = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s);
const validFlowName = (s: string): boolean => s.length >= 1 && s.length <= 200 && s === s.trim() && !hasControl(s);
const flowNameSchema = z.string().refine(validFlowName, "not a flow name");

export const AutonomyEntrySchema = z
  .object({ level: AutonomyLevelSchema, since: z.iso.datetime(), by: AutonomyBySchema, reason: z.string().min(1).max(AUTONOMY_REASON_MAX).optional() })
  .strict();
export const AutonomyStoreSchema = z
  .object({ version: z.literal(1), repos: z.record(z.uuid(), AutonomyEntrySchema), flows: z.record(flowNameSchema, AutonomyEntrySchema) })
  .strict();
export type AutonomyEntry = z.infer<typeof AutonomyEntrySchema>;
export type AutonomyStore = z.infer<typeof AutonomyStoreSchema>;

export const autonomyFile = (home = dataHome()): string => join(home, AUTONOMY_FILE);
export const emptyAutonomyStore = (): AutonomyStore => ({ version: 1, repos: {}, flows: {} });

/** Reads the store. A missing file is an empty store. Throws StoreError for anything else that is wrong. */
export function readAutonomy(home = dataHome()): AutonomyStore {
  const file = autonomyFile(home);
  const read = readPolicyFile(file, MAX_AUTONOMY_BYTES);
  if ("problem" in read) {
    if (read.problem === "missing") return emptyAutonomyStore();
    throw new StoreError("unreadable", file, read.problem === "too-large" ? "is larger than 1 MiB" : read.problem === "not-file" ? "is a link or not a plain file" : "could not be read");
  }
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    throw new StoreError("not-json", file, "is not valid JSON");
  }
  const res = AutonomyStoreSchema.safeParse(json);
  if (!res.success) {
    const path = res.error.issues[0]?.path.map(String).join(".") || "(root)";
    throw new StoreError("wrong-format", file, `is not valid at ${path.slice(0, 60)}`);
  }
  // zod's record may drop a key such as `__proto__`: the maps are rebuilt from the raw keys, as own properties
  const raw = json as { repos: Record<string, unknown>; flows: Record<string, unknown> };
  return { version: 1, repos: entriesOf(raw.repos), flows: entriesOf(raw.flows) };
}

/** Own properties from a raw map of entries that already passed the schema. Object.fromEntries never sets a prototype. */
const entriesOf = (m: Record<string, unknown>): Record<string, AutonomyEntry> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, AutonomyEntrySchema.parse(v)]));

const own = (m: Record<string, AutonomyEntry>, key: string): AutonomyEntry | undefined => (Object.hasOwn(m, key) ? m[key] : undefined);

export const levelOfRepo = (id: string, home = dataHome()): AutonomyLevel => own(readAutonomy(home).repos, id)?.level ?? DEFAULT_LEVEL;
export const levelOfFlow = (name: string, home = dataHome()): AutonomyLevel => own(readAutonomy(home).flows, name)?.level ?? DEFAULT_LEVEL;

/** The levels of a run from a store already read. With several repository ids the lowest wins; with none there is no `repository`. */
export function levelsOf(store: AutonomyStore, repoIds: readonly string[], flow: string): RunAutonomy {
  const flowLevel = own(store.flows, flow)?.level ?? DEFAULT_LEVEL;
  if (repoIds.length === 0) return { level: flowLevel, flow: flowLevel };
  const repository = repoIds.map((id) => own(store.repos, id)?.level ?? DEFAULT_LEVEL).reduce(lowerLevel);
  return { level: lowerLevel(repository, flowLevel), repository, flow: flowLevel };
}

/** The lower of the repository's and the flow's level; the flow's alone when there is no repository. */
export function effectiveLevel(repoId: string | undefined, flowName: string, home = dataHome()): AutonomyLevel {
  return levelsOf(readAutonomy(home), repoId === undefined ? [] : [repoId], flowName).level;
}

/** The text of a store, only when the reader would accept it and it is small enough. */
export function serializeAutonomy(store: AutonomyStore, maxBytes = MAX_AUTONOMY_BYTES): string {
  const file = autonomyFile();
  if (!AutonomyStoreSchema.safeParse(store).success) throw new StoreError("cannot-write", file, "would not be valid; nothing was written");
  const text = JSON.stringify(store, null, 2) + "\n";
  if (Buffer.byteLength(text) > maxBytes) throw new StoreError("cannot-write", file, "would be larger than 1 MiB; nothing was written");
  return text;
}

/** Sets one level. The caller holds the data-folder lock. Throws AutonomyError for bad input and StoreError for the file. */
export function setLevelLocked(kind: AutonomyKind, id: string, level: AutonomyLevel, by: string, reason?: string): AutonomyEntry {
  if (!authLockHeld()) throw new Error("setLevelLocked must run inside withAuthLock");
  if (kind !== "repos" && kind !== "flows") throw new AutonomyError("the kind must be repos or flows");
  if (kind === "repos" ? !z.uuid().safeParse(id).success : typeof id !== "string" || !validFlowName(id)) throw new AutonomyError(`the ${kind === "repos" ? "repository id" : "flow name"} is not valid`);
  if (!AutonomyLevelSchema.safeParse(level).success) throw new AutonomyError("the level is not valid");
  if (!AutonomyBySchema.safeParse(by).success) throw new AutonomyError("who set the level must be an account id or system:<actor>");
  let note: string | undefined;
  if (reason !== undefined) {
    note = reason.trim();
    if (hasControl(note)) throw new AutonomyError("the reason must not have control characters");
    if (note.length > AUTONOMY_REASON_MAX) throw new AutonomyError(`the reason is longer than ${AUTONOMY_REASON_MAX} characters`);
    if (credentialProblem(note)) throw new AutonomyError("the reason looks like a credential");
    if (note.length === 0) note = undefined;
  }
  const entry: AutonomyEntry = { level, since: new Date().toISOString(), by, ...(note ? { reason: note } : {}) };
  const store = readAutonomy(); // a throw leaves the file as it was
  const text = serializeAutonomy({ ...store, [kind]: { ...store[kind], [id]: entry } });
  writeAtomic(autonomyFile(), text);
  return entry;
}

/** Sets one level under the data-folder lock. */
export function setLevel(kind: AutonomyKind, id: string, level: AutonomyLevel, by: string, reason?: string, o: { waitMs?: number } = {}): AutonomyEntry {
  return withAuthLock(() => setLevelLocked(kind, id, level, by, reason), o.waitMs);
}

/** `addRepo`'s `beforeSave`: a newly connected repository starts at `guarded-write`. Runs under the lock. */
export const connectLevel = (id: string): void => void setLevelLocked("repos", id, NEW_REPO_LEVEL, SYSTEM_CONNECT);
