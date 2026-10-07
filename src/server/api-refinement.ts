import { basename } from "node:path";
import { loadFlow } from "../flow/load.js";
import { buildLimitsOf, type BuildLimits, type LoadFlowVars } from "../refinement/build-limits.js";
import { findOwnedRepo, listRepos, ownsRepo } from "../auth/repos.js";
import { githubNameOf } from "../auth/repo-url.js";
import { StoreError } from "../auth/store.js";
import { getUser, type User } from "../auth/users.js";
import { auditAction } from "../auth/audit.js";
import { architectView, askArchitect, settleSession, stopArchitect, type ArchitectDeps, type ArchitectRequest } from "../refinement/architect.js";
import { draftRemarks } from "../refinement/draft-check.js";
import { impactView } from "../refinement/draft-impact.js";
import { otherDrafts } from "../refinement/known-areas.js";
import { acceptedLines, acceptedView, isReady, readinessView, unsureByCode } from "../refinement/draft-ready.js";
import { reviewView } from "../refinement/draft-review.js";
import { readyListOf, type ReadyItem } from "../refinement/ready-list.js";
import { isDraftKind, preview, type Draft } from "../refinement/draft.js";
import { emptyTalk, isTalkKind } from "../refinement/talk.js";
import {
  DROP_KEEP_MS,
  RefinementError,
  type RefinementErrorCode,
  type Session,
  acceptProposal,
  acceptAnywayOf,
  acceptSuggestionOf,
  addDraft,
  checkReadyOf,
  correctReadyState,
  removeAcceptedOf,
  answerQuestion,
  moveToNotesOf,
  setReviewLabelOf,
  rejectSuggestionOf,
  removeDraft,
  saveDraft,
  setEpic,
  changeEntry,
  rejectProposal,
  removeEntry,
  createSession,
  dropSession,
  getSession,
  listSessions,
  purgeDropped,
  renameSession,
  restoreSession,
} from "../refinement/store.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

const INTERNAL = "the refinement sessions are not working; see the server log";
const NOT_FOUND = "no such refinement session";
const STATUS: Record<RefinementErrorCode, number> = {
  "bad-idea": 400,
  "bad-title": 400,
  "bad-repo": 400,
  "bad-answer": 400,
  "bad-text": 400,
  "bad-round": 400,
  "bad-draft": 400,
  "bad-epic": 400,
  "no-owner": 404,
  "not-yours": 403,
  limit: 400,
  "not-found": 404,
  "not-owner": 403,
  "bad-state": 409,
  busy: 409,
  "no-repo": 409,
};

/** How often the server removes dropped sessions that are past their 30 days, in ms. */
export const REFINEMENT_SWEEP_MS = 10 * 60 * 1000;

/** Runs refinement code. Input errors become 4xx; everything else is logged (file name and kind only) and answered with a plain 500. */
function guarded<T>(ctx: ApiContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RefinementError) throw new HttpError(STATUS[e.code], e.message);
    if (e instanceof HttpError) throw e;
    const log = ctx.diagLog;
    if (e instanceof StoreError) log?.(`refinement: ${basename(e.file)} ${e.kind}`);
    else log?.(`refinement: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

const deps = (ctx: ApiContext): ArchitectDeps => ({ scheduler: ctx.scheduler, repo: ctx.opts.repo, log: ctx.diagLog });

/** The GitHub repositories of an account, as the names a new session takes. */
function githubNames(userId: string): string[] {
  const out: string[] = [];
  for (const r of listRepos(userId)) {
    const name = githubNameOf(r.url);
    if (name !== undefined) out.push(name);
  }
  return out;
}

/** The vars of a flow, read fresh each time so a changed limit shows at once; undefined when the flow cannot be loaded. */
const flowVarsOf =
  (repo: string): LoadFlowVars =>
  (name) => {
    try {
      return loadFlow(name, repo).flow.vars;
    } catch {
      return undefined;
    }
  };

/** The build limits of the session's repository; never fails a read. */
function limitsOf(ctx: ApiContext, s: Session): BuildLimits {
  try {
    return buildLimitsOf(s.repo, ctx.config().watchers, flowVarsOf(ctx.opts.repo), s.owner);
  } catch {
    return {};
  }
}

/** A draft as the caller sees it: with its preview, the remarks of the code checks (computed now) and the review (without the texts it kept). */
const draftView = (s: Session, limits: BuildLimits, list: readonly ReadyItem[]) => (d: Draft) => {
  const { review: _stored, impact: _impact, readiness: _readiness, acceptedAnyway: _accepted, ...rest } = d;
  const review = reviewView(d);
  // Drafts of the owner's other sessions are looked up only for an overlap with a draft that is not in this session.
  const outside = d.impact?.overlaps.some((o) => o.draft !== undefined && !s.drafts.some((x) => x.id === o.draft));
  const impact = impactView(d, s.drafts, outside ? otherDrafts(s) : [], limits);
  const readiness = readinessView(d, list);
  const accepted = acceptedView(d, list);
  return {
    ...rest,
    state: isReady(d, list) ? "ready" : "drafting",
    preview: preview(d, s, acceptedLines(d, list)),
    remarks: draftRemarks(d),
    ...(review ? { review } : {}),
    ...(impact ? { impact } : {}),
    ...(readiness ? { readiness } : {}),
    ...(accepted.length ? { acceptedAnyway: accepted } : {}),
  };
};

/** A session as the caller sees it. The log says who by name; to the owner an administrator is "an administrator". */
function view(ctx: ApiContext, s: Session, viewer: User) {
  const repoAvailable = ownsRepo(s.owner, s.repo);
  // The talk holds details of the repository, read with the owner's token: it is not shown while the repository is not theirs.
  const talkHidden = !repoAvailable && s.talk !== undefined;
  const draftsHidden = !repoAvailable && s.drafts.length > 0;
  const limits = !draftsHidden && s.drafts.some((d) => d.impact) ? limitsOf(ctx, s) : {};
  const list = readyListOf(findOwnedRepo(s.owner, s.repo)?.definitionOfReady);
  const mine = s.owner === viewer.id;
  const admin = viewer.role === "admin";
  const who = (by: string) => {
    if (by === viewer.id) return viewer.name;
    if (!admin) return "an administrator";
    return getUser(by)?.name ?? "a removed account";
  };
  return {
    id: s.id,
    repo: s.repo,
    repoAvailable,
    title: s.title,
    idea: s.idea,
    state: s.state,
    // The Definition of Ready of the repository, only while the repository is there (a removed one has no list of its own).
    ...(repoAvailable ? { readyList: list } : {}),
    // Like the talk, the drafts are not shown while the repository is not theirs.
    ...(draftsHidden ? { draftsHidden: true } : { drafts: s.drafts.map(draftView(s, limits, list)) }),
    ...(s.epic !== undefined ? { epic: s.epic } : {}),
    architect: architectView(deps(ctx), s),
    // The brief holds details of the repository, read with the owner's token: it is not shown while the repository is not theirs.
    ...(s.brief && repoAvailable ? { brief: s.brief } : {}),
    ...(s.brief && !repoAvailable ? { briefHidden: true } : {}),
    ...(talkHidden ? { talkHidden: true } : { talk: s.talk ?? emptyTalk() }),
    log: s.log.map((l) => ({
      at: l.at,
      what: l.what,
      who: who(l.by),
      ...(l.detail !== undefined && !(talkHidden && isTalkKind(l.what)) && !(!repoAvailable && isDraftKind(l.what)) ? { detail: l.detail } : {}),
      ...(l.list !== undefined ? { list: l.list } : {}),
    })),
    created: s.created,
    updated: s.updated,
    ...(s.droppedAt !== undefined ? { droppedAt: s.droppedAt, removedOn: new Date(Date.parse(s.droppedAt) + DROP_KEEP_MS).toISOString() } : {}),
    mine,
    ...(admin ? { owner: s.owner, ownerName: getUser(s.owner)?.name ?? "a removed account" } : {}),
  };
}

/** A session as the list shows it: no idea, drafts or log, so a long list stays small. */
function summary(s: Session, viewer: User, ownerName: (id: string) => string) {
  return {
    id: s.id,
    repo: s.repo,
    title: s.title,
    state: s.state,
    created: s.created,
    updated: s.updated,
    ...(s.droppedAt !== undefined ? { droppedAt: s.droppedAt, removedOn: new Date(Date.parse(s.droppedAt) + DROP_KEEP_MS).toISOString() } : {}),
    mine: s.owner === viewer.id,
    ...(viewer.role === "admin" ? { owner: s.owner, ownerName: ownerName(s.owner) } : {}),
  };
}

/** The sweep for the timer: removes expired dropped sessions. It never throws; a problem that stays is logged once. */
export function refinementSweeper(log: (msg: string) => void): () => void {
  let told = false;
  return () => {
    try {
      purgeDropped();
      told = false;
    } catch (e) {
      if (told) return;
      told = true;
      log(`! refinement: ${e instanceof StoreError ? `${basename(e.file)} ${e.kind}` : e instanceof Error ? e.name : "error"}`);
    }
  };
}

/** Refinement sessions: a person sees and changes their own; an admin sees all and may also drop. */
export const refinementRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "refinement") return false;
  const actor = { id: user.id, admin: user.role === "admin" };
  const admin = actor.admin;
  /** The session when the caller may see it. */
  const find = (id: string) => {
    const s = getSession(id);
    if (!s || (s.owner !== user.id && !admin)) throw new HttpError(404, NOT_FOUND);
    return s;
  };
  if (seg.length === 1 && method === "GET") {
    const body = guarded(ctx, () => {
      const names = new Map<string, string>();
      const ownerName = (id: string) => {
        if (!names.has(id)) names.set(id, getUser(id)?.name ?? "a removed account");
        return names.get(id)!;
      };
      return { sessions: listSessions(admin ? undefined : user.id).map((s) => summary(s, user, ownerName)), repos: githubNames(user.id) };
    });
    return send(res, 200, body), true;
  }
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    const s = guarded(ctx, () => view(ctx, createSession(user.id, { repo: body.repo, idea: body.idea, title: body.title }), user));
    return send(res, 201, s), true;
  }
  /** The session when the caller may see it, after the end of its architect run was taken in. */
  const settled = (id: string) => {
    find(id);
    const s = settleSession(deps(ctx), id) ?? find(id);
    // An admin may have changed the Definition of Ready: the stored drafting/ready state is made right on a read.
    return correctReadyState(id) ?? s;
  };
  if (seg.length === 2 && method === "GET") return send(res, 200, guarded(ctx, () => view(ctx, settled(seg[1]!), user))), true;
  if (seg.length === 2 && method === "PUT") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(renameSession(actor, seg[1]!, body.title).id), user))), true;
  }
  if (seg.length === 3 && seg[2] === "drop" && method === "POST") {
    return send(res, 200, guarded(ctx, () => {
      // Cancel first: if the process stops after this, a retry of the drop still works and the read is already gone.
      const id = find(seg[1]!).id;
      const runId = getSession(id)?.architect?.runId;
      if (stopArchitect(deps(ctx), id) && runId) auditAction(ctx.diagLog, user.id, "run-cancel", runId);
      dropSession(actor, id);
      return view(ctx, settled(id), user);
    })), true;
  }
  if (seg.length === 3 && seg[2] === "restore" && method === "POST") {
    return send(res, 200, guarded(ctx, () => view(ctx, settled(restoreSession(actor, seg[1]!).id), user))), true;
  }
  /** Starts (or resumes) a run of the architect for the session and answers 202 with the session. */
  const startRun = (ask: ArchitectRequest) => {
    const body = guarded(ctx, () => {
      const r = askArchitect(deps(ctx), actor, seg[1]!, ask);
      auditAction(ctx.diagLog, user.id, r.resumed ? "run-resume" : "run-start", r.runId);
      return view(ctx, settled(seg[1]!), user);
    });
    return send(res, 202, body), true;
  };
  if (seg.length === 3 && seg[2] === "architect" && method === "POST") return startRun({ kind: "brief" });
  if (seg.length === 3 && seg[2] === "round" && method === "POST") return startRun({ kind: "round" });
  if (seg.length === 3 && seg[2] === "ask" && method === "POST") {
    const body = await readJson(req);
    return startRun({ kind: "question", question: body.question });
  }
  if (seg.length === 5 && seg[2] === "questions" && seg[4] === "answer" && method === "POST") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(answerQuestion(actor, seg[1]!, seg[3]!, body).id), user))), true;
  }
  if (seg.length === 5 && seg[2] === "proposals" && (seg[4] === "accept" || seg[4] === "reject") && method === "POST") {
    const decide = seg[4] === "accept" ? acceptProposal : rejectProposal;
    return send(res, 200, guarded(ctx, () => view(ctx, settled(decide(actor, seg[1]!, seg[3]!).id), user))), true;
  }
  if (seg.length === 4 && seg[2] === "map" && method === "PUT") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(changeEntry(actor, seg[1]!, seg[3]!, body.text).id), user))), true;
  }
  if (seg.length === 4 && seg[2] === "map" && method === "DELETE") {
    return send(res, 200, guarded(ctx, () => view(ctx, settled(removeEntry(actor, seg[1]!, seg[3]!).id), user))), true;
  }
  if (seg.length === 3 && seg[2] === "drafts" && method === "POST") {
    return send(res, 201, guarded(ctx, () => view(ctx, settled(addDraft(actor, seg[1]!).id), user))), true;
  }
  if (seg.length === 4 && seg[2] === "drafts" && method === "PUT") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(saveDraft(actor, seg[1]!, seg[3]!, body).id), user))), true;
  }
  if (seg.length === 4 && seg[2] === "drafts" && method === "DELETE") {
    return send(res, 200, guarded(ctx, () => view(ctx, settled(removeDraft(actor, seg[1]!, seg[3]!).id), user))), true;
  }
  if (seg.length === 5 && seg[2] === "drafts" && seg[4] === "suggest" && method === "POST") {
    const body = await readJson(req);
    return startRun({ kind: "suggest", draft: seg[3]!, field: body.field });
  }
  if (seg.length === 5 && seg[2] === "drafts" && seg[4] === "review" && method === "POST") return startRun({ kind: "review", draft: seg[3]! });
  if (seg.length === 5 && seg[2] === "drafts" && seg[4] === "impact" && method === "POST") return startRun({ kind: "impact", draft: seg[3]! });
  if (seg.length === 5 && seg[2] === "drafts" && seg[4] === "review-label" && method === "PUT") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(setReviewLabelOf(actor, seg[1]!, seg[3]!, body).id), user))), true;
  }
  if (seg.length === 5 && seg[2] === "drafts" && seg[4] === "move-to-notes" && method === "POST") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(moveToNotesOf(actor, seg[1]!, seg[3]!, body).id), user))), true;
  }
  if (seg.length === 5 && seg[2] === "drafts" && seg[4] === "ready-check" && method === "POST") {
    const did = seg[3]!;
    // The code checks come first and are stored; the architect judges only what they left unsure.
    const checked = guarded(ctx, () => checkReadyOf(actor, seg[1]!, did));
    const draft = checked.drafts.find((d) => d.id === did);
    if (draft && unsureByCode(draft).length) return startRun({ kind: "ready", draft: did });
    // Code decided everything: a run for this draft that is still there (paused, say) is not needed any more.
    const body = guarded(ctx, () => {
      const a = getSession(checked.id)?.architect;
      if (a?.kind === "ready" && a.draft === did && a.failed === undefined && stopArchitect(deps(ctx), checked.id)) auditAction(ctx.diagLog, user.id, "run-cancel", a.runId);
      return view(ctx, settled(checked.id), user);
    });
    return send(res, 200, body), true;
  }
  if (seg.length === 7 && seg[2] === "drafts" && seg[4] === "ready" && seg[6] === "accept" && method === "POST") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(acceptAnywayOf(actor, seg[1]!, seg[3]!, seg[5]!, body).id), user))), true;
  }
  if (seg.length === 7 && seg[2] === "drafts" && seg[4] === "ready" && seg[6] === "accept" && method === "DELETE") {
    return send(res, 200, guarded(ctx, () => view(ctx, settled(removeAcceptedOf(actor, seg[1]!, seg[3]!, seg[5]!).id), user))), true;
  }
  if (seg.length === 7 && seg[2] === "drafts" && seg[4] === "suggestions" && (seg[6] === "accept" || seg[6] === "reject") && method === "POST") {
    const body = await readJson(req);
    const decide = seg[6] === "accept" ? acceptSuggestionOf : rejectSuggestionOf;
    return send(res, 200, guarded(ctx, () => view(ctx, settled(decide(actor, seg[1]!, seg[3]!, seg[5]!, body).id), user))), true;
  }
  if (seg.length === 3 && seg[2] === "epic" && method === "PUT") {
    const body = await readJson(req);
    return send(res, 200, guarded(ctx, () => view(ctx, settled(setEpic(actor, seg[1]!, body).id), user))), true;
  }
  return false;
};
