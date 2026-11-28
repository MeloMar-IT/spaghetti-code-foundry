import { isLocalRepoName } from "../auth/local-name.js";
import { findLocalRepo, findOwnedProject, findOwnedRepo, type RepoRecord } from "../auth/repos.js";
import type { User } from "../auth/users.js";
import { ghReadOnly } from "../gh-retry.js";
import { ghJson, isFoundryComment, withGhEnv, type Comment, type GhSession } from "../github.js";
import { guardedLine as line, type GuardOptions } from "../help/guard.js";
import { BRANCH_PATTERN, COMMENTS_DEFAULT,type IssueArgs, type IssuePullsArgs, type ToolResult } from "../help/tools.js";
import type { Asker, Source } from "../help/turn.js";
import { repoGhIdentity } from "../queue/gh-identity.js";
import { isLookUpCall, lookUpArgs } from "../stories/github-store.js";
import { storeFor } from "../stories/store.js";
import { currentAccount } from "./help-context.js";
import { stateId } from "./help-evidence.js";
import type { StatusOptions } from "./help-github-status.js";
import { authorize, findRule } from "./permissions.js";
import type { ApiContext } from "./server.js";

/**
 * The `issue` and `issue_pulls` look-ups of Ask Foundry. Who may read what is as for `GET your-turn/detail`: a user only a
 * repository they own, with that repository's own sign-in and never the server's. Only `gh` read calls are made, and their
 * arguments hold only checked values. Every text from GitHub is guarded on its own (`guardedLine`). A model gets at most
 * 1200 characters of a source, so a result is split into small sources of whole entries.
 */

export interface GithubToolOptions extends StatusOptions {
  /** All `gh` calls of one look-up share this time. */
  ghTimeoutMs?: number;
}

export const NO_REPO = "No repository with that name was found for this person.";
export const NO_ISSUE = "No issue with that number was found in this repository.";
export const HOST_LOGIN = "This repository uses the server's own GitHub login, which is not used here. A GitHub token or the GitHub App can be set for it under My repositories.";
export const SIGN_IN = "The GitHub sign-in of this repository does not work. It can be checked under My repositories.";
export const UNREACHABLE = "GitHub could not be reached. The look-up github_status says whether GitHub has a problem.";
export const LOCAL_NO_PULLS = "This project is local: it has no pull requests on GitHub.";

const GH_TIMEOUT_MS = 10_000;
const LABELS = 10;
const COMMENTS_PER_SOURCE = 2;
const PULLS = 5;
const PULLS_PER_SOURCE = 2;
const TIMELINE_PAGES = 3;
const LISTED = 100;
const OF_BRANCH = 10;
const CHECKS_READ = 100;

const nothing = (note: string): ToolResult => ({ note, sources: [] });

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---- who may read, and as whom ----------------------------------------------------------------------------

function mayReadIssues(ctx: ApiContext, user: User): boolean {
  const seg = ["your-turn", "detail"];
  const rule = findRule("GET", seg);
  if (!rule) return false;
  try {
    authorize(ctx, user, rule, seg);
    return true;
  } catch {
    return false;
  }
}

/** Runs `fn` with the sign-in of a stored repository. The server's own login only when `hostAllowed`. */
async function asRecord(ctx: ApiContext, rec: RepoRecord, hostAllowed: boolean, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const id = repoGhIdentity(rec.id, { config: ctx.config });
  try {
    if (!hostAllowed && id.usesHostLogin()) return nothing(HOST_LOGIN);
    let session: GhSession;
    try {
      session = await id.prepare();
    } catch {
      return nothing(SIGN_IN);
    }
    // the method may have changed while the sign-in was made: a session without its own env is the server's login
    if (!hostAllowed && !session.env) return nothing(HOST_LOGIN);
    return await withGhEnv(session, fn);
  } finally {
    id.dispose();
  }
}

/**
 * Runs `fn` for a repository the account may read, with the sign-in it may use; otherwise the refusal in fixed words.
 * Another account's repository and an unknown one get the same words, before anything is read.
 */
async function readAs(ctx: ApiContext, asker: Asker, repo: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const user = currentAccount(asker);
  if (!user || !mayReadIssues(ctx, user)) return nothing(NO_REPO);
  const admin = user.role === "admin";
  if (isLocalRepoName(repo)) {
    return (admin ? findLocalRepo(repo) : findOwnedProject(user.id, repo)) ? fn() : nothing(NO_REPO);
  }
  const own = findOwnedRepo(user.id, repo);
  if (!admin) return own ? asRecord(ctx, own, false, fn) : nothing(NO_REPO);
  if (own) return asRecord(ctx, own, true, fn);
  const cfg = ctx.watchers.tracked().find((t) => t.watcher.github_repo.toLowerCase() === repo.toLowerCase())?.watcher;
  if (!cfg) return withGhEnv(undefined, fn);
  let session: GhSession | undefined;
  try {
    // the watchers own this identity: it is not disposed here
    session = await ctx.watchers.identityOf(cfg)?.prepare();
  } catch {
    return nothing(SIGN_IN);
  }
  return withGhEnv(session, fn);
}

// ---- the gh calls ------------------------------------------------------------------------------------------

/** One of the three read calls these look-ups may make, within what is left of the time of the look-up. */
async function readGh<T>(args: string[], deadline: number): Promise<T> {
  if (!isLookUpCall(args) || !ghReadOnly(args)) throw new Error("not a read call of a look-up");
  const left = deadline - Date.now();
  if (left <= 0) throw new Error("out of time");
  return ghJson<T>(args, undefined, left);
}

/** What `gh` printed about a failed call, without the command line. It is only matched, never passed on. */
function errorWords(e: unknown): string {
  const err = (e ?? {}) as { stderr?: unknown; message?: unknown };
  const message = typeof err.message === "string" ? err.message.split("\n").slice(1).join("\n") : "";
  return `${typeof err.stderr === "string" ? err.stderr : ""}\n${message}`;
}

/** The fixed note for a repository or issue GitHub does not have; undefined for any other failure. */
function missing(e: unknown, otherwise: string): string | undefined {
  const words = errorWords(e);
  if (/Could not resolve to a Repository/i.test(words)) return NO_REPO;
  if (/Could not resolve to an Issue/i.test(words)) return NO_ISSUE;
  return /HTTP 404|Not Found/i.test(words) ? otherwise : undefined;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => x !== null && typeof x === "object") as T[]) : []);

// ---- issue -------------------------------------------------------------------------------------------------

interface IssueRead {
  title: string;
  state: string;
  labels: (string | { name?: string })[];
  /** Oldest first. */
  comments: Partial<Comment>[];
}

async function readIssue(repo: string, n: number, deadline: number): Promise<IssueRead | string> {
  if (isLocalRepoName(repo)) {
    const store = storeFor(repo);
    const found = await store.get(n);
    if (!found) return NO_ISSUE;
    return { title: found.title, state: found.state, labels: found.labels, comments: await store.comments(n) };
  }
  let got: Partial<IssueRead>;
  try {
    got = await readGh<Partial<IssueRead>>(lookUpArgs.issue(repo, n), deadline);
  } catch (e) {
    return missing(e, NO_ISSUE) ?? UNREACHABLE;
  }
  if (typeof got?.title !== "string" || typeof got.state !== "string") return UNREACHABLE;
  return { title: got.title, state: got.state, labels: Array.isArray(got.labels) ? got.labels : [], comments: list(got.comments) };
}

function issueResult(repo: string, n: number, issue: IssueRead, wanted: number, guard: GuardOptions): ToolResult {
  const observedAt = new Date().toISOString();
  const state = line(issue.state.toLowerCase(), guard, 30);
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : (l?.name ?? "")));
  const newest = issue.comments.slice(-wanted).reverse();
  const shown = `showing the newest ${newest.length} of ${issue.comments.length} comments`;
  const source = (id: string, title: string, lines: string[]): Source => ({
    id,
    kind: "state",
    title,
    ref: `${repo}#${n}`,
    observedAt,
    excerpt: [`Observed by the server at ${observedAt}.`, ...lines].join("\n"),
  });
  const facts = source(stateId("issue", `${repo}#${n}`), `Issue #${n} of ${repo}`, [
    `title: ${line(issue.title, guard, 200)}`,
    `state: ${state}`,
    `labels: ${labels.length ? labels.slice(0, LABELS).map((l) => line(l, guard, 50)).join(", ") : "none"}${labels.length > LABELS ? ` and ${labels.length - LABELS} more` : ""}`,
    `comments: ${shown}`,
  ]);
  const lines = newest.map((c) => {
    const body = c.body ?? "";
    const foundry = isFoundryComment({ body, viewerDidAuthor: c.viewerDidAuthor }) ? " (Foundry)" : "";
    return `- ${line(c.createdAt ?? "", guard, 25)} · ${line(c.author?.login ?? "unknown", guard, 40)}${foundry}: ${line(body, guard, 300)}`;
  });
  const parts = chunks(lines, COMMENTS_PER_SOURCE).map((part, i) => {
    const first = i * COMMENTS_PER_SOURCE + 1;
    const which = part.length > 1 ? `${first} and ${first + 1}` : `${first}`;
    return source(stateId("issue-comments", `${repo}#${n}#${i}`), `Comments of issue #${n} of ${repo}, part ${i + 1}`, [`Of the newest ${newest.length} comments, newest first: ${which}.`, ...part]);
  });
  return { note: `Read issue #${n}: it is ${state}; ${shown}.`, sources: [facts, ...parts] };
}

export async function issueTool(ctx: ApiContext, asker: Asker, args: IssueArgs, guard: GuardOptions, o: GithubToolOptions = {}): Promise<ToolResult> {
  return readAs(ctx, asker, args.repo, async () => {
    const got = await readIssue(args.repo, args.number, Date.now() + (o.ghTimeoutMs ?? GH_TIMEOUT_MS));
    return typeof got === "string" ? nothing(got) : issueResult(args.repo, args.number, got, args.comments ?? COMMENTS_DEFAULT, guard);
  });
}

// ---- pull requests -----------------------------------------------------------------------------------------

const HOW = ["linked to close this issue", "mentions this issue", "matched by branch name (a guess)"] as const;

interface PullDetails {
  state?: string;
  title?: string;
  headRefName?: string;
}
interface ListedPull extends PullDetails {
  number: number;
  url?: string;
  isCrossRepository?: boolean;
  statusCheckRollup?: unknown;
}
interface FoundPull extends PullDetails {
  number: number;
  how?: (typeof HOW)[number];
  checks?: string;
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/** The checks of a pull request in one line, from gh's `statusCheckRollup` (check runs and commit statuses). */
export function checksSummary(rollup: unknown, guard: GuardOptions = {}): string {
  if (!Array.isArray(rollup)) return "checks: not read";
  if (!rollup.length) return "checks: none";
  let passed = 0;
  let pending = 0;
  const failed: string[] = [];
  for (const c of list<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>(rollup)) {
    const verdict = c.status !== undefined && c.status !== "COMPLETED" ? "PENDING" : String(c.conclusion || c.state || "");
    if (PASSED.has(verdict)) passed++;
    else if (FAILED.has(verdict)) failed.push(c.name ?? c.context ?? "unnamed");
    else pending++;
  }
  const names = failed.length ? ` (${failed.slice(0, 3).map((x) => line(x, guard, 40)).join(", ")}${failed.length > 3 ? ", …" : ""})` : "";
  return `checks: ${passed} passed, ${failed.length} failed${names}, ${pending} pending${rollup.length >= CHECKS_READ ? " (first 100 only)" : ""}`;
}

function pullsResult(repo: string, what: { key: string; words: string }, pulls: readonly FoundPull[], notices: readonly string[], guard: GuardOptions): ToolResult {
  const observedAt = new Date().toISOString();
  const rows = pulls.map((p) => {
    const unread = p.title === undefined && p.state === undefined;
    return [
      `- #${p.number}`,
      ...(unread
        ? ["details not read"]
        : [line(String(p.state ?? "state not read").toLowerCase(), guard, 15), line(p.title ?? "", guard, 100), p.headRefName ? `branch ${line(p.headRefName, guard, 80)}` : "branch not read"]),
      ...(p.how ? [p.how] : []),
      p.checks ?? "checks: not read",
    ].join(" · ");
  });
  const parts = rows.length ? chunks(rows, PULLS_PER_SOURCE) : [[notices.length ? "No pull request was found in what could be read; there may be one." : "No pull request was found."]];
  const sources = parts.map((part, i): Source => ({
    id: stateId("issue-pulls", `${repo}#${what.key}#${i}`),
    kind: "state",
    title: `Pull requests of ${what.words} of ${repo}, part ${i + 1}`,
    ref: what.key.startsWith("issue:") ? `${repo}#${what.key.slice(6)}` : repo,
    observedAt,
    excerpt: [`Observed by the server at ${observedAt}.`, ...(i === 0 ? notices : []), ...part].join("\n"),
  }));
  return { note: `Found ${rows.length} pull request(s) to list.${notices.length ? ` ${notices.join(" ")}` : ""}`.slice(0, 300), sources };
}

const MORE = "More pull requests were found than are listed.";

async function pullsOfBranch(repo: string, branch: string, deadline: number, guard: GuardOptions): Promise<ToolResult> {
  let got: ListedPull[];
  try {
    got = list<ListedPull>(await readGh(lookUpArgs.pulls(repo, { head: branch, limit: OF_BRANCH, fields: "number,state,title,headRefName,url,statusCheckRollup" }), deadline));
  } catch (e) {
    return nothing(missing(e, NO_REPO) ?? UNREACHABLE);
  }
  const exact = got.filter((p) => p.headRefName === branch && Number.isInteger(p.number)).sort((a, b) => b.number - a.number);
  const notices = exact.length > PULLS || got.length >= OF_BRANCH ? [got.length >= OF_BRANCH ? "There may be more pull requests than are listed." : MORE] : [];
  const pulls = exact.slice(0, PULLS).map((p): FoundPull => ({ number: p.number, state: p.state, title: p.title, headRefName: p.headRefName, checks: checksSummary(p.statusCheckRollup, guard) }));
  return pullsResult(repo, { key: `branch:${branch}`, words: "a branch" }, pulls, notices, guard);
}

const sameRepo = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

interface ClosingRef {
  number?: number;
  url?: string;
  repository?: { name?: string; owner?: { login?: string } };
}

/** Is a closing reference a pull request of this repository? One that does not say where it is from is not. */
function closingOf(r: ClosingRef, repo: string): boolean {
  const named = r.repository?.owner?.login && r.repository.name ? `${r.repository.owner.login}/${r.repository.name}` : /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(r.url ?? "")?.[1];
  return Number.isInteger(r.number) && sameRepo(named, repo);
}

interface TimelineEvent {
  event?: string;
  source?: { issue?: { number?: number; title?: string; state?: string; pull_request?: { merged_at?: string | null }; repository?: { full_name?: string } } };
}

/** A pull request of this repository by its number: its state, title and branch. Undefined when GitHub does not give them. */
async function pullByNumber(repo: string, n: number, deadline: number): Promise<PullDetails | undefined> {
  try {
    const got = await readGh<{ number?: unknown; state?: unknown; merged_at?: unknown; title?: unknown; head?: { ref?: unknown } }>(lookUpArgs.pull(repo, n), deadline);
    const ref = got?.head?.ref;
    if (got?.number !== n || typeof got.title !== "string" || typeof ref !== "string") return undefined;
    return { state: got.merged_at ? "MERGED" : String(got.state ?? "").toUpperCase(), title: got.title, headRefName: ref };
  } catch {
    return undefined;
  }
}

/** The pull requests of an issue: GitHub's own links first, then mentions, then branches that are named after it. */
async function pullsOfIssue(repo: string, n: number, deadline: number, guard: GuardOptions): Promise<ToolResult> {
  const notices: string[] = [];
  const found = new Map<number, FoundPull & { rank: number }>();
  const add = (number: number, rank: number, details: PullDetails = {}) => {
    if (!found.has(number)) found.set(number, { number, rank, how: HOW[rank], ...details });
  };
  /** A source of pull requests that could not be read: then an empty result is a failure, not "none". */
  let incomplete = false;

  try {
    const got = await readGh<{ closedByPullRequestsReferences?: unknown }>(lookUpArgs.closing(repo, n), deadline);
    if (!Array.isArray(got?.closedByPullRequestsReferences)) notices.push("Manual links were not read.");
    for (const r of list<ClosingRef>(got?.closedByPullRequestsReferences)) if (closingOf(r, repo)) add(r.number!, 0);
  } catch (e) {
    const gone = /Unknown JSON field/i.test(errorWords(e)) ? undefined : missing(e, NO_ISSUE);
    if (gone) return nothing(gone);
    notices.push("Manual links were not read.");
  }

  for (let page = 1; page <= TIMELINE_PAGES; page++) {
    let events: unknown;
    try {
      events = await readGh(lookUpArgs.timeline(repo, n, page), deadline);
      if (!Array.isArray(events)) throw new Error("not a list");
    } catch (e) {
      const gone = missing(e, NO_ISSUE);
      if (gone && !found.size) return nothing(gone);
      incomplete = true;
      notices.push("Not all mentions could be read.");
      break;
    }
    for (const e of list<TimelineEvent>(events)) {
      const from = e.source?.issue;
      if (e.event !== "cross-referenced" || !from?.pull_request || !Number.isInteger(from.number) || !sameRepo(from.repository?.full_name, repo)) continue;
      add(from.number!, 1, { title: from.title, state: from.pull_request.merged_at ? "merged" : from.state });
    }
    if ((events as unknown[]).length < 100) break;
    if (page === TIMELINE_PAGES) notices.push("Mentions may be incomplete: only 3 timeline pages were read.");
  }

  try {
    const listed = list<ListedPull>(await readGh(lookUpArgs.pulls(repo, { limit: LISTED, fields: "number,state,title,headRefName,url,isCrossRepository" }), deadline));
    const named = new RegExp(`^[^/]+/${n}-`);
    for (const p of listed) {
      if (!Number.isInteger(p.number)) continue;
      const details: PullDetails = { state: p.state, title: p.title, headRefName: p.headRefName };
      const known = found.get(p.number);
      if (known) Object.assign(known, details);
      else if (p.isCrossRepository === false && named.test(p.headRefName ?? "")) add(p.number, 2, details);
    }
    if (listed.length >= LISTED) notices.push("Only the newest 100 pull requests were searched by branch name.");
  } catch (e) {
    const gone = missing(e, NO_REPO);
    if (gone && !found.size) return nothing(gone);
    incomplete = true;
    notices.push("The pull request list could not be read.");
  }

  if (incomplete && !found.size) return nothing(UNREACHABLE);
  const all = [...found.values()].sort((a, b) => a.rank - b.rank || b.number - a.number);
  if (all.length > PULLS) notices.push(MORE);
  const pulls = await Promise.all(
    all.slice(0, PULLS).map(async (p): Promise<FoundPull> => {
      // a pull request outside the newest 100 of the list has no branch yet: GitHub is asked for it by its number
      const known = p.headRefName === undefined ? await pullByNumber(repo, p.number, deadline) : undefined;
      const q: FoundPull = known ? { ...p, ...known } : p;
      const branch = q.headRefName;
      if (!branch || !BRANCH_PATTERN.test(branch)) return q;
      let got: ListedPull[];
      try {
        got = list<ListedPull>(await readGh(lookUpArgs.pulls(repo, { head: branch, limit: OF_BRANCH, fields: "number,statusCheckRollup" }), deadline));
      } catch {
        return q;
      }
      return { ...q, checks: checksSummary(got.find((x) => x.number === q.number)?.statusCheckRollup, guard) };
    }),
  );
  return pullsResult(repo, { key: `issue:${n}`, words: `issue #${n}` }, pulls, notices, guard);
}

export async function issuePullsTool(ctx: ApiContext, asker: Asker, args: IssuePullsArgs, guard: GuardOptions, o: GithubToolOptions = {}): Promise<ToolResult> {
  return readAs(ctx, asker, args.repo, async () => {
    if (isLocalRepoName(args.repo)) return nothing(LOCAL_NO_PULLS);
    const deadline = Date.now() + (o.ghTimeoutMs ?? GH_TIMEOUT_MS);
    return args.issue !== undefined ? pullsOfIssue(args.repo, args.issue, deadline, guard) : pullsOfBranch(args.repo, args.branch!, deadline, guard);
  });
}
