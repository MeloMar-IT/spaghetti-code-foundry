import { basename } from "node:path";
import { listRepos, ownsRepo } from "../auth/repos.js";
import { tryParseRepoUrl } from "../auth/repo-url.js";
import { StoreError } from "../auth/store.js";
import { getUser, type User } from "../auth/users.js";
import { auditAction } from "../auth/audit.js";
import { architectView, askArchitect, settleSession, stopArchitect, type ArchitectDeps } from "../refinement/architect.js";
import {
  DROP_KEEP_MS,
  RefinementError,
  type RefinementErrorCode,
  type Session,
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
    const p = tryParseRepoUrl(r.url);
    if (p?.github !== undefined) out.push(p.key.slice("github.com/".length));
  }
  return out;
}

/** A session as the caller sees it. The log says who by name; to the owner an administrator is "an administrator". */
function view(ctx: ApiContext, s: Session, viewer: User) {
  const repoAvailable = ownsRepo(s.owner, s.repo);
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
    drafts: s.drafts,
    architect: architectView(deps(ctx), s),
    // The brief holds details of the repository, read with the owner's token: it is not shown while the repository is not theirs.
    ...(s.brief && repoAvailable ? { brief: s.brief } : {}),
    ...(s.brief && !repoAvailable ? { briefHidden: true } : {}),
    log: s.log.map((l) => ({ at: l.at, what: l.what, who: who(l.by), ...(l.detail !== undefined ? { detail: l.detail } : {}) })),
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
    return settleSession(deps(ctx), id) ?? find(id);
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
  if (seg.length === 3 && seg[2] === "architect" && method === "POST") {
    const body = guarded(ctx, () => {
      const r = askArchitect(deps(ctx), actor, seg[1]!);
      auditAction(ctx.diagLog, user.id, r.resumed ? "run-resume" : "run-start", r.runId);
      return view(ctx, settled(seg[1]!), user);
    });
    return send(res, 202, body), true;
  }
  return false;
};
