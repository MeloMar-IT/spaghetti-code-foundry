import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { ReplySchema, displayText, type Reply } from "./contract.js";

/**
 * The stored conversations of Ask SCF: `help.json` in the data folder, written under the lock of the data folder
 * through a temporary file and a rename. Every conversation belongs to one account, and every call that reads or
 * changes one takes that account: a conversation of another account is the same as one that does not exist.
 */

export type HelpErrorCode = "bad-question" | "bad-context" | "not-found" | "deleted" | "bad-state" | "busy" | "limit";

/** A problem with what the caller asked for (not with the file). The message is safe to show. */
export class HelpError extends Error {
  constructor(
    public code: HelpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HelpError";
  }
}

export const helpPath = () => join(dataHome(), "help.json");

// ---- the retention policy --------------------------------------------------------------------------

/** A conversation that was not changed for this long expires: it is deleted like one the owner deleted. */
export const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/** A deleted conversation keeps an empty record (id, owner, times) this long, then nothing is left. */
export const DELETED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many conversations per account that are not deleted. */
export const CONVERSATION_LIMIT = 100;
/** At most this many messages in one conversation (a question and its reply are two). */
export const MESSAGE_LIMIT = 100;
export const QUESTION_MAX = 4000;
export const TITLE_MAX = 80;
const TEXT_MAX = 20_000;

export const STATES = ["active", "completed", "failed", "cancelled", "archived", "deleted"] as const;
export type ConversationState = (typeof STATES)[number];
const BEFORE_ARCHIVE = ["active", "completed", "failed", "cancelled"] as const;

export const MESSAGE_STATUS = ["pending", "done", "failed", "cancelled"] as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[number];

/** Why a turn did not end with a reply. `interrupted`: the server stopped while the turn was running. */
export const FAILURE_CODES = ["timeout", "provider", "quota", "limit", "setup", "bad-answer", "interrupted"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** What a person reads for a failed turn. Fixed sentences: never the text of a provider or of the server. */
export const FAILURE_WORDS: Record<FailureCode, string> = {
  timeout: "The answer took too long, so Ask SCF stopped waiting. You can try again.",
  provider: "The AI service did not answer. You can try again in a moment.",
  quota: "The AI service has reached its limit for now. Try again later.",
  limit: "The limit for Ask SCF is reached for today. Try again tomorrow, or ask an administrator.",
  setup: "Ask SCF is not set up to answer here. Ask an administrator of this Foundry.",
  "bad-answer": "Ask SCF got an answer it could not use, so it shows none. You can try again.",
  interrupted: "The Foundry restarted before the answer was ready. You can try again.",
};
export const CANCELLED_WORDS = "You stopped this answer. You can ask again.";

// ---- the file --------------------------------------------------------------------------------------

export const CONTEXT_KINDS = ["run", "issue", "repository", "queue", "refinement", "problem"] as const;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Where the question was asked: the page, and the one thing selected there. Names only, never content of the page. */
const ContextSchema = z
  .object({
    page: z.string().min(2).max(200).regex(/^#\/[A-Za-z0-9._~%:/-]*$/),
    kind: z.enum(CONTEXT_KINDS).optional(),
    id: z.string().min(1).max(200).refine((s) => !CONTROL.test(s)).optional(),
  })
  .strict()
  .refine((c) => (c.kind === undefined) === (c.id === undefined), { message: "a selection has a kind and an id", path: ["id"] });
export type PageContext = z.infer<typeof ContextSchema>;

const FailureSchema = z.object({ code: z.enum(FAILURE_CODES), retry: z.boolean() }).strict();

const MessageSchema = z
  .object({
    id: z.uuid(),
    role: z.enum(["user", "assistant"]),
    at: z.iso.datetime(),
    status: z.enum(MESSAGE_STATUS),
    /** What a person reads. For a reply the server wrote it from `reply`; it is never parsed back. */
    text: z.string().max(TEXT_MAX),
    /** A question: where it was asked. */
    context: ContextSchema.optional(),
    /** A reply: the question it answers. */
    replyTo: z.uuid().optional(),
    /** A reply: the checked, structured output (citations in `evidence`, proposals in `actions`). */
    reply: ReplySchema.optional(),
    failure: FailureSchema.optional(),
    /** A reply: how often the turn was started (1, and one more for every retry). */
    tries: z.number().int().min(1).max(1000).optional(),
    /** A reply: when it last changed (answered, failed, stopped or started again). */
    updated: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: "custom", message: "invalid", path: [path] });
    if (m.role === "user") {
      if (m.status !== "done") issue("status");
      for (const k of ["replyTo", "reply", "failure", "tries", "updated"] as const) if (m[k] !== undefined) issue(k);
    } else {
      if (m.replyTo === undefined) issue("replyTo");
      if (m.tries === undefined) issue("tries");
      if (m.context !== undefined) issue("context");
      if ((m.status === "done") !== (m.reply !== undefined)) issue("reply");
      if ((m.status === "failed") !== (m.failure !== undefined)) issue("failure");
    }
  });
export type Message = z.infer<typeof MessageSchema>;

const ConversationSchema = z
  .object({
    id: z.uuid(),
    owner: z.uuid(),
    title: z.string().max(TITLE_MAX),
    state: z.enum(STATES),
    /** While archived: the state to go back to. */
    stateBefore: z.enum(BEFORE_ARCHIVE).optional(),
    deletedAt: z.iso.datetime().optional(),
    /** While deleted: `expired` when the retention time ended it, not the owner. */
    deletedBy: z.enum(["owner", "expired"]).optional(),
    messages: z.array(MessageSchema).max(MESSAGE_LIMIT),
    created: z.iso.datetime(),
    updated: z.iso.datetime(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: "custom", message: "invalid", path: [path] });
    if ((c.state === "archived") !== (c.stateBefore !== undefined)) issue("stateBefore");
    if ((c.state === "deleted") !== (c.deletedAt !== undefined)) issue("deletedAt");
    if ((c.state === "deleted") !== (c.deletedBy !== undefined)) issue("deletedBy");
    // a deleted conversation holds nothing a person wrote or read
    if (c.state === "deleted" && (c.messages.length > 0 || c.title !== "")) issue("messages");
    if (c.state !== "deleted" && c.title === "") issue("title");
    const ids = new Set<string>();
    c.messages.forEach((m, i) => {
      if (ids.has(m.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["messages", i, "id"] });
      ids.add(m.id);
      // a reply comes right after its question, and only the last reply can be unfinished
      if (m.role === "assistant" && c.messages[i - 1]?.id !== m.replyTo) ctx.addIssue({ code: "custom", message: "invalid", path: ["messages", i, "replyTo"] });
      if (m.status === "pending" && i !== c.messages.length - 1) ctx.addIssue({ code: "custom", message: "invalid", path: ["messages", i, "status"] });
    });
  });
export type Conversation = z.infer<typeof ConversationSchema>;

/** The version this code writes. A file with another version is refused and left as it is. */
export const FILE_VERSION = 1;
const FileSchema = z
  .object({ version: z.literal(FILE_VERSION), conversations: z.array(ConversationSchema) })
  .strict()
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    f.conversations.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["conversations", i, "id"] });
      ids.add(c.id);
    });
  });
type FileData = z.infer<typeof FileSchema>;

const EMPTY: FileData = { version: FILE_VERSION, conversations: [] };
const read = (): FileData => readJsonFile(helpPath(), FileSchema, EMPTY);
const save = (conversations: Conversation[]) => writeJsonFile(helpPath(), { version: FILE_VERSION, conversations });
const copy = <T>(v: T): T => structuredClone(v);

export interface StoreOptions {
  now?: () => Date;
}
const clock = (opts: StoreOptions) => (opts.now ?? (() => new Date()))();

// ---- retention -------------------------------------------------------------------------------------

/** The empty record that is left of a deleted conversation: no title, no messages, no page context. */
function wiped(c: Conversation, at: string, by: "owner" | "expired"): Conversation {
  return { id: c.id, owner: c.owner, title: "", state: "deleted", deletedAt: at, deletedBy: by, messages: [], created: c.created, updated: at };
}

/**
 * The conversations as they are at `now`: one that was not changed for KEEP_MS is deleted (its content is gone, its
 * record says when it expired), and the record of a deleted one is left out after DELETED_KEEP_MS. Reads use this
 * too, so nothing past its time is shown while it waits for the next write.
 */
function current(list: Conversation[], now: Date): Conversation[] {
  const t = now.getTime();
  const out: Conversation[] = [];
  for (const c of list) {
    if (c.state !== "deleted" && t - Date.parse(c.updated) >= KEEP_MS) {
      const at = new Date(Date.parse(c.updated) + KEEP_MS).toISOString();
      if (t - Date.parse(at) < DELETED_KEEP_MS) out.push(wiped(c, at, "expired"));
    } else if (c.state !== "deleted" || t - Date.parse(c.deletedAt ?? c.updated) < DELETED_KEEP_MS) out.push(c);
  }
  return out;
}

const pendingOf = (c: Conversation): Message | undefined => {
  const last = c.messages[c.messages.length - 1];
  return last?.role === "assistant" && last.status === "pending" ? last : undefined;
};

// ---- checking input --------------------------------------------------------------------------------

export function checkQuestion(input: unknown): string {
  const bad = (m: string) => new HelpError("bad-question", m);
  if (typeof input !== "string") throw bad("type your question");
  const q = input.replace(/\r\n/g, "\n").trim();
  if (!q) throw bad("type your question");
  if (q.length > QUESTION_MAX) throw bad(`a question can have at most ${QUESTION_MAX} characters`);
  if (CONTROL_IN_TEXT.test(q)) throw bad("the question has characters that are not allowed");
  return q;
}

export function checkContext(input: unknown): PageContext | undefined {
  if (input === undefined || input === null) return undefined;
  const r = ContextSchema.safeParse(input);
  if (!r.success) throw new HelpError("bad-context", "the page context must be a page of the Foundry (\"#/…\") and, at most, the kind and id of one thing on it");
  return r.data;
}

function titleOf(question: string): string {
  const first = question.split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/\t/g, " ").trim().slice(0, TITLE_MAX).trim() || "Question";
}

// ---- reading ---------------------------------------------------------------------------------------

/** The conversations of one account that are not deleted, last changed first. Archived ones only when asked for. */
export function listConversations(owner: string, opts: StoreOptions & { archived?: boolean } = {}): Conversation[] {
  return current(read().conversations, clock(opts))
    .filter((c) => c.owner === owner && c.state !== "deleted" && (c.state === "archived") === (opts.archived === true))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map(copy);
}

/**
 * One conversation of the account. `not-found` for an unknown id and for a conversation of another account alike;
 * a deleted one comes back as its empty record.
 */
export function getConversation(owner: string, id: string, opts: StoreOptions = {}): Conversation {
  const c = current(read().conversations, clock(opts)).find((x) => x.id === id && x.owner === owner);
  if (!c) throw new HelpError("not-found", NOT_FOUND);
  return copy(c);
}

/** Reads the file and throws when it cannot be read: a broken file stops an account delete before anything changes. */
export function checkHelp(): void {
  read();
}

const NOT_FOUND = "no such conversation";
const DELETED = "this conversation was deleted";

// ---- changing --------------------------------------------------------------------------------------

/** Under the lock: changes one conversation of `owner` and saves the list as it is now (expired ones wiped). */
function change<T>(owner: string | undefined, id: string, opts: StoreOptions, fn: (c: Conversation, at: string) => { next: Conversation; value: T } | undefined): T | undefined {
  return withAuthLock(() => {
    const now = clock(opts);
    const list = current(read().conversations, now);
    const cur = list.find((c) => c.id === id && (owner === undefined || c.owner === owner));
    if (!cur) {
      if (owner !== undefined) throw new HelpError("not-found", NOT_FOUND);
      return undefined;
    }
    if (cur.state === "deleted") {
      if (owner !== undefined) throw new HelpError("deleted", DELETED);
      return undefined;
    }
    const r = fn(cur, now.toISOString());
    if (!r) return undefined;
    save(list.map((c) => (c === cur ? r.next : c)));
    return r.value;
  });
}

export interface NewQuestion {
  /** The conversation to go on with; without it a new one is made. */
  conversation?: string;
  question: unknown;
  context?: unknown;
}

export interface Turn {
  conversation: Conversation;
  /** The stored question and its reply, which is `pending` until the turn ends. */
  question: Message;
  reply: Message;
}

/**
 * Stores a question and the reply that is waited for. A new conversation without `conversation`; else the turn is
 * added to that one. Refused while the last reply is still waited for (`busy`), in a conversation that is completed
 * or archived (`bad-state`), and at the limits.
 */
export function addQuestion(owner: string, input: NewQuestion, opts: StoreOptions = {}): Turn {
  const text = checkQuestion(input.question);
  const context = checkContext(input.context);
  const messages = (at: string): [Message, Message] => {
    const q: Message = { id: randomUUID(), role: "user", at, status: "done", text, ...(context ? { context } : {}) };
    return [q, { id: randomUUID(), role: "assistant", at, status: "pending", text: "", replyTo: q.id, tries: 1, updated: at }];
  };
  if (input.conversation === undefined) {
    return withAuthLock(() => {
      const now = clock(opts);
      const at = now.toISOString();
      const list = current(read().conversations, now);
      if (list.filter((c) => c.owner === owner && c.state !== "deleted").length >= CONVERSATION_LIMIT) {
        throw new HelpError("limit", `you have ${CONVERSATION_LIMIT} conversations, the most an account can keep; delete one first`);
      }
      const [q, a] = messages(at);
      const c: Conversation = { id: randomUUID(), owner, title: titleOf(text), state: "active", messages: [q, a], created: at, updated: at };
      save([...list, c]);
      return copy({ conversation: c, question: q, reply: a });
    });
  }
  return change(owner, input.conversation, opts, (c, at) => {
    if (pendingOf(c)) throw new HelpError("busy", "Ask SCF is still answering your last question in this conversation; wait for it or stop it");
    if (c.state === "completed" || c.state === "archived") throw new HelpError("bad-state", `a conversation that is ${c.state} takes no new question`);
    if (c.messages.length + 2 > MESSAGE_LIMIT) throw new HelpError("limit", `a conversation can have at most ${MESSAGE_LIMIT} messages; start a new one`);
    const [q, a] = messages(at);
    const next: Conversation = { ...c, state: "active", messages: [...c.messages, q, a], updated: at };
    return { next, value: copy({ conversation: next, question: q, reply: a }) };
  })!;
}

/**
 * Starts the last turn again after it failed, was stopped or was interrupted. The same two messages are used: the
 * question stays, its reply is waited for again and counts one more try. Nothing is added.
 */
export function retryTurn(owner: string, id: string, opts: StoreOptions = {}): Turn {
  return change(owner, id, opts, (c, at) => {
    if (pendingOf(c)) throw new HelpError("busy", "Ask SCF is already answering this question");
    const last = c.messages[c.messages.length - 1];
    const question = c.messages[c.messages.length - 2];
    if ((c.state !== "failed" && c.state !== "cancelled") || !last || !question || last.role !== "assistant" || (last.status !== "failed" && last.status !== "cancelled")) {
      throw new HelpError("bad-state", "there is no failed or stopped answer to try again in this conversation");
    }
    const { failure: _failure, reply: _reply, ...rest } = last;
    const again: Message = { ...rest, status: "pending", text: "", tries: (last.tries ?? 1) + 1, updated: at };
    const next: Conversation = { ...c, state: "active", messages: [...c.messages.slice(0, -1), again], updated: at };
    return { next, value: copy({ conversation: next, question, reply: again }) };
  })!;
}

/** The reply a running turn writes to: its id and the try it belongs to. A result of an earlier try is never stored. */
export interface TurnRef {
  message: string;
  tries: number;
}

/** Changes the reply of `turn` while it is still waited for. Undefined (and nothing written) when it is not: answered, stopped, started again, deleted or gone. */
function endTurn(id: string, turn: TurnRef, opts: StoreOptions, fn: (m: Message, at: string) => { message: Message; state: ConversationState }): Conversation | undefined {
  return change(undefined, id, opts, (c, at) => {
    const m = pendingOf(c);
    if (!m || m.id !== turn.message || m.tries !== turn.tries) return undefined;
    const r = fn(m, at);
    const next: Conversation = { ...c, state: r.state, messages: [...c.messages.slice(0, -1), r.message], updated: at };
    return { next, value: copy(next) };
  });
}

/**
 * Stores the reply of a turn: the checked structure, and the text the server writes from it. A reply that comes
 * after the turn was stopped or the conversation was deleted is not stored.
 */
export function finishTurn(id: string, turn: TurnRef, reply: Reply, opts: StoreOptions = {}): Conversation | undefined {
  const checked = ReplySchema.parse(reply);
  return endTurn(id, turn, opts, (m, at) => ({ state: "active", message: { ...m, status: "done", reply: checked, text: displayText(checked).slice(0, TEXT_MAX), updated: at } }));
}

/** Marks a turn as failed, with the fixed sentence for its reason. */
export function failTurn(id: string, turn: TurnRef, failure: { code: FailureCode; retry: boolean }, opts: StoreOptions = {}): Conversation | undefined {
  return endTurn(id, turn, opts, (m, at) => ({ state: "failed", message: { ...m, status: "failed", failure: { code: failure.code, retry: failure.retry }, text: FAILURE_WORDS[failure.code], updated: at } }));
}

/** The owner stops the reply that is waited for. Returns the conversation and the id of the stopped reply. */
export function cancelTurn(owner: string, id: string, opts: StoreOptions = {}): { conversation: Conversation; message: string } {
  return change(owner, id, opts, (c, at) => {
    const m = pendingOf(c);
    if (!m) throw new HelpError("bad-state", "no answer is being written in this conversation");
    const next: Conversation = { ...c, state: "cancelled", messages: [...c.messages.slice(0, -1), { ...m, status: "cancelled", text: CANCELLED_WORDS, updated: at }], updated: at };
    return { next, value: { conversation: copy(next), message: m.id } };
  })!;
}

const notWhilePending = (c: Conversation) => {
  if (pendingOf(c)) throw new HelpError("busy", "Ask SCF is still answering in this conversation; wait for it or stop it first");
};

/** The owner closes a conversation: it stays readable and takes no new question. */
export function completeConversation(owner: string, id: string, opts: StoreOptions = {}): Conversation {
  return change(owner, id, opts, (c, at) => {
    notWhilePending(c);
    if (c.state === "completed") return { next: c, value: copy(c) };
    if (c.state === "archived") throw new HelpError("bad-state", "restore the conversation first");
    const next: Conversation = { ...c, state: "completed", updated: at };
    return { next, value: copy(next) };
  })!;
}

/** Moves a conversation out of the list. It keeps its content and remembers the state it had. */
export function archiveConversation(owner: string, id: string, opts: StoreOptions = {}): Conversation {
  return change(owner, id, opts, (c, at) => {
    notWhilePending(c);
    if (c.state === "archived") return { next: c, value: copy(c) };
    const next: Conversation = { ...c, state: "archived", stateBefore: c.state as (typeof BEFORE_ARCHIVE)[number], updated: at };
    return { next, value: copy(next) };
  })!;
}

/** Takes a conversation out of the archive: it gets the state it had. */
export function restoreConversation(owner: string, id: string, opts: StoreOptions = {}): Conversation {
  return change(owner, id, opts, (c, at) => {
    if (c.state !== "archived" || c.stateBefore === undefined) throw new HelpError("bad-state", "only an archived conversation can be restored");
    const { stateBefore, ...rest } = c;
    const next: Conversation = { ...rest, state: stateBefore, updated: at };
    return { next, value: copy(next) };
  })!;
}

/**
 * Deletes a conversation of the account: its title, its messages (with their page context, sources and drafts) are
 * removed at once and cannot be brought back. `pending` is the reply that was still waited for, so its turn can be stopped.
 */
export function deleteConversation(owner: string, id: string, opts: StoreOptions = {}): { conversation: Conversation; pending?: string } {
  return change(owner, id, opts, (c, at) => {
    const next = wiped(c, at, "owner");
    const pending = pendingOf(c)?.id;
    return { next, value: { conversation: copy(next), ...(pending !== undefined ? { pending } : {}) } };
  })!;
}

// ---- the server's own housekeeping -----------------------------------------------------------------

/**
 * Marks every reply that is still waited for as failed (`interrupted`), except the ones in `alive`. The server calls
 * it at its start, when no turn can be running: such a turn can then be tried again.
 */
export function settleInterrupted(alive: ReadonlySet<string> = new Set(), opts: StoreOptions = {}): number {
  return withAuthLock(() => {
    const now = clock(opts);
    const at = now.toISOString();
    const list = current(read().conversations, now);
    let n = 0;
    const next = list.map((c) => {
      const m = pendingOf(c);
      if (!m || alive.has(m.id)) return c;
      n++;
      const failed: Message = { ...m, status: "failed", failure: { code: "interrupted", retry: true }, text: FAILURE_WORDS.interrupted, updated: at };
      return { ...c, state: "failed" as const, messages: [...c.messages.slice(0, -1), failed], updated: at };
    });
    if (n > 0) save(next);
    return n;
  });
}

/** Applies the retention policy to the file: wipes expired conversations and removes old deleted records. Returns how many changed. */
export function sweepHelp(opts: StoreOptions = {}): { expired: number; removed: number } {
  return withAuthLock(() => {
    const before = read().conversations;
    const after = current(before, clock(opts));
    const expired = after.filter((c) => c.state === "deleted" && before.find((b) => b.id === c.id)?.state !== "deleted").length;
    const removed = before.length - after.length;
    if (expired > 0 || removed > 0) save(after);
    return { expired, removed };
  });
}

/** Removes every conversation of an account, with nothing left, when the account is deleted. Only inside withAuthLock. */
export function removeHelpLocked(owner: string): number {
  if (!authLockHeld()) throw new Error("removeHelpLocked must run inside withAuthLock");
  const file = read();
  const mine = file.conversations.filter((c) => c.owner === owner);
  if (!mine.length) return 0;
  save(file.conversations.filter((c) => c.owner !== owner));
  return mine.length;
}
