import { api as realApi } from "./api.js";
import { mount, tabStops, trapTarget } from "./dom.js";
import { MAX_READ_FAILURES, QUESTION_MAX, announce, closesOn, contextFor, explainAskError, pollDelay, sendPlan, suggestionsFor, threadOf, whereOf } from "./ask-model.js";
import { askButton, askFrame, entryNode, suggestionNodes } from "./ask-view.js";

// Ask SCF: the help drawer of both displays. One implementation; ui/app.js and ui/user/app.js only call initAsk.
// The drawer lies over the page and never draws the page again, so what is typed or open there stays as it is.
// Opening it sends nothing: a question, and the page it is asked on, go out only when the person presses Send.

// What lies behind the open drawer: the header, the skip button and the page.
const BEHIND = ["top", "skip", "content"];

/**
 * Builds the drawer for a role and puts its button into `slot`. `deps` are for tests: the calls, the address, the timers.
 * Returns { open, close, send, stop, state }.
 */
export function createAsk(role, { slot, api = realApi, host = document.body, hash = () => globalThis.location?.hash ?? "", win = globalThis, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
  const st = { open: false, conversation: null, busy: false, attach: true, polls: 0, failures: 0, timer: null };
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
  }, { questionMax: QUESTION_MAX });
  const button = askButton(() => (st.open ? close() : open()));

  function drawContext() {
    ui.context.textContent = contextFor(where(), st.attach).text;
  }
  function draw() {
    ui.thread.replaceChildren(...threadOf(st.conversation).map(entryNode));
    ui.thread.hidden = !st.conversation;
    mount(ui.suggest, suggestionNodes(suggestionsFor(where()), (text) => {
      ui.question.value = text;
      ui.error.textContent = "";
      ui.question.focus();
    }));
    drawContext();
    const plan = sendPlan({ draft: "x", busy: st.busy, conversation: st.conversation });
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
    say(announce(before, conversation));
    draw();
    // the newest message is what the person waits for
    ui.thread.lastElementChild?.scrollIntoView?.({ block: "nearest" });
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
    st.polls++;
    let next;
    try {
      next = await api.helpConversation(id);
    } catch (e) {
      // an answer for a conversation that is no longer the open one is dropped
      if (st.conversation?.id !== id) return;
      if (++st.failures >= MAX_READ_FAILURES || e?.status === 404 || e?.status === 410) {
        st.failures = 0;
        ui.error.textContent = explainAskError(e);
        return;
      }
      schedule();
      return;
    }
    if (st.conversation?.id !== id) return;
    st.failures = 0;
    take(next);
  }

  async function send() {
    const plan = sendPlan({ draft: ui.question.value, busy: st.busy, conversation: st.conversation, where: where(), attach: st.attach });
    if (!plan.ok) {
      ui.error.textContent = plan.reason;
      ui.question.focus();
      return false;
    }
    st.busy = true;
    ui.error.textContent = "";
    draw();
    const from = st.conversation?.id ?? null;
    try {
      const next = await api.askHelp(plan.to, plan.body);
      st.busy = false;
      // the person moved to another conversation meanwhile: the answer belongs to the one it was asked in
      if ((st.conversation?.id ?? null) !== from) { draw(); return true; }
      ui.question.value = "";
      st.polls = 0;
      take(next);
      return true;
    } catch (e) {
      st.busy = false;
      ui.error.textContent = explainAskError(e);
      draw();
      return false;
    }
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
    // a reply that was waited for when the drawer was closed is read again; nothing is asked
    if (pollDelay({ open: true, conversation: st.conversation }) !== null) void read();
  }
  function close() {
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
    back.focus?.();
  }

  const onKey = (e) => {
    if (!st.open) return;
    const top = dialogOnTop();
    if (closesOn(e, { dialogOnTop: top })) { close(); return; }
    if (e.key !== "Tab" || top) return;
    const to = trapTarget(tabStops(ui.drawer), document.activeElement, !!e.shiftKey);
    if (to) { e.preventDefault?.(); to.focus(); }
  };
  // the page behind changed (the Back key): the suggestions and the context line follow it
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
    document.removeEventListener("keydown", onKey);
    win.removeEventListener?.("hashchange", onHash);
    ui.scrim.remove?.();
    ui.drawer.remove?.();
    if (slot) { slot.replaceChildren(); slot.hidden = true; }
  }
  return { open, close, send, stop, state: st, ui, button };
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
  return createAsk(role, { slot: document.getElementById("ask-scf"), ...deps, api });
}
