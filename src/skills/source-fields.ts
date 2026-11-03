import { githubKey, validGithubName } from "../auth/repo-url.js";

// The optional source fields `access` and `exclude`, as pure functions: the value and a list of [field, message] problems.
// `sources.ts` calls them once `paths`, `trust` and `repositoryKey` are known.

export type FieldProblems = [field: string, message: string][];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const inside = (parent: string, child: string) => child.startsWith(parent + "/");
export const EXCLUDE_MAX = 200;

/** `access: { repo: <owner/name> }`: only for a first-party source, and only for the repository of the source itself. */
export function parseAccess(raw: unknown, ctx: { trust?: string; repositoryKey?: string }): { value?: { repo: string }; problems: FieldProblems } {
  const problems: FieldProblems = [];
  const bad = (m: string) => void problems.push(["access", m]);
  if (!isObject(raw)) {
    bad("must be a map like { repo: owner/name }");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (k !== "repo") bad("has an unknown key; only repo is allowed");
  if (ctx.trust !== undefined && ctx.trust !== "first-party") bad("is only allowed for a first-party source");
  const repo = raw.repo;
  if (typeof repo !== "string" || !validGithubName(repo)) {
    bad("repo must be a GitHub repository written as owner/name");
    return { problems };
  }
  if (ctx.repositoryKey !== undefined && githubKey(repo) !== ctx.repositoryKey) bad("repo must be the repository of the source");
  if (problems.length) return { problems };
  return { value: { repo }, problems };
}

/** `exclude: [<folder>, …]`: folders strictly inside one of `paths` that the import leaves out. */
export function parseExclude(raw: unknown, paths: readonly string[], pathProblem: (p: string) => string | undefined): { value?: string[]; problems: FieldProblems } {
  const problems: FieldProblems = [];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > EXCLUDE_MAX) {
    return { problems: [["exclude", `must be a list of 1 to ${EXCLUDE_MAX} folders`]] };
  }
  const out: string[] = [];
  raw.forEach((v, j) => {
    const field = `exclude[${j}]`;
    if (typeof v !== "string") return void problems.push([field, "must be text"]);
    const why = v === "." ? "must not be the repository root" : pathProblem(v);
    if (why) return void problems.push([field, why]);
    if (!paths.some((p) => (p === "." ? true : inside(p, v)))) return void problems.push([field, "must be a folder inside one of the paths"]);
    if (out.includes(v)) return void problems.push([field, "is listed twice"]);
    out.push(v);
  });
  if (problems.length) return { problems };
  return { value: out, problems };
}
