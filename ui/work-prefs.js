import { COLUMN_IDS, DEFAULTS, GROUPS, ORDERS, WHO, workItems } from "./work-model.js";

// The Work page's choices (filters, grouping, order), kept per account in this browser.
// Same store pattern as ui/since.js: missing, throwing or garbage storage means the defaults.

const PROPS = DEFAULTS.props;
const defaultStore = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};
const keyOf = (userId) => `scf.work.${userId || "local"}`;
const fresh = () => ({ ...DEFAULTS, status: [], props: [...DEFAULTS.props] });
const text = (v, fallback) => (typeof v === "string" ? v : fallback);
const oneOf = (v, list, fallback) => (typeof v === "string" && list.includes(v) ? v : fallback);
const listOf = (v, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && allowed.includes(x)))] : null);

/**
 * Cleans what storage held: unknown keys dropped, wrong types replaced by the defaults, and — when `known`
 * is given — a repository or owner that no longer exists cleared. `known` is the board answer (so a
 * repository without cards still counts) or a list of work items.
 */
export function cleanPrefs(raw, known) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = fresh();
  out.layout = oneOf(r.layout, ["board", "list"], out.layout);
  out.repo = text(r.repo, "");
  out.owner = text(r.owner, "");
  out.status = listOf(r.status, COLUMN_IDS) ?? [];
  out.who = oneOf(r.who, WHO, "");
  out.text = text(r.text, "");
  out.group = oneOf(r.group, GROUPS.map((g) => g.id), out.group);
  out.order = oneOf(r.order, ORDERS.map((o) => o.id), out.order);
  out.props = listOf(r.props, PROPS) ?? out.props;
  out.compact = r.compact === true;
  if (known) {
    const items = Array.isArray(known) ? known : workItems(known);
    const repos = new Set([...items.map((i) => i.repo), ...(Array.isArray(known) ? [] : (known.repos ?? []).map((x) => x.repo))]);
    if (out.repo && !repos.has(out.repo)) out.repo = "";
    if (out.owner && !items.some((i) => i.owner === out.owner)) out.owner = "";
  }
  return out;
}

export function loadPrefs(userId, store = defaultStore()) {
  try {
    return cleanPrefs(JSON.parse(store.getItem(keyOf(userId))));
  } catch {
    return fresh();
  }
}

export function savePrefs(userId, prefs, store = defaultStore()) {
  try {
    store.setItem(keyOf(userId), JSON.stringify(prefs));
  } catch {
    // no storage: nothing is remembered
  }
}
