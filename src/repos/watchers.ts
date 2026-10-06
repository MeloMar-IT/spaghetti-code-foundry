import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { githubKey, githubNameOf } from "../auth/repo-url.js";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { RepoWatcherSchema, type RepoWatcherOptions, type WatcherConfig } from "../config.js";

/**
 * The watchers that belong to a repository connection: `repo-watchers.json` in the data folder,
 * `{ version: 1, watchers: [{ repoId, …options }] }`. The options are those of a watcher in config.yaml, except
 * `github_repo` and `owner` (they come from the repository record) and source "monitor". An entry may also hold `repoName`:
 * the spelling of the GitHub name the watcher had in config.yaml when it differs from the repository's lower-case name
 * (status comments and run history match on it).
 * This module does not import src/auth/repos.ts (import cycle); the API layer checks that the repository exists.
 */

export const repoWatchersPath = () => join(dataHome(), "repo-watchers.json");

export type RepoWatcherErrorCode = "bad-watcher" | "duplicate" | "not-found";

export class RepoWatcherError extends Error {
  constructor(public code: RepoWatcherErrorCode, message: string) {
    super(message);
    this.name = "RepoWatcherError";
  }
}

export type StoredWatcher = RepoWatcherOptions & { repoId: string; repoName?: string };

const RepoNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

const EntrySchema = z
  .object({ repoId: z.uuid() })
  .passthrough()
  .transform((e, ctx): StoredWatcher => {
    const { repoId, repoName, ...rest } = e;
    const r = RepoWatcherSchema.safeParse(rest);
    const name = repoName === undefined ? undefined : RepoNameSchema.safeParse(repoName);
    if (!r.success || (name && !name.success)) {
      ctx.addIssue({ code: "custom", message: "invalid" });
      return z.NEVER;
    }
    return { repoId, ...r.data, ...(name?.success ? { repoName: name.data } : {}) };
  });

const FileSchema = z
  .object({ version: z.literal(1), watchers: z.array(EntrySchema) })
  .strict()
  .refine((f) => new Set(f.watchers.map((w) => w.id)).size === f.watchers.length, { message: "an id is used twice", path: ["watchers"] });

const read = (): StoredWatcher[] => readJsonFile(repoWatchersPath(), FileSchema, { version: 1 as const, watchers: [] }).watchers;
const save = (watchers: StoredWatcher[]) => writeJsonFile(repoWatchersPath(), { version: 1, watchers });

/** All stored watchers. Throws a StoreError when the file cannot be read. */
export const listRepoWatchers = (): StoredWatcher[] => read();

const bad = (message: string) => new RepoWatcherError("bad-watcher", message);
const notFound = () => new RepoWatcherError("not-found", "no such watcher");
const dup = (id: string) => new RepoWatcherError("duplicate", `a watcher with the id "${id}" exists already; choose another id`);

/** Checks the options; the sentence names the first thing that is wrong. */
function parseOptions(input: unknown): RepoWatcherOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw bad("the watcher must be an object");
  const o = input as Record<string, unknown>;
  if ("github_repo" in o) throw bad("a watcher of a repository does not set github_repo; it is the repository");
  if ("owner" in o) throw bad("a watcher of a repository does not set owner; it is the owner of the repository");
  const r = RepoWatcherSchema.safeParse(o);
  if (r.success) return r.data;
  const i = r.error.issues[0]!;
  const key = i.code === "unrecognized_keys" ? i.keys.join(", ") : i.path.join(".");
  throw bad(i.code === "unrecognized_keys" ? `unknown option: ${key}` : `${key || "watcher"}: ${i.message}`);
}

/** Adds a watcher. `taken` are the ids that exist elsewhere (config.yaml); an id is unique on the whole install. */
export function addRepoWatcher(repoId: string, input: unknown, opts: { taken?: string[]; repoName?: string } = {}): StoredWatcher {
  const options = parseOptions(input);
  return withAuthLock(() => {
    const all = read();
    if (all.some((w) => w.id === options.id) || (opts.taken ?? []).includes(options.id)) throw dup(options.id);
    const w: StoredWatcher = { repoId, ...options, ...(opts.repoName ? { repoName: opts.repoName } : {}) };
    save([...all, w]);
    return w;
  });
}

/** Changes a watcher: a value sets, `null` removes an option. The id cannot change. `changed` names the options that differ. */
export function updateRepoWatcher(repoId: string, id: string, patch: unknown): { watcher: StoredWatcher; changed: string[] } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw bad("the change must be an object");
  const p = patch as Record<string, unknown>;
  if ("id" in p && p.id !== id) throw bad("the id of a watcher cannot be changed");
  return withAuthLock(() => {
    const all = read();
    const at = all.findIndex((w) => w.id === id && w.repoId === repoId);
    if (at < 0) throw notFound();
    const { repoId: _r, repoName, ...current } = all[at]!;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const options = parseOptions(merged);
    const before = current as Record<string, unknown>;
    const after = options as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const watcher: StoredWatcher = { repoId, ...options, ...(repoName ? { repoName } : {}) };
    if (changed.length) {
      all[at] = watcher;
      save(all);
    }
    return { watcher, changed };
  });
}

/** Removes one watcher. */
export function removeRepoWatcher(repoId: string, id: string): StoredWatcher {
  return withAuthLock(() => {
    const all = read();
    const found = all.find((w) => w.id === id && w.repoId === repoId);
    if (!found) throw notFound();
    save(all.filter((w) => w !== found));
    return found;
  });
}

/** Removes the watchers of these repositories and returns them. Writes nothing when there are none. */
export function removeWatchersOfRepos(repoIds: string[]): StoredWatcher[] {
  if (!repoIds.length) return [];
  return withAuthLock(() => {
    const all = read();
    const gone = all.filter((w) => repoIds.includes(w.repoId));
    if (gone.length) save(all.filter((w) => !repoIds.includes(w.repoId)));
    return gone;
  });
}

/**
 * Like removeWatchersOfRepos, for a caller that holds the auth lock (and throws when it does not). `undo()` writes the
 * old list back (a no-op when nothing was removed), for a caller whose next write fails.
 */
export function removeWatchersOfReposLocked(repoIds: string[]): { gone: StoredWatcher[]; undo: () => void } {
  if (!authLockHeld()) throw new Error("removeWatchersOfReposLocked must run inside withAuthLock");
  if (!repoIds.length) return { gone: [], undo: () => {} };
  const all = read();
  const gone = all.filter((w) => repoIds.includes(w.repoId));
  if (!gone.length) return { gone, undo: () => {} };
  save(all.filter((w) => !repoIds.includes(w.repoId)));
  return { gone, undo: () => save(all) };
}

/**
 * Removes the watchers whose repository is not in the list `repoIds` returns, and returns them. `repoIds` is not called
 * for an empty store, and nothing is written when there is no leftover. A file that cannot be read throws a StoreError.
 */
export function removeOrphanWatchers(repoIds: () => string[]): StoredWatcher[] {
  return withAuthLock(() => {
    const all = read();
    if (!all.length) return [];
    const known = new Set(repoIds());
    const gone = all.filter((w) => !known.has(w.repoId));
    if (gone.length) save(all.filter((w) => known.has(w.repoId)));
    return gone;
  });
}

/** The modification time of the file (0 when there is none); a cheap way to see that nothing was written. */
export const repoWatchersMtime = (): number => {
  try {
    return statSync(repoWatchersPath()).mtimeMs;
  } catch {
    return 0;
  }
};

// ---- who may have a watcher, and what runs ----------------------------------------------------------

interface RepoLike {
  url: string;
  method: string;
  owner: string;
}
interface UserLike {
  email: string;
  role: string;
  status: string;
}

/** A sentence when a repository cannot have a watcher; undefined when it can. */
export function watcherRepoProblem(rec: RepoLike, owner: UserLike | undefined): string | undefined {
  if (githubNameOf(rec.url) === undefined) return "a watcher needs a GitHub repository";
  if (rec.method === "ssh-deploy-key" || rec.method === "https-token") {
    return "this repository's sign-in cannot call the GitHub API; use a GitHub token, the GitHub App, or the server's own access";
  }
  if (!owner) return "the owner of this repository is not an account any more";
  if (rec.method === "none" && owner.role !== "admin") return 'a watcher on a repository with the server\'s own access ("none") needs an owner who is an admin';
  return undefined;
}

/** The problem of a watcher whose owner is blocked; the words of the "paused" state. */
export const OWNER_BLOCKED = "paused: the owner is blocked";

export interface BlockedWatcher extends Omit<WatcherConfig, "github_repo" | "owner"> {
  github_repo: string;
  owner?: string;
  repoId: string;
  /** Why it cannot run. */
  problem: string;
  /** True when it waits only because its owner is blocked (it starts again on unblock). */
  paused?: true;
}

/** Splits the stored watchers into the ones that can run (as `WatcherConfig`) and the ones that cannot (with their problem). Every watcher is in exactly one list. */
export function effectiveRepoWatchers(
  stored: StoredWatcher[],
  getRepo: (id: string) => (RepoLike & { id: string }) | undefined,
  getUser: (id: string) => UserLike | undefined,
  /** Ids that config.yaml uses: a stored watcher with one of them cannot run (the file's watcher keeps the id). */
  taken: string[] = [],
): { runnable: WatcherConfig[]; blocked: BlockedWatcher[] } {
  const runnable: WatcherConfig[] = [];
  const blocked: BlockedWatcher[] = [];
  for (const { repoName, ...w } of stored) {
    const rec = getRepo(w.repoId);
    if (taken.includes(w.id)) {
      blocked.push({ ...w, github_repo: (rec && githubNameOf(rec.url)) || "", problem: "this watcher's id is used by another watcher in config.yaml; change the id or delete the watcher" });
      continue;
    }
    if (!rec) {
      blocked.push({ ...w, github_repo: "", problem: "this watcher's repository is not connected any more; delete the watcher" });
      continue;
    }
    const owner = getUser(rec.owner);
    const lower = githubNameOf(rec.url) ?? "";
    // the spelling the watcher had in config.yaml, when it names this repository
    const github_repo = repoName && githubKey(repoName) === `github.com/${lower}` ? repoName : lower;
    if (owner && owner.status !== "active") {
      // a blocked owner wins over the other problems of the repository; the watcher starts again on unblock
      blocked.push({ ...w, github_repo, owner: owner.email, problem: OWNER_BLOCKED, paused: true });
      continue;
    }
    const problem = watcherRepoProblem(rec, owner);
    if (problem || !owner) {
      blocked.push({ ...w, github_repo, owner: owner?.email, problem: problem ?? "the owner of this repository is not an account any more" });
    } else runnable.push({ ...w, github_repo, owner: owner.email, ownerId: rec.owner });
  }
  return { runnable, blocked };
}

/** A sentence when a new config.yaml adds or changes a watcher other than the monitor. One that is in the file unchanged still saves. */
export function fileWatcherProblem(next: WatcherConfig[], current: WatcherConfig[]): string | undefined {
  const had = new Set(current.map((w) => JSON.stringify(w)));
  for (const w of next) {
    if (w.source !== "monitor" && !had.has(JSON.stringify(w))) {
      return `watcher "${w.id}": watchers other than the monitor are not kept in config.yaml any more; add or change it on the Watchers page`;
    }
  }
  return undefined;
}

/**
 * A sentence when the watcher ids of a new config.yaml are not unique on the install. Only what is new counts: a duplicate
 * the file already had, or a stored id that the file already shared, still saves.
 */
export function configIdProblem(next: { id: string }[], current: { id: string }[], stored: { id: string }[]): string | undefined {
  const count = (list: { id: string }[], id: string) => list.filter((w) => w.id === id).length;
  const storedIds = new Set(stored.map((w) => w.id));
  for (const w of next) {
    if (count(next, w.id) > 1 && count(current, w.id) < 2) return `the watcher id "${w.id}" is used twice; ids must be different`;
    if (storedIds.has(w.id) && count(current, w.id) === 0) return `the watcher id "${w.id}" is used by a watcher of a repository; choose another id`;
  }
  return undefined;
}
