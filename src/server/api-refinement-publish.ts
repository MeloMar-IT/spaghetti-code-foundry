import type { IncomingMessage } from "node:http";
import { auditAction } from "../auth/audit.js";
import { buildLabelOf } from "../refinement/build-limits.js";
import { acceptedLines } from "../refinement/draft-ready.js";
import { readyListOf, type ReadyItem } from "../refinement/ready-list.js";
import { chosenLabels, issueText, issueUrl, issueWithMarker, labelsFor, parsePublishInput, planOf, refinedMarker } from "../refinement/publish.js";
import { architectWorking, settleSession } from "../refinement/architect.js";
import { RefinementError, beginPublishing, endPublishing, getSession, logRoom, recordPublished, type Session } from "../refinement/store.js";
import { createIssue, isBot, listNewestIssues, repoLabels, type RestIssue } from "../github.js";
import { HttpError, readJson, send } from "./http.js";
import { architectDeps, guardedAsync, limitsOf } from "./api-refinement.js";
import { GH_TIMEOUT_MS, whatHappened } from "./api-refinement-import.js";
import { sessionUser } from "./api-auth.js";
import { asOwnedRepo } from "./repo-sign-in.js";
import type { ApiContext, Route } from "./server.js";


/** The session of the signed-in account, for the plan and for publishing: both use the owner's GitHub sign-in, so only the owner may. */
function ownedSession(ctx: ApiContext, req: IncomingMessage, id: string) {
  // The signed-in account, not the one an admin views as: a view of the owner must not open it.
  const user = sessionUser(ctx, req);
  const s = getSession(id);
  if (!s || (s.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such refinement session");
  if (s.owner !== user.id) throw new HttpError(403, "only the owner can read or publish the plan: it is used with the owner's GitHub sign-in");
  if (s.state === "dropped") throw new HttpError(409, "a dropped session cannot be published; restore it first");
  // Publishing makes new issues; writing back to the issue a session came from is not built yet, so it must not make a copy.
  if (s.source) throw new HttpError(409, `this session came from issue #${s.source.issue}; publishing it back to that issue is not possible yet, so nothing is made`);
  const by = (user.name ?? "").replace(/\s+/g, " ").trim() || "a Foundry user";
  if (isBot({ body: by })) throw new HttpError(400, "the account name holds a Foundry marker");
  return { user, s, by };
}

/** The labels of the repository (read with the sign-in that is set), with the Definition of Ready that goes with them. */
async function readRepoLabels(ctx: ApiContext, s: Session, list: ReadyItem[]) {
  let names: string[];
  try {
    names = await repoLabels(s.repo, ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS);
  } catch (e) {
    throw new HttpError(502, `could not read the labels on GitHub: ${whatHappened(e)} — check the repository's sign-in under My repositories and try again`);
  }
  return { names, list };
}

/** The publish plan of a refinement session (it only reads), and the publishing of its ready drafts (it creates the issues). */
export const refinementPublishRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "refinement" || seg.length !== 3 || seg[2] !== "publish" || (method !== "GET" && method !== "POST")) return false;
  if (method === "POST") {
    const body = await readJson(req);
    const answer = await guardedAsync(ctx, () => publish(ctx, req, seg[1]!, body));
    return send(res, 200, answer), true;
  }
  const body = await guardedAsync(ctx, async () => {
    const { s, by } = ownedSession(ctx, req, seg[1]!);
    const labels = await asOwnedRepo(ctx, s.owner, s.repo, (rec) => readRepoLabels(ctx, s, readyListOf(rec.definitionOfReady)));

    const buildLabel = buildLabelOf(s.repo, ctx.config().watchers, s.owner);
    const reviewLabel = limitsOf(ctx, s).reviewLabel;
    const onGithub = new Map(s.drafts.flatMap((d) => (d.published !== undefined ? [[d.id, d.published.issue] as const] : [])));
    const { items, willCreate } = planOf(s, {
      list: labels.list,
      onGithub,
      by,
      date: new Date().toISOString().slice(0, 10),
      ...(buildLabel ? { buildLabel } : {}),
      ...(reviewLabel ? { reviewLabel } : {}),
    });
    return {
      repo: s.repo,
      items,
      willCreate,
      repoLabels: labels.names,
      ...(buildLabel ? { buildLabel } : { noBuildLabel: "this repository has no enabled watcher for issues, so no label starts a build" }),
      ...(reviewLabel ? { reviewLabel } : {}),
    };
  });
  return send(res, 200, body), true;
};

interface Made {
  draft: string;
  issue: number;
  url: string;
  found: boolean;
}

/**
 * Creates the issues of the ready drafts, in the order of the plan, and remembers each one as soon as it exists. The session is marked as
 * being published for the whole time, so nothing else changes it. An issue that carries the draft's marker is taken over, not made again.
 */
async function publish(ctx: ApiContext, req: IncomingMessage, id: string, input: unknown) {
  const { user, s: first, by } = ownedSession(ctx, req, id);
  // The end of a finished run is taken in before the mark: the mark refuses every change of the session, also that one.
  settleSession(architectDeps(ctx), id);
  if (!beginPublishing(id)) throw new HttpError(409, "this session is being published; try again in a moment");
  const done: Made[] = [];
  try {
    // Marked: nothing else changes the session now. What is read here is the settled session; a working architect is waited for.
    const settled = settleSession(architectDeps(ctx), id);
    if (!settled) throw new HttpError(404, "no such refinement session");
    const s: Session = settled;
    if (s.state === "dropped") throw new HttpError(409, "a dropped session cannot be published; restore it first");
    if (architectWorking(architectDeps(ctx), s)) throw new HttpError(409, "the architect is working for this session; publish when it is done");
    const choices = parsePublishInput(input, s.drafts);

    const timeout = ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
    // One sign-in for all the calls to GitHub of this publish.
    return await asOwnedRepo(ctx, s.owner, s.repo, (rec) => inRepo(rec.definitionOfReady));

    async function inRepo(stored: Parameters<typeof readyListOf>[0]) {
    const labelsOf = await readRepoLabels(ctx, s, readyListOf(stored));
    const buildLabel = buildLabelOf(s.repo, ctx.config().watchers, s.owner);
    const reviewLabel = limitsOf(ctx, s).reviewLabel;
    const rules = { repo: s.repo, repoLabels: labelsOf.names, ...(buildLabel ? { buildLabel } : {}), ...(reviewLabel ? { reviewLabel } : {}) };
    const date = new Date().toISOString().slice(0, 10);
    const planned = planOf(s, { list: labelsOf.list, onGithub: new Map(s.drafts.flatMap((d) => (d.published ? [[d.id, d.published.issue] as const] : []))), by, date, ...rules });

    // Everything is checked before the first issue is made: every entry of the request, and the labels of each draft that is made.
    for (const choice of choices.values()) chosenLabels(choice, rules);
    const byId = new Map(s.drafts.map((d) => [d.id, d]));
    const labels = new Map(planned.willCreate.map((did) => [did, labelsFor(choices.get(did), byId.get(did)!, rules)]));
    const untitled = planned.willCreate.find((did) => !byId.get(did)!.title);
    if (untitled !== undefined) throw new HttpError(409, `the story draft ${untitled} has no title; give every ready draft a title first, nothing was created`);
    if (planned.willCreate.length > logRoom(s)) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
    if (!planned.willCreate.length) return { repo: s.repo, created: [] as Made[], state: s.state };

    let recent: RestIssue[];
    try {
      recent = await listNewestIssues(s.repo, timeout);
    } catch (e) {
      throw new HttpError(502, `could not read the issues on GitHub: ${whatHappened(e)}; nothing was created`);
    }

    const numbers = new Map(s.drafts.flatMap((d) => (d.published ? [[d.id, d.published.issue] as const] : [])));
    const actor = { id: s.owner, admin: false };
    const progress = () => (done.length ? ` Made so far: ${done.map((m) => `#${m.issue}`).join(", ")}.` : "");
    {
      for (const did of planned.willCreate) {
        const d = byId.get(did)!;
        const marked: RestIssue | undefined = issueWithMarker(recent, s.id, did);
        let made: Made;
        if (marked) made = { draft: did, issue: marked.number, url: issueUrl(s.repo, marked.number, marked.html_url), found: true };
        else {
          const text = issueText(d, s, { accepted: acceptedLines(d, labelsOf.list), by, date, numberOf: (other) => (numbers.has(other) ? { issue: numbers.get(other)! } : undefined) });
          let issue: RestIssue;
          try {
            issue = await createIssue(s.repo, { title: text.title, body: `${text.body}\n\n${refinedMarker(s.id, did)}`, labels: labels.get(did)! }, timeout);
          } catch (e) {
            throw new HttpError(502, `GitHub did not make the issue: ${whatHappened(e)}.${progress()} Fix the problem and publish again, after a moment.`);
          }
          made = { draft: did, issue: issue.number, url: issueUrl(s.repo, issue.number, issue.html_url), found: false };
        }
        done.push(made);
        numbers.set(did, made.issue);
        try {
          recordPublished(actor, id, did, { issue: made.issue, url: made.url });
        } catch (e) {
          ctx.diagLog?.(`refinement: publish could not record an issue (${e instanceof Error ? e.name : "error"})`);
          throw new HttpError(500, `The issue ${made.url} was made, but it could not be saved in the session.${progress()} Publish again, after a moment: the issue is taken over, not made twice.`);
        }
      }
    }
    return { repo: s.repo, created: done, state: getSession(id)?.state ?? s.state };
    }
  } finally {
    endPublishing(id);
    if (done.length) auditAction(ctx.diagLog, user.id, "refinement-publish", first.id, `${first.repo} ${done.map((m) => `#${m.issue}`).join(",")}`);
  }
}
