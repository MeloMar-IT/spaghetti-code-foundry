// Filters in the address (Runs, Board, Refinement, My repositories, All repositories): `#/runs?repo=owner%2Fname&owner=<accountId>`. Pure helpers, plus the filter bar and the empty state.
// Values are only ever drawn as text nodes (h), never as HTML. The page filters what the server already sent.
import { h } from "./dom.js";
import { parseQuery, splitHash } from "./ia.js";

export { parseQuery, splitHash };

const KEYS = ["repo", "owner"];
const NAMES = { repo: "Repository", owner: "Owner" };

/** "" or "?repo=…&owner=…" (fixed key order; values that are not valid are left out). */
export function formatQuery(filters) {
  const parts = [];
  for (const key of KEYS) {
    const value = filters?.[key];
    if (typeof value !== "string" || !value) continue;
    const probe = parseQuery(`${key}=${encodeURIComponent(value)}`);
    if (probe[key] === value) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** The address of a path with filters. */
export const withQuery = (path, filters) => path + formatQuery(filters);

/** The same filters without one key. */
export function without(filters, key) {
  const next = { ...filters };
  delete next[key];
  return next;
}

/** True when both are repository names and the same one, ignoring case. */
export const sameRepo = (a, b) => typeof a === "string" && typeof b === "string" && a !== "" && a.toLowerCase() === b.toLowerCase();

/** Changes the address without a reload and without a hashchange. Safe where there is no browser. */
export const defaultGo = (hash) => {
  if (typeof history !== "undefined" && typeof history.replaceState === "function") history.replaceState(null, "", hash);
};

/** "owner/name" of a github.com address (https, ssh:// or git@, any number of ".git"); "" for anything else. */
export function githubOf(url) {
  if (typeof url !== "string") return "";
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+)\/?$/i.exec(url.trim());
  if (!m) return "";
  // as stripGit() in src/auth/repo-url.ts: a final name of ".git" is kept
  let name = `${m[1]}/${m[2]}`;
  while (name.length > 4 && /\.git$/i.test(name) && !/\/\.git$/i.test(name)) name = name.slice(0, -4);
  return name;
}

/** True when a repository record is the named GitHub repository: by `github` when present, else by its address. */
export const matchesRepo = (record, name) => sameRepo(record?.github || githubOf(record?.url), name);

export const NOT_IN_LIST = "This repository is not in your list. It may have been removed, or you may not have access.";

/** What a page shows when the repository of the filter is not in the answer. The text never depends on the filter. `onDelete` (an out-of-date saved view is open) adds "Delete this view". */
export function filterGone({ onClear, onDelete } = {}) {
  return h("div", { class: "empty" },
    h("p", {}, NOT_IN_LIST),
    h("button", { type: "button", onClick: () => onClear?.() }, "Clear filters"),
    onDelete ? h("button", { type: "button", "data-focus": "view-delete", onClick: () => onDelete() }, "Delete this view") : null);
}

const describe = (filters, labels) => KEYS.filter((k) => filters?.[k]).map((k) => `${NAMES[k]}: ${labels?.[k] ?? filters[k]}`);

// The context offer: "Use as my context". The source is null, an offer { label, onUse } or a function (given `{ repo }`
// when the page names the repository it shows) that returns one or null. The live context registers a function, so the
// offer is worked out when a bar is drawn. Module-level state: tests must clear it.
let offerSource = null;
const mounted = new Set(); // the bars drawn with an offer, to hide it again when the context changes without a redraw

export function setContextOffer(source) {
  offerSource = source ?? null;
  if (!offerSource) mounted.clear();
}

/** The offer for the page now, or null. A source that throws is no offer. `arg` = { repo } names the repository the page really shows. */
export function contextOffer(arg) {
  try {
    const o = typeof offerSource === "function" ? offerSource(arg) : offerSource;
    return o && typeof o.label === "string" && typeof o.onUse === "function" ? o : null;
  } catch {
    return null;
  }
}

/** For a page with its own button: calls `hide` once the registered offer for `arg` ({ repo } or undefined) is gone after a context change. */
export function watchContextOffer(arg, hide) {
  mounted.add({ update: () => { if (contextOffer(arg)) return true; hide(); return false; } });
  if (mounted.size > 20) mounted.delete(mounted.values().next().value);
}

/** Hides the offer of the bars already on the page that no longer have one. */
export function refreshContextOffer() {
  for (const m of [...mounted]) if (!m.update()) mounted.delete(m);
}

/**
 * The bar above a list: one chip per active filter with a remove button, and Clear filters (only with a chip). With a
 * context offer it also names the scope (when no repository chip does) and has "Use as my context". `onContext` is
 * undefined for the registered offer, null for none, or an offer object; `shown` names the repository the page really
 * shows when the address does not. Null when there is no chip, no offer and no `onSave`. `focus` is the prefix of the `data-focus` names of its buttons.
 * `onSave` draws "Save view" (saved views, ui/views.js). `row` is the row of saved views (a node): the result is then
 * a `div.filter-area` with the row above the bar; any other value leaves the result as it is.
 */
export function filterBar(filters, { labels = {}, onRemove, onClear, onContext, shown, focus = "filter", onSave, row } = {}) {
  const active = filters ?? {};
  const keys = KEYS.filter((k) => active[k]);
  const own = onContext === undefined;
  const arg = shown === undefined ? undefined : { repo: shown };
  const offer = own ? contextOffer(arg) : onContext;
  const saving = typeof onSave === "function";
  const withRow = row instanceof Node;
  if (!keys.length && !offer && !saving) return withRow ? h("div", { class: "filter-area" }, row) : null;
  const extra = [];
  let bar;
  if (offer) {
    const scope = active.repo ? null : h("span", { class: "muted" }, offer.label);
    const hide = () => {
      if (scope) scope.hidden = true;
      button.hidden = true;
      if (!keys.length && !saving && bar) bar.hidden = true;
    };
    const button = h("button", { type: "button", class: "small", "data-focus": `${focus}-context`, onClick: () => { offer.onUse(); hide(); } }, "Use as my context");
    if (scope) extra.push(scope);
    extra.push(button);
    if (own) watchContextOffer(arg, hide);
  }
  bar = h("div", { class: "filter-bar", role: "group", "aria-label": "Active filters" },
    keys.map((key) => {
      const text = `${NAMES[key]}: ${labels[key] ?? active[key]}`;
      return h("span", { class: "filter-chip" }, text,
        h("button", { type: "button", class: "ghost small", "aria-label": `Remove filter ${text}`, "data-focus": `${focus}-remove-${key}`, onClick: () => onRemove?.(key) }, "×"));
    }),
    keys.length ? h("button", { type: "button", class: "small", "data-focus": `${focus}-clear`, onClick: () => onClear?.() }, "Clear filters") : null,
    saving ? h("button", { type: "button", class: "small", "data-focus": `${focus}-save`, onClick: () => onSave() }, "Save view") : null,
    extra);
  return withRow ? h("div", { class: "filter-area" }, row, bar) : bar;
}

/** What a list shows when the filters match nothing: names them and offers Clear filters (and, with `onDelete`, "Delete this view" for an out-of-date saved view). `what` is "runs" or "cards". `focus` is the prefix of the button name. */
export function filterEmpty(what, filters, { labels = {}, note, onClear, onDelete, focus = "filter" } = {}) {
  return h("div", { class: "empty" },
    h("p", {}, `No ${what} match ${describe(filters, labels).join(", ")}.`),
    note ? h("p", {}, note) : null,
    h("button", { type: "button", "data-focus": `${focus}-empty-clear`, onClick: () => onClear?.() }, "Clear filters"),
    onDelete ? h("button", { type: "button", "data-focus": `${focus}-empty-delete`, onClick: () => onDelete() }, "Delete this view") : null);
}
