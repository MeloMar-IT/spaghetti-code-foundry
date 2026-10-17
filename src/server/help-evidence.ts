import { createHash } from "node:crypto";
import type { User } from "../auth/users.js";
import { OFFER_WORDS, OfferCallSchema, callOf, checkOf, checkText, offerCall, offerDef, subjectPage, type CheckInput, type CheckOutcome, type OfferType } from "../help/actions.js";
import { aboutOf } from "../help/contract.js";
import { ENTITY_LIMIT, pageOf, type Asker } from "../help/context.js";
import type { HelpRole } from "../help/contract.js";
import { guardExcerpt, type GuardOptions } from "../help/guard.js";
import { HelpError, addCheck, checkBlocked, getConversation, revisionOf, type Conversation } from "../help/store.js";
import type { Source, TurnInput } from "../help/turn.js";
import { onHome } from "../your-turn.js";
import { runsListFor } from "./api-runs.js";
import { currentAccount, helpSnapshot, type Snapshot } from "./help-context.js";
import { diagnosisSources } from "./help-diagnosis.js";
import { testRepo } from "./api-repos.js";
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
export function sourceOf(s: Snapshot, about = false): Source {
  const link = subjectPage(s.kind, s.id);
  const old = s.stale.length > 0;
  const bound = about && s.kind === "run" && !old ? aboutOf({ kind: "run", id: s.id }) : undefined;
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
    ...(bound ? { about: bound } : {}),
  };
}

/** The state sources of the shown snapshots. A run carries what it is about only when the asker owns it and no source disagrees; sourceOf adds "not stale". */
export function stateSources(shown: readonly Snapshot[], mine: (runId: string) => boolean, conflict: boolean): Source[] {
  return shown.map((s) => sourceOf(s, !conflict && s.kind === "run" && mine(s.id)));
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
    const states = stateSources(shown, (id) => ctx.scheduler.ownerOf(id) === input.owner, !!conflict);
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

/** What a click gives back: the address of a page, or the outcome of a check and the conversation that now holds its result. */
export type OfferDone = { type: OfferType; to: string } | { type: OfferType; outcome: CheckOutcome; conversation: Conversation };

/** The connection test, as `runOffer` calls it. A test can put another function in its place to hold the wait open. */
export type TestFn = (ctx: ApiContext, user: User, id: string) => Promise<{ at: string; ok: boolean; checks: unknown[] }>;

/** The connection test ran, but its result could not be stored in the conversation. `detail` is the audit detail. */
export class CheckNotStored extends HttpError {
  constructor(
    status: number,
    message: string,
    public detail: string,
  ) {
    super(status, message);
  }
}

/** The conversations in which a check runs now. */
const checking = new Set<string>();

/** The label of a snapshot is not guarded by `helpSnapshot` (it can hold a repository or flow name): it passes the guard here, with a fixed word when it is withheld. */
function labelOf(s: Snapshot, guard: GuardOptions): string {
  const g = guardExcerpt(s.label, guard);
  return g.withheld || !g.text.trim() ? "the thing you asked about" : g.text;
}

const inputOf = (s: Snapshot, type: CheckInput["type"], offer: number, scope: HelpRole, guard: GuardOptions): CheckInput => ({ type, offer, scope, kind: s.kind, id: s.id, label: labelOf(s, guard), observedAt: s.observedAt, fields: s.fields, unavailable: s.unavailable, stale: s.stale });

/**
 * Runs an offer of a stored reply for the account as it is now: checks the role, the permission rule of the call the
 * offer names, and that the thing is still there and visible. A navigation offer gives back the address the server
 * builds and stores nothing. A check (read it again, test the connection) also needs an open conversation with room
 * and no other check, runs, and stores its result as a `check` message. Throws HttpError (or HelpError from the store).
 */
export async function runOffer(ctx: ApiContext, asker: Asker, conversation: string, body: unknown, guard: GuardOptions = {}, test: TestFn = testRepo): Promise<OfferDone> {
  // again: the conversation can change while the body is read
  const { user, role, conversation: found } = offerConversation(ctx, asker, conversation);
  const call = OfferCallSchema.safeParse(body);
  if (!call.success) throw new HttpError(400, OFFER_WORDS.badBody);
  const message = found.messages.find((m) => m.id === call.data.message && m.role === "assistant" && m.status === "done");
  const offer = message?.reply?.offers?.[call.data.offer];
  if (!message || !offer) throw stale();
  const def = offerDef(role, offer.type);
  if (!def) throw denied();
  if (!def.subjects.includes(offer.subject.kind)) throw stale();
  // the patterns can change after the reply was stored: an id the guard changes now is not followed
  const g = guardExcerpt(offer.subject.id, guard);
  if (g.withheld || g.removed.length > 0 || g.text !== offer.subject.id) throw stale();
  const seg = offerCall(def, offer.subject);
  const rule = findRule(callOf(def, offer.subject).method, seg);
  if (!rule) throw denied();
  try {
    authorize(ctx, user, rule, seg);
  } catch (e) {
    throw e instanceof HttpError && e.status === 404 ? stale() : denied();
  }
  const who = { id: user.id, role };
  let there: boolean;
  let snap: Snapshot | undefined;
  if (def.type === "open-turn-item") {
    if (offer.subject.kind === "run") there = onHome(turnFor(ctx), { runId: offer.subject.id });
    else {
      const s = helpSnapshot(ctx, who, offer.subject, guard);
      there = !!s && onHome(turnFor(ctx), { repo: String(s.fields.repository), issue: Number(s.fields.issue) });
    }
  } else {
    snap = helpSnapshot(ctx, who, offer.subject, guard);
    there = !!snap;
  }
  if (!there) throw stale();
  if (def.effect === "navigation" || !snap) return { type: def.type, to: def.to!(offer.subject) };

  // a check: refused before anything is contacted when the conversation cannot take its result
  const blocked = checkBlocked(found);
  if (blocked) throw new HttpError(409, checkText[blocked]);
  if (checking.has(conversation)) throw new HttpError(409, checkText.running);
  const revision = revisionOf(found);
  checking.add(conversation);
  try {
    if (def.type === "refresh-evidence") {
      const stored = addCheck(user.id, conversation, message.id, checkOf(inputOf(snap, def.type, call.data.offer, role, guard), "read"), revision);
      return { type: def.type, outcome: "read", conversation: stored };
    }
    if (def.type !== "test-repository") throw denied();
    let result: Awaited<ReturnType<TestFn>>;
    try {
      result = await test(ctx, user, offer.subject.id);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw stale();
      if (e instanceof HttpError && e.status === 403) throw denied();
      throw e;
    }
    const again = helpSnapshot(ctx, who, offer.subject, guard);
    if (!again) throw stale();
    const outcome: CheckOutcome = result.ok ? "passed" : "failed";
    const failed = (result.checks as { check?: unknown; ok?: unknown; message?: unknown }[]).filter((c) => c.ok === false).map((c) => `${String(c.check)}: ${String(c.message)}`);
    const check = checkOf(inputOf(again, def.type, call.data.offer, role, guard), outcome, failed);
    try {
      return { type: def.type, outcome, conversation: addCheck(user.id, conversation, message.id, check, revision) };
    } catch (e) {
      if (!(e instanceof HelpError)) throw e;
      // the test ran and its result is on the repository: say so, and do not bring a deleted conversation back
      const gone = e.code === "deleted";
      throw new CheckNotStored(gone ? 410 : 409, gone ? e.message : checkText.notStored, `${def.type}; ${outcome}; not stored: ${e.code}`);
    }
  } finally {
    checking.delete(conversation);
  }
}
