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

/** What the drawer shows for one message: `kind` is question, waiting, answer, failed or stopped. Text stays text. */
export function entryOf(message) {
  const text = typeof message?.text === "string" ? message.text : "";
  if (message?.role === "user") return { id: message.id, kind: "question", who: "You", text };
  if (message?.status === "pending") return { id: message?.id, kind: "waiting", who: "Ask SCF", text: "Ask SCF is working on your answer." };
  if (message?.status === "failed") return { id: message.id, kind: "failed", who: "Ask SCF", text: text || "Ask SCF could not answer." };
  if (message?.status === "cancelled") return { id: message.id, kind: "stopped", who: "Ask SCF", text: text || "You stopped this answer." };
  return { id: message?.id, kind: "answer", who: "Ask SCF", text };
}

/** The messages of a conversation as the drawer shows them, oldest first. */
export const threadOf = (conversation) => (conversation?.messages ?? []).map(entryOf);

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
