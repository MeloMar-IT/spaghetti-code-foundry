import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Marker in every comment the factory writes, e.g. <!-- claude-factory run=… --> */
export const BOT_MARKER = "<!-- claude-factory";
/** Markers that identify our own comments: the one we write, and the new product name's. */
export const BOT_MARKERS = [BOT_MARKER, "<!-- spaghetti-code-foundry"] as const;

/**
 * The identity `gh` acts as for the code that runs inside `withGhEnv`: the env that makes it use one repository's credential
 * (and nothing from the host), whether it is the GitHub App, and a stamp that changes when the account changes.
 * A session is frozen: a check that started with it keeps it until it ends.
 */
export interface GhSession {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** gh acts as a GitHub App installation: there is no user, so `api user` and collaborator checks do not work. */
  readonly app?: boolean;
  readonly stamp: string;
}

const sessions = new AsyncLocalStorage<GhSession | undefined>();

/** Runs `fn` (and everything it starts: timers, promises) with this identity for every `gh` call. `undefined` is the host login. */
export const withGhEnv = <T>(session: GhSession | undefined, fn: () => T): T => sessions.run(session, fn);

/** The identity of the running code, if a repository's. */
export const currentGhSession = (): GhSession | undefined => sessions.getStore();

/** Does `gh` act as a GitHub App here? */
export const ghActsAsApp = (): boolean => sessions.getStore()?.app === true;

/** The host's variables that would make `gh` act as someone else. */
const GH_AUTH_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;

function childEnv(env: NodeJS.ProcessEnv | undefined, session: GhSession | undefined): NodeJS.ProcessEnv {
  if (env) return { ...process.env, ...env };
  if (!session?.env) return process.env;
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GH_AUTH_VARS) delete out[k];
  for (const [k, v] of Object.entries(session.env)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** An error of a call made with a token: the token is replaced wherever the error holds it. */
function scrub(e: unknown, token: string): unknown {
  if (!e || typeof e !== "object") return e;
  const err = e as Record<string, unknown>;
  for (const k of ["message", "stderr", "stdout", "cmd"]) {
    if (typeof err[k] === "string" && (err[k] as string).includes(token)) err[k] = (err[k] as string).split(token).join("[redacted]");
  }
  return e;
}

/** `timeoutMs` kills the process and rejects; without it gh may take as long as it likes. */
export async function gh(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, input?: string): Promise<string> {
  const session = sessions.getStore();
  const p = exec(process.env.FACTORY_GH_BIN ?? "gh", args, {
    maxBuffer: 20_000_000,
    env: childEnv(env, session),
    timeout: timeoutMs,
  });
  if (input !== undefined) {
    p.child.stdin?.on("error", () => {}); // gh may exit before it reads everything; its exit code tells
    p.child.stdin?.end(input);
  }
  const token = !env ? session?.env?.GH_TOKEN : undefined;
  try {
    return (await p).stdout;
  } catch (e) {
    throw token ? scrub(e, token) : e;
  }
}

/** One resource of GitHub's request limit (`gh api rate_limit`). */
export interface RateResource { limit: number; used: number; remaining: number; reset: number }
/** What `gh api rate_limit` said, and when it was read. */
export interface RateReading { at: string; resources: Record<string, RateResource> }

/** The valid resources of a `rate_limit` answer. */
export function parseRateLimit(text: string, at = new Date(), prefix = ""): RateReading | undefined {
  try {
    const res = (JSON.parse(text) as { resources?: Record<string, Partial<RateResource>> }).resources ?? {};
    const resources: Record<string, RateResource> = {};
    // Every valid resource (core, graphql, search, …); `prefix` names another identity ("bot:").
    for (const [k, r] of Object.entries(res)) {
      if (r && [r.limit, r.used, r.remaining, r.reset].every((n) => typeof n === "number" && Number.isFinite(n)) && r.limit! > 0) {
        resources[`${prefix}${k}`] = { limit: r.limit!, used: r.used!, remaining: r.remaining!, reset: r.reset! };
      }
    }
    return Object.keys(resources).length ? { at: at.toISOString(), resources } : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the request limit (this call does not count against it). Never throws; undefined when it cannot be read. */
export async function readRateLimit(timeoutMs = 4_000, env?: NodeJS.ProcessEnv, prefix = ""): Promise<RateReading | undefined> {
  try {
    return parseRateLimit(await gh(["api", "rate_limit"], env, timeoutMs), new Date(), prefix);
  } catch {
    return undefined;
  }
}

export async function ghJson<T>(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<T> {
  const out = (await gh(args, env, timeoutMs)).trim();
  return (out ? JSON.parse(out) : []) as T;
}

export interface Comment {
  author: { login: string };
  body: string;
  createdAt: string;
  /** Link to the comment (…#issuecomment-<id>); gh reports it. */
  url?: string;
  /** Did the account `gh` acts as write it? */
  viewerDidAuthor?: boolean;
}

export interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
  body?: string;
  state?: string;
  createdAt?: string;
}

export const isBot = (c: { body: string }) => BOT_MARKERS.some((m) => c.body.includes(m));

/** Last line of the status comment: the one comment per issue the Foundry keeps up to date. */
export const STATUS_MARKER = "<!-- claude-factory status -->";
const STATUS_MARKERS: readonly string[] = [STATUS_MARKER, "<!-- spaghetti-code-foundry status -->"];

/** A status comment has its marker as the last line; a comment that only quotes the marker is not one. */
export function isStatusComment(c: { body: string }): boolean {
  const last = c.body.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last !== undefined && STATUS_MARKERS.includes(last);
}

/** The numeric id in a comment link (…#issuecomment-123). */
export function commentId(url: string | undefined): string | undefined {
  return /#issuecomment-(\d+)\s*$/.exec(url?.trim() ?? "")?.[1];
}

const normal = (t: string) => t.replace(/\r\n/g, "\n").trim();
/** Is this the same comment text? Line ends and trailing white space do not count; no text is never the same. */
export function sameBody(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normal(a) === normal(b);
}

export async function issueComments(repo: string, issue: number | string, timeoutMs?: number): Promise<Comment[]> {
  const r = await ghJson<{ comments: Comment[] }>(["issue", "view", String(issue), "--repo", repo, "--json", "comments,labels"], undefined, timeoutMs);
  return r.comments ?? [];
}

/** The permission GitHub reports for this user on the repo ("admin", "write", "read", …). Rejects when GitHub cannot tell. */
export async function repoPermission(repo: string, login: string, timeoutMs?: number): Promise<string> {
  return (await gh(["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"], undefined, timeoutMs)).trim();
}

/** Does this permission allow pushing? */
export const mayWrite = (perm: string) => ["admin", "maintain", "write"].includes(perm);

/** Can this user push to the repo? Used to trust /approve and /reject. A failing call counts as no. */
export async function canWrite(repo: string, login: string): Promise<boolean> {
  try {
    return mayWrite(await repoPermission(repo, login));
  } catch {
    return false;
  }
}

/** The login `gh` acts as. */
export async function ghLogin(timeoutMs?: number): Promise<string> {
  return (await gh(["api", "user", "--jq", ".login"], undefined, timeoutMs)).trim();
}

/** Posts a comment; the text goes through stdin (not a shell, not the process list). Returns the id of the new comment when gh prints its link. */
export async function commentOnIssue(repo: string, issue: number, body: string, timeoutMs?: number): Promise<string | undefined> {
  const out = await gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], undefined, timeoutMs, body);
  return commentId(out.split("\n").map((l) => l.trim()).filter(Boolean).at(-1));
}

export interface UpsertOptions {
  /** The comment id from an earlier call: edit it without reading the issue. */
  id?: string;
  /** Post a new comment when the issue has none of ours. */
  create: boolean;
  timeoutMs?: number;
  /** Time (ms since epoch) after which no call is made: the call rejects with "out of time". */
  deadline?: number;
  /** The login gh acts as, when known (saves a call). */
  login?: string;
}
export interface UpsertResult {
  id?: string;
  /** Created or edited. */
  changed: boolean;
  /** A new comment was posted. */
  created?: boolean;
  /** Extra status comments of ours that were deleted. */
  removed: number;
  /** Extra status comments of ours that could not be deleted. */
  left: number;
  login?: string;
}

const MAX_REMOVE = 5;
export const APP_NO_AUTHOR = "this gh does not tell who wrote a comment, so the app cannot tell its own status comment; update gh";

/**
 * Keeps one status comment of ours on an issue: edits it, or creates it. Ours means: marker on the last line and
 * written by the account gh acts as. Extra ones of ours (an older one exists) are deleted, best effort.
 * Rejects when a needed call fails, the comment has no link, or the deadline has passed.
 */
export async function upsertStatusComment(repo: string, issue: number, body: string, o: UpsertOptions): Promise<UpsertResult> {
  let login = o.login;
  const limit = () => {
    const left = o.deadline === undefined ? undefined : o.deadline - Date.now();
    if (left !== undefined && left <= 0) throw new Error("out of time");
    return left === undefined ? o.timeoutMs : Math.min(o.timeoutMs ?? left, left);
  };
  const edit = async (id: string) => {
    await gh(["api", `repos/${repo}/issues/comments/${id}`, "-X", "PATCH", "--input", "-"], undefined, limit(), JSON.stringify({ body }));
  };
  if (o.id) {
    await edit(o.id);
    return { id: o.id, changed: true, removed: 0, left: 0, login };
  }
  const comments = await issueComments(repo, issue, limit());
  const ours: Comment[] = [];
  const app = ghActsAsApp();
  for (const c of comments) {
    if (!isStatusComment(c)) continue;
    // An app has no user to compare with: only what gh itself says is ours counts.
    if (app && c.viewerDidAuthor === undefined) throw new Error(APP_NO_AUTHOR);
    if (c.viewerDidAuthor === undefined) login ??= await ghLogin(limit());
    if (c.viewerDidAuthor === true || (c.viewerDidAuthor === undefined && c.author.login === login)) ours.push(c);
  }
  if (!ours.length) {
    if (!o.create) return { changed: false, removed: 0, left: 0, login };
    const id = await commentOnIssue(repo, issue, body, limit());
    return { id, changed: true, created: true, removed: 0, left: 0, login };
  }
  const first = ours[0]!;
  const id = commentId(first.url);
  if (!id) throw new Error("the status comment has no link, so it cannot be edited");
  const changed = !sameBody(first.body, body);
  if (changed) await edit(id);
  let removed = 0;
  let left = 0;
  for (const extra of ours.slice(1)) {
    const eid = commentId(extra.url);
    if (!eid || removed + left >= MAX_REMOVE) { left++; continue; }
    try {
      await gh(["api", `repos/${repo}/issues/comments/${eid}`, "-X", "DELETE"], undefined, limit());
      removed++;
    } catch {
      left++;
    }
  }
  return { id, changed, removed, left, login };
}

/** The human comments posted after the latest comment matching `after` (or all, if none matches). */
export function commentsAfter(comments: Comment[], after: (c: Comment) => boolean): Comment[] {
  let idx = -1;
  comments.forEach((c, i) => {
    if (after(c)) idx = i;
  });
  return comments.slice(idx + 1).filter((c) => !isBot(c));
}

export async function setLabels(repo: string, issue: number, add: string | undefined, remove: string[], timeoutMs?: number) {
  const args = ["issue", "edit", String(issue), "--repo", repo];
  for (const l of remove) if (l !== add) args.push("--remove-label", l);
  if (add) args.push("--add-label", add);
  await gh(args, undefined, timeoutMs);
}

export async function ensureLabel(repo: string, name: string, color: string, description: string) {
  await gh(["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"]);
}

/** An issue as the REST API reports it. */
export interface RestIssue {
  number: number;
  state: string;
  /** "completed", "not_planned" or "reopened" once the issue was closed or reopened. */
  state_reason?: string | null;
  title: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  closed_at?: string | null;
  updated_at?: string;
  /** Set when the "issue" is a pull request. */
  pull_request?: unknown;
  labels: ({ name?: string } | string)[];
}

const errorText = (e: unknown) => `${String((e as { stderr?: string }).stderr ?? "")} ${String((e as Error).message)}`;

/** One call to the issue list of a repository: the answer as a list, pull requests left out. */
async function listIssues(repo: string, query: string, timeoutMs?: number): Promise<RestIssue[]> {
  return (await listPage(repo, query, timeoutMs)).issues;
}

async function listPage(repo: string, query: string, timeoutMs?: number): Promise<{ issues: RestIssue[]; full: boolean }> {
  const out = (await gh(["api", `repos/${repo}/issues?${query}state=all&per_page=100&sort=created&direction=desc`], undefined, timeoutMs)).trim();
  const list = (out ? JSON.parse(out) : []) as (RestIssue & { pull_request?: unknown })[];
  if (!Array.isArray(list)) throw new Error("GitHub gave an answer that is not a list of issues");
  return { issues: list.filter((i) => !i.pull_request), full: list.length >= 100 };
}

/** Like listNewestIssues, and whether GitHub's page was full (100 issues and pull requests), so that older ones may be missing. */
export async function listNewestIssuesCut(repo: string, timeoutMs?: number): Promise<{ issues: RestIssue[]; cut: boolean }> {
  const { issues, full } = await listPage(repo, "", timeoutMs);
  return { issues, cut: full };
}

/** The newest issues (not pull requests) with a label, open and closed: one call, at most 100. */
export const listIssuesByLabel = (repo: string, label: string, timeoutMs?: number): Promise<RestIssue[]> => listIssues(repo, `labels=${encodeURIComponent(label)}&`, timeoutMs);

/** The newest issues (not pull requests), open and closed: one call, at most 100. */
export const listNewestIssues = (repo: string, timeoutMs?: number): Promise<RestIssue[]> => listIssues(repo, "", timeoutMs);


/** One issue by number; undefined when GitHub says it does not exist. */
export async function restIssue(repo: string, issue: number, timeoutMs?: number): Promise<RestIssue | undefined> {
  try {
    return JSON.parse((await gh(["api", `repos/${repo}/issues/${issue}`], undefined, timeoutMs)).trim()) as RestIssue;
  } catch (e) {
    if (/not found|HTTP 404/i.test(errorText(e))) return undefined;
    throw e;
  }
}

/**
 * The state of a pull request: "closed" only when GitHub says it is closed and not merged; "gone" when GitHub says it does not exist;
 * "unknown" when the answer is not clear (so a caller can treat it as not closed).
 */
export async function pullState(repo: string, pr: number, timeoutMs?: number): Promise<"open" | "merged" | "closed" | "gone" | "unknown"> {
  let p: { state?: unknown; merged?: unknown; merged_at?: unknown };
  try {
    p = JSON.parse((await gh(["api", `repos/${repo}/pulls/${pr}`], undefined, timeoutMs)).trim());
  } catch (e) {
    if (/not found|HTTP 404/i.test(errorText(e))) return "gone";
    throw e;
  }
  if (!p || typeof p !== "object") return "unknown";
  if (p.merged === true || (typeof p.merged_at === "string" && p.merged_at)) return "merged";
  if (p.state === "open") return "open";
  if (p.state === "closed" && p.merged === false) return "closed";
  return "unknown";
}

/** Makes an issue. Title and text go through stdin as JSON, never into the command line. */
export async function createIssue(repo: string, o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<RestIssue> {
  const out = await gh(["api", `repos/${repo}/issues`, "-X", "POST", "--input", "-"], undefined, timeoutMs, JSON.stringify(o));
  const made = JSON.parse(out.trim()) as RestIssue;
  if (!made || !Number.isSafeInteger(made.number) || made.number < 1) throw new Error("GitHub did not report the new issue");
  return made;
}

/** Replaces the title and text of an issue. Title and text go through stdin as JSON, never into the command line. */
export async function updateIssue(repo: string, issue: number, o: { title: string; body: string }, timeoutMs?: number): Promise<RestIssue> {
  const out = await gh(["api", `repos/${repo}/issues/${issue}`, "-X", "PATCH", "--input", "-"], undefined, timeoutMs, JSON.stringify({ title: o.title, body: o.body }));
  const changed = JSON.parse(out.trim()) as RestIssue;
  if (!changed || changed.number !== issue) throw new Error("GitHub did not report the changed issue");
  return changed;
}

/** Makes a label when it is missing; an existing one is left as it is (no --force). Rejects on any other error. */
export async function createLabelIfMissing(repo: string, name: string, color: string, description: string, timeoutMs?: number): Promise<void> {
  try {
    await gh(["label", "create", name, "--repo", repo, "--color", color, "--description", description], undefined, timeoutMs);
  } catch (e) {
    if (/already exists/i.test(errorText(e))) return;
    throw e;
  }
}

/** At most this many issue numbers go in one GraphQL call; more go in sequential calls. */
export const ISSUE_STATE_BATCH = 500;

/**
 * The state of each issue, in one GraphQL call per 500 numbers. Rejects when a call fails, GitHub reports any
 * error (also for a deleted issue or a pull request), an issue is missing or has an unknown state.
 * `before` runs ahead of every call; when it throws, nothing more is asked.
 */
export async function issueStates(repo: string, numbers: number[], timeoutMs?: number, before?: () => void, env?: NodeJS.ProcessEnv): Promise<Map<number, "open" | "closed">> {
  const slash = repo.indexOf("/");
  const owner = repo.slice(0, Math.max(slash, 0));
  const name = repo.slice(slash + 1);
  if (slash < 0 || !owner || !name) throw new Error(`not a repository: ${repo}`);
  const wanted = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647))];
  const out = new Map<number, "open" | "closed">();
  for (let i = 0; i < wanted.length; i += ISSUE_STATE_BATCH) {
    before?.();
    const chunk = wanted.slice(i, i + ISSUE_STATE_BATCH);
    // Only integers are written into the query text; the repository goes in as variables.
    const fields = chunk.map((n) => `i${n}: issue(number: ${n}) { state }`).join(" ");
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`;
    const text = await gh(["api", "graphql", "--input", "-"], env, timeoutMs, JSON.stringify({ query, variables: { owner, name } }));
    let body: { data?: { repository?: Record<string, { state?: unknown } | null> | null }; errors?: unknown[] };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("GitHub gave an answer that is not JSON");
    }
    if (Array.isArray(body.errors) && body.errors.length) {
      const first = body.errors[0] as { message?: unknown };
      throw new Error(`GitHub reported an error: ${typeof first?.message === "string" ? first.message : "unknown"}`);
    }
    const repoData = body.data?.repository;
    if (!repoData || typeof repoData !== "object") throw new Error(`GitHub gave no repository for ${repo}`);
    for (const n of chunk) {
      const s = repoData[`i${n}`]?.state;
      const state = typeof s === "string" ? s.toLowerCase() : "";
      if (state !== "open" && state !== "closed") throw new Error(`GitHub did not report issue #${n}`);
      out.set(n, state);
    }
  }
  return out;
}

/** The state of one issue. Rejects when it cannot be read. */
export async function issueState(repo: string, issue: number, timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<"open" | "closed"> {
  if (!Number.isInteger(issue) || issue <= 0 || issue > 2147483647) throw new Error("not an issue number");
  const s = (await issueStates(repo, [issue], timeoutMs, undefined, env)).get(issue);
  if (!s) throw new Error(`GitHub did not report issue #${issue}`);
  return s;
}

/** The names of the labels of a repository (all pages). Rejects when GitHub cannot be reached or refuses. */
export async function repoLabels(repo: string, timeoutMs?: number): Promise<string[]> {
  // --jq prints one name per line, also over several pages (plain --paginate prints the arrays one after the other).
  const out = await gh(["api", `repos/${repo}/labels?per_page=100`, "--paginate", "--jq", ".[].name"], undefined, timeoutMs);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}
