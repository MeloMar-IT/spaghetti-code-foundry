import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { isLocalRepoName } from "../auth/local-name.js";
import { findLocalRepo } from "../auth/repos.js";
import type { WatcherConfig } from "../config.js";
import { errorLine } from "../errors.js";
import { gh, mayWrite, repoPermission } from "../github.js";
import { GO_STATE } from "../stories/story-file.js";
import { contentsPath } from "./owner-action.js";

/**
 * What a watcher asks of its repository outside the story store. A GitHub repository answers with `gh`; a local one reads
 * the connected folder and makes no GitHub call at all.
 */
export interface WatcherRepoAccess {
  readonly local: boolean;
  /** Rejects with a sentence when the repository cannot be reached (GitHub: `gh repo view`; local: the connected folder is there). */
  check(): Promise<void>;
  /** Is this a plain file on the branch (GitHub contents API) or in the work tree (local; `ref` is ignored)? GitHub: throws on an error other than 404. */
  hasFile(path: string, ref: string | undefined, timeoutMs: number): Promise<boolean>;
  /** May this login decide or overrule? GitHub: push permission, throws when the lookup fails; local: always true. */
  writer(login: string, timeoutMs?: number): Promise<boolean>;
}

/** A contents answer that is one file (not a directory's list). */
function isFileBody(body: string): boolean {
  try {
    const v: unknown = JSON.parse(body);
    return !!v && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type === "file";
  } catch {
    return false;
  }
}

const isMissing = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");

function githubAccess(repo: string): WatcherRepoAccess {
  return {
    local: false,
    async check() {
      await gh(["repo", "view", repo, "--json", "nameWithOwner"]).catch((e: Error) => {
        throw new Error(`cannot access ${repo} with gh: ${errorLine(e.message)}`);
      });
    },
    async hasFile(path, ref, timeoutMs) {
      try {
        // A directory answers with a list, a file with one object: only a file counts.
        return isFileBody(await gh(["api", contentsPath(repo, path, ref)], undefined, timeoutMs));
      } catch (e) {
        if (/\b404\b|Not Found/i.test(errorLine((e as Error).message))) return false;
        throw e;
      }
    },
    async writer(login, timeoutMs) {
      return mayWrite(await repoPermission(repo, login, timeoutMs));
    },
  };
}

function localAccess(repo: string): WatcherRepoAccess {
  const folder = (): string => {
    const rec = findLocalRepo(repo);
    if (!rec) throw new Error(`the folder of ${repo} is not there: the repository is not connected`);
    return rec.url;
  };
  return {
    local: true,
    async check() {
      const dir = folder();
      let ok = false;
      try { ok = statSync(dir).isDirectory(); } catch { /* not there */ }
      if (!ok) throw new Error(`the folder of ${repo} is not there: ${dir}`);
    },
    async hasFile(path) {
      try {
        const dir = realpathSync(folder());
        const p = realpathSync(join(dir, path));
        // a link that leaves the folder does not count
        return p.startsWith(dir + sep) && statSync(p).isFile();
      } catch (e) {
        if (isMissing(e)) return false;
        throw e;
      }
    },
    async writer() {
      return true;
    },
  };
}

export const watcherRepoAccess = (repo: string): WatcherRepoAccess => (isLocalRepoName(repo) ? localAccess(repo) : githubAccess(repo));
export const isLocalWatcher = (cfg: Pick<WatcherConfig, "github_repo">): boolean => isLocalRepoName(cfg.github_repo);

/** A local repository's watcher uses `go` as its trigger label; any other config is returned unchanged. */
export function localWatcherConfig(cfg: WatcherConfig): WatcherConfig {
  return isLocalWatcher(cfg) && cfg.label !== GO_STATE ? { ...cfg, label: GO_STATE } : cfg;
}
