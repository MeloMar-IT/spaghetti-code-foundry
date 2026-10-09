import { h, mount } from "./dom.js";
import { banner, errorState, explainError, loadingState, staleNote, staleText } from "./states.js";

// Pages that refresh themselves: one poller (one request at a time, paused in a hidden tab), scroll keeping and the live states.

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** True while a dialog is open (`#modal-root` has children). */
export const dialogOpen = () => (document.getElementById("modal-root")?.children?.length ?? 0) > 0;

/** Runs `fn` and puts the page scroll and the scroll of every `[data-scroll]` element in `box` back (matched by value, in order). */
export function keepScroll(box, fn) {
  const root = document.documentElement;
  const page = [root.scrollTop, root.scrollLeft];
  const saved = new Map();
  for (const el of box.querySelectorAll("[data-scroll]")) {
    const key = el.getAttribute("data-scroll");
    if (!saved.has(key)) saved.set(key, []);
    saved.get(key).push([el.scrollTop, el.scrollLeft]);
  }
  try {
    return fn();
  } finally {
    const seen = new Map();
    for (const el of box.querySelectorAll("[data-scroll]")) {
      const key = el.getAttribute("data-scroll");
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const pos = saved.get(key)?.[n];
      if (pos) {
        el.scrollTop = pos[0];
        el.scrollLeft = pos[1];
      }
    }
    root.scrollTop = page[0];
    root.scrollLeft = page[1];
  }
}

// A callback of the page that throws must not break the poller.
const guard = (fn, ...args) => {
  try {
    return fn?.(...args);
  } catch (e) {
    console.error(e);
  }
};

/**
 * Asks `load()` now and every `every` ms and draws the answer when it changed.
 * Every request goes through one gate: not stopped, the tab is visible, not offline (the offline signal is ignored on a local address),
 * and not waiting for `wake()`. One request at a time; a tick or `refresh()` during a flight gives one follow-up.
 */
export function poller({ load, draw, every = 5000, onState, hold, wake } = {}) {
  const local = LOCAL_HOSTS.includes(globalThis.location?.hostname);
  let stopped = false;
  let busy = false;
  let again = false;
  let waking = false;
  let offline = !local && globalThis.navigator?.onLine === false;
  let drawn = null;
  let at;
  let held = null;
  let holdTimer;
  let timer;
  let done;
  const ready = new Promise((resolve) => { done = resolve; });
  const offlineError = () => new TypeError("The browser is offline.");

  const open = () => !stopped && !waking && document.visibilityState === "visible" && (local || !offline);

  const paint = (data, text) => {
    if (text === drawn) return;
    try {
      draw?.(data);
      drawn = text; // only after a draw that worked, so a draw that threw is tried again with the same data
    } catch (e) {
      console.error(e);
    }
  };

  const release = () => {
    holdTimer = undefined;
    if (stopped) return;
    if (hold?.()) {
      holdTimer = setTimeout(release, 250);
      return;
    }
    const next = held;
    held = null;
    if (next) paint(next.data, next.text);
  };

  const accept = (data, text) => {
    if (hold?.()) {
      held = { data, text };
      if (holdTimer === undefined) holdTimer = setTimeout(release, 250);
      return;
    }
    held = null;
    paint(data, text);
  };

  const answer = (data) => {
    let text;
    try {
      text = JSON.stringify(data);
    } catch (error) {
      // Data that cannot be compared cannot be drawn: report it as a failure, keep the last good time.
      guard(onState, { at, failed: true, error });
      return;
    }
    at = Date.now();
    accept(data, text);
    if (!stopped) guard(onState, { at, failed: false });
  };

  const request = async () => {
    if (!open()) {
      again = false;
      done();
      return;
    }
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    let data;
    let failure = null;
    try {
      data = await load();
    } catch (error) {
      failure = { error };
    }
    busy = false;
    try {
      if (!stopped) {
        if (failure) guard(onState, { at, failed: true, error: failure.error });
        else if (data !== undefined) answer(data);
      }
    } finally {
      done();
      if (again) {
        again = false;
        request();
      }
    }
  };

  const onVisible = async () => {
    if (stopped || waking || document.visibilityState !== "visible") return;
    waking = true;
    try {
      await wake?.();
    } catch {
      // A failing wake-up never blocks the refresh.
    }
    waking = false;
    if (document.visibilityState === "visible") request();
  };
  const onOffline = () => {
    if (stopped || local) return;
    offline = true;
    guard(onState, { at, failed: true, error: offlineError() });
  };
  const onOnline = () => {
    if (stopped) return;
    offline = false;
    request();
  };

  document.addEventListener("visibilitychange", onVisible);
  globalThis.addEventListener?.("online", onOnline);
  globalThis.addEventListener?.("offline", onOffline);
  timer = setInterval(request, every);
  if (offline) Promise.resolve().then(() => { if (!stopped) guard(onState, { at, failed: true, error: offlineError() }); });
  request();

  return {
    ready,
    refresh: () => request().catch(() => {}),
    show(data) {
      if (!stopped && data !== undefined) answer(data);
    },
    stop() {
      stopped = true;
      held = null;
      clearInterval(timer);
      clearTimeout(holdTimer);
      document.removeEventListener("visibilitychange", onVisible);
      globalThis.removeEventListener?.("online", onOnline);
      globalThis.removeEventListener?.("offline", onOffline);
      done();
    },
  };
}

/**
 * The three live states of a page as a function of `onState` of a poller: a skeleton at the start, an error state when the first load fails,
 * and after data a note "Updated HH:MM" (`note`) or a banner with Retry (`alert`). The page places `alert` and `note`.
 */
export function liveStates({ body, heading, label, rows, shape, what, quiet = false, retry, focus } = {}) {
  const alert = h("div");
  const note = h("div");
  const name = (s) => (focus ? `${focus}-${s}` : s);
  let errorUp = false;
  let bannerUp = false;
  let noteText = "";
  mount(body, heading?.(), loadingState(label, { rows, shape }));

  const onState = ({ at, failed, error } = {}) => {
    if (!failed) {
      errorUp = false;
      if (bannerUp) {
        bannerUp = false;
        mount(alert);
      }
      if (quiet) return;
      const text = staleText(at, false);
      if (text !== noteText) {
        noteText = text;
        mount(note, staleNote(at));
      }
      return;
    }
    if (at == null) {
      if (errorUp) return;
      errorUp = true;
      mount(body, heading?.(), errorState(explainError(error, { what }), { onRetry: retry, focus: name("retry") }));
      return;
    }
    if (bannerUp) return;
    bannerUp = true;
    mount(alert, banner("error", staleText(at, true), [{ label: "Retry", onClick: retry, focus: name("refresh-retry") }]));
  };
  return { alert, note, onState };
}
