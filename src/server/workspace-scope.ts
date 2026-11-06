import { findOwnedProject, findOwnedRepo, getRepo, type RepoRecord } from "../auth/repos.js";
import type { User } from "../auth/users.js";
import type { RunBrief } from "../engine/state.js";
import type { Session } from "../refinement/store.js";
import { getSession } from "../refinement/store.js";
import { DEFAULT_WORKSPACE, workspacesOf } from "../workspaces/index.js";
import { validWorkspaceId } from "../workspaces/list.js";
import { HttpError } from "./http.js";
import type { RuleScope } from "./permissions.js";
import type { ApiContext } from "./server.js";

/**
 * Workspace scope (#817). A user reaches only their own objects that are in their workspaces; an admin reaches everything.
 * Access only narrows: these checks come on top of the ownership checks and never grant anything.
 */

type Who = Pick<User, "id" | "role">;
type Set_ = ReadonlySet<string> | undefined;

/** The workspaces of an account: exactly the ones that list it, else {default}. */
export const userWorkspaces = (userId: string): ReadonlySet<string> => new Set(workspacesOf(userId));

/** undefined for an admin (no check). */
export const callerWorkspaces = (user: Who): Set_ => (user.role === "admin" ? undefined : userWorkspaces(user.id));

/** True when the value is in the set. No set means no check. A missing or invalid value reads as "default". */
export function inWorkspaces(ws: Set_, value: unknown): boolean {
  if (ws === undefined) return true;
  return ws.has(validWorkspaceId(value) ? value : DEFAULT_WORKSPACE);
}

/** A run brief the caller may see: an admin all; a user their own runs that are in their workspaces. */
export function briefInScope(user: Who, ws: Set_, b: RunBrief): boolean {
  return user.role === "admin" || (b.owner === user.id && inWorkspaces(ws, b.workspace));
}

/** The "is it mine" check for a run: an admin all; a user the runs they started that are in their workspaces. */
export function runInScope(ctx: ApiContext, user: Who, runId: string): boolean {
  if (user.role === "admin") return true;
  return ctx.scheduler.ownerOf(runId) === user.id && inWorkspaces(userWorkspaces(user.id), ctx.scheduler.workspaceOf(runId));
}

/** The records in the caller's workspaces (all for an admin). */
export function scopedRepos<T extends { workspace?: string }>(user: Who, repos: T[]): T[] {
  const ws = callerWorkspaces(user);
  return ws === undefined ? repos : repos.filter((r) => inWorkspaces(ws, r.workspace));
}

const repoInScope = (user: Who, rec: RepoRecord | undefined): RepoRecord | undefined =>
  rec && inWorkspaces(callerWorkspaces(user), rec.workspace) ? rec : undefined;

/** findOwnedRepo, but only when the record is in the caller's workspaces. */
export function findScopedRepo(user: Who, name: string): RepoRecord | undefined {
  return repoInScope(user, findOwnedRepo(user.id, name));
}

/** findOwnedProject, but only when the record is in the caller's workspaces. */
export function findScopedProject(user: Who, name: string): RepoRecord | undefined {
  return repoInScope(user, findOwnedProject(user.id, name));
}

/** True when the session's repository is in the caller's workspaces. A session whose repository record is gone stays visible. */
export function sessionInScope(user: Who, s: Pick<Session, "owner" | "repo">): boolean {
  if (user.role === "admin") return true;
  let rec: RepoRecord | undefined;
  try {
    rec = findOwnedProject(s.owner, s.repo);
  } catch {
    rec = undefined;
  }
  return rec === undefined || inWorkspaces(callerWorkspaces(user), rec.workspace);
}

/**
 * The workspace check of a rule (called by authorize() after the role and ownership checks). Throws 404 with the same text as an
 * unknown object when the object is the caller's but outside their workspaces. Other cases are left to the handler.
 */
export function checkScope(ctx: ApiContext, user: User, scope: RuleScope, seg: string[]): void {
  if (user.role === "admin") return;
  const ws = callerWorkspaces(user);
  switch (scope) {
    case "run":
      if (!inWorkspaces(ws, ctx.scheduler.workspaceOf(seg[1] ?? ""))) throw new HttpError(404, "run not found");
      return;
    case "repo": {
      const rec = getRepo(seg[1] ?? "");
      if (rec && rec.owner === user.id && !inWorkspaces(ws, rec.workspace)) throw new HttpError(404, "no such repository");
      return;
    }
    case "repo-name": {
      let rec: RepoRecord | undefined;
      try {
        rec = findOwnedRepo(user.id, `${seg[1]}/${seg[2]}`);
      } catch {
        return; // a bad name: the handler validates it
      }
      if (rec && !inWorkspaces(ws, rec.workspace)) throw new HttpError(404, "no such repository");
      return;
    }
    case "session": {
      const s = getSession(seg[1] ?? "");
      if (!s || s.owner !== user.id) return;
      if (!sessionInScope(user, s)) throw new HttpError(404, "no such refinement session");
      // The architect run keeps the workspace it was queued in: a repository moved since then does not open it, nor its run (#817).
      const run = s.architect?.runId;
      if (run && !inWorkspaces(ws, ctx.scheduler.workspaceOf(run))) throw new HttpError(404, "no such refinement session");
      return;
    }
    default:
      return;
  }
}
