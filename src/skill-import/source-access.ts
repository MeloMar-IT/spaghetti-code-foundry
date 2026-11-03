import { listAllRepos, type RepoRecord } from "../auth/repos.js";
import { tryParseRepoUrl } from "../auth/repo-url.js";
import { loadConfig } from "../config.js";
import { appTokenAccess, type AppTokenResult } from "../engine/repo-access.js";
import { ACCESS_NOT_APP, ACCESS_NOT_REGISTERED, accessProblem, accessRecord } from "../skills/source-access-rules.js";
import type { SkillLibrarySource } from "../skills/sources.js";
import type { GitCredential } from "./git-tree.js";

// The access of a private first-party source: the GitHub App of the registered repository gives a new token that can read the
// contents of that one repository. Every failure is a fixed sentence; no text of GitHub and no token is ever in one.

export type SourceAccess = { ok: true; credential?: GitCredential } | { ok: false; problem: string };

export { ACCESS_NOT_APP, ACCESS_NOT_REGISTERED, accessProblem, accessRecord };
export const ACCESS_BAD_TOKEN = "the app's token could not be used; try again";
export const ACCESS_CHANGED = "the source now names another repository or access than the approved one; nothing was fetched";

type Token = typeof appTokenAccess;

/** A source with no `access` gives `{ ok: true }` and reads nothing. Otherwise a new, repository-limited, read-only token. */
export async function sourceCredential(
  source: Pick<SkillLibrarySource, "repositoryKey" | "access">,
  o: { repos?: () => readonly RepoRecord[]; token?: Token; config?: () => ReturnType<typeof loadConfig> } = {},
): Promise<SourceAccess> {
  if (!source.access) return { ok: true };
  let found: ReturnType<typeof accessRecord>;
  try {
    found = accessRecord(source, (o.repos ?? listAllRepos)());
  } catch {
    return { ok: false, problem: ACCESS_NOT_REGISTERED };
  }
  if ("problem" in found) return { ok: false, problem: found.problem };
  const { record } = found;
  const github = tryParseRepoUrl(record.url)?.github;
  if (!github || !record.installationId) return { ok: false, problem: ACCESS_NOT_APP };
  let result: AppTokenResult;
  try {
    result = await (o.token ?? appTokenAccess)({ kind: "app", installationId: record.installationId, url: record.url, github }, (o.config ?? loadConfig)(), undefined, { contents: "read" });
  } catch {
    return { ok: false, problem: ACCESS_BAD_TOKEN };
  }
  if (!result.ok) return { ok: false, problem: result.reason };
  if (!/^[A-Za-z0-9_.-]{1,1024}$/.test(result.token)) return { ok: false, problem: ACCESS_BAD_TOKEN };
  return { ok: true, credential: { username: "x-access-token", password: result.token } };
}

/** The credential bound to the approved source may only be used for a source with the same repository and the same access. */
export function sameDestination(approved: Pick<SkillLibrarySource, "repositoryKey" | "access">, candidate: Pick<SkillLibrarySource, "repositoryKey" | "access">): boolean {
  return approved.repositoryKey === candidate.repositoryKey && approved.access?.repo === candidate.access?.repo;
}
