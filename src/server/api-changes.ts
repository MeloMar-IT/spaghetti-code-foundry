import type { IncomingMessage } from "node:http";
import { auditAction } from "../auth/audit.js";
import { isLocalRepoName } from "../auth/local-name.js";
import { findOwnedProject } from "../auth/repos.js";
import type { User } from "../auth/users.js";
import { architectView, askArchitect, settleSession } from "../refinement/architect.js";
import { cardInput, cardsOf, changeView, isChange, parseAnswers, retryAsk } from "../refinement/change-request.js";
import { buildLabelOf } from "../refinement/build-limits.js";
import {
  RefinementError,
  answerRound,
  beginPublishing,
  createSession,
  endPublishing,
  getSession,
  listSessions,
  recordChangeBuild,
  recordChangeBuilt,
  saveDraft,
  type Session,
} from "../refinement/store.js";
import { storeFor } from "../stories/store.js";
import { architectDeps, guardedAsync } from "./api-refinement.js";
import { GH_TIMEOUT_MS, whatHappened } from "./api-refinement-import.js";
import { auditLines, newLedger } from "./api-refinement-replace.js";
import { publish } from "./api-refinement-publish.js";
import { readFileSync } from "node:fs";
import { PICTURE_EXT, PICTURE_MIME, PictureError, picturePath, readPictures, type PictureFile } from "../refinement/pictures.js";
import { CHANGES_BODY_MAX, HttpError, readJson, send } from "./http.js";
import { asOwnedProject, stillOwnsProject } from "./repo-sign-in.js";
import { findScopedProject, sessionInScope } from "./workspace-scope.js";
import type { ApiContext, Route } from "./server.js";

const NOT_FOUND = "no such change request";
const TEXT_MAX = 10_000;

/** The session of a change request that the caller owns. Another account's: 404 for a user, 403 for an admin. */
function ownedChange(user: Pick<User, "id" | "role">, id: string): Session {
  const s = getSession(id);
  if (!s || !isChange(s) || s.state === "dropped" || (s.owner !== user.id && user.role !== "admin") || !sessionInScope(user, s)) throw new HttpError(404, NOT_FOUND);
  if (s.owner !== user.id) throw new HttpError(403, "only the owner can use this change request");
  return s;
}

const settled = (ctx: ApiContext, s: Session): Session => settleSession(architectDeps(ctx), s.id) ?? s;
const viewOf = (ctx: ApiContext, s: Session) => changeView(s, architectView(architectDeps(ctx), s));

/** Asks the architect and writes the audit line. */
function ask(ctx: ApiContext, s: Session, step: Parameters<typeof askArchitect>[3]) {
  const r = askArchitect(architectDeps(ctx), { id: s.owner, admin: false }, s.id, step);
  auditAction(ctx.diagLog, s.owner, r.resumed ? "run-resume" : "run-start", r.runId);
}

/** The build label of the repository, in the spelling the repository has it. 409 (nothing written) when there is none. */
async function buildLabelFor(ctx: ApiContext, s: Session): Promise<string> {
  const label = buildLabelOf(s.repo, ctx.config().watchers, s.owner);
  if (!label) throw new HttpError(409, "this repository has no enabled watcher for issues, so no label starts a build");
  if (isLocalRepoName(s.repo)) return label;
  let names: string[];
  try {
    names = await asOwnedProject(ctx, s.owner, s.repo, () => storeFor(s.repo).labels(ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS));
  } catch (e) {
    if (e instanceof HttpError || e instanceof RefinementError) throw e;
    throw new HttpError(502, `could not read the labels on GitHub: ${whatHappened(e)}`);
  }
  const found = names.find((n) => n.toLowerCase() === label.toLowerCase());
  if (!found) throw new HttpError(409, `the build label "${label}" does not exist in ${s.repo}; create it first`);
  return found;
}

/**
 * Makes sure every card's story has the build label. Under the publishing mark, so two calls never label a card twice; each card is
 * recorded as soon as its label is there. A story that is closed or has the label already is not labelled again.
 */
async function labelCards(ctx: ApiContext, user: User, id: string, label: string): Promise<void> {
  if (!beginPublishing(id)) throw new HttpError(409, "this change request is being published; try again in a moment");
  const ledger = newLedger();
  let repo = "";
  try {
    const s = getSession(id);
    if (!s) throw new HttpError(404, NOT_FOUND);
    repo = s.repo;
    const timeout = ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
    const actor = { id: s.owner, admin: false };
    const guard = isLocalRepoName(s.repo) ? () => stillOwnsProject(s.owner, s.repo) : undefined;
    await asOwnedProject(ctx, s.owner, s.repo, async () => {
      const store = storeFor(s.repo);
      for (const d of cardsOf(s)) {
        if (s.changeRequest?.built?.includes(d.id)) continue;
        const n = d.published?.issue;
        if (n === undefined) throw new HttpError(409, "a card could not be published; nothing more was done");
        try {
          const story = await store.get(n, timeout);
          if (!story) throw new Error("the issue was not found");
          const has = story.labels.some((l) => (typeof l === "string" ? l : (l.name ?? "")).toLowerCase() === label.toLowerCase());
          // A local story is written again even when it shows the label: an earlier write may have saved the file and failed to commit
          // it, and only a write commits it. A write with nothing to change makes no commit. GitHub has no such gap: skip what is labelled.
          if (story.state !== "closed" && (isLocalRepoName(s.repo) || !has)) {
            await store.setLabels(n, label, [], timeout, guard);
            if (!has) ledger.add({ issue: n, what: "labelled" });
          }
        } catch (e) {
          if (e instanceof HttpError || e instanceof RefinementError) throw e;
          throw new HttpError(502, `Issue #${n} did not get its label: ${whatHappened(e)}; ${ledger.text()}. Build again, after a moment.`);
        }
        recordChangeBuilt(actor, id, d.id);
      }
      recordChangeBuild(actor, id);
    });
  } finally {
    endPublishing(id);
    for (const line of auditLines(repo, ledger.numbers())) auditAction(ctx.diagLog, user.id, "refinement-publish", id, line);
  }
}

/** "Yes, build this" (`build`) or "Not now": publishes every card, and for a build makes sure each has the build label. */
async function finish(ctx: ApiContext, req: IncomingMessage, user: User, first: Session, build: boolean) {
  const s = settled(ctx, first);
  const v = viewOf(ctx, s);
  if (v.state !== "cards" && v.state !== "planned") throw new HttpError(409, "the cards are not ready yet");
  const cards = cardsOf(s);
  const unpublished = cards.filter((d) => !d.published);
  if (!build && !unpublished.length) return v;
  if (build && !unpublished.length && s.changeRequest?.build) return v;
  const label = build ? await buildLabelFor(ctx, s) : undefined;
  if (unpublished.length) await publish(ctx, req, s.id, build ? { drafts: unpublished.map((d) => ({ draft: d.id, startBuilding: true })) } : {}, { everyCard: true });
  if (label) await labelCards(ctx, user, s.id, label);
  return viewOf(ctx, settled(ctx, getSession(s.id) ?? s));
}

/** Change requests (#812): one request in plain words, from the first question to "Yes, build this". Only the owner acts. */
export const changeRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "changes") return false;
  const actor = { id: user.id, admin: user.role === "admin" };
  if (seg.length === 1 && method === "GET") {
    const repo = new URL(req.url ?? "/", "http://x").searchParams.get("repo");
    if (!repo) throw new HttpError(400, "give the repository: ?repo=…");
    const body = await guardedAsync(ctx, async () => ({
      changes: listSessions(user.id)
        .filter((s) => isChange(s) && s.state !== "dropped" && s.repo.toLowerCase() === repo.toLowerCase() && sessionInScope(user, s))
        .map((s) => viewOf(ctx, settled(ctx, s))),
    }));
    return send(res, 200, body), true;
  }
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req, CHANGES_BODY_MAX);
    const stray = Object.keys(body).find((k) => k !== "repo" && k !== "text" && k !== "pictures");
    if (stray) throw new HttpError(400, `${stray} is not allowed; send repo, text and pictures`);
    if (typeof body.repo !== "string" || !body.repo) throw new HttpError(400, "give the repository");
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "describe the change you want");
    if ([...body.text.trim()].length > TEXT_MAX) throw new HttpError(400, `the text can have at most ${TEXT_MAX} characters`);
    let pictures: PictureFile[] = [];
    if (body.pictures !== undefined) {
      try {
        pictures = readPictures(body.pictures);
      } catch (e) {
        if (e instanceof PictureError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    const repo = body.repo;
    const answer = await guardedAsync(ctx, async () => {
      // A project of the account that is outside its workspaces is refused like one that is not theirs (#817).
      if (!actor.admin) {
        let outside = false;
        try {
          outside = !!findOwnedProject(user.id, repo) && !findScopedProject(user, repo);
        } catch {
          outside = false; // a bad name or an unreadable store: createSession answers it
        }
        if (outside) throw new RefinementError("not-yours", "that is not one of your projects");
      }
      const s = createSession(user.id, { repo, idea: body.text, changeRequest: true, ...(pictures.length ? { pictures } : {}) });
      // If the architect cannot be asked, the request stays and shows `stuck`; a retry asks again.
      try {
        ask(ctx, s, { kind: "brief" });
      } catch (e) {
        ctx.diagLog?.(`refinement: a change request could not start its first step (${e instanceof Error ? e.name : "error"})`);
      }
      return viewOf(ctx, settled(ctx, getSession(s.id) ?? s));
    });
    return send(res, 202, answer), true;
  }
  const id = seg[1]!;
  if (seg.length === 2 && method === "GET") {
    return send(res, 200, await guardedAsync(ctx, async () => viewOf(ctx, settled(ctx, ownedChange(user, id))))), true;
  }
  if (seg.length === 4 && seg[2] === "pictures" && method === "GET") {
    const s = ownedChange(user, id);
    const n = /^[1-5]$/.test(seg[3]!) ? Number(seg[3]) : 0;
    const p = s.pictures?.[n - 1];
    if (!p) throw new HttpError(404, "no such picture");
    let data: Buffer;
    try {
      data = readFileSync(picturePath(s.id, n, p.type));
    } catch {
      throw new HttpError(404, "no such picture");
    }
    // Raw bytes, not JSON: for the owner only, never cached or sniffed.
    res.writeHead(200, {
      "content-type": PICTURE_MIME[p.type],
      "content-length": String(data.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="picture-${n}.${PICTURE_EXT[p.type]}"`,
    });
    res.end(data);
    return true;
  }
  if (seg.length === 3 && seg[2] === "answers" && method === "POST") {
    const body = await readJson(req);
    const answer = await guardedAsync(ctx, async () => {
      const s = settled(ctx, ownedChange(user, id));
      if (viewOf(ctx, s).state !== "questions") throw new HttpError(409, "there is no question to answer now");
      const parsed = parseAnswers(s, body);
      const next = answerRound(actor, id, parsed);
      ask(ctx, next, { kind: "understand", words: "simple" });
      return viewOf(ctx, settled(ctx, getSession(id) ?? next));
    });
    return send(res, 202, answer), true;
  }
  if (seg.length === 4 && seg[2] === "cards" && method === "PUT") {
    const body = await readJson(req);
    const answer = await guardedAsync(ctx, async () => {
      const s = settled(ctx, ownedChange(user, id));
      const card = cardsOf(s).find((d) => d.id === seg[3]);
      if (!card) throw new HttpError(404, "no such card");
      if (card.published) throw new HttpError(409, "this card is published; it cannot be changed here");
      const input = cardInput(card, body);
      return viewOf(ctx, settled(ctx, saveDraft(actor, id, card.id, input)));
    });
    return send(res, 200, answer), true;
  }
  if (seg.length === 3 && (seg[2] === "build" || seg[2] === "later") && method === "POST") {
    await readJson(req);
    return send(res, 200, await guardedAsync(ctx, async () => finish(ctx, req, user, ownedChange(user, id), seg[2] === "build"))), true;
  }
  if (seg.length === 3 && seg[2] === "retry" && method === "POST") {
    const answer = await guardedAsync(ctx, async () => {
      const s = settled(ctx, ownedChange(user, id));
      if (viewOf(ctx, s).state !== "stuck") throw new HttpError(409, "nothing is stuck");
      ask(ctx, s, retryAsk(s, architectView(architectDeps(ctx), s)));
      return viewOf(ctx, settled(ctx, getSession(id) ?? s));
    });
    return send(res, 202, answer), true;
  }
  return false;
};
