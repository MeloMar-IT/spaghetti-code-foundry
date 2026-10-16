import { basename, dirname, join } from "node:path";
import { writeAudit } from "../auth/audit.js";
import { effectiveLimits } from "../auth/limits.js";
import { StoreError } from "../auth/store.js";
import { getUser, type User } from "../auth/users.js";
import { CONTEXT_MAX, CONTEXT_PRIORITY, ENTITY_LIMIT, FILTER_LIMIT, SELECTION_MAX, contextSize, type EntityResolver } from "../help/context.js";
import { forRole } from "../help/contract.js";
import { HelpDocs } from "../help/docs.js";
import {
  CONVERSATION_LIMIT,
  DELETED_KEEP_MS,
  HelpError,
  MESSAGE_LIMIT,
  QUESTION_MAX,
  type Conversation,
  type Turn,
  type HelpErrorCode,
  archiveConversation,
  checkFeedback,
  completeConversation,
  rateReply,
  deleteConversation,
  getConversation,
  listConversations,
  restoreConversation,
  dayOf,
  readUsage,
  retentionMs,
  setRetentionDays,
  usageToday,
  settleInterrupted,
  sweepHelp,
} from "../help/store.js";
import { addStats, readStats, sumStats, sweepStats } from "../help/telemetry.js";
import { HelpTurns, REFUSAL_WORDS, TurnRefused, helpPaused, helpTarget, type Asker, type RefusalCode } from "../help/turn.js";
import type { Config } from "../config.js";
import { currentAccount, snapshotResolver } from "./help-context.js";
import { liveEvidence } from "./help-evidence.js";
import { ActionRefused, cancelAction, confirmAction, prepareAction, type ActionDeps } from "./help-actions.js";
import { FLOW_GUIDE_PATH } from "./generate.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { asParam } from "./view-as.js";

const INTERNAL = "Ask SCF is not working; see the server log";
/** The answer to a help call made through "View as user": conversations are the owner's alone. */
export const NOT_IN_PREVIEW = "Ask SCF conversations are not shown in a preview";
const STATUS: Record<HelpErrorCode, number> = { "bad-question": 400, "bad-context": 400, "not-found": 404, deleted: 410, "bad-state": 409, busy: 409, limit: 409, "bad-feedback": 400 };

/** How often the server applies the retention policy to the stored conversations, in ms. */
export const HELP_SWEEP_MS = 60 * 60 * 1000;

const REFUSED: Record<RefusalCode, number> = { off: 503, paused: 503, "not-allowed": 403, busy: 409, "queue-full": 429, limit: 429, unsafe: 503 };

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

/**
 * Whether an account may ask now, by the settings and the account's own limits; a code when not. Read at the time
 * of the question: the account as it is now (a blocked or removed one may not ask), `help.audience`,
 * `help.disabled_accounts`, and the account's daily budget (`limits.json`), against what its help turns cost today.
 */
export function helpAllowed(ctx: ApiContext, asker: Asker): RefusalCode | undefined {
  const help = ctx.config().help;
  const now = currentAccount(asker);
  if (!now) return "not-allowed";
  if (help.audience === "admins" && now.role !== "admin") return "not-allowed";
  if (help.audience === "pilot" && now.role !== "admin" && !(help.pilot_accounts ?? []).includes(now.id)) return "not-allowed";
  if ((help.disabled_accounts ?? []).includes(now.id)) return "not-allowed";
  const budget = effectiveLimits(now.id, ctx.diagLog).dailyBudgetUsd;
  if (ctx.config().cost_limits && budget !== undefined && usageToday(now.id).costUsd >= budget) return "limit";
  return undefined;
}

/** One audit line of Ask SCF: who, what, which conversation, how it ended, and the id of the turn. Never a text of a question or an answer. */
function auditHelp(ctx: ApiContext, by: string, action: "help-ask" | "help-delete" | "help-export", result: "ok" | "failed", target: string, detail?: string): void {
  try {
    writeAudit(by, { action, result, target, ...(detail !== undefined ? { detail } : {}) }, 0);
  } catch (e) {
    ctx.diagLog?.(e instanceof StoreError ? `audit: ${basename(e.file)} ${e.kind} (${action})` : `audit: audit.jsonl not-valid (${action})`);
  }
}
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const targetOf = (id: string | undefined) => (id !== undefined && ID_SHAPE.test(id) ? `conversation ${id}` : "conversation");

const services = new WeakMap<ApiContext, HelpTurns>();
/** The help turns of this server: what runs and what waits. */
export function helpTurnsOf(ctx: ApiContext): HelpTurns {
  let s = services.get(ctx);
  if (!s) {
    const docs = helpDocsOf(ctx);
    // the evidence of a turn: what the server observes now for this account, then the fitting sections of the installed documentation
    s = new HelpTurns({ config: ctx.config, claudeBin: ctx.opts.claudeBin, log: ctx.diagLog, resolve: helpResolver(ctx), allow: (asker) => helpAllowed(ctx, asker), evidence: (input) => [...liveEvidence(ctx, input, { patterns: ctx.config().help.sensitive_patterns ?? [] }), ...docs.sources(input.question, input.role)] });
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
const expiresOn = (c: Conversation) => new Date(Date.parse(c.updated) + retentionMs()).toISOString();

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

export type RolloutStage = "off" | "paused" | "admins" | "pilot" | "everyone";

/** Where Ask SCF stands in a staged rollout, from the settings alone: off, paused (the emergency stop), administrators only, the pilot accounts, or everyone. */
export function rolloutStage(help: Config["help"]): RolloutStage {
  if (!help.enabled) return "off";
  if (help.paused === true) return "paused";
  return help.audience === "admins" ? "admins" : help.audience === "pilot" ? "pilot" : "everyone";
}

/** Adds to the quality numbers; a problem is logged in fixed words and never fails the request. */
function countQuietly(ctx: ApiContext, delta: Parameters<typeof addStats>[0], opts?: Parameters<typeof addStats>[1]): void {
  try {
    addStats(delta, opts);
  } catch {
    ctx.diagLog?.("help: the statistics could not be stored");
  }
}

/** The quality numbers for an administrator: the last 7 days summed, and the daily rows, newest first. Null when the file cannot be read. */
function qualityView(ctx: ApiContext) {
  try {
    const rows = readStats();
    const from = dayOf(new Date(Date.now() - 6 * 86_400_000));
    return { last7: sumStats(rows.filter((r) => r.day >= from), "last 7 days"), days: [...rows].reverse() };
  } catch {
    ctx.diagLog?.("help: the statistics could not be read");
    return null;
  }
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
    rollout: { stage: rolloutStage(config.help), paused: helpPaused(config), audience: config.help.audience ?? "everyone", pilotAccounts: (config.help.pilot_accounts ?? []).length, disabledAccounts: (config.help.disabled_accounts ?? []).length },
    quality: qualityView(ctx),
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
export function helpSweeper(log: (msg: string) => void, keepDays?: () => number | undefined): () => void {
  let told = false;
  let toldStats = false;
  let first = true;
  return () => {
    try {
      setRetentionDays(keepDays?.());
      let settled = 0;
      if (first) {
        settled = settleInterrupted();
        // the start is done once the turns are settled: the statistics must never make a later sweep settle live turns
        first = false;
      }
      sweepHelp();
      told = false;
      // the quality numbers are apart from the conversations: a problem there is logged and changes nothing above
      try {
        if (settled > 0) addStats({ failed: { interrupted: settled } });
        sweepStats();
      } catch {
        if (!toldStats) log("! help: help-stats.json could not be used");
        toldStats = true;
      }
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
  setRetentionDays(ctx.config().help.keep_days);
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
    if (helpPaused(ctx.config())) throw new HttpError(503, REFUSAL_WORDS.paused);
    const no = helpAllowed(ctx, asker);
    if (no === "not-allowed") throw new HttpError(REFUSED[no], REFUSAL_WORDS[no]);
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
  // Everything the account has in Ask SCF, to keep: its own conversations only, with the same view as reading them one by one.
  if (seg.length === 2 && seg[1] === "export" && method === "GET") {
    const body = guardedHelp(ctx, () => {
      const all = [...listConversations(user.id), ...listConversations(user.id, { archived: true })].sort((a, b) => a.created.localeCompare(b.created));
      return { exportedAt: new Date().toISOString(), retention: { keepDays: retentionMs() / 86_400_000, deletedKeepDays: DELETED_KEEP_MS / 86_400_000 }, conversations: all.map((c) => conversationView(c, user)) };
    });
    auditHelp(ctx, user.id, "help-export", "ok", "conversations", `${body.conversations.length} conversation(s)`);
    send(res, 200, body);
    return true;
  }
  if (seg[1] !== "conversations") return false;
  const id = seg[2] ?? "";
  // Approved actions: a preview with a token, the confirmation, and dropping the token. Before the generic POST block.
  if (method === "POST" && seg[3] === "actions" && (seg.length === 4 || (seg.length === 5 && (seg[4] === "confirm" || seg[4] === "cancel")))) {
    const deps: ActionDeps = { allow: (a) => helpAllowed(ctx, a) };
    try {
      if (seg.length === 4) send(res, 200, prepareAction(ctx, user, id, await readJson(req), deps));
      else if (seg[4] === "cancel") send(res, 200, cancelAction(ctx, user, id, await readJson(req), deps));
      else send(res, 200, await confirmAction(ctx, user, id, () => readJson(req), deps));
    } catch (e) {
      if (e instanceof ActionRefused) throw new HttpError(e.status, e.message);
      throw mapped(ctx, e);
    }
    return true;
  }
  /** Takes a turn and writes its audit line: started (with the id of the turn) or refused (with the code). A question that is not valid writes none. */
  const audited = (conversation: string | undefined, how: "ask" | "retry", fn: () => Turn): Turn => {
    try {
      const turn = guardedHelp(ctx, fn);
      auditHelp(ctx, user.id, "help-ask", "ok", targetOf(turn.conversation.id), `${how}; turn ${turn.reply.id}; try ${turn.reply.tries ?? 1}`);
      return turn;
    } catch (e) {
      const code = (Object.keys(REFUSAL_WORDS) as RefusalCode[]).find((c) => e instanceof HttpError && e.message === REFUSAL_WORDS[c]);
      if (code) auditHelp(ctx, user.id, "help-ask", "failed", targetOf(conversation), `${how}; refused: ${code}`);
      throw e;
    }
  };
  // A question: in a new conversation, or as the next one of a conversation. The answer comes later; read the conversation for it.
  if (method === "POST" && (seg.length === 2 || (seg.length === 4 && seg[3] === "messages"))) {
    const body = await readJson(req);
    const turn = audited(seg.length === 4 ? id : undefined, "ask", () => turns.ask(asker, { ...(seg.length === 4 ? { conversation: id } : {}), question: body.question, context: body.context }));
    send(res, 202, conversationView(turn.conversation, user));
    return true;
  }
  if (seg.length === 4 && method === "POST" && seg[3] === "retry") {
    send(res, 202, conversationView(audited(id, "retry", () => turns.retry(asker, id)).conversation, user));
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
      paused: helpPaused(ctx.config()),
      conversations,
      limits: { conversations: CONVERSATION_LIMIT, messages: MESSAGE_LIMIT, questionChars: QUESTION_MAX, keepDays: retentionMs() / 86_400_000, deletedKeepDays: DELETED_KEEP_MS / 86_400_000 },
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
    if (pending !== undefined) {
      turns.drop(pending);
      countQuietly(ctx, { counts: { abandoned: 1 } });
    }
    auditHelp(ctx, user.id, "help-delete", "ok", targetOf(conversation.id));
    send(res, 200, conversationView(conversation, user));
    return true;
  }
  // The owner rates one finished answer. Only a vote and fixed reasons are kept, and only counts go to the statistics.
  if (seg.length === 4 && method === "POST" && seg[3] === "feedback") {
    // the conversation of another account is the same as none, before the body is looked at
    guardedHelp(ctx, () => getConversation(user.id, id));
    const body = await readJson(req);
    const { conversation, before, after } = guardedHelp(ctx, () => rateReply(user.id, id, checkFeedback(body)));
    // a changed vote leaves the day it was given and counts on today; the reasons follow their vote
    const delta = (f: typeof before, sign: 1 | -1) => (f ? { counts: { [f.vote === "helpful" ? "helpful" : "notHelpful"]: sign }, reasons: Object.fromEntries(f.reasons.map((r) => [r, sign])) } : undefined);
    const same = before?.vote === after?.vote && JSON.stringify(before?.reasons) === JSON.stringify(after?.reasons);
    if (!same) {
      const out = delta(before, -1);
      if (before && out) countQuietly(ctx, out, { day: before.at.slice(0, 10) });
      const inn = delta(after, 1);
      if (after && inn) countQuietly(ctx, inn, { day: after.at.slice(0, 10) });
    }
    send(res, 200, conversationView(conversation, user));
    return true;
  }
  if (seg.length === 4 && method === "POST") {
    const act = seg[3] === "complete" ? completeConversation : seg[3] === "archive" ? archiveConversation : seg[3] === "restore" ? restoreConversation : undefined;
    if (!act) return false;
    // Closing is not an outcome. Only a person who says "this solved my problem" (`resolved: true`) is counted as resolved,
    // once, and only for a conversation that has a finished answer.
    const said = seg[3] === "complete" && req.headers["content-type"]?.startsWith("application/json") ? (await readJson(req)).resolved === true : false;
    const was = said ? guardedHelp(ctx, () => getConversation(user.id, id)) : undefined;
    const done = guardedHelp(ctx, () => act(user.id, id));
    if (said && was?.state === "active" && done.state === "completed" && was.messages.some((m) => m.role === "assistant" && m.status === "done")) countQuietly(ctx, { counts: { resolved: 1 } });
    send(res, 200, conversationView(done, user));
    return true;
  }
  return false;
};
