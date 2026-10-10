import { h, mount } from "./dom.js";
import { liveStates } from "./live.js";
import { banner, errorState, explainError, loadingState, permissionState } from "./states.js";

// What the two run lists (Runs and My runs) share: the empty state, parts that may fail, and the live states with a 403 case.
// Relative imports only, so the user display can load it.

export const NO_RUNS = "No runs yet.";

/** The empty state of a list with no runs and no filter: the sentence and a link to Start work. */
export const noRuns = () => h("div", { class: "empty" }, h("p", {}, NO_RUNS), h("a", { class: "btn primary", "data-focus": "start", href: "#/start" }, "Start work"));

/**
 * Waits for a call and turns the answer into plain data, so a failed part never rejects and compares the same way in the poller:
 * `{ ok: true, value }` or `{ ok: false, status, message }`.
 */
export const part = (promise) => Promise.resolve(promise).then(
  (value) => ({ ok: true, value }),
  (e) => ({ ok: false, status: Number(e?.status) || 0, message: e?.message ? String(e.message) : "" }));

/** The inline note in place of a part that could not be loaded. `what` is e.g. "the queue"; `failed` is a failed `part`. */
export const partNote = (what, failed, { onRetry, focus = "retry", safe } = {}) =>
  errorState(explainError({ status: failed.status, message: failed.message }, { what: `Could not load ${what}.`, safe }), { onRetry, focus });

/**
 * `liveStates` with a case for 403: a first load that the server refuses draws a permission state (no Retry) instead of the error state.
 * Takes the options of `liveStates` plus `denied`, the sentence of the permission state.
 */
export function runsLiveStates({ denied = "You are not allowed to see the runs.", ...opts } = {}) {
  const states = liveStates(opts);
  let first = "";
  const onState = (s = {}) => {
    if (!s.failed || s.at != null) {
      first = "";
      return states.onState(s);
    }
    const kind = Number(s.error?.status) === 403 ? "denied" : "error";
    if (kind === first) return;
    if (kind === "error") {
      // The permission state was drawn outside `liveStates`: clear its error flag so this error is drawn again.
      if (first === "denied") states.onState({ failed: false });
      first = kind;
      return states.onState(s);
    }
    first = kind;
    mount(opts.body, opts.heading?.(), permissionState(denied));
  };
  return { alert: states.alert, note: states.note, onState };
}

// ── The run page ──

export const NOT_FOUND = "This run was not found. It may have been removed.";
export const NO_ACCESS = "You are not allowed to see this run.";
export const STREAM_LOST = "Lost connection to the run stream";

/** True for something that can be drawn as a run: an object with a run id (not a list, not null). */
export const isRun = (s) => !!s && typeof s === "object" && !Array.isArray(s) && typeof s.runId === "string";

/** What a failed first load of a run page is: "loading" (no error yet), "missing" (404), "denied" (403) or "error". */
export const runLoadKind = (error) => {
  if (!error) return "loading";
  const status = Number(error.status) || 0;
  return status === 404 ? "missing" : status === 403 ? "denied" : "error";
};

/** The first-load state of a run page. `back` is { href, label, focus }. */
export function runLoadState(error, { back, onRetry, focus = "run-retry" } = {}) {
  const kind = runLoadKind(error);
  const link = back && { href: back.href, label: back.label };
  if (kind === "loading") return loadingState("Loading the run", { rows: 6, shape: "detail" });
  if (kind === "missing") return h("div", { class: "empty" }, h("p", {}, NOT_FOUND), h("a", { href: back.href, "data-focus": back.focus }, back.label));
  if (kind === "denied") return permissionState(NO_ACCESS, link);
  return errorState(explainError(error, { what: "Could not load the run." }), { onRetry, back: link, focus });
}

/**
 * Loads into `box`: a loading line, then `draw(await load())`, or an inline error state with Retry.
 * `loading` is a text or a node. `current()` says if the answer is still wanted.
 */
export async function loadInto(box, opts) {
  const { loading, load, draw, what, focus = "retry", current = () => true } = opts;
  mount(box, typeof loading === "string" ? h("p", { class: "muted" }, loading) : loading);
  let node;
  try {
    node = draw(await load());
  } catch (e) {
    node = errorState(explainError(e, { what }), { onRetry: () => loadInto(box, opts), focus });
  }
  if (current()) mount(box, node);
}

/**
 * The event stream of a run page and its "lost" banner. `open()` makes an EventSource; `on` maps event types to handlers.
 * The banner shows once when a stream is closed for good and goes on the next event. `onLost` is called on every such close,
 * `onReopen` before the first event of a stream opened by Reconnect.
 * Returns { el, start(), down(), close() }.
 */
export function runStream({ open, on = {}, onLost, onReopen } = {}) {
  const el = h("div");
  let es = null;
  let down = false;
  let closed = false;
  let fresh = false;

  function connect() {
    const mine = open();
    es = mine;
    for (const [type, fn] of Object.entries(on)) {
      mine.addEventListener(type, (e) => {
        if (closed || mine !== es) return;
        if (down) {
          down = false;
          mount(el);
        }
        if (fresh) {
          fresh = false;
          onReopen?.();
        }
        fn(e);
      });
    }
    mine.onerror = () => {
      if (closed || mine !== es || mine.readyState !== 2) return;
      if (!down) {
        down = true;
        mount(el, banner("error", STREAM_LOST, [{ label: "Reconnect", onClick: reconnect, focus: "stream-reconnect" }]));
      }
      onLost?.();
    };
  }

  function reconnect() {
    if (closed) return;
    es?.close();
    try {
      connect();
      fresh = true;
    } catch {
      onLost?.();
    }
  }

  return {
    el,
    start: connect,
    down: () => down,
    close() {
      closed = true;
      es?.close();
    },
  };
}
