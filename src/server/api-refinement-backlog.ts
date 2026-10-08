import { findOwnedRepo } from "../auth/repos.js";
import { githubNameOf, validGithubName } from "../auth/repo-url.js";
import { listNewestIssuesCut, restIssue } from "../github.js";
import { dependencyRefs, quickChecks, type BacklogIssue } from "../refinement/backlog.js";
import type { PullKind } from "../refinement/issue-building.js";
import { cleanTitle } from "../refinement/issue-import.js";
import { issueUrl } from "../refinement/publish.js";
import { RefinementError, openSessionsOfRepo } from "../refinement/store.js";
import { guardedAsync } from "./api-refinement.js";
import { GH_TIMEOUT_MS, labelsOf, whatHappened, whyBuilding } from "./api-refinement-import.js";
import { sessionUser } from "./api-auth.js";
import { HttpError, send } from "./http.js";
import { asOwnedRepo } from "./repo-sign-in.js";
import type { Route } from "./server.js";

const CHECK_SIGN_IN = "check the repository's sign-in under My repositories and try again";
const MAX_NUMBER = 2_147_483_647;

/**
 * The open issues of one of the caller's repositories that the Foundry is not building and has not built, newest first, each with the four
 * quick checks. Only GitHub is read (with the owner's sign-in); no architect run starts, nothing is queued, and nothing is written.
 */
export const refinementBacklogRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg.length !== 2 || seg[0] !== "refinement" || seg[1] !== "backlog" || method !== "GET") return false;
  const body = await guardedAsync(ctx, async () => {
    // The signed-in account, not the one an admin views as: the list is read with the owner's GitHub sign-in.
    const user = sessionUser(ctx, req);
    const given = new URL(req.url ?? "/", "http://x").searchParams.get("repo");
    if (given === null || !validGithubName(given)) throw new RefinementError("bad-repo", "give a GitHub repository as owner/name");
    const rec = findOwnedRepo(user.id, given);
    const name = rec ? githubNameOf(rec.url) : undefined;
    if (name === undefined) throw new RefinementError("not-yours", "that is not one of your GitHub repositories");
    const timeout = ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS;

    return await asOwnedRepo(ctx, user.id, name, async () => {
      let listed;
      try {
        listed = await listNewestIssuesCut(name, timeout);
      } catch (e) {
        throw new HttpError(502, `could not read the issues on GitHub: ${whatHappened(e)} — ${CHECK_SIGN_IN}`);
      }
      const { issues, cut } = listed;
      const known = new Set(issues.map((i) => i.number));
      const titles = issues.map(({ number, title }) => ({ number, title: typeof title === "string" ? title : "" }));
      const open = issues.filter((i) => i.state === "open");

      // What is left: not built, not being built.
      const pulls = new Map<string, PullKind>();
      const listable = [];
      for (const i of open) {
        let why: string | undefined;
        try {
          why = await whyBuilding(ctx, name, i.number, labelsOf(i), timeout, pulls);
        } catch (e) {
          throw new HttpError(502, `could not read a pull request on GitHub: ${whatHappened(e)} — ${CHECK_SIGN_IN}`);
        }
        if (!why) listable.push(i);
      }

      const asIssue = (i: (typeof issues)[number]): BacklogIssue => ({ number: i.number, title: typeof i.title === "string" ? i.title : "", body: typeof i.body === "string" ? i.body : null });
      const rows = listable.map(asIssue);
      // A "Depends on" number outside the page is read from GitHub: it exists when it is an issue, not a pull request.
      const outside = new Set<number>();
      for (const r of rows) for (const n of dependencyRefs(r, titles).numbers) if (!known.has(n) && n <= MAX_NUMBER) outside.add(n);
      const exists = new Set(known);
      for (const n of outside) {
        let found;
        try {
          found = await restIssue(name, n, timeout);
        } catch (e) {
          throw new HttpError(502, `could not read issue #${n} on GitHub: ${whatHappened(e)} — ${CHECK_SIGN_IN}`);
        }
        if (found && !found.pull_request) exists.add(n);
      }

      const sessions = openSessionsOfRepo(user.id, name);
      const out = listable.map((i, k) => {
        const c = quickChecks(rows[k]!, exists, { titles });
        const session = sessions.get(i.number);
        return {
          number: i.number,
          title: cleanTitle(rows[k]!.title),
          url: issueUrl(name, i.number, i.html_url),
          checks: { criteria: c.criteria, value: c.value, dependencies: c.dependencies, questions: c.questions },
          ...(c.missing.length ? { missing: c.missing } : {}),
          ...(c.unmatched.length ? { unmatched: c.unmatched } : {}),
          ...(session !== undefined ? { session } : {}),
        };
      });
      return { repo: name, issues: out, cut };
    });
  });
  return send(res, 200, body), true;
};
