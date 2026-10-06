import { join } from "node:path";
import { z } from "zod";
import { prepareAuditLocked } from "./audit.js";
import { githubKey, validGithubName } from "./repo-url.js";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "./store.js";
import { getUser } from "./users.js";

export const appReposPath = () => join(dataHome(), "app-repos.json");

/** At most this many entries per account. */
export const APP_REPOS_MAX = 200;

export class AppReposError extends Error {
  constructor(
    public code: "bad-list" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "AppReposError";
  }
}

const WILDCARD_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/\*$/;
const PREFIX = "github.com/";

/**
 * One entry in its stored form, or undefined when it is not valid. The wildcard is checked first, and ".git" is only
 * stripped from an exact name, so "acme/*.git" is refused and never becomes "acme/*".
 */
function normalise(entry: string): string | undefined {
  const e = entry.trim();
  if (WILDCARD_RE.test(e)) return e.toLowerCase();
  if (e.includes("*")) return undefined;
  const name = githubKey(e).slice(PREFIX.length);
  return validGithubName(name) ? name : undefined;
}

/**
 * Checks and normalises a list: an array of at most APP_REPOS_MAX strings, each "owner/name" or "owner/*". Trims,
 * lower-cases, strips ".git", drops duplicates and keeps the order. The messages name a position, never a value.
 */
export function checkAppRepos(input: unknown): string[] {
  if (!Array.isArray(input)) throw new AppReposError("bad-list", 'give "repos": a list of entries');
  if (input.length > APP_REPOS_MAX) throw new AppReposError("bad-list", `at most ${APP_REPOS_MAX} entries`);
  const out: string[] = [];
  input.forEach((v, i) => {
    const n = typeof v === "string" ? normalise(v) : undefined;
    if (n === undefined) throw new AppReposError("bad-list", `entry ${i + 1} is not valid: write "owner/name" or "owner/*"`);
    if (!out.includes(n)) out.push(n);
  });
  return out;
}

const FileSchema = z
  .object({
    version: z.literal(1),
    lists: z.record(z.uuid(), z.array(z.string()).max(APP_REPOS_MAX)),
  })
  .strict()
  .refine((f) => Object.values(f.lists).every((l) => l.every((e) => normalise(e) === e)));

type AppReposFile = z.infer<typeof FileSchema>;
const EMPTY: AppReposFile = { version: 1, lists: {} };

/** Reads the file; a missing one is empty, a broken one throws a StoreError. */
const read = (): AppReposFile => readJsonFile(appReposPath(), FileSchema, EMPTY);

/** Reads the file and throws a StoreError when it is broken. Writes nothing. */
export function checkAppReposFile(): void {
  read();
}

/** The list of one account; [] when it has none. */
export const getAppRepos = (userId: string): string[] => [...(read().lists[userId] ?? [])];

/** All lists, for the admin's repository page. */
export const allAppRepos = (): Map<string, string[]> => new Map(Object.entries(read().lists).map(([k, v]) => [k, [...v]]));

/** True when `github` ("owner/name", any case, with or without ".git") is on the list. */
export function onAppList(list: readonly string[], github: string): boolean {
  const name = githubKey(github).slice(PREFIX.length);
  const owner = name.split("/")[0];
  return list.some((e) => (e.endsWith("/*") ? e.slice(0, -2) === owner : e === name));
}

export const appRepoAllowed = (userId: string, github: string): boolean => onAppList(getAppRepos(userId), github);

/**
 * Replaces the list ([] removes the key). The account must exist. With `by`, the audit line `app-repos-change` is
 * added under the same lock, only when the list changed.
 */
export function setAppRepos(userId: string, input: unknown, opts: { by?: string } = {}): { repos: string[]; changed: boolean } {
  const repos = checkAppRepos(input);
  return withAuthLock(() => {
    if (!getUser(userId)) throw new AppReposError("not-found", "no such account");
    const file = read();
    const old = file.lists[userId] ?? [];
    if (JSON.stringify(old) === JSON.stringify(repos)) return { repos, changed: false };
    const { [userId]: _gone, ...others } = file.lists;
    const next = { version: 1 as const, lists: repos.length ? { ...others, [userId]: repos } : others };
    const log = opts.by === undefined ? undefined : prepareAuditLocked(opts.by, { action: "app-repos-change", result: "ok", userId });
    try {
      writeJsonFile(appReposPath(), next);
      log?.write();
    } finally {
      log?.close();
    }
    return { repos, changed: true };
  });
}

/** Removes the list of a deleted account. Only inside withAuthLock; writes nothing when there is none. */
export function removeAppReposLocked(userId: string): void {
  if (!authLockHeld()) throw new Error("removeAppReposLocked must run inside withAuthLock");
  const file = read();
  if (!(userId in file.lists)) return;
  const { [userId]: _gone, ...others } = file.lists;
  writeJsonFile(appReposPath(), { version: 1, lists: others });
}
