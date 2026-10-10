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

/** What a page shows when the repository of the filter is not in the answer. The text never depends on the filter. */
export function filterGone({ onClear } = {}) {
  return h("div", { class: "empty" },
    h("p", {}, NOT_IN_LIST),
    h("button", { type: "button", onClick: () => onClear?.() }, "Clear filters"));
}

const describe = (filters, labels) => KEYS.filter((k) => filters?.[k]).map((k) => `${NAMES[k]}: ${labels?.[k] ?? filters[k]}`);

/** The bar above a list: one chip per active filter with a remove button, and Clear filters. Null when no filter is active. */
export function filterBar(filters, { labels = {}, onRemove, onClear } = {}) {
  const active = filters ?? {};
  const keys = KEYS.filter((k) => active[k]);
  if (!keys.length) return null;
  return h("div", { class: "filter-bar", role: "group", "aria-label": "Active filters" },
    keys.map((key) => {
      const text = `${NAMES[key]}: ${labels[key] ?? active[key]}`;
      return h("span", { class: "filter-chip" }, text,
        h("button", { type: "button", class: "ghost small", "aria-label": `Remove filter ${text}`, onClick: () => onRemove?.(key) }, "×"));
    }),
    h("button", { type: "button", class: "small", onClick: () => onClear?.() }, "Clear filters"));
}

/** What a list shows when the filters match nothing: names them and offers Clear filters. `what` is "runs" or "cards". */
export function filterEmpty(what, filters, { labels = {}, note, onClear } = {}) {
  return h("div", { class: "empty" },
    h("p", {}, `No ${what} match ${describe(filters, labels).join(", ")}.`),
    note ? h("p", {}, note) : null,
    h("button", { type: "button", onClick: () => onClear?.() }, "Clear filters"));
}
