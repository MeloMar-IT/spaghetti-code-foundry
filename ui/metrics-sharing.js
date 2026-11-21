import { api } from "./api.js";
import { h, modal, mount } from "./dom.js";
import { whatIsSharedDialog } from "./metrics-shared.js";

// The sharing answer of the signed-in account (#887): one item on Today while it is not answered, and a switch in
// Account settings. All of them read one store, so a change in one shows in the others without a reload.

export const SHARING = {
  title: "Share the metrics of your runs?",
  shared: "Shared: numbers only, once a day — how many runs started, finished and failed, how long they took, the tokens and cost, the built-in flow, step and model names, and the Foundry version.",
  never: "Never shared: your code, tasks, step output, the text of a change, names, e-mail addresses, repository names or paths.",
  privacy: "How metrics sharing works",
  privacyHref: "/privacy.html#shared-metrics",
  preview: "What is shared",
  previewHref: "/privacy.html#preview",
  share: "Share",
  dontShare: "Don't share",
  dialog: "Account settings",
  switchLabel: "Share the metrics of my runs",
  notAnswered: "You have not answered yet.",
  failed: "Your answer was not saved.",
};

const ANSWERS = new Set(["unasked", "yes", "no"]);
// Another session can switch sharing off or on: the state is read again every 30 seconds while a control is shown.
const REFRESH_MS = 30_000;
// `known`: a GET or PUT has answered at least once; before that nothing is shown.
let state = { known: false, allowed: false, answer: "unasked", changed: null };
const subscribers = new Set();
let seq = 0;
let users = 0; // controls that keep the state fresh
let pollApi = null;
let timer;

/** The last known state: { known, allowed, answer, changed }. */
export const sharingState = () => ({ ...state });
/** How many controls listen to the store (for tests: navigation must not grow it). */
export const sharingSubscribers = () => subscribers.size;
/** Forgets the state and every listener (for tests). */
export function resetSharing() {
  state = { known: false, allowed: false, answer: "unasked", changed: null };
  subscribers.clear();
  seq++;
  users = 0;
  pollApi = null;
  clearInterval(timer);
  timer = undefined;
}

function tick() {
  if (globalThis.document?.visibilityState === "hidden" || !pollApi) return;
  void refreshSharing(pollApi);
}

/** Keeps the state fresh while a control is shown: one timer for all of them, stopped with the last one. Returns the disposer. */
function keepFresh(a) {
  users++;
  pollApi = a;
  timer ??= setInterval(tick, REFRESH_MS);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--users === 0) {
      clearInterval(timer);
      timer = undefined;
      pollApi = null;
    }
  };
}

function apply(v) {
  if (!v || typeof v !== "object" || typeof v.allowed !== "boolean" || !ANSWERS.has(v.answer)) return false;
  state = { known: true, allowed: v.allowed, answer: v.answer, changed: typeof v.changed === "string" ? v.changed : null };
  for (const fn of [...subscribers]) {
    try {
      fn(sharingState());
    } catch {
      /* one control must not stop the others */
    }
  }
  return true;
}

/** Calls `fn(state)` after every change; returns the disposer. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
}

/** Reads the state again and tells every control. Never rejects; a failed read keeps the last state. A read older than a later call is dropped. */
export async function refreshSharing(a = api) {
  if (typeof a?.metricsSharing !== "function") return sharingState();
  const mine = ++seq;
  try {
    const v = await a.metricsSharing();
    if (mine === seq) apply(v);
  } catch {
    /* no state: nothing is shown */
  }
  return sharingState();
}

/** Stores the answer ("yes" or "no"); on success every control follows. Rejects with the server's error. */
export async function setAnswer(a, answer) {
  const v = await a.setMetricsSharing(answer);
  seq++; // a read that started before this answer is older than it
  if (!apply(v)) throw new Error(SHARING.failed);
  return sharingState();
}

const errorText = (e) => (e && typeof e.message === "string" && e.message ? e.message : SHARING.failed);

/** The Today item: the question, what is shared and what never is, two links and the two buttons. */
export function sharingAskCard({ onChoose, previewHref = SHARING.previewHref, openPreview }) {
  const note = h("p", { class: "status", role: "status" });
  const choose = async (answer) => {
    share.disabled = true;
    dont.disabled = true;
    mount(note);
    try {
      await onChoose(answer);
    } catch (e) {
      note.setAttribute("class", "status bad");
      mount(note, errorText(e));
    } finally {
      share.disabled = false;
      dont.disabled = false;
    }
  };
  const share = h("button", { type: "button", class: "primary", onClick: () => choose("yes") }, SHARING.share);
  const dont = h("button", { type: "button", onClick: () => choose("no") }, SHARING.dontShare);
  return h("section", { class: "card today-ask", "aria-label": SHARING.title },
    h("p", {}, h("strong", {}, SHARING.title)),
    h("p", {}, SHARING.shared),
    h("p", {}, SHARING.never),
    h("p", { class: "row" }, h("a", { href: SHARING.privacyHref }, SHARING.privacy), h("a", { href: previewHref || SHARING.previewHref, onClick: openPreview ? (e) => { e?.preventDefault?.(); void openPreview(); } : undefined }, SHARING.preview)),
    h("div", { class: "row" }, share, dont),
    note);
}

/**
 * Shows the Today item in `slot` while sharing is allowed and the account has not answered. Never rejects, never throws.
 * Returns the disposer; after it, late answers change nothing here.
 */
export function mountSharingAsk(slot, { a = api, previewHref } = {}) {
  if (!slot || typeof a?.metricsSharing !== "function") return () => {};
  let live = true;
  let card = null;
  const draw = (s) => {
    if (!live) return;
    if (s.known && s.allowed && s.answer === "unasked") {
      card ??= sharingAskCard({ onChoose: (answer) => setAnswer(a, answer), previewHref, openPreview: () => whatIsSharedDialog(a) });
      if (card.parentNode !== slot) mount(slot, card);
    } else {
      card = null;
      mount(slot);
    }
  };
  const off = subscribe(draw);
  draw(state);
  const stopWait = whenVisible(() => void refreshSharing(a));
  const stopFresh = keepFresh(a);
  return () => {
    live = false;
    stopWait();
    stopFresh();
    off();
  };
}

/** Runs `fn` now, or once the tab is visible again (a hidden tab makes no requests). Returns a disposer. */
function whenVisible(fn) {
  const doc = globalThis.document;
  if (doc?.visibilityState !== "hidden" || typeof doc.addEventListener !== "function") {
    fn();
    return () => {};
  }
  const on = () => {
    if (doc.visibilityState === "hidden") return;
    doc.removeEventListener("visibilitychange", on);
    fn();
  };
  doc.addEventListener("visibilitychange", on);
  return () => doc.removeEventListener("visibilitychange", on);
}

const dateText = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }) : "";
};

/** The Account settings dialog: the switch and the date of the last change. It reads the state again when it opens. */
export function accountSettingsDialog(a = api) {
  let off = () => {};
  let busy = false;
  const done = modal(SHARING.dialog, (close) => {
    const box = h("input", { type: "checkbox", name: "metrics-sharing" });
    const when = h("p", { class: "muted" });
    const note = h("p", { class: "status", role: "status" });
    const draw = (s) => {
      if (busy) return;
      box.checked = s.answer === "yes";
      box.disabled = !s.known || !s.allowed;
      mount(when, s.changed ? `Last changed on ${dateText(s.changed)}.` : SHARING.notAnswered);
    };
    box.addEventListener("change", async () => {
      if (busy) return;
      const before = state.answer === "yes";
      busy = true;
      box.disabled = true;
      mount(note);
      try {
        await setAnswer(a, box.checked ? "yes" : "no");
      } catch (e) {
        box.checked = before;
        note.setAttribute("class", "status bad");
        mount(note, errorText(e));
      } finally {
        busy = false;
        draw(state);
      }
    });
    off = subscribe(draw);
    draw(state);
    void refreshSharing(a);
    return h("div", { class: "stack" },
      h("label", { class: "check" }, box, h("span", {}, SHARING.switchLabel)),
      when,
      h("p", { class: "muted" }, SHARING.shared, " ", SHARING.never),
      h("p", { class: "row" },
        h("a", { href: SHARING.privacyHref }, SHARING.privacy),
        h("a", { href: SHARING.previewHref, onClick: (e) => { e?.preventDefault?.(); close(); void whatIsSharedDialog(a); } }, SHARING.preview)),
      note);
  }, { busy: () => busy });
  return done.finally(() => off());
}

/**
 * Puts an **Account settings** button into the account menu (before "Sign out") while sharing is allowed, and takes it
 * away when an admin switches sharing off. Never throws; returns the disposer.
 */
export function mountAccountSettings(box, { a = api } = {}) {
  if (!box || typeof a?.metricsSharing !== "function") return () => {};
  const button = h("button", { class: "small", type: "button", onClick: () => void accountSettingsDialog(a) }, SHARING.dialog);
  const draw = (s) => {
    if (s.known && s.allowed) {
      if (button.parentNode === box) return;
      const out = [...box.querySelectorAll("button")].find((b) => b.textContent === "Sign out");
      if (out) box.insertBefore(button, out);
      else box.append(button);
    } else if (button.parentNode === box) {
      button.remove();
    }
  };
  const off = subscribe(draw);
  draw(state);
  void refreshSharing(a);
  const stopFresh = keepFresh(a);
  return () => {
    stopFresh();
    off();
  };
}
