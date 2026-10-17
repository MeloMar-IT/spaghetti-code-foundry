import { listRepos } from "../auth/repos.js";
import { githubNameOf } from "../auth/repo-url.js";
import { pageOf, type Asker } from "../help/context.js";
import type { GuardOptions } from "../help/guard.js";
import { HANDOFF_WORDS, HandoffCallSchema, copiedOf, handoffOffers, routeOfRef, sameFill, type HandoffOffer } from "../help/handoff.js";
import { addHandoff, type Conversation } from "../help/store.js";
import { githubNames } from "./api-refinement.js";
import { helpSnapshot } from "./help-context.js";
import { offerConversation } from "./help-evidence.js";
import { HttpError } from "./http.js";
import type { ApiContext } from "./server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pages one finished answer of the account's conversation can be taken to, worked out now for the account as it
 * is now: the run, the finding and the repository are looked up again, and every source is checked again before its
 * line is copied. Nothing is written.
 */
export function handoffsFor(ctx: ApiContext, asker: Asker, conversation: string, message: unknown, guard: GuardOptions = {}): { conversation: Conversation; offers: HandoffOffer[] } {
  const { user, role, conversation: found } = offerConversation(ctx, asker, conversation);
  if (found.state === "archived") throw new HttpError(409, "restore the conversation first");
  const i = typeof message === "string" && UUID.test(message) ? found.messages.findIndex((m) => m.id === message && m.role === "assistant" && m.status === "done") : -1;
  const reply = i >= 0 ? found.messages[i]!.reply : undefined;
  const question = i > 0 ? found.messages[i - 1] : undefined;
  if (!reply || !question) throw new HttpError(404, HANDOFF_WORDS.unknownMessage);
  const who: Asker = { id: user.id, role };

  // the things the page context names, in the order the live evidence takes them
  const asked: { kind: string; id: string }[] = [];
  const add = (kind: string, id: string) => {
    if (!asked.some((x) => x.kind === kind && x.id === id)) asked.push({ kind, id });
  };
  const c = question.context;
  if (c) {
    const at = pageOf(c.page, role);
    if (at?.page.entity && at.arg !== undefined) add(at.page.entity, at.arg);
    if (c.kind !== undefined && c.id !== undefined) add(c.kind, c.id);
    for (const e of c.entities ?? []) add(e.kind, e.id);
  }
  const seen: NonNullable<ReturnType<typeof helpSnapshot>>[] = [];
  for (const ref of asked) {
    const s = helpSnapshot(ctx, who, ref, guard);
    if (s) seen.push(s);
  }
  const run = seen.find((s) => s.kind === "run");
  const problem = seen.find((s) => s.kind === "problem");

  // the repository: only a GitHub repository the account owns now
  let named: string | undefined;
  const first = seen.find((s) => s.kind === "run" || s.kind === "repository" || s.kind === "refinement" || s.kind === "problem");
  if (first?.kind === "repository") named = githubNameOf(listRepos(user.id).find((r) => r.id === first.id)?.url ?? "");
  else if (first && typeof first.fields.repository === "string") named = first.fields.repository;
  const repo = named === undefined ? undefined : githubNames(user.id).find((n) => n.toLowerCase() === named!.toLowerCase());

  // the sources: copied only when the account can still open them
  const evidence: string[] = [];
  for (const e of reply.evidence) {
    if (e.kind === "doc") {
      evidence.push(`- ${e.title} · ${e.ref}`);
      continue;
    }
    const route = routeOfRef(e.ref);
    const at = route === undefined ? undefined : pageOf(route, role);
    if (route === undefined || !at) continue;
    if (at.page.entity && at.arg !== undefined && !helpSnapshot(ctx, who, { kind: at.page.entity, id: at.arg }, guard)) continue;
    evidence.push(`- ${e.title} · ${route}`);
  }

  const offers = handoffOffers({
    role,
    conversation: found.id,
    question: question.text,
    reply,
    found: { ...(run ? { run: run.id } : {}), ...(problem ? { problem: problem.id } : {}) },
    evidence,
    ...(repo ? { repo } : {}),
  });
  return { conversation: found, offers };
}

/**
 * Records that the account took an answer to another page. The offers are worked out again; the offer, its page and
 * its copy must be the ones that were shown, or the answer is 409 and nothing is written. The target is never changed.
 */
export function recordHandoff(ctx: ApiContext, asker: Asker, conversation: string, body: unknown, guard: GuardOptions = {}): { conversation: Conversation; offer: HandoffOffer } {
  // the conversation first, before the body is looked at
  const { user } = offerConversation(ctx, asker, conversation);
  const call = HandoffCallSchema.safeParse(body);
  if (!call.success) throw new HttpError(400, HANDOFF_WORDS.badBody);
  const { offers } = handoffsFor(ctx, asker, conversation, call.data.message, guard);
  const offer = offers.find((o) => o.key === call.data.offer);
  if (!offer || offer.page !== call.data.page || !sameFill(offer.fill, call.data.fill)) throw new HttpError(409, HANDOFF_WORDS.changed);
  const done = addHandoff(user.id, conversation, { message: call.data.message, where: offer.where, page: offer.page, copied: copiedOf(offer) });
  return { conversation: done, offer };
}
