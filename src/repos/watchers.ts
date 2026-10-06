import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { githubNameOf } from "../auth/repo-url.js";
import { dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { RepoWatcherSchema, type RepoWatcherOptions, type WatcherConfig } from "../config.js";

/**
 * The watchers that belong to a repository connection: `repo-watchers.json` in the data folder,
 * `{ version: 1, watchers: [{ repoId, …options }] }`. The options are those of a watcher in config.yaml, except
 * `github_repo` and `owner` (they come from the repository record) and source "monitor".
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

export type StoredWatcher = RepoWatcherOptions & { repoId: string };

const EntrySchema = z
  .object({ repoId: z.uuid() })
  .passthrough()
  .transform((e, ctx): StoredWatcher => {
    const { repoId, ...rest } = e;
    const r = RepoWatcherSchema.safeParse(rest);
    if (!r.success) {
      ctx.addIssue({ code: "custom", message: "invalid" });
      return z.NEVER;
    }
    return { repoId, ...r.data };
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
export function addRepoWatcher(repoId: string, input: unknown, opts: { taken?: string[] } = {}): StoredWatcher {
  const options = parseOptions(input);
  return withAuthLock(() => {
    const all = read();
    if (all.some((w) => w.id === options.id) || (opts.taken ?? []).includes(options.id)) throw dup(options.id);
    const w: StoredWatcher = { repoId, ...options };
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
    const { repoId: _r, ...current } = all[at]!;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const options = parseOptions(merged);
    const before = current as Record<string, unknown>;
    const after = options as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const watcher: StoredWatcher = { repoId, ...options };
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

export interface BlockedWatcher extends Omit<WatcherConfig, "github_repo" | "owner"> {
  github_repo: string;
  owner?: string;
  repoId: string;
  /** Why it cannot run. */
  problem: string;
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
  for (const w of stored) {
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
    const github_repo = githubNameOf(rec.url) ?? "";
    const problem = watcherRepoProblem(rec, owner);
    if (problem || !owner) {
      blocked.push({ ...w, github_repo, owner: owner?.email, problem: problem ?? "the owner of this repository is not an account any more" });
    } else if (owner.status !== "active") {
      blocked.push({ ...w, github_repo, owner: owner.email, problem: "the owner of this repository is blocked" });
    } else runnable.push({ ...w, github_repo, owner: owner.email, ownerId: rec.owner });
  }
  return { runnable, blocked };
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
