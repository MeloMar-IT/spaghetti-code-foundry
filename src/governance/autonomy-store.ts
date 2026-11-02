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

/** A history target as the audit lines write it: `repos:<repository id>` or `flows:<flow name>`, with the rules of the store. */
export function validTarget(t: string): boolean {
  const i = t.indexOf(":");
  if (i < 0) return false;
  const kind = t.slice(0, i);
  const id = t.slice(i + 1);
  if (kind === "repos") return z.uuid().safeParse(id).success;
  return kind === "flows" && validFlowName(id);
}

export const AutonomyEntrySchema = z
  .object({ level: AutonomyLevelSchema, since: z.iso.datetime(), by: AutonomyBySchema, reason: z.string().min(1).max(AUTONOMY_REASON_MAX).optional() })
  .strict();
/** A promotion that waits for its approval (#646). `token` binds an approval to this one request. */
export const AutonomyRequestSchema = z
  .object({
    token: z.uuid(),
    from: AutonomyLevelSchema,
    to: AutonomyLevelSchema,
    reason: z.string().min(1).max(AUTONOMY_REASON_MAX),
    by: z.uuid(),
    at: z.iso.datetime(),
    state: z.enum(["pending", "expired"]),
  })
  .strict();
export const AutonomyStoreSchema = z
  .object({
    version: z.literal(1),
    repos: z.record(z.uuid(), AutonomyEntrySchema),
    flows: z.record(flowNameSchema, AutonomyEntrySchema),
    requests: z.object({ repos: z.record(z.uuid(), AutonomyRequestSchema), flows: z.record(flowNameSchema, AutonomyRequestSchema) }).strict().optional(),
  })
  .strict();
export type AutonomyEntry = z.infer<typeof AutonomyEntrySchema>;
export type AutonomyRequest = z.infer<typeof AutonomyRequestSchema>;
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
  const raw = json as { repos: Record<string, unknown>; flows: Record<string, unknown>; requests?: { repos: Record<string, unknown>; flows: Record<string, unknown> } };
  const store: AutonomyStore = { version: 1, repos: entriesOf(raw.repos, AutonomyEntrySchema), flows: entriesOf(raw.flows, AutonomyEntrySchema) };
  if (raw.requests) {
    const requests = { repos: entriesOf(raw.requests.repos, AutonomyRequestSchema), flows: entriesOf(raw.requests.flows, AutonomyRequestSchema) };
    if (Object.keys(requests.repos).length || Object.keys(requests.flows).length) store.requests = requests;
  }
  return store;
}

/** Own properties from a raw map of entries that already passed the schema. Object.fromEntries never sets a prototype. */
const entriesOf = <T>(m: Record<string, unknown>, schema: z.ZodType<T>): Record<string, T> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, schema.parse(v)]));

const own = <T>(m: Record<string, T>, key: string): T | undefined => (Object.hasOwn(m, key) ? m[key] : undefined);

/** The stored level of one repository or flow; `delivery-handoff` without an entry. */
export const levelIn = (store: AutonomyStore, kind: AutonomyKind, id: string): AutonomyLevel => own(store[kind], id)?.level ?? DEFAULT_LEVEL;

/** The request of one component, if the store holds one (it may be stale: see `liveRequest`). */
export const requestOf = (store: AutonomyStore, kind: AutonomyKind, id: string): AutonomyRequest | undefined => own(store.requests?.[kind] ?? {}, id);

/** The store with the request of one component set, or removed with `undefined`. The `requests` key is left out when it is empty. */
export function withRequest(store: AutonomyStore, kind: AutonomyKind, id: string, req: AutonomyRequest | undefined): AutonomyStore {
  const maps: { repos: Record<string, AutonomyRequest>; flows: Record<string, AutonomyRequest> } = {
    repos: Object.fromEntries(Object.entries(store.requests?.repos ?? {})),
    flows: Object.fromEntries(Object.entries(store.requests?.flows ?? {})),
  };
  if (req) Object.defineProperty(maps[kind], id, { value: req, enumerable: true, writable: true, configurable: true });
  else delete maps[kind][id];
  const { requests: _old, ...rest } = store;
  return Object.keys(maps.repos).length || Object.keys(maps.flows).length ? { ...rest, requests: maps } : rest;
}

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

/** The entry for a new level, after the checks of every input. Throws AutonomyError; nothing is written. */
export function newEntry(kind: AutonomyKind, id: string, level: AutonomyLevel, by: string, reason?: string): AutonomyEntry {
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
  return { level, since: new Date().toISOString(), by, ...(note ? { reason: note } : {}) };
}

/** Sets one level. The caller holds the data-folder lock. Throws AutonomyError for bad input and StoreError for the file. */
export function setLevelLocked(kind: AutonomyKind, id: string, level: AutonomyLevel, by: string, reason?: string): AutonomyEntry {
  if (!authLockHeld()) throw new Error("setLevelLocked must run inside withAuthLock");
  const entry = newEntry(kind, id, level, by, reason);
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
