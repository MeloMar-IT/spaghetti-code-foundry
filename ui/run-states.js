import { h, mount } from "./dom.js";
import { liveStates } from "./live.js";
import { errorState, explainError, permissionState } from "./states.js";

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
