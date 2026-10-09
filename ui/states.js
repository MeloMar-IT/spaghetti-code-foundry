import { h } from "./dom.js";
import { button, link } from "./kit/actions.js";
import { banner as kitBanner } from "./kit/display.js";

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

export function errorState(info, { onRetry, back, focus = "retry" } = {}) {
  const row = onRetry || back
    ? h("div", { class: "row" },
        onRetry && h("button", { type: "button", "data-focus": focus, onClick: () => onRetry() }, "Retry"),
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

/** The text of the stale note: "Updated HH:MM", or when `failed`, "Could not refresh. Showing data from HH:MM.". "" for a good note with no valid time. */
export function staleText(at, failed = false) {
  const d = at == null ? null : new Date(at);
  const valid = d && !Number.isNaN(d.getTime());
  const time = valid ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (!failed) return time ? `Updated ${time}` : "";
  return time ? `Could not refresh. Showing data from ${time}.` : "Could not refresh.";
}

export function staleNote(at, { failed = false, onRetry } = {}) {
  const text = staleText(at, failed);
  if (!failed) return text ? h("p", { class: "stale-note" }, text) : null;
  return h("p", { class: "stale-note failed", role: "status" }, text, onRetry && h("button", { type: "button", class: "small", onClick: () => onRetry() }, "Retry"));
}

const BANNER_TONES = { error: "fail", warn: "warn", info: "neutral" };

/**
 * A message that stays on the page (a required follow-up, stale data, a lost stream). An adapter over the kit banner:
 * "error" is `role="alert"`, the others `role="status"`. An action is `{ label, onClick, focus? }` or `{ label, href, focus? }`; `focus` sets `data-focus`.
 */
export function banner(kind, text, actions) {
  const k = Object.hasOwn(BANNER_TONES, kind) ? kind : "info";
  const nodes = (actions ?? []).map((a) => (a.href
    ? link({ href: a.href, "data-focus": a.focus }, a.label)
    : button({ size: "small", onClick: a.onClick, "data-focus": a.focus }, a.label)));
  return kitBanner({ tone: BANNER_TONES[k], actions: nodes.length ? nodes : undefined, "data-kind": k }, text);
}
