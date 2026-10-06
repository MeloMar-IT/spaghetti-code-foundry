import { githubKey, githubNameOf, validGithubName } from "./auth/repo-url.js";
import type { Config } from "./config.js";
import { appTokenAccess, ghConfigDir, removeGhConfigDir, repoTokenEnv, stepRepoAccess } from "./engine/repo-access.js";
import type { RunSummary } from "./engine/state.js";
import { flowFiles } from "./flow/load.js";
import { issueState } from "./github.js";
import { type IssueState, knownIssueState, putIssueState } from "./issue-states.js";
import { runOrigin } from "./your-turn.js";

export const CLOSED_MESSAGE = "The issue is closed — nothing to retry. Reopen the issue if the work is still wanted.";
export const FORCE_HINT = " Use --force to resume it anyway.";
export const GATE_TIMEOUT_MS = 15_000;

export const retiredMessage = (flow: string): string =>
  `The flow "${flow}" is retired — this run cannot be resumed. Start the work again with a current flow.`;

export type GateRun = Pick<RunSummary, "vars" | "owner" | "source" | "flow"> & { repo?: string };
export type GateResult = { ok: true; unchecked?: true } | { ok: false; reason: "issue_closed" | "flow_retired"; message: string };
export type RetiredRun = { flow?: string; repo?: string; source?: string };

// Any file name part: only path separators and NUL are out, so no path can be built from it.
const PLAIN_NAME = /^[^/\\\0]+$/;

/** A flow file of this name exists in one of the three flow folders of `repo`. */
export function flowExists(flow: string, repo: string): boolean {
  // A name that is not a plain file name cannot be a flow file; no path is built from it.
  if (!PLAIN_NAME.test(flow)) return false;
  return flowFiles(flow, repo).length > 0;
}

/** A watcher started the run (or it has no source) and its flow is in none of the flow folders. A hand-started run is never retired. */
export function flowRetired(run: RetiredRun, exists: (flow: string, repo: string) => boolean = flowExists): boolean {
  if (!run.flow || !run.repo) return false;
  if (typeof run.source === "string" && run.source !== "" && runOrigin(run.source) !== "watcher") return false;
  // An unsafe name is looked up nowhere: no such flow file can exist.
  if (!PLAIN_NAME.test(run.flow)) return true;
  return !exists(run.flow, run.repo);
}
export interface GateOptions {
  /** The environment for gh; undefined is the server's own gh. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  read?: (repo: string, issue: number) => Promise<IssueState>;
  /** Write the live result to the issue-state store. */
  store?: boolean;
  /** The name the store uses for the repository (the watcher's spelling); default: the run's. */
  storeRepo?: string;
}

/** The repository and issue number of a run; undefined for a run without an issue (a pull request alone is not one). */
export function runIssue(run: Pick<RunSummary, "vars">): { repo: string; issue: number } | undefined {
  const repo = run.vars?.github_repo;
  const text = run.vars?.issue;
  if (typeof repo !== "string" || !validGithubName(repo)) return undefined;
  if (typeof text !== "string" || !/^\d+$/.test(text)) return undefined;
  const issue = Number(text);
  if (!Number.isSafeInteger(issue) || issue < 1 || issue > 2147483647) return undefined;
  return { repo, issue };
}

const closed = (): GateResult => ({ ok: false, reason: "issue_closed", message: CLOSED_MESSAGE });

/** One live look at the issue of the run. A closed issue refuses; when GitHub cannot be asked, only a stored "closed" refuses. */
export async function resumeGate(run: Pick<RunSummary, "vars">, o: GateOptions = {}): Promise<GateResult> {
  const target = runIssue(run);
  if (!target) return { ok: true };
  const { issue } = target;
  // GitHub knows the repository without a ".git" and in any case; the store keeps the watcher's own spelling.
  const repo = githubNameOf(target.repo) ?? target.repo;
  const key = o.storeRepo ?? repo;
  const timeoutMs = o.timeoutMs ?? GATE_TIMEOUT_MS;
  const read = o.read ?? ((r: string, n: number) => issueState(r, n, timeoutMs, o.env));
  let state: IssueState;
  try {
    state = await read(repo, issue);
  } catch {
    let known: ReturnType<typeof knownIssueState>;
    try {
      known = knownIssueState(key, issue);
    } catch {
      known = undefined;
    }
    return known === "closed" ? closed() : { ok: true, unchecked: true };
  }
  if (o.store) {
    try {
      putIssueState(key, issue, state);
    } catch {
      // a write error never changes the answer
    }
  }
  return state === "closed" ? closed() : { ok: true };
}

/** The enabled issues watcher of the repository (the same repository in any case, with or without ".git"). */
export function issuesWatcher(watchers: Config["watchers"], repo: string): Config["watchers"][number] | undefined {
  const key = githubKey(repo);
  return watchers.find((w) => w.enabled && w.source === "issues" && !!w.github_repo && githubKey(w.github_repo) === key);
}

export const issuesWatched = (watchers: Config["watchers"], repo: string): boolean => issuesWatcher(watchers, repo) !== undefined;

const NO_API = () => Promise.reject(new Error("no API access"));

/**
 * The gate for a run: reads the issue with the access of the run's owner (stored token or GitHub App), or with the server's
 * gh when the run has no owner. A deploy key, a refusal or a failed setup cannot call the API: the check is then unchecked
 * (a stored "closed" still refuses). No token or GitHub text is returned.
 */
export async function gateRun(run: GateRun, config: Pick<Config, "github_app" | "watchers">, o: Pick<GateOptions, "timeoutMs" | "read"> = {}): Promise<GateResult> {
  // The live closed check comes first; the retired flow only counts when the issue is not closed.
  const gate = await issueGate(run, config, o);
  if (!gate.ok) return gate;
  return flowRetired(run) ? { ok: false, reason: "flow_retired", message: retiredMessage(run.flow) } : gate;
}

async function issueGate(run: GateRun, config: Pick<Config, "github_app" | "watchers">, o: Pick<GateOptions, "timeoutMs" | "read">): Promise<GateResult> {
  const target = runIssue(run);
  if (!target) return { ok: true };
  const watcher = issuesWatcher(config.watchers, target.repo);
  const base: GateOptions = { ...o, store: !!watcher, storeRepo: watcher?.github_repo };
  const offline: GateOptions = { ...base, store: false, read: NO_API };
  if (!run.owner) return resumeGate(run, base);
  let ghDir: string | undefined;
  try {
    const access = stepRepoAccess({ id: "resume-gate", type: "shell", repo_access: true }, 0, run.flow, run, run.vars);
    if (!access || access.kind === "server") return await resumeGate(run, base);
    let token: { kind: "token"; token: string; url: string; username: string } | undefined;
    if (access.kind === "token") token = access;
    else if (access.kind === "app") {
      const t = await appTokenAccess(access, config, o.timeoutMs ?? GATE_TIMEOUT_MS);
      if (t.ok) token = { kind: "token", token: t.token, url: access.url, username: "x-access-token" };
    }
    if (!token) return await resumeGate(run, offline);
    ghDir = ghConfigDir();
    return await resumeGate(run, { ...base, env: repoTokenEnv(token, {}, ghDir) });
  } catch {
    return await resumeGate(run, offline);
  } finally {
    if (ghDir) {
      try {
        removeGhConfigDir(ghDir);
      } catch {
        // best effort
      }
    }
  }
}
