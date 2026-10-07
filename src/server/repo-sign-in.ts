import { findOwnedRepo, type RepoRecord } from "../auth/repos.js";
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
