import { h } from "./dom.js";
import { emptyState, errorState, explainError, permissionState } from "./states.js";

export { emptyState };

// The states of the refinement pages that more than one module draws. Every text is set as text, never as HTML.

/** The state for a failed load of a page or list: 403 is a permission state, 404 a missing state (no Retry), the rest can be tried again. */
export function failState(e, { errorText, onRetry, back = { href: "#/refinement", label: "← All sessions" } } = {}) {
  const what = errorText(e);
  if (e?.status === 403) return permissionState(what, back);
  if (e?.status === 404) return errorState({ ...explainError(e), what }, { back });
  return errorState({ ...explainError(e), what }, { onRetry, back });
}

/** A polite, hidden line for a screen reader. `say(text)` sets it once per text; "" clears it. */
export function announcer() {
  const node = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  let last = "";
  return {
    node,
    say(text) {
      const t = String(text ?? "");
      if (t === last) return;
      last = t;
      node.textContent = t;
    },
  };
}

/** The save state of each field: "saving", "saved" or "failed" (with the error and Retry). The typed text is never touched here. */
export function saveStates() {
  const kept = new Map(); // key → { state, text, onRetry }
  const nodes = new Map(); // key → the node that shows it
  const draw = (key) => {
    const el = nodes.get(key);
    const v = kept.get(key);
    if (!el) return;
    if (!v) {
      el.replaceChildren();
      el.setAttribute("data-save", "");
      return;
    }
    el.setAttribute("data-save", v.state);
    el.setAttribute("class", v.state === "failed" ? "save-state status bad" : "save-state muted");
    if (v.state === "saving") el.replaceChildren("Saving…");
    else if (v.state === "saved") el.replaceChildren("Saved");
    else el.replaceChildren(v.text || "Not saved.", " ", h("button", { type: "button", class: "small", onClick: () => v.onRetry?.() }, "Retry"));
  };
  return {
    /** A fresh node for `key`; it shows the state the key has now. */
    node(key) {
      const el = h("span", { class: "save-state", role: "status", "data-save": "" });
      nodes.set(key, el);
      draw(key);
      return el;
    },
    set(key, state, { text, onRetry } = {}) {
      kept.set(key, { state, text, onRetry });
      draw(key);
    },
    get: (key) => kept.get(key)?.state,
    clear(key) {
      kept.delete(key);
      draw(key);
    },
    /** A row got its id: its state and node move to the new key. */
    rekey(from, to) {
      if (kept.has(from)) kept.set(to, kept.get(from));
      if (nodes.has(from)) nodes.set(to, nodes.get(from));
      kept.delete(from);
      nodes.delete(from);
      draw(to);
    },
  };
}

const SPLIT_SENTENCE = /this draft is split/i;
/** True when the server refused a change because the draft was split meanwhile (409). */
export const isSplitConflict = (e) => e?.status === 409 && SPLIT_SENTENCE.test(String(e?.message ?? ""));

/** The conflict box for a split original: what happened and a link to each part. `parts`: [{ id, label }]; `open(id)` shows the part. */
export function splitConflict(parts, open) {
  return h("div", { class: "state-error", role: "alert", "data-kind": "conflict" },
    h("p", { class: "state-what" }, "This draft was split while you were typing. It can no longer be changed."),
    h("p", { class: "state-next" }, "Your text was not saved. It is kept below so you can copy it into one of the parts."),
    h("div", { class: "row" }, parts.map((p) => h("a", { href: "#", "data-part": p.id, onClick: (e) => {
      e?.preventDefault?.();
      open(p.id);
    } }, p.label))));
}

/** The link to the issue of a published draft; plain text when the address is not on github.com. */
export function issueLink(d) {
  const text = `#${d.published.issue}`;
  const url = String(d.published.url ?? "");
  return url.startsWith("https://github.com/") ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text) : text;
}

/** The "Not saved" card: texts of this session that have no place on the page. `lost`: [[label, text]]; `onDiscard` is left out when the person may not change the session. */
export function lostCard(lost, onDiscard) {
  return h("div", { class: "card" },
    h("b", {}, "Not saved"),
    h("p", { class: "muted" }, "This text could not be saved: its place is gone or the session can no longer be changed. Copy it if you need it."),
    lost.map(([label, text]) => h("p", { class: "said" }, h("b", {}, `${label}: `), text)),
    onDiscard ? h("button", { onClick: onDiscard }, "Discard") : null);
}
