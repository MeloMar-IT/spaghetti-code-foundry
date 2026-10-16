import { api as realApi } from "./api.js";
import { confirmDialog, mount, tabStops, trapTarget } from "./dom.js";
import {
  CONSEQUENCES, MAX_READ_FAILURES, PAUSED_WORDS, QUESTION_MAX, REASON_WORDS, announce, closesOn, contextFor, controlsFor, explainAskError, feedbackPlan, historyRows, isPausedError, isWaiting, lastOf,
  pollDelay, restorePick, sendPlan, solveOffered, staleGuard, suggestionsFor, threadOf, voteNote, waitNote, whereOf,
} from "./ask-model.js";
import { actionNodes, askButton, askFrame, entryNode, historyNodes, rateNodes, suggestionNodes } from "./ask-view.js";

// Ask SCF: the help drawer of both displays. One implementation; ui/app.js and ui/user/app.js only call initAsk.
// The drawer lies over the page and never draws the page again, so what is typed or open there stays as it is.
// Opening it sends nothing: a question, and the page it is asked on, go out only when the person presses Send.

// What lies behind the open drawer: the header, the skip button and the page.
const BEHIND = ["top", "skip", "content"];
/** Where this tab keeps the id of the open conversation, so a reload shows it again. Only the id, never a text. */
export const REMEMBER_KEY = "scf-ask-open";

/** sessionStorage that never throws; without one, nothing is remembered. */
function tabStore() {
  try {
    const s = globalThis.sessionStorage;
    if (!s) throw new Error("none");
    return { get: () => { try { return s.getItem(REMEMBER_KEY); } catch { return null; } }, set: (v) => { try { if (v) s.setItem(REMEMBER_KEY, v); else s.removeItem(REMEMBER_KEY); } catch { /* not remembered */ } } };
  } catch {
    return { get: () => null, set: () => {} };
  }
}

/**
 * Builds the drawer for a role and puts its button into `slot`. `deps` are for tests: the calls, the address, the
 * timers, the clock, the confirmation and the store of this tab. `list`: the conversations the server listed at the
 * start. Returns { open, close, send, stop, … , state }.
 */
export function createAsk(role, {
  slot, api = realApi, host = document.body, hash = () => globalThis.location?.hash ?? "", win = globalThis, list = [], paused = false, store = tabStore(), now = () => Date.now(),
  confirmer = confirmDialog, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
} = {}) {
  // `restore`: the conversation to read when the drawer opens for the first time after a reload.
  const st = { open: false, view: "talk", conversation: null, busy: false, attach: true, polls: 0, failures: 0, timer: null, rows: [], archived: false, restore: restorePick(list, store.get()), waitKey: "", waitSince: 0, saidSlow: false,
    // `paused`: the administrator's emergency stop, as the server last said so (never guessed from another error)
    // `drafts`: reasons ticked for an answer and not saved yet, by message, so a redraw keeps them
    paused: paused === true, drafts: new Map() };
  const guard = staleGuard();
  let opener = null;
  const where = () => whereOf(role, hash());
  const el = (id) => document.getElementById(id);
  const dialogOnTop = () => !!el("modal-root")?.children?.length;

  const ui = askFrame({
    close: () => close(),
    submit: () => void send(),
    attach: (on) => { st.attach = on; drawContext(); },
    // Enter is a new line in the question; Ctrl+Enter or Cmd+Enter sends it.
    key: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault?.(); void send(); } },
    fresh: () => fresh(),
    history: () => (st.view === "history" ? showTalk() : void showHistory()),
    archived: () => { st.archived = !st.archived; void showHistory(); },
  }, { questionMax: QUESTION_MAX, hints: CONSEQUENCES });
  const button = askButton(() => (st.open ? close() : open()));

  /** How long the reply that is being written has been waited for, as this tab saw it. */
  function elapsed() {
    const last = lastOf(st.conversation);
    if (!isWaiting(st.conversation)) { st.waitKey = ""; st.saidSlow = false; return 0; }
    const key = `${st.conversation.id}:${last.id}:${last.tries}`;
    if (key !== st.waitKey) { st.waitKey = key; st.waitSince = now(); st.saidSlow = false; }
    return now() - st.waitSince;
  }
  function drawContext() {
    ui.context.textContent = contextFor(where(), st.attach).text;
  }
  function draw() {
    const history = st.view === "history";
    ui.talk.hidden = history;
    ui.history.hidden = !history;
    ui.historyBtn.setAttribute("aria-expanded", String(history));
    ui.historyBtn.textContent = history ? "Back to the conversation" : "History";
    // the notice is on both views: in the list too, a person can see why asking does not work
    ui.paused.textContent = PAUSED_WORDS;
    ui.paused.hidden = !st.paused;
    if (history) {
      ui.archivedBtn.setAttribute("aria-pressed", String(st.archived));
      mount(ui.list, historyNodes(st.rows, { current: st.conversation?.id, archived: st.archived, onOpen: (id) => void openConversation(id), now: now() }));
      return;
    }
    // a link to a page closes the drawer, so the page it opens is seen; the address changes by the link itself
    const view = {
      now: now(),
      onNavigate: () => close({ back: false }),
      reasonWords: REASON_WORDS,
      onRate: (message, vote) => void rate(message, vote),
      onReasons: (message, reasons) => void rate(message, "not-helpful", reasons, true),
      draftOf: (message) => st.drafts.get(message),
      onDraft: (message, reasons) => st.drafts.set(message, reasons),
    };
    // `mount` keeps the focus on the control with the same name, so voting by keyboard works across a redraw
    mount(ui.thread, threadOf(st.conversation, { elapsedMs: elapsed(), role }).flatMap((entry) => [entryNode(entry, view), ...(entry.rateable ? rateNodes(entry, view) : [])]));
    ui.thread.hidden = !st.conversation;
    const controls = { ...controlsFor(st.conversation, { busy: st.busy, paused: st.paused }), solved: solveOffered(st.conversation, { busy: st.busy }) };
    mount(ui.actions, actionNodes(controls, CONSEQUENCES, { stop: () => void stopAnswer(), retry: () => void retry(), solved: () => void solve(), archive: () => void archive(), restore: () => void restore(), remove: () => void remove() }));
    // suggestions are for a start: a conversation that runs has its own questions
    ui.suggestBox.hidden = !!st.conversation;
    if (!st.conversation) {
      mount(ui.suggest, suggestionNodes(suggestionsFor(where()), (text) => {
        ui.question.value = text;
        ui.error.textContent = "";
        ui.question.focus();
      }));
    }
    drawContext();
    const plan = sendPlan({ draft: "x", busy: st.busy, conversation: st.conversation, paused: st.paused });
    if (plan.ok) ui.send.removeAttribute("aria-disabled");
    else ui.send.setAttribute("aria-disabled", "true");
  }
  function say(text) {
    if (text) ui.status.textContent = text;
  }
  /** Takes a conversation the server answered with; says what changed. */
  function take(conversation) {
    const before = st.conversation;
    st.conversation = conversation;
    store.set(conversation?.id ?? "");
    st.restore = null;
    const told = announce(before, conversation);
    say(told);
    const slow = waitNote(elapsed());
    if (isWaiting(conversation) && slow.slow && !st.saidSlow && !told) { st.saidSlow = true; say(slow.text); }
    draw();
    // the newest message is what the person waits for
    ui.thread.lastElementChild?.scrollIntoView?.({ block: "nearest" });
    schedule();
  }
  /** Leaves the open conversation: nothing of it is drawn or read any more, and a late answer for it is dropped. */
  function leave() {
    guard.next();
    st.conversation = null;
    st.restore = null;
    st.polls = 0;
    st.failures = 0;
    store.set("");
    ui.error.textContent = "";
    schedule();
  }

  function schedule() {
    if (st.timer !== null) clearTimer(st.timer);
    st.timer = null;
    const ms = pollDelay({ open: st.open, conversation: st.conversation, polls: st.polls });
    if (ms === null) { st.polls = 0; return; }
    st.timer = setTimer(() => { st.timer = null; void read(); }, ms);
  }
  async function read() {
    const id = st.conversation?.id;
    if (!id || !st.open) return;
    const current = guard.ticket();
    st.polls++;
    let next;
    try {
      next = await api.helpConversation(id);
    } catch (e) {
      // an answer for a conversation that is no longer the open one is dropped
      if (!current()) return;
      if (++st.failures >= MAX_READ_FAILURES || e?.status === 404 || e?.status === 410) {
        st.failures = 0;
        ui.error.textContent = explainAskError(e);
        return;
      }
      schedule();
      return;
    }
    if (!current()) return;
    st.failures = 0;
    take(next);
  }

  /** One call that changes something. A second one while it runs does nothing, so no press is counted twice. */
  async function act(call, after) {
    if (st.busy) return false;
    const current = guard.ticket();
    st.busy = true;
    ui.error.textContent = "";
    draw();
    try {
      const result = await call();
      st.busy = false;
      // the person went on to another conversation meanwhile: the answer is not drawn over it
      if (current()) after(result);
      else draw();
      return true;
    } catch (e) {
      st.busy = false;
      // only the exact sentence of a paused Ask SCF pauses the drawer: another 503 (switched off, secret check) does not
      if (isPausedError(e)) st.paused = true;
      if (current()) ui.error.textContent = explainAskError(e);
      draw();
      return false;
    }
  }

  /** Asks the server whether Ask SCF is still paused. A failed read leaves it as it was. */
  async function refreshPaused() {
    try {
      const info = await api.helpConversations(st.archived);
      st.paused = info?.paused === true;
    } catch {
      /* keep what is known */
    }
    draw();
  }

  async function send() {
    // paused: look again before refusing, so an unpaused Ask SCF is usable without a reload
    if (st.paused) await refreshPaused();
    const plan = sendPlan({ draft: ui.question.value, busy: st.busy, conversation: st.conversation, where: where(), attach: st.attach, paused: st.paused });
    if (!plan.ok) {
      ui.error.textContent = plan.reason;
      ui.question.focus();
      return false;
    }
    return act(() => api.askHelp(plan.to, plan.body), (next) => {
      ui.question.value = "";
      st.polls = 0;
      take(next);
    });
  }
  const mine = () => st.conversation?.id;
  const backToBox = () => { if (st.open) ui.question.focus(); };
  function stopAnswer() {
    if (!controlsFor(st.conversation, { busy: st.busy }).stop) return false;
    const id = mine();
    return act(() => api.cancelHelp(id), (next) => { take(next); backToBox(); });
  }
  function retry() {
    if (!controlsFor(st.conversation, { busy: st.busy, paused: st.paused }).retry) return false;
    const id = mine();
    return act(() => api.retryHelp(id), (next) => { st.polls = 0; take(next); backToBox(); });
  }
  /** Rates one finished answer, or takes the vote back by pressing it again. `keep`: save the ticked reasons for the vote that is set. */
  function rate(message, vote, reasons, keep = false) {
    const entry = st.conversation?.messages?.find((m) => m.id === message);
    if (!entry || entry.role !== "assistant" || entry.status !== "done") return false;
    const id = mine();
    const current = entry.feedback?.vote ?? null;
    const body = keep ? { message, vote: "not-helpful", reasons: feedbackPlan(message, "not-helpful", reasons).reasons } : feedbackPlan(message, vote, [], current);
    return act(() => api.rateHelp(id, body), (next) => {
      st.drafts.delete(message);
      st.conversation = next;
      draw();
      say(voteNote(body.vote));
    });
  }
  /** "This solved my problem": closes the conversation and says so, which is the only way a conversation counts as resolved. */
  function solve() {
    if (!solveOffered(st.conversation, { busy: st.busy })) return false;
    const id = mine();
    return act(() => api.solveHelp(id), (next) => { take(next); say("The conversation is closed. Thank you."); });
  }
  function archive() {
    if (!controlsFor(st.conversation, { busy: st.busy }).archive) return false;
    const id = mine();
    return act(() => api.archiveHelp(id), () => { leave(); say("The conversation is in the archive. Open History and choose Show archived to take it back."); draw(); backToBox(); });
  }
  function restore() {
    if (!controlsFor(st.conversation, { busy: st.busy }).restore) return false;
    const id = mine();
    return act(() => api.restoreHelp(id), (next) => { take(next); say("The conversation is back in your list."); backToBox(); });
  }
  async function remove() {
    if (!controlsFor(st.conversation, { busy: st.busy }).remove) return false;
    const id = mine();
    const current = guard.ticket();
    const yes = await confirmer({ title: "Delete this conversation?", text: `${CONSEQUENCES.remove} An answer that is still being written is stopped.`, confirm: "Delete", danger: true });
    if (!yes || !current()) return false;
    return act(() => api.deleteHelp(id), () => { leave(); say("The conversation was deleted."); draw(); backToBox(); });
  }
  /** An empty conversation. The one that was open stays in the list; nothing is sent. */
  function fresh() {
    leave();
    st.view = "talk";
    say("A new conversation. Your earlier ones are under History.");
    draw();
    backToBox();
  }
  function showTalk() {
    st.view = "talk";
    draw();
    schedule();
    ui.historyBtn.focus();
  }
  async function showHistory() {
    st.view = "history";
    const archived = st.archived;
    st.rows = [];
    draw();
    ui.status.textContent = "Loading your conversations.";
    let info;
    try {
      info = await api.helpConversations(archived);
    } catch (e) {
      if (st.view === "history" && st.archived === archived) { ui.status.textContent = ""; ui.error.textContent = explainAskError(e); showTalk(); }
      return;
    }
    // the person left the list, or asked for the other one, before this answer came
    if (st.view !== "history" || st.archived !== archived) return;
    st.paused = info?.paused === true;
    st.rows = historyRows(info?.conversations);
    ui.status.textContent = archived ? `${st.rows.length} archived conversations.` : `${st.rows.length} conversations.`;
    draw();
  }
  /** Opens a conversation of the list. A later choice wins: the answer of an earlier one is dropped. */
  async function openConversation(id) {
    guard.next();
    const current = guard.ticket();
    ui.error.textContent = "";
    let next;
    try {
      next = await api.helpConversation(id);
    } catch (e) {
      if (!current()) return false;
      if (st.restore === id) { st.restore = null; store.set(""); }
      else ui.error.textContent = explainAskError(e);
      return false;
    }
    if (!current()) return false;
    st.view = "talk";
    st.polls = 0;
    st.failures = 0;
    // the same conversation before and after: opening one is not announced as a new answer
    st.conversation = next;
    take(next);
    say("The conversation is open.");
    backToBox();
    return true;
  }

  function behind(on) {
    // the menu of a narrow screen keeps its own lock
    if (!on && document.body?.classList?.contains("drawer-open")) return;
    for (const id of BEHIND) {
      const node = el(id);
      if (!node) continue;
      if (on) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    }
  }
  function open() {
    if (st.open) return;
    st.open = true;
    opener = document.activeElement;
    ui.drawer.hidden = false;
    ui.scrim.hidden = false;
    button.setAttribute("aria-expanded", "true");
    behind(true);
    draw();
    ui.question.focus();
    // After a reload: the conversation that was open is read again. A read, never a question.
    if (st.restore && !st.conversation) void openConversation(st.restore);
    // a reply that was waited for when the drawer was closed is read again; nothing is asked
    else if (pollDelay({ open: true, conversation: st.conversation }) !== null) void read();
  }
  /** `back: false`: a page is being opened, and the page takes the focus itself. */
  function close({ back: giveBack = true } = {}) {
    if (!st.open) return;
    st.open = false;
    ui.drawer.hidden = true;
    ui.scrim.hidden = true;
    button.setAttribute("aria-expanded", "false");
    behind(false);
    schedule();
    // back to where the person was; the button when that control is gone
    const back = opener && opener.isConnected !== false ? opener : button;
    opener = null;
    if (giveBack) back.focus?.();
    else document.getElementById("main")?.focus?.();
  }

  // a control of the part that is not shown (the list, or the conversation) is no Tab stop
  const shown = (node) => { for (let p = node; p && p !== ui.drawer; p = p.parentNode) if (p.hidden) return false; return true; };
  const onKey = (e) => {
    if (!st.open) return;
    const top = dialogOnTop();
    if (closesOn(e, { dialogOnTop: top })) { close(); return; }
    if (e.key !== "Tab" || top) return;
    const to = trapTarget(tabStops(ui.drawer).filter(shown), document.activeElement, !!e.shiftKey);
    if (to) { e.preventDefault?.(); to.focus(); }
  };
  // the page behind changed (the Back key): the suggestions and the context line follow it; the conversation stays
  const onHash = () => { if (st.open) draw(); };
  document.addEventListener("keydown", onKey);
  win.addEventListener?.("hashchange", onHash);

  host.append(ui.scrim, ui.drawer);
  if (slot) {
    slot.replaceChildren(button);
    slot.hidden = false;
  }

  function stop() {
    close();
    guard.next();
    document.removeEventListener("keydown", onKey);
    win.removeEventListener?.("hashchange", onHash);
    ui.scrim.remove?.();
    ui.drawer.remove?.();
    if (slot) { slot.replaceChildren(); slot.hidden = true; }
  }
  return { open, close, send, stop, stopAnswer, retry, rate, solve, archive, restore, remove, fresh, showHistory, showTalk, openConversation, state: st, ui, button };
}

/**
 * Asks the server whether Ask SCF is switched on and, only then, puts the button and the drawer on the page.
 * Switched off, or the answer did not come: nothing is offered. Returns the drawer or null; never rejects.
 */
export async function initAsk(role, deps = {}) {
  const api = deps.api ?? realApi;
  let info;
  try {
    info = await api.helpConversations();
  } catch {
    return null;
  }
  if (info?.enabled !== true) return null;
  return createAsk(role, { slot: document.getElementById("ask-scf"), list: info.conversations, paused: info.paused === true, ...deps, api });
}
