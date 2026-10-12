import { basename, dirname, join } from "node:path";
import { StoreError } from "../auth/store.js";
import { getUser, type User } from "../auth/users.js";
import { CONTEXT_MAX, CONTEXT_PRIORITY, ENTITY_LIMIT, FILTER_LIMIT, SELECTION_MAX, contextSize, type EntityResolver } from "../help/context.js";
import { forRole } from "../help/contract.js";
import { HelpDocs } from "../help/docs.js";
import {
  CONVERSATION_LIMIT,
  DELETED_KEEP_MS,
  HelpError,
  KEEP_MS,
  MESSAGE_LIMIT,
  QUESTION_MAX,
  type Conversation,
  type HelpErrorCode,
  archiveConversation,
  completeConversation,
  deleteConversation,
  getConversation,
  listConversations,
  restoreConversation,
  dayOf,
  readUsage,
  settleInterrupted,
  sweepHelp,
} from "../help/store.js";
import { HelpTurns, REFUSAL_WORDS, TurnRefused, helpTarget, type Asker, type RefusalCode } from "../help/turn.js";
import { snapshotResolver } from "./help-context.js";
import { FLOW_GUIDE_PATH } from "./generate.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { asParam } from "./view-as.js";

const INTERNAL = "Ask SCF is not working; see the server log";
/** The answer to a help call made through "View as user": conversations are the owner's alone. */
export const NOT_IN_PREVIEW = "Ask SCF conversations are not shown in a preview";
const STATUS: Record<HelpErrorCode, number> = { "bad-question": 400, "bad-context": 400, "not-found": 404, deleted: 410, "bad-state": 409, busy: 409, limit: 409 };

/** How often the server applies the retention policy to the stored conversations, in ms. */
export const HELP_SWEEP_MS = 60 * 60 * 1000;

const REFUSED: Record<RefusalCode, number> = { off: 503, busy: 409, "queue-full": 429, limit: 429, unsafe: 503 };

/**
 * Looks a thing a page context names up again, for the account that asks, with the rules of the API call that
 * reads the same thing (the adapters of `help-context.ts`). A thing that does not exist and one the account may not see give the same answer: nothing.
 * The account is read now, not taken from the question: a removed or blocked account finds nothing, and a role that
 * changed since counts as the lower of the two.
 */
export function helpResolver(ctx: ApiContext): EntityResolver {
  return snapshotResolver(ctx, () => ({ patterns: ctx.config().help.sensitive_patterns ?? [] }));
}

/** The folder the Foundry is installed in: where its own documents are. Never the repository that is worked on. */
export const INSTALL_ROOT = join(dirname(FLOW_GUIDE_PATH), "..");
const indexes = new WeakMap<ApiContext, HelpDocs>();
/** The documentation index of this server. */
export function helpDocsOf(ctx: ApiContext): HelpDocs {
  let d = indexes.get(ctx);
  if (!d) {
    d = new HelpDocs(INSTALL_ROOT, ctx.diagLog);
    indexes.set(ctx, d);
  }
  return d;
}

const services = new WeakMap<ApiContext, HelpTurns>();
/** The help turns of this server: what runs and what waits. */
export function helpTurnsOf(ctx: ApiContext): HelpTurns {
  let s = services.get(ctx);
  if (!s) {
    const docs = helpDocsOf(ctx);
    // the documentation of the install is the evidence of a product question: only sections of the asker's role
    s = new HelpTurns({ config: ctx.config, claudeBin: ctx.opts.claudeBin, log: ctx.diagLog, resolve: helpResolver(ctx), evidence: (input) => docs.sources(input.question, input.role) });
    services.set(ctx, s);
  }
  return s;
}

function mapped(ctx: ApiContext, e: unknown): HttpError {
  if (e instanceof HelpError) return new HttpError(STATUS[e.code], e.message);
  if (e instanceof TurnRefused) return new HttpError(REFUSED[e.code], e.message);
  if (e instanceof HttpError) return e;
  const log = ctx.diagLog;
  if (e instanceof StoreError) log?.(`help: ${basename(e.file)} ${e.kind}`);
  else log?.(`help: unexpected ${e instanceof Error ? e.name : "error"}`);
  return new HttpError(500, INTERNAL);
}

/** Runs help code. Input errors become 4xx; everything else is logged (file name and kind only) and answered with a plain 500. */
export function guardedHelp<T>(ctx: ApiContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw mapped(ctx, e);
  }
}

/** When a conversation that stays untouched is deleted by the retention policy. */
const expiresOn = (c: Conversation) => new Date(Date.parse(c.updated) + KEEP_MS).toISOString();

/** A conversation as the list shows it: no messages. */
function summary(c: Conversation) {
  const last = c.messages[c.messages.length - 1];
  return {
    id: c.id,
    title: c.title,
    state: c.state,
    messages: c.messages.length,
    waiting: last?.role === "assistant" && last.status === "pending",
    created: c.created,
    updated: c.updated,
    expiresOn: expiresOn(c),
  };
}

/** A conversation as its owner reads it. The owner field is not sent: it is always the reader. For a user every admin-only field is left out. */
export function conversationView(c: Conversation, viewer: User) {
  const { owner: _owner, ...rest } = c;
  return forRole(viewer.role === "admin" ? "admin" : "user", { ...rest, ...(c.state === "deleted" ? {} : { expiresOn: expiresOn(c) }) });
}

/** For administrators: whether Ask SCF is on, which provider answers, the limits, and what each account used per day. No question and no answer is in it. */
function usageView(ctx: ApiContext) {
  const config = ctx.config();
  const found = helpTarget(config);
  const rows = readUsage();
  const today = dayOf(new Date());
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, getUser(id)?.name ?? "a removed account");
    return names.get(id)!;
  };
  const sum = rows.filter((u) => u.day === today).reduce((t, u) => ({ turns: t.turns + u.turns, failed: t.failed + u.failed, costUsd: t.costUsd + u.costUsd, inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens }), { turns: 0, failed: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
  return {
    enabled: config.help.enabled,
    provider: "problem" in found ? { ok: false, problem: found.problem } : { ok: true, target: found.target.label, agent: found.target.agent, provider: found.target.providerName, model: found.target.model ?? null, free: found.target.free },
    limits: {
      timeoutSeconds: config.help.timeout_seconds,
      maxParallel: config.help.max_parallel,
      maxQueued: config.help.max_queued,
      turnsPerUserPerDay: config.help.turns_per_user_per_day,
      maxCostUsdPerTurn: config.help.max_cost_usd_per_turn,
      dailyBudgetUsd: config.help.daily_budget_usd ?? null,
      costLimits: config.cost_limits,
    },
    now: helpTurnsOf(ctx).status(),
    // the documentation Ask SCF quotes: the version it is for, what was indexed, and what is wrong with it
    documentation: helpDocsOf(ctx).status(),
    today: { day: today, ...sum },
    days: rows.map((u) => ({ ...u, ownerName: nameOf(u.owner) })).reverse(),
  };
}

/** The start and the timer: marks turns a stopped server left behind as interrupted (first call only) and applies the retention policy. Never throws; a problem that stays is logged once. */
export function helpSweeper(log: (msg: string) => void): () => void {
  let told = false;
  let first = true;
  return () => {
    try {
      if (first) settleInterrupted();
      first = false;
      sweepHelp();
      told = false;
    } catch (e) {
      if (told) return;
      told = true;
      log(`! help: ${e instanceof StoreError ? `${basename(e.file)} ${e.kind}` : e instanceof Error ? e.name : "error"}`);
    }
  };
}

/**
 * The stored conversations of Ask SCF. Every call works on the conversations of the signed-in account only; the
 * role gives nothing more, so an administrator reads no conversation of another account, also not through
 * "View as user". An id of another account is answered like an unknown one.
 */
export const helpRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "help") return false;
  if (asParam(req) !== undefined) throw new HttpError(403, NOT_IN_PREVIEW);
  if (seg.length === 2 && seg[1] === "usage" && method === "GET") {
    // the permission table lets only an administrator come here
    if (user.role !== "admin") throw new HttpError(403, "not allowed for your role");
    send(res, 200, guardedHelp(ctx, () => usageView(ctx)));
    return true;
  }
  const asker: Asker = { id: user.id, role: user.role === "admin" ? "admin" : "user" };
  const turns = helpTurnsOf(ctx);
  // What a page context is worth, before it is sent with a question: nothing is stored and no model is called.
  if (seg.length === 2 && seg[1] === "context" && method === "POST") {
    if (!ctx.config().help.enabled) throw new HttpError(503, REFUSAL_WORDS.off);
    const body = await readJson(req);
    const { context, resolved } = guardedHelp(ctx, () => turns.describe(asker, body));
    send(res, 200, {
      context,
      size: context ? contextSize(context) : 0,
      limits: { size: CONTEXT_MAX, things: ENTITY_LIMIT, filters: FILTER_LIMIT, selectionChars: SELECTION_MAX, keptFirst: [...CONTEXT_PRIORITY] },
      page: resolved?.page ? { type: resolved.page.id, title: resolved.page.title } : null,
      things: resolved?.entities ?? [],
      notFound: resolved?.notFound ?? 0,
    });
    return true;
  }
  if (seg[1] !== "conversations") return false;
  const id = seg[2] ?? "";
  // A question: in a new conversation, or as the next one of a conversation. The answer comes later; read the conversation for it.
  if (method === "POST" && (seg.length === 2 || (seg.length === 4 && seg[3] === "messages"))) {
    const body = await readJson(req);
    const turn = guardedHelp(ctx, () => turns.ask(asker, { ...(seg.length === 4 ? { conversation: id } : {}), question: body.question, context: body.context }));
    send(res, 202, conversationView(turn.conversation, user));
    return true;
  }
  if (seg.length === 4 && method === "POST" && seg[3] === "retry") {
    send(res, 202, conversationView(guardedHelp(ctx, () => turns.retry(asker, id)).conversation, user));
    return true;
  }
  if (seg.length === 4 && method === "POST" && seg[3] === "cancel") {
    send(res, 200, conversationView(guardedHelp(ctx, () => turns.cancel(asker, id)), user));
    return true;
  }
  if (seg.length === 2 && method === "GET") {
    const archived = new URL(req.url ?? "/", "http://x").searchParams.get("archived") === "1";
    const conversations = guardedHelp(ctx, () => listConversations(user.id, { archived })).map(summary);
    send(res, 200, {
      enabled: ctx.config().help.enabled,
      conversations,
      limits: { conversations: CONVERSATION_LIMIT, messages: MESSAGE_LIMIT, questionChars: QUESTION_MAX, keepDays: KEEP_MS / 86_400_000, deletedKeepDays: DELETED_KEEP_MS / 86_400_000 },
    });
    return true;
  }
  if (seg.length === 3 && method === "GET") {
    const c = guardedHelp(ctx, () => getConversation(user.id, id));
    if (c.state === "deleted") throw new HttpError(410, "this conversation was deleted");
    send(res, 200, conversationView(c, user));
    return true;
  }
  if (seg.length === 3 && method === "DELETE") {
    const { conversation, pending } = guardedHelp(ctx, () => deleteConversation(user.id, id));
    // the turn of a deleted conversation is ended: its answer has nowhere to go
    if (pending !== undefined) turns.drop(pending);
    send(res, 200, conversationView(conversation, user));
    return true;
  }
  if (seg.length === 4 && method === "POST") {
    const act = seg[3] === "complete" ? completeConversation : seg[3] === "archive" ? archiveConversation : seg[3] === "restore" ? restoreConversation : undefined;
    if (!act) return false;
    send(res, 200, conversationView(guardedHelp(ctx, () => act(user.id, id)), user));
    return true;
  }
  return false;
};
