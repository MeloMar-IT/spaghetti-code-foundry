import { isLocalRepoName } from "../auth/local-name.js";
import { findOwnedProject, findOwnedRepo, type RepoRecord } from "../auth/repos.js";
import { RefinementError } from "../refinement/store.js";
import { repoGhIdentity } from "../queue/gh-identity.js";
import { withGhEnv } from "../github.js";
import { HttpError } from "./http.js";
import type { ApiContext } from "./server.js";

/**
 * Runs `fn` with the GitHub sign-in of the repository `owner` has stored for `githubRepo` (its token or app), and removes the temporary
 * `gh` settings after. The server's own `gh` login is never a fallback: a repository that uses it is refused. A store failure is thrown as it
 * is (the caller's guard answers it); the sign-in errors are plain sentences and become 409.
 */
export async function asOwnedRepo<T>(ctx: ApiContext, owner: string, githubRepo: string, fn: (rec: RepoRecord) => Promise<T>): Promise<T> {
  const rec = findOwnedRepo(owner, githubRepo);
  if (!rec) throw new HttpError(409, "the repository is not in My repositories any more");
  const id = repoGhIdentity(rec.id, { config: ctx.config });
  try {
    if (id.usesHostLogin()) {
      throw new HttpError(409, "this repository uses the server's own GitHub login; set a GitHub token or the GitHub App for it under My repositories");
    }
    let session;
    try {
      session = await id.prepare();
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return await withGhEnv(session, () => fn(rec));
  } finally {
    id.dispose();
  }
}

const NOT_YOURS = "that is not one of your projects any more";

/**
 * `asOwnedRepo` for a GitHub name. For a local project (`local:<slug>-<id8>`): `fn` runs with the owner's record and no sign-in (no `gh`);
 * a project that is not the owner's (any more) is `not-yours` (403).
 */
export async function asOwnedProject<T>(ctx: ApiContext, owner: string, name: string, fn: (rec: RepoRecord) => Promise<T>): Promise<T> {
  if (!isLocalRepoName(name)) return asOwnedRepo(ctx, owner, name, fn);
  const rec = findOwnedProject(owner, name);
  if (!rec) throw new RefinementError("not-yours", NOT_YOURS);
  return fn(rec);
}

/** Local project only: throws `not-yours` when `owner` no longer owns it. Synchronous, so it can run inside the story lock. */
export function stillOwnsProject(owner: string, name: string): void {
  if (!findOwnedProject(owner, name)) throw new RefinementError("not-yours", NOT_YOURS);
}
