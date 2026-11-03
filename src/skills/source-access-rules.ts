import { tryParseRepoUrl } from "../auth/repo-url.js";

// Which registered repository gives a private first-party source its access. Pure: the caller reads the list of repositories.
// Every problem is a fixed sentence.

export const ACCESS_NOT_REGISTERED = "the repository is not registered under My repositories; add it there with the method GitHub App";
export const ACCESS_NOT_APP = "the registered repository does not use the method GitHub App; change it under My repositories (a deploy key or a token is not used for a skill source)";

/** The fields of a registered repository (a record of repos.json) that the choice needs. */
export interface SourceRepo {
  id: string;
  url: string;
  method: string;
  installationId?: string;
  added: string;
}

/** The registered record that gives access to the source: the oldest GitHub App record of its repository, else a fixed problem. */
export function accessRecord<T extends SourceRepo>(source: { repositoryKey: string }, repos: readonly T[]): { record: T } | { problem: string } {
  const same = repos.filter((r) => tryParseRepoUrl(r.url)?.key === source.repositoryKey);
  if (same.length === 0) return { problem: ACCESS_NOT_REGISTERED };
  const apps = same.filter((r) => r.method === "github-app" && r.installationId).sort((a, b) => (a.added < b.added ? -1 : a.added > b.added ? 1 : a.id < b.id ? -1 : 1));
  const first = apps[0];
  return first ? { record: first } : { problem: ACCESS_NOT_APP };
}

/** Undefined when the source may be fetched with the access of a registered repository, else the fixed sentence. */
export function accessProblem(source: { repositoryKey: string }, repos: readonly SourceRepo[]): string | undefined {
  const r = accessRecord(source, repos);
  return "problem" in r ? r.problem : undefined;
}
