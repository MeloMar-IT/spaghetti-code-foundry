import { join } from "node:path";
import { findLocalRepo, getRepo, listAllRepos } from "../auth/repos.js";
import { githubNameOf } from "../auth/repo-url.js";
import { loadConfig } from "../config.js";
import { loadRun } from "../engine/state.js";
import { FACTORY_HOME } from "../flow/load.js";
import { DEFAULT_WORKSPACE, suppliedWorkspaces, validWorkspaceId, type Workspace, type WorkspaceLimits } from "./list.js";

/**
 * Workspace lookups (#816). Nothing here throws: a failure reads as the default workspace. Nothing is enforced yet; later
 * parts of #784 build on these functions.
 */

export { DEFAULT_WORKSPACE };

/** The current list: the plugin's when one supplies it (a bad list is empty), else config.yaml's (an unreadable file is empty). */
export function currentWorkspaces(): readonly Workspace[] {
  try {
    const supplied = suppliedWorkspaces();
    if (supplied) return supplied.ok ? supplied.list : [];
    return loadConfig().workspaces;
  } catch {
    return [];
  }
}

/** Every workspace that lists the account, in list order; ["default"] when none does. */
export function workspacesOf(userId: string): string[] {
  try {
    const ids = currentWorkspaces()
      .filter((w) => w.members.includes(userId))
      .map((w) => w.id);
    return ids.length ? ids : [DEFAULT_WORKSPACE];
  } catch {
    return [DEFAULT_WORKSPACE];
  }
}

/** The workspace of a repository record: its value, or "default" for a missing record or field. */
export function workspaceOfRepo(id: string): string {
  try {
    const ws = getRepo(id)?.workspace;
    return validWorkspaceId(ws) ? ws : DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/** The workspace stored with a run; "default" for a missing run or an older run.json. */
export function workspaceOfRun(runId: string, runsDir = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "runs")): string {
  try {
    if (typeof runId !== "string" || !/^[\w-]+$/.test(runId)) return DEFAULT_WORKSPACE;
    const ws = loadRun(runsDir, runId)?.workspace;
    return validWorkspaceId(ws) ? ws : DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/** The limits of a workspace. {} for "default" and for an id that is not in the list. */
export function limitsOf(workspaceId: string): Readonly<WorkspaceLimits> {
  try {
    if (workspaceId === DEFAULT_WORKSPACE) return {};
    const w = currentWorkspaces().find((x) => x.id === workspaceId);
    return w ? { ...w.limits } : {};
  } catch {
    return {};
  }
}

/** "default" or an id in the current list. */
export function knownWorkspace(id: string): boolean {
  try {
    return id === DEFAULT_WORKSPACE || currentWorkspaces().some((w) => w.id === id);
  } catch {
    return false;
  }
}

/**
 * The workspace of a job in the repository named `githubRepo` (`owner/name` or `local:…`), for the account `owner`. The record
 * of that account is used; when the account does not own it, the value all records of that name agree on, else "default".
 * The flow's own `workspace` setting plays no part: "empty" only means "no checkout".
 */
export function workspaceForJob(input: { githubRepo?: string; owner?: string }): string {
  try {
    const name = input.githubRepo?.trim();
    if (!name) return DEFAULT_WORKSPACE;
    const valueOf = (r: { workspace?: string } | undefined): string => (validWorkspaceId(r?.workspace) ? r!.workspace! : DEFAULT_WORKSPACE);
    if (name.startsWith("local:")) return valueOf(findLocalRepo(name));
    const want = githubNameOf(`https://github.com/${name}`);
    if (want === undefined) return DEFAULT_WORKSPACE;
    const mine = listAllRepos().filter((r) => githubNameOf(r.url) === want);
    const own = input.owner ? mine.find((r) => r.owner === input.owner) : undefined;
    if (own) return valueOf(own);
    const values = new Set(mine.map(valueOf));
    return values.size === 1 ? [...values][0]! : DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}
