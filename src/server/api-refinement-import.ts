import type { IncomingMessage } from "node:http";
import { findOwnedRepo } from "../auth/repos.js";
import { githubKey, githubNameOf, validGithubName } from "../auth/repo-url.js";
import type { WatcherConfig } from "../config.js";
import { pullState, restIssue, type RestIssue } from "../github.js";
import { labelNames } from "../queue/watcher.js";
import { buildLabelOf } from "../refinement/build-limits.js";
import { buildingReason, pullsToRead, type PullKind } from "../refinement/issue-building.js";
import { cleanTitle, ideaOf, parseStory } from "../refinement/issue-import.js";
import { issueUrl } from "../refinement/publish.js";
import { IDEA_MAX, RefinementError, SESSION_TITLE_MAX, SOURCE_BODY_MAX, createSessionFromIssue, openSessionOfIssue, type Session } from "../refinement/store.js";
import { HttpError } from "./http.js";
import { sessionUser } from "./api-auth.js";
import { asOwnedRepo } from "./repo-sign-in.js";
import type { ApiContext } from "./server.js";

export const GH_TIMEOUT_MS = 15_000;

/** What went wrong with a call to GitHub, in one line: its own words (the first line of stderr), or that it did not answer. */
export function whatHappened(e: unknown): string {
  const x = e as { killed?: boolean; stderr?: unknown; message?: unknown };
  if (x?.killed === true) return "GitHub did not answer in time";
  const first = (t: unknown) => (typeof t === "string" ? t.split("\n").map((l) => l.trim()).find(Boolean) : undefined);
  return first(x?.stderr) ?? first(x?.message) ?? "unknown error";
}

const bad = (m: string) => new RefinementError("bad-issue", m);

/** What the Foundry has for one issue right now: its runs, and whether a job for it waits. Reads memory and the run files; no await. */
function foundryFacts(ctx: ApiContext, key: string, issue: number) {
  const mine = ctx.scheduler.briefs().filter((b) => b.githubRepo !== undefined && githubKey(b.githubRepo) === key && b.issue === String(issue));
  const ids = new Set(mine.map((b) => b.runId));
  // A new run job names the issue; a job that resumes a run names the run only.
  const queued = ctx.scheduler
    .queue()
    .pending.some((p) => ids.has(p.runId) || (p.kind === "run" && p.githubRepo !== undefined && githubKey(p.githubRepo) === key && p.issue === String(issue)));
  const runs = mine.map((b) => ({ status: b.status, startedAt: b.startedAt, ...(b.pr !== undefined ? { pr: b.pr } : {}) }));
  return { runs, queued };
}

/** The status label names that count for a repository: the defaults and those of each of its watchers. */
function namesFor(ctx: ApiContext, key: string) {
  // The names of the repository's issues watchers replace the defaults; the defaults count only when there is no such watcher.
  const own = ctx.config().watchers.filter((w) => w.source === "issues" && w.github_repo !== "" && githubKey(w.github_repo) === key);
  return own.length ? own.map((w) => labelNames(w)) : [labelNames({} as WatcherConfig)];
}

/**
 * Why the Foundry builds or has built an issue right now, or undefined when it may be written to. A run's pull request only blocks when it is
 * not closed without a merge; the ones not in `pulls` are read (and added to it). Errors of the read propagate.
 */
export async function whyBuilding(ctx: ApiContext, repo: string, n: number, labels: readonly string[], timeout: number, pulls: Map<string, PullKind> = new Map()): Promise<string | undefined> {
  const key = githubKey(repo);
  const names = namesFor(ctx, key);
  const first = foundryFacts(ctx, key, n);
  const early = buildingReason({ labels, runs: first.runs.map(({ pr: _pr, ...r }) => r), queued: first.queued, labelNames: names, pulls });
  if (early) return early;
  for (const pr of pullsToRead(first.runs)) if (!pulls.has(pr)) pulls.set(pr, await pullState(repo, Number(pr), timeout));
  // Fresh facts: a run that started while the pull requests were read still counts.
  const f = foundryFacts(ctx, key, n);
  return buildingReason({ labels, runs: f.runs, queued: f.queued, labelNames: names, pulls });
}

export const labelsOf = (issue: RestIssue): string[] => (Array.isArray(issue.labels) ? issue.labels.flatMap((l) => (typeof l === "string" ? [l] : typeof l?.name === "string" ? [l.name] : [])) : []);

/**
 * Reads an open issue of the caller's repository with the repository's sign-in and makes a refinement session from it. Nothing on GitHub
 * changes. Throws RefinementError for what the caller can fix, HttpError for GitHub and the sign-in.
 */
export async function importIssue(ctx: ApiContext, req: IncomingMessage, body: Record<string, unknown>): Promise<Session> {
  const user = sessionUser(ctx, req);
  if (typeof body.repo !== "string" || !validGithubName(body.repo)) throw new RefinementError("bad-repo", "give a GitHub repository as owner/name");
  const n = body.issue;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 2_147_483_647) throw bad("give the issue number as a whole number from 1");
  if (body.idea !== undefined || body.title !== undefined) throw bad("send an idea or an issue number, not both");

  const rec = findOwnedRepo(user.id, body.repo);
  if (!rec) throw new RefinementError("not-yours", "that is not one of your GitHub repositories");
  const repo = githubNameOf(rec.url);
  if (repo === undefined) throw new RefinementError("not-yours", "that is not one of your GitHub repositories");
  const key = githubKey(repo);
  const dup = openSessionOfIssue(user.id, repo, n);
  if (dup) throw new RefinementError("duplicate", `issue #${n} already has an open refinement session: "${dup.title}"`, dup.id);

  const timeout = ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
  const names = namesFor(ctx, key);
  return await asOwnedRepo(ctx, user.id, repo, async () => {
    let issue: RestIssue | undefined;
    try {
      issue = await restIssue(repo, n, timeout);
    } catch (e) {
      throw new HttpError(502, `could not read the issue on GitHub: ${whatHappened(e)} — check the repository's sign-in under My repositories and try again`);
    }
    if (!issue) throw new RefinementError("no-issue", `issue #${n} does not exist in ${repo}`);
    if (issue.pull_request) throw bad(`#${n} is a pull request, not an issue`);
    if (issue.state !== "open") throw new RefinementError("issue-closed", `issue #${n} is closed; reopen it on GitHub first`);
    const updated = typeof issue.updated_at === "string" ? Date.parse(issue.updated_at) : NaN;
    if (!Number.isFinite(updated)) throw new HttpError(502, "GitHub did not say when the issue was last changed; try again");

    const labels = labelsOf(issue);
    const pulls = new Map<string, PullKind>();
    const refuse = (why: string) => new RefinementError("building", `issue #${n} cannot be refined: ${why}`);
    /** Whether the Foundry builds or has built the issue, with what is known about pull requests so far. */
    const check = (withPulls: boolean) => {
      const f = foundryFacts(ctx, key, n);
      const runs = withPulls ? f.runs : f.runs.map(({ pr: _pr, ...r }) => r);
      const why = buildingReason({ labels, runs, queued: f.queued, labelNames: names, pulls });
      if (why) throw refuse(why);
      return f.runs;
    };

    // First what needs no read of a pull request: a live run, a queued job, a label.
    const runs = check(false);
    // A pull request of a run only blocks when it is not closed without a merge; every one is read.
    for (const pr of pullsToRead(runs)) {
      try {
        pulls.set(pr, await pullState(repo, Number(pr), timeout));
      } catch (e) {
        throw new HttpError(502, `could not read pull request #${pr} on GitHub: ${whatHappened(e)} — try again`);
      }
    }

    const title = typeof issue.title === "string" ? issue.title : "";
    const text = typeof issue.body === "string" ? issue.body : "";
    const idea = ideaOf(title, text);
    if (title.length > SESSION_TITLE_MAX || text.length > SOURCE_BODY_MAX || idea.length > IDEA_MAX) {
      throw new RefinementError(
        "bad-idea",
        `issue #${n} is too long for a session: its title and text have ${title.length + text.length} characters, at most ${IDEA_MAX} fit; shorten the issue on GitHub first`,
      );
    }
    const sessionTitle = cleanTitle(title) || `Issue #${n}`;
    const wanted = buildLabelOf(repo, ctx.config().watchers, user.id);
    const buildLabel = wanted !== undefined && labels.some((l) => l.toLowerCase() === wanted.toLowerCase()) ? wanted : undefined;
    const story = parseStory(title, text);

    return createSessionFromIssue(
      user.id,
      {
        repo,
        title: sessionTitle,
        idea,
        source: {
          issue: n,
          url: issueUrl(repo, n, issue.html_url),
          title: title.trim() ? title : sessionTitle,
          body: text,
          updatedAt: new Date(updated).toISOString(),
          ...(buildLabel !== undefined ? { buildLabel } : {}),
        },
        ...(story ? { story } : {}),
      },
      // Under the lock, right before the write: a run that started or was queued while GitHub was read still counts.
      { beforeSave: () => void check(true) },
    );
  });
}
