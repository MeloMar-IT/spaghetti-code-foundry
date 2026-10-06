import { constants, copyFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { stringify } from "yaml";
import { REPO_LIMIT, addRepo, listAllRepos, type RepoRecord } from "../auth/repos.js";
import { RepoError, githubNameOf, tryParseRepoUrl } from "../auth/repo-url.js";
import { StoreError } from "../auth/store.js";
import { findUserByEmail, firstAdmin, getUser } from "../auth/users.js";
import { CONFIG_PATH, ConfigSchema, RepoWatcherSchema, loadConfig, type WatcherConfig } from "../config.js";
import { homeMoved } from "../home.js";
import { RepoWatcherError, addRepoWatcher, listRepoWatchers, watcherRepoProblem, type StoredWatcher } from "./watchers.js";

/**
 * At server start, the watchers of config.yaml (except the monitor) move to the repository store: a connection with the
 * method "none" (the server's own access) for the first admin, or the existing connection of that repository.
 * The store is written first and config.yaml second (after a backup, by an atomic replace), so a crash in between
 * leaves the watcher in both places; the next start finds an identical stored copy and only drops the file's copy.
 */

export interface MoveResult {
  /** Ids written to the store in this pass. */
  moved: string[];
  /** Ids that were in the store already (identical); only the file copy went. */
  dropped: string[];
  /** Watchers that stay in config.yaml. */
  left: { id: string; reason: string }[];
  /** File name of the backup (no folder). */
  backup?: string;
  /** config.yaml was rewritten. */
  changed: boolean;
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** The same text for the same value, whatever the order of the keys. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Copies the file to a new name next to it; undefined when that fails. */
function backupFile(path: string, now: Date): string | undefined {
  const base = `${path}.before-watcher-move-${stamp(now)}`;
  for (let i = 1; i <= 9; i++) {
    const target = i === 1 ? base : `${base}-${i}`;
    try {
      copyFileSync(path, target, constants.COPYFILE_EXCL);
      return basename(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
  }
  return undefined;
}

/** Writes the file through a temporary file in the same folder and a rename; the old file stays when anything fails. */
function replaceConfig(path: string, config: unknown): void {
  const text = stringify(ConfigSchema.parse(config), { lineWidth: 0 });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: statSync(path).mode & 0o777 });
    loadConfig(tmp); // what is renamed in must load
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    throw e;
  }
}

/** Moves the watchers of config.yaml into their repositories. Never throws; see the issue for the rules. */
export function moveConfigWatchers(o: { log: (msg: string) => void; path?: string; now?: () => Date }): MoveResult {
  const result: MoveResult = { moved: [], dropped: [], left: [], changed: false };
  const { log } = o;
  const path = o.path ?? CONFIG_PATH();
  const fixed = (e: unknown) => (e instanceof StoreError ? `${basename(e.file)} ${e.kind}` : "unexpected error");
  try {
    if (!existsSync(path) || homeMoved()) return result;
    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(path);
    } catch {
      return result;
    }
    const candidates = config.watchers.filter((w) => w.source !== "monitor");
    if (!candidates.length) return result;
    const admin = firstAdmin();
    if (!admin) {
      log(`${candidates.length} watcher${plural(candidates.length)} stay in config.yaml until there is an admin account`);
      return result;
    }
    const stored = new Map<string, StoredWatcher>(listRepoWatchers().map((w) => [w.id, w]));
    let records = listAllRepos();

    const idCount = new Map<string, number>();
    for (const w of candidates) idCount.set(w.id, (idCount.get(w.id) ?? 0) + 1);
    const handled: WatcherConfig[] = []; // moved or dropped, by object identity
    const leave = (w: WatcherConfig, reason: string) => void result.left.push({ id: w.id, reason });
    const findRecord = (key: string) => {
      const same = records.filter((r) => {
        const p = tryParseRepoUrl(r.url);
        return p?.github !== undefined && p.key === key;
      });
      return same.find((r) => r.owner === admin.id) ?? same[0];
    };

    // said for a new move and again for one a crash left half done
    const ownerNote = (w: WatcherConfig, rec: RepoRecord, name: string) => {
      if (w.owner?.trim() && findUserByEmail(w.owner)?.id !== rec.owner) {
        log(`watcher "${w.id}": its owner option named another account than the owner of ${name}; the repository's owner is used`);
      }
    };

    for (const w of candidates) {
      if ((idCount.get(w.id) ?? 0) > 1) {
        leave(w, "its id is used twice in config.yaml; change one of them");
        continue;
      }
      const parsed = tryParseRepoUrl(`https://github.com/${w.github_repo}`);
      if (parsed?.github === undefined) {
        leave(w, "its github_repo is not a GitHub repository name");
        continue;
      }
      let rec: RepoRecord | undefined = findRecord(parsed.key);
      const have = stored.get(w.id);
      if (!rec) {
        if (have) {
          leave(w, "its id is used by a watcher of another repository; change the id");
          continue;
        }
        try {
          addRepo(admin.id, { url: `https://github.com/${w.github_repo}` });
          records = listAllRepos();
          log(`repository ${githubNameOf(parsed.url)} connected for the first admin (legacy: the server's own access)`);
        } catch (e) {
          if (!(e instanceof RepoError)) throw e;
          if (e.code === "limit") {
            leave(w, `the first admin has ${REPO_LIMIT} repositories already`);
            continue;
          }
          if (e.code === "duplicate" || e.code === "taken") records = listAllRepos();
          else {
            leave(w, `its repository could not be connected (${e.code})`);
            continue;
          }
        }
        rec = findRecord(parsed.key);
        if (!rec) {
          leave(w, "its repository could not be connected (not-found)");
          continue;
        }
      }
      const name = githubNameOf(rec.url) ?? w.github_repo;
      const problem = watcherRepoProblem(rec, getUser(rec.owner));
      const {
        github_repo: _repo,
        owner: _owner,
        repoId: _id,
        ownerId: _ownerId,
        ...options
      } = w as WatcherConfig & { repoId?: string; ownerId?: string };
      const repoName = w.github_repo !== name ? w.github_repo : undefined;
      const wanted = RepoWatcherSchema.safeParse({ ...options, enabled: problem ? false : w.enabled });
      if (!wanted.success) {
        leave(w, "its options are not valid for a watcher of a repository");
        continue;
      }
      if (have) {
        const expected: StoredWatcher = { repoId: rec.id, ...wanted.data, ...(repoName ? { repoName } : {}) };
        if (have.repoId !== rec.id) leave(w, "its id is used by a watcher of another repository; change the id");
        else if (canon(have) !== canon(expected)) leave(w, "its id is used by a different watcher of this repository; change the id");
        else {
          result.dropped.push(w.id);
          handled.push(w);
          log(`watcher "${w.id}": already moved; its copy in config.yaml is removed${problem ? `; it is disabled: ${problem}` : ""}`);
          ownerNote(w, rec, name);
        }
        continue;
      }
      try {
        const added = addRepoWatcher(rec.id, wanted.data, { repoName });
        stored.set(w.id, added);
      } catch (e) {
        if (!(e instanceof RepoWatcherError)) throw e;
        leave(w, e.code === "duplicate" ? "its id is used by another watcher; change the id" : "its options are not valid for a watcher of a repository");
        continue;
      }
      result.moved.push(w.id);
      handled.push(w);
      log(`watcher "${w.id}" moved to ${name}${problem ? ` and disabled: ${problem}` : ""}`);
      ownerNote(w, rec, name);
    }

    if (handled.length) {
      const backup = backupFile(path, (o.now ?? (() => new Date()))());
      if (!backup) {
        log("! config.yaml was not changed: the backup could not be written");
      } else {
        try {
          // the file as it is now (not the snapshot above): only what was handled goes, whatever else changed stays
          const gone = new Set(handled.map((w) => canon(w)));
          const fresh = loadConfig(path);
          replaceConfig(path, { ...fresh, watchers: fresh.watchers.filter((w) => !gone.has(canon(w))) });
          result.backup = backup;
          result.changed = true;
          log(`config.yaml: ${handled.length} watcher${plural(handled.length)} moved to their repositories; the file as it was is kept as ${backup}`);
        } catch {
          log("! config.yaml was not changed: it could not be replaced");
        }
      }
    }
  } catch (e) {
    log(`! watchers stay in config.yaml: ${fixed(e)}`);
  }
  for (const l of result.left) log(`! watcher "${l.id}" stays in config.yaml: ${l.reason}`);
  return result;
}
