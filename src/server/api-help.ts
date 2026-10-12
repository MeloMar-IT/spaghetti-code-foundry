import { basename } from "node:path";
import { StoreError } from "../auth/store.js";
import type { User } from "../auth/users.js";
import { forRole } from "../help/contract.js";
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
  settleInterrupted,
  sweepHelp,
} from "../help/store.js";
import { HttpError, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { asParam } from "./view-as.js";

const INTERNAL = "Ask SCF is not working; see the server log";
/** The answer to a help call made through "View as user": conversations are the owner's alone. */
export const NOT_IN_PREVIEW = "Ask SCF conversations are not shown in a preview";
const STATUS: Record<HelpErrorCode, number> = { "bad-question": 400, "bad-context": 400, "not-found": 404, deleted: 410, "bad-state": 409, busy: 409, limit: 409 };

/** How often the server applies the retention policy to the stored conversations, in ms. */
export const HELP_SWEEP_MS = 60 * 60 * 1000;

function mapped(ctx: ApiContext, e: unknown): HttpError {
  if (e instanceof HelpError) return new HttpError(STATUS[e.code], e.message);
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
  if (seg[0] !== "help" || seg[1] !== "conversations") return false;
  if (asParam(req) !== undefined) throw new HttpError(403, NOT_IN_PREVIEW);
  const id = seg[2] ?? "";
  if (seg.length === 2 && method === "GET") {
    const archived = new URL(req.url ?? "/", "http://x").searchParams.get("archived") === "1";
    const conversations = guardedHelp(ctx, () => listConversations(user.id, { archived })).map(summary);
    send(res, 200, {
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
    const { conversation } = guardedHelp(ctx, () => deleteConversation(user.id, id));
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
