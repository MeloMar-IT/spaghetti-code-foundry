import { h } from "./dom.js";

// What a page can say about a failure without guessing: the client cannot know if a request that got no answer took effect.
const KINDS = {
  offline: {
    safe: "Your data on the server is not changed by this message. If you were saving, check the page before you try again.",
    next: "Check your connection, then try again.",
  },
  permission: { safe: "Nothing was changed. The pages you can open still work.", next: "Ask an admin for access, or go back." },
  missing: { safe: "Nothing else was changed or removed.", next: "Check the address, or go back to the list." },
  conflict: {
    safe: "The server refused the change, so it was not applied.",
    next: "Load the page again to see the current state, then decide if you still want to make the change.",
  },
  server: {
    safe: "Runs that already started keep going. If you were saving, check the page before you try again.",
    next: "Try again in a moment. If it keeps failing, tell an admin.",
  },
  other: { safe: "Nothing was changed by this request.", next: "Read the message above, fix what it names, then try again." },
};

const kindOf = (status) => {
  if (!status) return "offline";
  if (status === 403) return "permission";
  if (status === 404) return "missing";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "other";
};

/** What went wrong, in three parts for `errorState`. `what` is the caller's sentence plus the server's text. */
export function explainError(e, { what = "Something went wrong.", safe } = {}) {
  const status = Number(e?.status) || 0;
  const kind = kindOf(status);
  let detail = e?.message ? String(e.message) : "";
  if (kind === "offline" && e instanceof TypeError) detail = "The server could not be reached.";
  return {
    kind,
    what: detail ? `${what} ${detail}` : what,
    safe: safe || KINDS[kind].safe,
    next: KINDS[kind].next,
  };
}

const SHAPES = ["list", "table", "cards", "detail"];

/** A skeleton for a page or section that loads. One hidden label; the rows say nothing. */
export function loadingState(label, { rows = 3, shape = "list" } = {}) {
  const n = typeof rows === "number" && Number.isFinite(rows) ? Math.min(20, Math.max(1, Math.floor(rows))) : 3;
  const s = SHAPES.includes(shape) ? shape : "list";
  const items = [];
  for (let i = 0; i < n; i++) items.push(h("div", { class: "skeleton-row", "aria-hidden": "true" }));
  return h("div", { class: `skeleton skeleton-${s}`, "aria-busy": "true", role: "status" }, h("span", { class: "sr-only" }, label), items);
}

export function emptyState(text, action) {
  return h("div", { class: "empty" }, h("p", {}, text), action && h("button", { type: "button", class: "primary", onClick: () => action.onClick() }, action.label));
}

export function errorState(info, { onRetry, back } = {}) {
  const row = onRetry || back
    ? h("div", { class: "row" },
        onRetry && h("button", { type: "button", "data-focus": "retry", onClick: () => onRetry() }, "Retry"),
        back && h("a", { href: back.href }, back.label))
    : null;
  return h("div", { class: "state-error", role: "alert", "data-kind": info.kind },
    h("p", { class: "state-what" }, info.what), h("p", { class: "state-safe" }, info.safe), h("p", { class: "state-next" }, info.next), row);
}

export function permissionState(text, back) {
  return h("div", { class: "state-error state-permission", "data-kind": "permission" },
    h("p", { class: "state-what" }, text),
    h("p", { class: "state-next" }, "Ask an admin if you need access."),
    back && h("a", { href: back.href }, back.label));
}

export function staleNote(at, { failed = false, onRetry } = {}) {
  const d = at == null ? null : new Date(at);
  const valid = d && !Number.isNaN(d.getTime());
  if (!failed) {
    if (!valid) return null;
    return h("p", { class: "stale-note" }, `Updated ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  const text = valid
    ? `Could not refresh. Showing data from ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
    : "Could not refresh.";
  return h("p", { class: "stale-note failed", role: "status" }, text, onRetry && h("button", { type: "button", class: "small", onClick: () => onRetry() }, "Retry"));
}
