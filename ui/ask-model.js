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

/** The sentence of the server for a paused Ask SCF (REFUSAL_WORDS.paused in src/help/turn.ts; a test keeps them equal). */
export const PAUSED_WORDS = "Ask SCF is paused by an administrator for now. You can still read, export and delete your conversations.";

/** True when an error of a send or a retry is the answer of a paused Ask SCF, and not another 503 (switched off, secret check). */
export const isPausedError = (e) => Number(e?.status) === 503 && String(e?.message ?? "").trim() === PAUSED_WORDS;

/**
 * Whether a question can be sent now, and what is sent: `{ ok: true, to, body }` (`to`: the conversation it goes to,
 * null for a new one) or `{ ok: false, reason }`. Nothing is sent while a request is on its way (`busy`) or while a
 * reply is being written, so a second Send never starts a second turn.
 */
export function sendPlan({ draft, busy = false, conversation = null, where = null, attach = true, paused = false } = {}) {
  if (paused) return { ok: false, reason: PAUSED_WORDS };
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
export function entryOf(message, { elapsedMs = 0, role = "user", planDone = () => [], outcomes = () => [] } = {}) {
  const text = typeof message?.text === "string" ? message.text : "";
  if (message?.role === "user") return { id: message.id, kind: "question", who: "You", text, note: "" };
  const note = triesNote(message);
  if (message?.status === "pending") return { id: message?.id, kind: "waiting", who: "Ask SCF", text: waitNote(elapsedMs).text, note };
  if (message?.status === "failed") return { id: message.id, kind: message.failure?.retry === false ? "limit" : "failed", who: "Ask SCF", text: text || "Ask SCF could not answer.", note };
  if (message?.status === "cancelled") return { id: message.id, kind: "stopped", who: "Ask SCF", text: text || "You stopped this answer.", note };
  // a reply with its checked parts is laid out by them; the text is what is left when there are none
  const layout = replyLayout(message?.reply, role, planDone(message?.id));
  if (layout) layout.outcomes = outcomesFor(message, outcomes(message?.id));
  const vote = message?.feedback?.vote === "helpful" || message?.feedback?.vote === "not-helpful" ? message.feedback.vote : null;
  const reasons = vote === "not-helpful" ? list(message.feedback.reasons).filter((r) => r in REASON_WORDS) : [];
  return { id: message?.id, kind: "answer", who: "Ask SCF", text: layout ? "" : text, note, rateable: true, feedback: { vote, reasons }, ...(layout ? { layout } : {}) };
}

// ---- rating an answer -------------------------------------------------------------------------------

/** The reasons for a vote of not-helpful, with their words (FEEDBACK_REASONS in src/help/store.ts; a test keeps the keys equal). */
export const REASON_WORDS = {
  incorrect: "It was wrong",
  outdated: "It was out of date",
  "not-my-question": "It did not answer my question",
  unclear: "It was unclear",
  "missing-sources": "It named no source I could check",
  unsafe: "It was unsafe or should not have been said",
};

/**
 * The body of a rating. Pressing the vote that is already set takes it back (`vote: null`). Reasons go only with
 * not-helpful, and only the known ones, each once. No free text exists.
 */
export function feedbackPlan(message, vote, reasons = [], current = null) {
  const next = vote === "helpful" || vote === "not-helpful" ? vote : null;
  const toggled = next !== null && next === current ? null : next;
  const kept = toggled === "not-helpful" ? [...new Set(list(reasons))].filter((r) => r in REASON_WORDS) : [];
  return { message, vote: toggled, reasons: kept };
}

/** What the status line says after a rating was saved. */
export function voteNote(vote) {
  return vote === "helpful" ? "Saved: this answer helped." : vote === "not-helpful" ? "Saved: this answer did not help." : "Your vote was taken back.";
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
export function controlsFor(conversation, { busy = false, paused = false } = {}) {
  const none = { stop: false, retry: false, archive: false, restore: false, remove: false };
  if (!conversation || conversation.state === "deleted") return none;
  const last = lastOf(conversation);
  const waiting = isWaiting(conversation);
  const archived = conversation.state === "archived";
  const ended = !archived && !!last && last.role === "assistant" && ((last.status === "failed" && last.failure?.retry !== false) || last.status === "cancelled");
  return {
    stop: waiting && !busy,
    // a paused Ask SCF starts no turn, so there is nothing to try again
    retry: ended && !busy && !paused,
    // the server archives no conversation whose reply is still being written
    archive: !archived && !waiting && !busy,
    restore: archived && !busy,
    remove: !busy,
  };
}

/**
 * Whether "This solved my problem" is offered: an open conversation whose last message is a finished answer. It closes
 * the conversation and says so to the server; closing in any other way (by the API) is not counted as solved.
 */
export function solveOffered(conversation, { busy = false } = {}) {
  const last = lastOf(conversation);
  return !busy && conversation?.state === "active" && last?.role === "assistant" && last.status === "done";
}

/** What each control does, said before it is pressed. */
export const CONSEQUENCES = {
  stop: "Stops the answer that is being written. Your question stays.",
  retry: "Asks the same question again. It counts as one of your questions of today.",
  archive: "Moves this conversation out of your list. You can take it back from the archived ones.",
  restore: "Takes this conversation back into your list.",
  remove: "Removes the questions and answers of this conversation at once. They cannot be brought back.",
  solved: "Closes this conversation and tells the Foundry that the answers solved your problem. Only a number is counted; you can still read it.",
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

// ---- a reply by its parts: what is known, how sure, where it is from, and what could be done --------

/** The fixed sentences for how sure a reply is (CERTAINTY_WORDS in src/help/contract.ts; a test keeps them equal). */
export const CERTAINTY_WORDS = {
  confirmed: "This rests on the sources listed below.",
  likely: "This is likely, but the sources below do not fully confirm it.",
  unverified: "Ask SCF could not check this against the documentation or the current state. Treat it as a guess.",
};

/** The kind of source each kind of question needs (QUESTION_RULES in src/help/contract.ts). */
export const NEEDS = { "product-help": "doc", status: "state", troubleshooting: "state", "guided-resolution": "state" };

/**
 * A link to a page of this interface, or null: `to` must be an address of the form the Foundry uses, without a
 * query, that resolves for the role to itself (no fallback, no alias). `fixed`: only a page without an id in its
 * address, as a reply may link to. Anything else (another site, a script, a page of another role) is no link.
 */
export function pageLink(role, to, { fixed = false } = {}) {
  if (typeof to !== "string" || pageOf(to) !== to) return null;
  const r = resolve(role, to);
  if (r.redirected || r.hash !== to) return null;
  if (fixed && r.page.path !== to) return null;
  return { href: to, title: String(r.title) };
}

const str = (v) => (typeof v === "string" ? v : "");
const list = (v) => (Array.isArray(v) ? v : []);

/** The sources of a reply as the drawer lists them. A source links to its page only when that page is one of this role. */
export function sourcesOf(reply, role) {
  return list(reply?.evidence).filter((e) => e && str(e.title)).map((e) => {
    const at = Date.parse(str(e.observedAt));
    const link = pageLink(role, str(e.ref));
    return { id: str(e.id), kind: e.kind === "state" ? "state" : "doc", what: e.kind === "state" ? "Current state" : "Documentation", title: str(e.title), ref: str(e.ref), href: link?.href ?? null, observedAt: Number.isFinite(at) ? new Date(at).toISOString() : null };
  });
}

/** True when two sources speak about the same place and do not say the same: the reply cannot rest on both. */
export function sourcesDisagree(sources) {
  const seen = new Map();
  for (const s of sources) {
    if (!s.ref) continue;
    const key = `${s.kind}|${s.ref}`;
    if (seen.has(key) && seen.get(key) !== s.title) return true;
    if (!seen.has(key)) seen.set(key, s.title);
  }
  return false;
}

const TRUST = {
  confirmed: { glyph: "✓", label: "Checked against its sources" },
  low: { glyph: "≈", label: "Not fully confirmed" },
  missing: { glyph: "?", label: "Not checked: no source" },
  conflict: { glyph: "!", label: "The sources do not agree" },
  limit: { glyph: "–", label: "Not answered" },
};

/**
 * How far a reply can be trusted, as one of five states that look different: confirmed, low (likely, or unsure with
 * sources), missing (no source of the kind the question needs), conflict (two sources differ about one place) and
 * limit (a request Ask SCF does not serve). The sentence is a fixed one; a model never writes it.
 */
export function trustOf(reply, sources) {
  const make = (state, text) => ({ state, ...TRUST[state], text });
  if (reply?.limit) return make("limit", "Ask SCF does not do this. What you can do instead is below.");
  if (sourcesDisagree(sources)) return make("conflict", "Two sources below say different things about the same place. Open them and look yourself before you act.");
  const fits = sources.some((s) => s.kind === (NEEDS[reply?.type] ?? "doc"));
  if (!fits) return make("missing", reply?.type && NEEDS[reply.type] === "state" ? `No source shows the current state of your work. ${CERTAINTY_WORDS.unverified}` : CERTAINTY_WORDS.unverified);
  if (reply?.certainty === "confirmed") return make("confirmed", CERTAINTY_WORDS.confirmed);
  if (reply?.certainty === "likely") return make("low", CERTAINTY_WORDS.likely);
  return make("low", "Ask SCF has the sources below but is not sure of this. Treat it as a guess.");
}

/** What a reply takes for granted, in fixed sentences made from its sources and its state. */
export function assumptionsOf(reply, sources, trust) {
  if (trust.state === "limit") return [];
  const out = [];
  if (sources.some((s) => s.kind === "state")) out.push("The current state was read at the times shown. It can have changed since.");
  if (sources.some((s) => s.kind === "doc")) out.push("The documentation of this Foundry was used as it is installed here.");
  if (trust.state === "missing") out.push("Nothing was checked against the documentation or the current state.");
  if (trust.state === "low") out.push("The sources do not fully confirm the answer.");
  if (trust.state === "conflict") out.push("The answer may rest on the wrong one of two sources.");
  out.push("Ask SCF sees only what your own account can see.");
  return out;
}

export const EFFECT_WORDS = { "read-only": "Read-only", "changes-state": "Changes state" };

/**
 * The proposals of a reply as cards, each with its effect: `read-only` (nothing happens by itself) or
 * `changes-state`. A card never runs anything. A page is a link only when `pageLink` takes it; an address it does
 * not take stays text. An action is shown as a suggestion: there is no control that does it.
 */
export function cardsOf(reply, role) {
  const cards = [];
  for (const r of list(reply?.recommendations)) if (str(r)) cards.push({ kind: "recommendation", effect: "read-only", title: reply?.limit ? "What you can do" : "What you could do", text: str(r), note: "You decide and you do it. Nothing happens by itself." });
  for (const l of list(reply?.links)) {
    const to = str(l?.to);
    const link = pageLink(role, to, { fixed: true });
    if (link) cards.push({ kind: "navigation", effect: "read-only", title: "A page you can open", text: "", link, note: "Opening the page changes nothing." });
    else if (to || str(l?.label)) cards.push({ kind: "navigation", effect: "read-only", title: "An address that is not a page here", text: [str(l?.label), to].filter(Boolean).join(": "), note: "This is not a page of the Foundry for your account. It is shown as text and cannot be opened here." });
  }
  for (const d of list(reply?.drafts)) if (str(d?.text)) cards.push({ kind: "draft", effect: "read-only", title: `Draft: ${str(d.title) || "Draft"}`, text: str(d.text), pre: true, note: "This text is not sent, saved or posted. Copy it yourself if you want to use it." });
  list(reply?.actions).forEach((a, index) => {
    if (!str(a?.title)) return;
    const bound = !reply?.limit && Object.hasOwn(ACTION_TITLES, a.id) && a.about?.kind === "run" && str(a.about.id);
    cards.push({ kind: "action", effect: "changes-state", title: `Suggested change: ${str(a.title)}`, text: str(a.impact),
      ...(bound ? { act: index, note: ACT_NOTE } : { note: "Ask SCF does not do this. Nothing happens here. If you want it, do it yourself on the page where it belongs." }) });
  });
  return cards;
}

/** What each offer of a reply does (OFFERS in src/help/actions.ts; a test keeps them equal). */
export const OFFER_EFFECTS = { "open-run": "navigation", "open-repository": "navigation", "open-turn-item": "navigation" };

const OFFER_NOTE = "Opens a page. The server checks again that you may see it.";

/** The offers of a reply as cards with a button. `index` is the place in `reply.offers`: it is what a click sends. */
export function offersOf(reply) {
  if (!reply || reply.limit) return [];
  return list(reply.offers).flatMap((o, index) => {
    if (!o || !Object.hasOwn(OFFER_EFFECTS, o.type) || !str(o.title)) return [];
    const source = list(reply.evidence).find((e) => e?.id === o.evidence);
    return [{ index, type: o.type, effect: OFFER_EFFECTS[o.type], title: str(o.title), text: str(source?.title), note: OFFER_NOTE }];
  });
}

/** The page an offer opens, or null when it is not a page of this role. The address comes from the server and is checked here again. */
export const offerTarget = (role, to) => pageLink(role, to);

/** A failed offer in plain words; the 403 and the 404 each have their own fixed sentence. */
export function explainOfferError(e) {
  const status = Number(e?.status) || 0;
  if (status === 403) return "You are not allowed to open this now. Your permissions were checked again when you clicked.";
  if (status === 404 || status === 410) return "This is not there any more, or you can no longer see it.";
  return explainAskError(e);
}

/**
 * A checked reply as the drawer lays it out: the short answer first, how sure it is, the proposals as cards, and the
 * sources and assumptions to unfold. Null when there is no reply to lay out. `basis`: the sources of the kind the
 * question needs, shown next to the answer, so a statement about the current state can be traced to what was read.
 */
export function replyLayout(reply, role = "user", done = []) {
  if (!reply || typeof reply !== "object" || !str(reply.summary)) return null;
  const sources = reply.limit ? [] : sourcesOf(reply, role);
  const trust = trustOf(reply, sources);
  const needs = NEEDS[reply.type] ?? "doc";
  return {
    summary: str(reply.summary),
    explanation: str(reply.explanation),
    trust,
    basis: { needs, sources: sources.filter((s) => s.kind === needs) },
    cards: cardsOf(reply, role),
    offers: offersOf(reply),
    plan: planOf(reply, role, done),
    sources,
    assumptions: assumptionsOf(reply, sources, trust),
  };
}

// ---- a plan: ordered steps that the person follows; nothing in it runs ------------------------------

/** The labels of the six kinds of step (STEP_RULES in src/help/plan.ts; a test keeps them equal). */
export const STEP_WORDS = {
  explanation: "Explanation",
  navigation: "Open a page",
  check: "Read-only check",
  input: "Your input",
  reversible: "Reversible change",
  "high-impact": "High-impact change",
};

/** The one sentence under a step the person marked: Ask SCF never checks the result of a step. */
export const stepNote = (done) => (done ? "You marked this. Ask SCF has not checked the result." : "");

/** Where this tab keeps which steps of a reply were marked. Only indices, never a text. */
export const planKey = (messageId) => `scf-ask-plan-${String(messageId ?? "").replace(/[^A-Za-z0-9-]/g, "")}`;

/**
 * The plan of a reply as steps for the drawer, or null when there is none (or the reply is a limit). `done`: the
 * indices the person marked in this tab. The first step not marked is the current one. A step never says that it
 * worked: `note` is only what the person marked.
 */
export function planOf(reply, role = "user", done = []) {
  const steps = list(reply?.plan);
  if (reply?.limit || !steps.length) return null;
  const marked = new Set(list(done).filter((n) => Number.isInteger(n)));
  const current = steps.findIndex((_, i) => !marked.has(i));
  const rows = steps.map((s, i) => {
    const kind = Object.hasOwn(STEP_WORDS, s?.kind) ? s.kind : "explanation";
    const wouldBe = s?.wouldBe === "high-impact" || s?.wouldBe === "reversible" ? s.wouldBe : "";
    return {
      n: i + 1,
      kind,
      label: STEP_WORDS[kind],
      danger: kind === "high-impact" || wouldBe === "high-impact",
      title: str(s?.title),
      instructions: str(s?.instructions),
      link: pageLink(role, str(s?.to), { fixed: true }),
      expected: str(s?.expected),
      failure: str(s?.failure),
      fallback: str(s?.fallback),
      wouldBe,
      wouldBeLabel: wouldBe === "high-impact" ? "Would be a high-impact change" : wouldBe ? "Would be a change" : "",
      proposal: str(s?.proposal),
      done: marked.has(i),
      current: i === current,
      note: stepNote(marked.has(i)),
    };
  });
  const high = rows.filter((r) => r.danger).length;
  return {
    steps: rows,
    highImpact: high,
    header: `${rows.length === 1 ? "1 step" : `${rows.length} steps`}${high ? `, ${high === 1 ? "1 is a high-impact change" : `${high} are high-impact changes`}` : ""}. Nothing is done until you do it.`,
    manual: true,
  };
}

// ---- reviewing a change: the preview, the confirmation and what was read back ------------------------

/** The title of each action (ACTIONS in src/help/contract.ts; a test keeps them equal). */
export const ACTION_TITLES = { "resume-run": "Resume the run", "cancel-run": "Cancel the run" };
export const ACT_NOTE = "Nothing happens until you review the change and confirm it.";
const UNSAID = "The server did not say.";
const LEVEL = { high: "High impact", reversible: "Reversible", "read-only": "Read-only" };
const said = (v) => (typeof v === "string" && v.trim() ? v : UNSAID);

/** The six rows of the review dialog, from the preview the server made. A missing field says so. */
export function previewRows(preview) {
  const p = preview && typeof preview === "object" ? preview : {};
  const title = str(p.title) || ACTION_TITLES[p.action] || "";
  const run = str(p.about?.id);
  const action = title ? (run ? `${title} (run ${run})` : title) : UNSAID;
  return [
    { label: "Action", text: action },
    { label: "Now", text: said(p.now) },
    { label: "What changes", text: said(p.changes) },
    { label: "Impact", text: `${LEVEL[p.impactLevel] ?? "Impact"}: ${said(p.impact)}` },
    { label: "Undo", text: `${p.undoable === true ? "Can be undone." : "Cannot be undone."} ${said(p.undo)}` },
    { label: "Who may do this", text: said(p.who) },
  ];
}
export const previewDanger = (p) => p?.impactLevel === "high";
/** The words of the dialog. */
export const REVIEW_TEXT = {
  title: "Review the change",
  intro: "This is what the server says the change would do. Nothing has changed yet.",
  note: "You can confirm this once, within 5 minutes. The server checks everything again when you confirm.",
  confirm: "Confirm the change",
};
export const NOT_STORED_NOTE = "The result could not be saved with the conversation. It is shown here until you leave the conversation.";

/** The word and the pill of each result (OUTCOME_RESULTS in src/help/outcome.ts; a test keeps the keys equal). */
export const RESULT_WORDS = {
  done: ["Done", "sem-success"], dequeued: ["Done", "sem-success"], stopped: ["Done", "sem-success"],
  queued: ["Queued", "sem-info"],
  stopping: ["Partly done", "sem-warning"], unconfirmed: ["Partly done", "sem-warning"], missing: ["Partly done", "sem-warning"],
  "start-failed": ["Not done", "sem-danger"], "not-done": ["Not done", "sem-danger"],
};

/** One outcome the server read back, ready to draw; null when it has no words. An unknown result counts as partly done. */
export function outcomeOf(o) {
  if (!o || typeof o !== "object" || typeof o.words !== "string") return null;
  const [word, pill] = Object.hasOwn(RESULT_WORDS, o.result) ? RESULT_WORDS[o.result] : ["Partly done", "sem-warning"];
  const action = str(o.action);
  return { action, title: ACTION_TITLES[action] ?? "A change", run: str(o.about?.id), result: str(o.result), word, pill, words: o.words, recovery: str(o.recovery), at: str(o.at) };
}

/** The stored outcomes of a message and the ones this tab holds, once each, oldest first, the newest 10. */
export function outcomesFor(message, local = []) {
  const seen = new Set();
  const all = [];
  for (const o of [...list(message?.outcomes), ...list(local)]) {
    if (!o || typeof o !== "object") continue;
    const key = [o.action, o.about?.id, o.result, o.at].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(o);
  }
  all.sort((a, b) => str(a.at).localeCompare(str(b.at)));
  return all.slice(-10).map(outcomeOf).filter(Boolean);
}

/** A failed prepare or confirm in plain words. */
export function explainActionError(e) {
  if (e?.preview) return e.message;
  const status = Number(e?.status) || 0;
  if (status === 403) return "You may not do this now. Your permissions were checked again.";
  if (status === 404) return "This run or this answer is not there any more, or you can no longer change it.";
  if (status === 410) return "This conversation was deleted.";
  return explainAskError(e);
}
