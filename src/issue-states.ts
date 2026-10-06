import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_HOME } from "./flow/load.js";

export type IssueState = "open" | "closed";
export interface IssueStateEntry { state: IssueState; at: string }
export interface RepoIssueStates { repo: string; checkedAt?: string; failedAt?: string; issues: Record<string, IssueStateEntry> }

/** One file per repository, so two repositories (or two processes) never overwrite each other. */
export const issueStatesDir = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "issue-states");
const fileOf = (repo: string) => join(issueStatesDir(), `${encodeURIComponent(repo)}.json`);

const cache = new Map<string, { mtimeMs: number; size: number; value: RepoIssueStates | undefined }>();

const isTime = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The stored value when the whole file has the right shape, else undefined. */
function parse(text: string): RepoIssueStates | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown> | null;
    if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
    if (typeof j.repo !== "string" || !j.repo) return undefined;
    if (j.checkedAt !== undefined && !isTime(j.checkedAt)) return undefined;
    if (j.failedAt !== undefined && !isTime(j.failedAt)) return undefined;
    const issues = j.issues as Record<string, unknown> | null | undefined;
    if (!issues || typeof issues !== "object" || Array.isArray(issues)) return undefined;
    for (const [k, v] of Object.entries(issues)) {
      const e = v as Partial<IssueStateEntry> | null;
      if (!/^[1-9]\d{0,9}$/.test(k) || Number(k) > 2147483647 || !e || typeof e !== "object") return undefined;
      if ((e.state !== "open" && e.state !== "closed") || !isTime(e.at)) return undefined;
    }
    return j as unknown as RepoIssueStates;
  } catch {
    return undefined;
  }
}

function readFile(file: string): RepoIssueStates | undefined {
  try {
    const st = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = parse(readFileSync(file, "utf8"));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    cache.delete(file);
    return undefined;
  }
}

/** What is stored for a repository; undefined when there is no (valid) entry. */
export function readIssueStates(repo: string): RepoIssueStates | undefined {
  const v = readFile(fileOf(repo));
  return v && v.repo === repo ? v : undefined;
}

/** open / closed as of the last check; "unknown" when the last check failed and nothing is stored; undefined without an entry. */
export function knownIssueState(repo: string, issue: number | string): IssueState | "unknown" | undefined {
  const r = readIssueStates(repo);
  if (!r) return undefined;
  const e = r.issues[String(Number(issue))];
  if (e) return e.state;
  return r.failedAt ? "unknown" : undefined;
}

/** Written to a temporary file and renamed, so a reader never sees half a file. */
function write(repo: string, value: RepoIssueStates) {
  const file = fileOf(repo);
  mkdirSync(issueStatesDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  cache.delete(file);
}

/** Replaces the entry of the repository with exactly these issues (old ones are pruned) and clears failedAt. */
export function saveIssueStates(repo: string, states: Map<number, IssueState>, now = new Date()) {
  const at = now.toISOString();
  const issues: Record<string, IssueStateEntry> = {};
  for (const [n, state] of states) issues[String(n)] = { state, at };
  write(repo, { repo, checkedAt: at, issues });
}

/** Sets the state of one issue in an existing entry; does nothing when the repository has none. */
export function noteIssueState(repo: string, issue: number, state: IssueState, now = new Date()) {
  const r = readIssueStates(repo);
  if (!r) return;
  write(repo, { ...r, issues: { ...r.issues, [String(issue)]: { state, at: now.toISOString() } } });
}

/** A check failed: stored states stay, failedAt is set. */
export function markIssueCheckFailed(repo: string, now = new Date()) {
  const r = readIssueStates(repo) ?? { repo, issues: {} };
  write(repo, { ...r, failedAt: now.toISOString() });
}

/** Removes the entry of the repository. */
export function dropIssueStates(repo: string) {
  const file = fileOf(repo);
  rmSync(file, { force: true });
  cache.delete(file);
}

/** The repositories that have an entry. */
export function storedIssueRepos(): string[] {
  let names: string[];
  try {
    names = readdirSync(issueStatesDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((f) => readFile(join(issueStatesDir(), f))?.repo ?? []);
}
