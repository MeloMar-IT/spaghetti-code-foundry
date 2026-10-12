import { resolve, splitHash } from "./ia.js";

// Ask SCF, the help drawer: what it decides, without a page. Pure functions only (no document, no fetch, no timer),
// so every rule here is tested as it is. The drawer itself is ui/ask.js, its nodes are ui/ask-view.js.

/** The most characters the ask route takes in one question (QUESTION_MAX in src/help/store.ts). */
export const QUESTION_MAX = 4000;

// The form the ask route takes for a page (ContextSchema in src/help/store.ts): the address without its query.
const PAGE = /^#\/[A-Za-z0-9._~%:/-]*$/;

/** The page of an address as the ask route takes it, or null when the address is not one it takes. */
export function pageOf(hash) {
  const { path } = splitHash(hash);
  return path.length >= 2 && path.length <= 200 && PAGE.test(path) ? path : null;
}

/**
 * Where the person is, for a role: the page of the interface (`id`, `area`, `title`) and the address the ask route
 * takes (`page`, null when the address is not a page of this role).
 */
export function whereOf(role, hash) {
  const to = resolve(role, hash);
  return { id: to.page.id, area: to.page.area, title: String(to.title), page: to.redirected ? null : pageOf(to.hash) };
}

/**
 * What goes with a question, and the sentence that says so before Send. Only the address of the page: no id of a
 * thing on it and no content of the page. `attach` false, or a page the route does not take: nothing is sent.
 */
export function contextFor(where, attach) {
  if (!attach || !where?.page) return { context: undefined, text: "Nothing about this page is sent with your question." };
  return { context: { page: where.page }, text: `Sent with your question: the page you are on (${where.title}, ${where.page}). Nothing else of the page is sent.` };
}

const GENERAL = ["What can Ask SCF help me with?", "Where do I start work on an issue?"];
const BY_PAGE = {
  home: ["What does Home show me?", "What should I look at first?"],
  runs: ["What do the statuses of a run mean?", "Why can a run wait?"],
  run: ["How do I read the steps of a run?", "What can I do when a run failed?"],
  start: ["How do I start work on an issue?", "Which flow fits my task?"],
  repos: ["How do I connect a repository?", "What does a watcher do?"],
  repo: ["What do the settings of a repository mean?", "What does a watcher do?"],
  board: ["How do I read the Board?", "Why does an issue wait for another one?"],
  problems: ["What is a finding of the monitor?", "What happens when I mute a finding?"],
  problem: ["What is a finding of the monitor?", "What happens when I mute a finding?"],
};
const BY_AREA = {
  work: ["How does Refinement work?", "When is a story ready to build?"],
  build: ["What is a flow?", "How do I add a step to a flow?"],
  administration: ["What does this page set?", "Where do I set limits for runs?"],
  repositories: ["How do I connect a repository?", "What does a watcher do?"],
};

/** The questions offered for the page a person is on. A suggestion only fills the question box; the person sends it. */
export function suggestionsFor(where) {
  return [...(BY_PAGE[where?.id] ?? BY_AREA[where?.area] ?? []), ...GENERAL].slice(0, 4);
}

/** The last message of a conversation, or null. */
export const lastOf = (conversation) => conversation?.messages?.[conversation.messages.length - 1] ?? null;

/** True while the reply to the last question is still being written. */
export function isWaiting(conversation) {
  const last = lastOf(conversation);
  return !!last && last.role === "assistant" && last.status === "pending";
}

/**
 * Whether a question can be sent now, and what is sent: `{ ok: true, to, body }` (`to`: the conversation it goes to,
 * null for a new one) or `{ ok: false, reason }`. Nothing is sent while a request is on its way (`busy`) or while a
 * reply is being written, so a second Send never starts a second turn.
 */
export function sendPlan({ draft, busy = false, conversation = null, where = null, attach = true } = {}) {
  if (busy) return { ok: false, reason: "Your question is being sent." };
  if (isWaiting(conversation)) return { ok: false, reason: "Ask SCF is still answering. Wait for the answer first." };
  const question = String(draft ?? "").replace(/\r\n/g, "\n").trim();
  if (!question) return { ok: false, reason: "Type your question first." };
  if (question.length > QUESTION_MAX) return { ok: false, reason: `A question can have at most ${QUESTION_MAX} characters. Yours has ${question.length}.` };
  const { context } = contextFor(where, attach);
  // a closed conversation takes no new question: the next one starts a new conversation
  const open = conversation && conversation.state !== "completed" && conversation.state !== "archived" && conversation.state !== "deleted";
  return { ok: true, to: open ? conversation.id : null, body: context ? { question, context } : { question } };
}

/** How long to wait before the conversation is read again, in ms; null: do not read (closed drawer, no reply waited for). */
export function pollDelay({ open, conversation, polls = 0 } = {}) {
  if (!open || !isWaiting(conversation)) return null;
  return polls < 10 ? 1500 : 4000;
}

/** How many reads in a row may fail before the drawer stops asking and says so. */
export const MAX_READ_FAILURES = 4;

/** After this long the wait counts as slow, in ms: the drawer says so once and points at Stop. */
export const SLOW_AFTER_MS = 20_000;

/** What the drawer says while a reply is written, by how long it has waited (ms). */
export function waitNote(elapsedMs = 0) {
  const slow = Number(elapsedMs) >= SLOW_AFTER_MS;
  return { slow, text: slow ? "Ask SCF is still working. This takes longer than usual. You can wait, or stop the answer." : "Ask SCF is working on your answer." };
}

/** The line under a reply that was started more than once; "" for the first try. The earlier tries stay counted. */
export function triesNote(message) {
  const n = Number(message?.tries) || 1;
  if (message?.role !== "assistant" || n < 2) return "";
  return n === 2 ? "This is the second try. The first try gave no answer." : `This is try ${n}. The ${n - 1} tries before it gave no answer.`;
}

/**
 * What the drawer shows for one message: `kind` is question, waiting, answer, failed, limit or stopped. Text stays
 * text. `limit`: a failure that trying again now cannot solve (a limit, a budget, the setup).
 */
export function entryOf(message, { elapsedMs = 0 } = {}) {
  const text = typeof message?.text === "string" ? message.text : "";
  if (message?.role === "user") return { id: message.id, kind: "question", who: "You", text, note: "" };
  const note = triesNote(message);
  if (message?.status === "pending") return { id: message?.id, kind: "waiting", who: "Ask SCF", text: waitNote(elapsedMs).text, note };
  if (message?.status === "failed") return { id: message.id, kind: message.failure?.retry === false ? "limit" : "failed", who: "Ask SCF", text: text || "Ask SCF could not answer.", note };
  if (message?.status === "cancelled") return { id: message.id, kind: "stopped", who: "Ask SCF", text: text || "You stopped this answer.", note };
  return { id: message?.id, kind: "answer", who: "Ask SCF", text, note };
}

/** The messages of a conversation as the drawer shows them, oldest first. */
export const threadOf = (conversation, opts) => (conversation?.messages ?? []).map((m) => entryOf(m, opts));

/**
 * What the status line says after the conversation changed from `before` to `after`; "" for nothing new. A screen
 * reader hears it once: the start of the wait, and then the result.
 */
export function announce(before, after) {
  const was = lastOf(before);
  const now = lastOf(after);
  if (!now || now.role !== "assistant") return "";
  if (was && was.id === now.id && was.status === now.status && was.tries === now.tries) return "";
  if (now.status === "pending") return "Ask SCF is working on your answer.";
  if (now.status === "done") return "Ask SCF answered. The answer is below your question.";
  return entryOf(now).text;
}

/** A failed call in plain words. The sentences of the server for a refused question are fixed and safe to show. */
export function explainAskError(e) {
  const status = Number(e?.status) || 0;
  if (!status) return "The Foundry could not be reached. Check your connection, then try again.";
  if (status === 401) return "Your session has ended. Sign in again.";
  if (status === 404 || status === 410) return "This conversation is gone. Ask your question in a new one.";
  const text = String(e?.message ?? "").trim();
  if ([400, 409, 429, 503].includes(status) && text) return /[.!?]$/.test(text) ? text[0].toUpperCase() + text.slice(1) : `${text[0].toUpperCase()}${text.slice(1)}.`;
  return "Ask SCF is not working now. Try again later.";
}

/** Where Tab goes in the open drawer is `trapTarget` of ui/dom.js; this says which key closes it and when. */
export function closesOn(event, { dialogOnTop = false } = {}) {
  return event?.key === "Escape" && !dialogOnTop;
}

// ---- conversations: what can be done with one, the list, and coming back after a reload ------------

/**
 * The controls of the open conversation: which are offered now. One call at a time (`busy`), so a second press of
 * Try again or Stop sends nothing. Try again is offered only where it can help; it uses the same question and the
 * same reply, so nothing is shown twice.
 */
export function controlsFor(conversation, { busy = false } = {}) {
  const none = { stop: false, retry: false, archive: false, restore: false, remove: false };
  if (!conversation || conversation.state === "deleted") return none;
  const last = lastOf(conversation);
  const waiting = isWaiting(conversation);
  const archived = conversation.state === "archived";
  const ended = !archived && !!last && last.role === "assistant" && ((last.status === "failed" && last.failure?.retry !== false) || last.status === "cancelled");
  return {
    stop: waiting && !busy,
    retry: ended && !busy,
    // the server archives no conversation whose reply is still being written
    archive: !archived && !waiting && !busy,
    restore: archived && !busy,
    remove: !busy,
  };
}

/** What each control does, said before it is pressed. */
export const CONSEQUENCES = {
  stop: "Stops the answer that is being written. Your question stays.",
  retry: "Asks the same question again. It counts as one of your questions of today.",
  archive: "Moves this conversation out of your list. You can take it back from the archived ones.",
  restore: "Takes this conversation back into your list.",
  remove: "Removes the questions and answers of this conversation at once. They cannot be brought back.",
  fresh: "Starts an empty conversation. This one stays in your list.",
};

const STATE_WORDS = { active: "Open", completed: "Closed", failed: "No answer", cancelled: "Stopped", archived: "Archived" };

/** The state of a conversation in one or two words. `waiting` (from the list) wins: a reply is being written. */
export function stateWord(row) {
  if (row?.waiting || isWaiting(row)) return "Answering";
  return STATE_WORDS[row?.state] ?? "Open";
}

/** The rows of the list of conversations, as the server sent them (last changed first); anything without an id is left out. */
export function historyRows(list) {
  return (Array.isArray(list) ? list : []).filter((c) => typeof c?.id === "string" && c.id && c.state !== "deleted")
    .map((c) => ({ id: c.id, title: String(c.title ?? "").trim() || "Question", word: stateWord(c), updated: c.updated }));
}

const ID = /^[0-9a-f-]{8,64}$/i;

/**
 * The conversation to show after the page was loaded again: the one that was open (`remembered`, an id kept in this
 * tab) when the list still has it, else the one whose reply is being written, else none. Only an id that the server
 * listed for this account is ever read.
 */
export function restorePick(list, remembered) {
  const rows = historyRows(list);
  if (typeof remembered === "string" && ID.test(remembered) && rows.some((r) => r.id === remembered)) return remembered;
  return (Array.isArray(list) ? list : []).find((c) => c?.waiting === true && typeof c.id === "string")?.id ?? null;
}

/** A counter that tells a late answer from a current one: `ticket()` is taken before a call, and is true after it only when nothing was switched meanwhile. */
export function staleGuard() {
  let gen = 0;
  return { next: () => ++gen, ticket: () => { const mine = gen; return () => mine === gen; } };
}
