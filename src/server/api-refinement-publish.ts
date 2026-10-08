import type { IncomingMessage } from "node:http";
import { auditAction } from "../auth/audit.js";
import { buildLabelOf } from "../refinement/build-limits.js";
import { acceptedLines } from "../refinement/draft-ready.js";
import { readyListOf, type ReadyItem } from "../refinement/ready-list.js";
import { UPDATE_COMMENT_MAX, chosenLabels, endsWithMarker, issueText, issueUrl, issueWithMarker, labelsFor, parsePublishInput, planOf, refinedHash, refinedHashIn, refinedMarker, updateComment, updateMarker, withoutSplits, type LabelRules } from "../refinement/publish.js";
import { architectWorking, settleSession } from "../refinement/architect.js";
import { RefinementError, beginPublishing, endPublishing, getSession, logRoom, clearPendingUpdate, markOf, recordPendingUpdate, recordPublished, type Session } from "../refinement/store.js";
import { commentOnIssue, createIssue, ghLogin, isBot, issueComments, listNewestIssues, repoLabels, restIssue, setLabels, updateIssue, type RestIssue } from "../github.js";
import type { PullKind } from "../refinement/issue-building.js";
import { HttpError, readJson, send } from "./http.js";
import { architectDeps, guardedAsync, limitsOf } from "./api-refinement.js";
import { GH_TIMEOUT_MS, labelsOf as labelNamesOf, whatHappened, whyBuilding } from "./api-refinement-import.js";
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
    const draft = markOf(s);
    const { items, willCreate, willUpdate, notChanged, leftBehind } = planOf(s, {
      list: labels.list,
      onGithub,
      by,
      date: new Date().toISOString().slice(0, 10),
      ...(s.source ? { source: { issue: s.source.issue, ...(draft !== undefined ? { draft } : {}) } } : {}),
      ...(buildLabel ? { buildLabel } : {}),
      ...(reviewLabel ? { reviewLabel } : {}),
    });
    return {
      repo: s.repo,
      items,
      willCreate,
      willUpdate,
      ...(notChanged !== undefined ? { notChanged } : {}),
      ...(leftBehind.length ? { leftBehind } : {}),
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

interface UpdateInput {
  ctx: ApiContext;
  s: Session;
  did: string;
  /** The new title and text of the issue, without the hidden marker. */
  text: { title: string; body: string };
  /** The labels to add (the chosen ones, the build label, the review label). Existing labels are kept. */
  labels: string[];
  by: string;
  date: string;
  timeout: number;
  actor: { id: string; admin: boolean };
  rules: LabelRules;
  /** Called as soon as GitHub confirmed the replacement, for the audit line. */
  onWritten: () => void;
}

/**
 * Replaces the title and text of the issue the session came from with the draft that stands for it, adds one comment with the old title and
 * text folded, and adds the labels. Nothing is written when the issue is closed or is built. A retry takes over what is done: the issue
 * carries the marker once replaced, and the comment carries its own marker. The old text is kept in the session before the replacement.
 * Old text of the issue only goes to GitHub through stdin.
 */
async function updateOne(o: UpdateInput): Promise<Made> {
  const { ctx, s, did, timeout } = o;
  const source = s.source!;
  const n = source.issue;
  const text = `${o.text.body}\n\n${refinedMarker(s.id, did)}`;
  const marker = updateMarker(s.id, did);
  const again = "Publish again, after a moment: the issue is not updated twice.";

  /** Reads the issue: whether it was replaced already, and, when not, that it may be written to. */
  const target = async () => {
    // Pull requests are read afresh at every check: one that was closed may be reopened or merged meanwhile.
    const pulls = new Map<string, PullKind>();
    let before: RestIssue | undefined;
    try {
      before = await restIssue(s.repo, n, timeout);
    } catch (e) {
      throw new HttpError(502, `could not read issue #${n} on GitHub: ${whatHappened(e)}; nothing was written`);
    }
    if (!before) throw new HttpError(409, `issue #${n} does not exist on GitHub any more; nothing was written`);
    if (before.pull_request) throw new HttpError(409, `#${n} is a pull request, not an issue; nothing was written`);
    const done = refinedHashIn(before.body) === refinedHash(s.id, did);
    if (!done) {
      if (before.state !== "open") throw new HttpError(409, `issue #${n} is closed, so nothing was written; reopen it on GitHub and publish again`);
      let why: string | undefined;
      try {
        why = await whyBuilding(ctx, s.repo, n, labelNamesOf(before), timeout, pulls);
      } catch (e) {
        throw new HttpError(502, `could not read a pull request of issue #${n} on GitHub: ${whatHappened(e)}; nothing was written`);
      }
      if (why) throw new HttpError(409, `issue #${n} cannot be updated: ${why}; nothing was written`);
    }
    return { before, done };
  };

  let t = await target();
  // Read again right before the write: the issue may have been closed or started to be built meanwhile.
  if (!t.done) t = await target();
  const { before, done } = t;
  const old = done ? (source.pending ?? { title: source.title, body: source.body }) : { title: before.title, body: typeof before.body === "string" ? before.body : "" };
  const comment = updateComment({ by: o.by, date: o.date, oldTitle: old.title, oldBody: old.body, newTitle: o.text.title, newBody: o.text.body, marker });

  if (!done) {
    if (comment.length > UPDATE_COMMENT_MAX) {
      throw new HttpError(409, `the title and text of issue #${n} are too long to keep in a comment, so nothing was written; shorten the issue on GitHub and publish again`);
    }
    try {
      recordPendingUpdate(o.actor, s.id, { ...old, draft: did, newTitle: o.text.title, newBody: o.text.body });
    } catch (e) {
      ctx.diagLog?.(`refinement: publish could not keep the old text of an issue (${e instanceof Error ? e.name : "error"})`);
      throw new HttpError(500, `the old text of issue #${n} could not be saved in the session, so nothing was written; publish again, after a moment`);
    }
    try {
      await updateIssue(s.repo, n, { title: o.text.title, body: text }, timeout);
      o.onWritten();
    } catch (e) {
      // When GitHub did not answer in time the replacement may have landed: the record stays, and a retry finishes from it.
      if ((e as { killed?: boolean })?.killed !== true) {
        try {
          clearPendingUpdate(o.actor, s.id);
        } catch {
          /* the record stays; a retry replaces it */
        }
      }
      throw new HttpError(502, `GitHub did not update issue #${n}: ${whatHappened(e)}. Fix the problem and publish again, after a moment.`);
    }
  }

  let commented = false;
  if (done) {
    try {
      let login: string | undefined;
      for (const c of await issueComments(s.repo, n, timeout)) {
        if (!endsWithMarker(c.body, marker)) continue;
        // Only a comment of the account that publishes counts: the marker is public once the issue has it.
        if (c.viewerDidAuthor === undefined) login ??= await ghLogin(timeout);
        if (c.viewerDidAuthor === true || (c.viewerDidAuthor === undefined && c.author.login === login)) commented = true;
      }
    } catch (e) {
      throw new HttpError(502, `Issue #${n} was updated, but its comments could not be read: ${whatHappened(e)}. ${again}`);
    }
  }
  if (!commented) {
    try {
      await commentOnIssue(s.repo, n, comment, timeout);
    } catch (e) {
      throw new HttpError(502, `Issue #${n} was updated, but the comment could not be added: ${whatHappened(e)}. ${again}`);
    }
  }

  // The build label last: a build starts when it is added, and the other labels are there by then.
  const build = o.rules.buildLabel?.toLowerCase();
  const labels = [...o.labels.filter((l) => l.toLowerCase() !== build), ...o.labels.filter((l) => l.toLowerCase() === build)];
  for (const l of labels) {
    try {
      await setLabels(s.repo, n, l, [], timeout);
    } catch (e) {
      throw new HttpError(502, `Issue #${n} was updated, but the label "${l}" could not be added: ${whatHappened(e)}. ${again}`);
    }
  }

  const url = issueUrl(s.repo, n, before.html_url);
  try {
    recordPublished(o.actor, s.id, did, { issue: n, url });
  } catch (e) {
    ctx.diagLog?.(`refinement: publish could not record an issue (${e instanceof Error ? e.name : "error"})`);
    throw new HttpError(500, `The issue ${url} was updated, but it could not be saved in the session. ${again}`);
  }
  return { draft: did, issue: n, url, found: done };
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
  let wrote: number | undefined;
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
    const mark = markOf(s);
    const planned = planOf(s, {
      list: labelsOf.list,
      onGithub: new Map(s.drafts.flatMap((d) => (d.published ? [[d.id, d.published.issue] as const] : []))),
      by,
      date,
      ...(s.source ? { source: { issue: s.source.issue, ...(mark !== undefined ? { draft: mark } : {}) } } : {}),
      ...rules,
    });

    // Everything is checked before the first issue is made or changed: every entry of the request, and the labels of each draft that is made.
    for (const choice of choices.values()) chosenLabels(choice, rules);
    const live = withoutSplits(s.drafts);
    const byId = new Map(live.map((d) => [d.id, d]));
    // An update that was sent and not finished comes first, from what was sent, whatever the draft or the plan say now.
    const pend = s.source?.pending;
    const resumeId = pend?.draft !== undefined && pend.newTitle !== undefined && pend.newBody !== undefined && byId.get(pend.draft) && !byId.get(pend.draft)!.published ? pend.draft : undefined;
    const willUpdate = resumeId ? [resumeId] : planned.willUpdate;
    const willCreate = planned.willCreate.filter((d) => d !== resumeId);
    const todo = [...(resumeId ? [resumeId] : []), ...planned.items.filter((x) => x.state === "ready" && x.draft !== resumeId).map((x) => x.draft)];
    const labels = new Map(todo.map((did) => [did, labelsFor(choices.get(did), byId.get(did)!, rules)]));
    const untitled = todo.find((did) => did !== resumeId && !byId.get(did)!.title);
    if (untitled !== undefined) throw new HttpError(409, `the story draft ${untitled} has no title; give every ready draft a title first, nothing was written`);
    if (todo.length > logRoom(s)) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
    const notChanged = planned.notChanged !== undefined ? { notChanged: planned.notChanged } : {};
    if (!todo.length) return { repo: s.repo, created: [] as Made[], state: s.state, ...notChanged, ...(planned.leftBehind.length ? { leftBehind: planned.leftBehind } : {}) };

    const numbers = new Map(s.drafts.flatMap((d) => (d.published ? [[d.id, d.published.issue] as const] : [])));
    const actor = { id: s.owner, admin: false };
    const progress = () => (done.length ? ` Made so far: ${done.map((m) => `#${m.issue}`).join(", ")}.` : "");
    const numberOf = (other: string) => (numbers.has(other) ? { issue: numbers.get(other)! } : undefined);

    // The issue the session came from is changed first, before any issue is made: a refusal then leaves nothing behind.
    let updated: Made | undefined;
    const did0 = willUpdate[0];
    if (did0 !== undefined) {
      const d = byId.get(did0)!;
      const text = resumeId ? { title: pend!.newTitle!, body: pend!.newBody! } : issueText(d, { ...s, drafts: live }, { accepted: acceptedLines(d, labelsOf.list), by, date, numberOf });
      updated = await updateOne({ ctx, s, did: did0, text, labels: labels.get(did0)!, by, date, timeout, actor, rules, onWritten: () => (wrote = s.source!.issue) });
      done.push(updated);
      numbers.set(did0, updated.issue);
    }

    if (willCreate.length) {
      let recent: RestIssue[];
      try {
        recent = await listNewestIssues(s.repo, timeout);
      } catch (e) {
        throw new HttpError(502, `could not read the issues on GitHub: ${whatHappened(e)}; nothing was created.${progress()}`);
      }
      for (const did of willCreate) {
        const d = byId.get(did)!;
        const marked: RestIssue | undefined = issueWithMarker(recent, s.id, did);
        let made: Made;
        if (marked) made = { draft: did, issue: marked.number, url: issueUrl(s.repo, marked.number, marked.html_url), found: true };
        else {
          const text = issueText(d, { ...s, drafts: live }, { accepted: acceptedLines(d, labelsOf.list), by, date, numberOf });
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
    return {
      repo: s.repo,
      created: done.filter((m) => m !== updated),
      ...(updated ? { updated: [updated] } : {}),
      state: getSession(id)?.state ?? s.state,
      ...notChanged,
      ...(planned.leftBehind.length ? { leftBehind: planned.leftBehind } : {}),
    };
    }
  } finally {
    endPublishing(id);
    // Also a replacement that GitHub confirmed and a later step did not finish.
    const numbers = [...new Set([...done.map((m) => m.issue), ...(wrote !== undefined ? [wrote] : [])])];
    if (numbers.length) auditAction(ctx.diagLog, user.id, "refinement-publish", first.id, `${first.repo} ${numbers.map((n) => `#${n}`).join(",")}`);
  }
}
