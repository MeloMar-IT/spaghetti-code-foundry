import { createHash } from "node:crypto";
import type { User } from "../auth/users.js";
import { OFFER_WORDS, OfferCallSchema, offerCall, offerDef, subjectPage, type OfferType } from "../help/actions.js";
import { ENTITY_LIMIT, pageOf, type Asker } from "../help/context.js";
import type { HelpRole } from "../help/contract.js";
import { guardExcerpt, type GuardOptions } from "../help/guard.js";
import { getConversation, type Conversation } from "../help/store.js";
import type { Source, TurnInput } from "../help/turn.js";
import { onHome } from "../your-turn.js";
import { runsListFor } from "./api-runs.js";
import { currentAccount, helpSnapshot, type Snapshot } from "./help-context.js";
import { diagnosisSources } from "./help-diagnosis.js";
import { HttpError } from "./http.js";
import { authorize, findRule } from "./permissions.js";
import type { ApiContext } from "./server.js";
import { turnFor } from "./your-turn.js";

/**
 * The live evidence of Ask SCF: what the server knows now about the work a question is about, as sources a reply may
 * cite. Nothing is computed here. Every fact comes from a snapshot of the help context service, which reads through
 * the permission table and the readers of the API (the run with its next-step record, the queue, the repository's
 * connection check, the board, the monitor's findings, the health). This module only chooses which snapshots to
 * take, writes them as text, and compares them.
 */

/** The most state sources of one question (the comparison of the sources comes on top), and the longest text of one. */
export const STATE_SOURCES = 5;
export const STATE_EXCERPT_MAX = 800;
/** The id of the source that says the other sources disagree. */
export const CONFLICT_ID = "state-conflict";

/** The id under which a snapshot is offered: the same for the same thing. */
export const stateId = (kind: string, id: string): string => `state-${kind}-${createHash("sha256").update(`${kind}\n${id}`).digest("hex").slice(0, 10)}`;

/**
 * A snapshot as a source: the kind and id of the thing, where to open it, when the server observed it, and its
 * facts as plain lines. What is not available and what is known to be old is said in the text; a source with an old
 * fact is marked `uncertain`.
 */
export function sourceOf(s: Snapshot): Source {
  const link = subjectPage(s.kind, s.id);
  const old = s.stale.length > 0;
  const lines = [
    `Observed by the server at ${s.observedAt}. These are facts as recorded, not conclusions.`,
    ...Object.entries(s.fields).map(([k, v]) => `${k}: ${String(v)}`),
    ...(s.unavailable.length ? [`Not available now: ${s.unavailable.join(", ")}`] : []),
    ...(old ? [`May be out of date: ${s.stale.join(", ")}`] : []),
  ].join("\n");
  return {
    id: stateId(s.kind, s.id),
    kind: "state",
    title: `${s.label.charAt(0).toUpperCase()}${s.label.slice(1)}${old ? " (may be out of date)" : ""}`,
    ref: `${s.kind === s.id ? s.kind : `${s.kind} ${s.id}`} · ${link}`,
    observedAt: s.observedAt,
    subject: { kind: s.kind, id: s.id },
    excerpt: lines.length > STATE_EXCERPT_MAX ? `${lines.slice(0, STATE_EXCERPT_MAX - 2)} …` : lines,
    ...(old ? { uncertain: true } : {}),
  };
}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "stopped"]);

/**
 * Where two snapshots say different things about the same work, in fixed words. Compared:
 * a run that is finished and still stands in the queue; a run that works and whose next-step record waits for a
 * person; a board issue whose status is not the one of its run.
 */
export function conflictsOf(snapshots: readonly Snapshot[]): string[] {
  const out: string[] = [];
  const runs = snapshots.filter((s) => s.kind === "run");
  for (const r of runs) {
    const status = String(r.fields.status ?? "");
    if (FINISHED.has(status) && snapshots.some((q) => q.kind === "queue" && q.id === r.id)) out.push(`The run ${r.id} is recorded as ${status}, but it also stands in the queue.`);
    if (status === "running" && r.fields.nextWho === "You") out.push(`The run ${r.id} is recorded as running, but its next step says it waits for a person.`);
  }
  for (const i of snapshots.filter((s) => s.kind === "issue")) {
    const r = runs.find((x) => x.id === i.fields.run);
    if (r && r.fields.nextStatus !== undefined && i.fields.status !== undefined && r.fields.nextStatus !== i.fields.status) out.push(`The board says "${String(i.fields.status)}" for issue ${String(i.fields.issue)}, but its run ${r.id} says "${String(r.fields.nextStatus)}".`);
  }
  return out;
}

/** The source that tells of a disagreement. It is uncertain by nature. */
export function conflictSource(conflicts: readonly string[], observedAt: string): Source | undefined {
  if (!conflicts.length) return undefined;
  const text = ["The server compared the sources of this question and they disagree. The state is uncertain.", ...conflicts].join("\n");
  return { id: CONFLICT_ID, kind: "state", title: "The sources disagree: the state is uncertain", ref: "compared by the server", observedAt, excerpt: text.slice(0, STATE_EXCERPT_MAX), uncertain: true };
}

/**
 * The snapshots for a question, for the account as it is now: the things the page context names (looked up again,
 * never trusted), then the account's part of the queue, then for an administrator the health of the server and for
 * a user their newest runs that wait or failed. A queue entry of a named run is taken for the comparison only.
 */
export function liveSnapshots(ctx: ApiContext, asker: Asker, input: Pick<TurnInput, "context">, guard: GuardOptions = {}): { shown: Snapshot[]; all: Snapshot[] } {
  const user = currentAccount(asker);
  if (!user) return { shown: [], all: [] };
  const role = user.role === "admin" ? "admin" : "user";
  const who: Asker = { id: user.id, role };
  const asked: { kind: string; id: string }[] = [];
  const add = (kind: string, id: string) => {
    if (!asked.some((x) => x.kind === kind && x.id === id)) asked.push({ kind, id });
  };
  const c = input.context;
  if (c) {
    const found = pageOf(c.page, role);
    if (found?.page.entity && found.arg !== undefined) add(found.page.entity, found.arg);
    if (c.kind !== undefined && c.id !== undefined) add(c.kind, c.id);
    for (const e of c.entities ?? []) add(e.kind, e.id);
  }
  const shown: Snapshot[] = [];
  const hidden: Snapshot[] = [];
  const take = (kind: string, id: string, into = shown) => {
    if (into === shown && shown.length >= STATE_SOURCES) return;
    const s = helpSnapshot(ctx, who, { kind, id }, guard);
    if (s && ![...shown, ...hidden].some((x) => x.kind === s.kind && x.id === s.id)) into.push(s);
  };
  for (const ref of asked.slice(0, ENTITY_LIMIT + 2)) take(ref.kind, ref.id);
  if (role === "user" && !shown.some((s) => s.kind === "run")) {
    // "why does my work wait": the newest runs of the account that wait or failed
    let mine: { runId: string; status: string }[] = [];
    try {
      mine = runsListFor(ctx, user.id).filter((r) => r.status === "waiting" || r.status === "failed").slice(0, 2);
    } catch {
      mine = [];
    }
    for (const r of mine) take("run", r.runId);
  }
  take("queue", "queue");
  if (role === "admin") take("health", "health");
  for (const r of shown.filter((s) => s.kind === "run")) take("queue", r.id, hidden);
  return { shown, all: [...shown, ...hidden] };
}

/** The state sources of a question: the snapshots, then the diagnoses of the first of them. Never throws: what cannot be read is not offered. */
export function liveEvidence(ctx: ApiContext, input: TurnInput, guard: GuardOptions = {}): Source[] {
  try {
    const { shown, all } = liveSnapshots(ctx, { id: input.owner, role: input.role }, input, guard);
    const conflict = conflictSource(conflictsOf(all), new Date().toISOString());
    const states = shown.map(sourceOf);
    // what the product itself says is wrong with these things (#237): after the facts, and uncertain when the facts disagree
    const diagnoses = diagnosisSources(ctx, { id: input.owner, role: input.role }, shown, (s) => sourceOf(s).ref, guard, !!conflict);
    return [...(conflict ? [conflict] : []), ...states, ...diagnoses];
  } catch {
    return [];
  }
}

/**
 * The account now and its conversation, before any body is read: 403 when the account is gone, HelpError not-found
 * (404) for another account's or an unknown conversation, 410 for a deleted one.
 */
export function offerConversation(ctx: ApiContext, asker: Asker, conversation: string): { user: User; role: HelpRole; conversation: Conversation } {
  void ctx;
  const user = currentAccount(asker);
  if (!user) throw new HttpError(403, OFFER_WORDS.denied);
  const found = getConversation(user.id, conversation);
  if (found.state === "deleted") throw new HttpError(410, "this conversation was deleted");
  return { user, role: user.role === "admin" ? "admin" : "user", conversation: found };
}

const stale = () => new HttpError(404, OFFER_WORDS.stale);
const denied = () => new HttpError(403, OFFER_WORDS.denied);

/**
 * Runs an offer of a stored reply for the account as it is now: checks the role, the permission rule of the call the
 * offer names, and that the thing is still there and visible, then gives back the address the server builds.
 * Throws HttpError (or HelpError from the store); stores nothing.
 */
export function runOffer(ctx: ApiContext, asker: Asker, conversation: string, body: unknown, guard: GuardOptions = {}): { type: OfferType; to: string } {
  // again: the conversation can change while the body is read
  const { user, role, conversation: found } = offerConversation(ctx, asker, conversation);
  const call = OfferCallSchema.safeParse(body);
  if (!call.success) throw new HttpError(400, OFFER_WORDS.badBody);
  const message = found.messages.find((m) => m.id === call.data.message && m.role === "assistant" && m.status === "done");
  const offer = message?.reply?.offers?.[call.data.offer];
  if (!offer) throw stale();
  const def = offerDef(role, offer.type);
  if (!def) throw denied();
  if (!def.subjects.includes(offer.subject.kind)) throw stale();
  // the patterns can change after the reply was stored: an id the guard changes now is not followed
  const g = guardExcerpt(offer.subject.id, guard);
  if (g.withheld || g.removed.length > 0 || g.text !== offer.subject.id) throw stale();
  const seg = offerCall(def, offer.subject);
  const rule = findRule(def.call.method, seg);
  if (!rule) throw denied();
  try {
    authorize(ctx, user, rule, seg);
  } catch (e) {
    throw e instanceof HttpError && e.status === 404 ? stale() : denied();
  }
  const who = { id: user.id, role };
  let there: boolean;
  if (def.type === "open-turn-item") {
    if (offer.subject.kind === "run") there = onHome(turnFor(ctx), { runId: offer.subject.id });
    else {
      const s = helpSnapshot(ctx, who, offer.subject, guard);
      there = !!s && onHome(turnFor(ctx), { repo: String(s.fields.repository), issue: Number(s.fields.issue) });
    }
  } else {
    there = !!helpSnapshot(ctx, who, offer.subject, guard);
  }
  if (!there) throw stale();
  return { type: def.type, to: def.to(offer.subject) };
}
