import { resolve } from "./ia.js";

// The data side of the command palette: filtering, recent items, key decoding and the "intents" that tell the next
// page what to do on arrival. No DOM, so the tests call it directly.

export const RECENT_MAX = 8;
export const PREFIX_MS = 1000;
export const WISH_MS = 5000;
const ID_MAX = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shapes the server accepts in the id form of GET /api/search; a stored id that does not fit would make it refuse the whole request. */
const ID_SHAPE = {
  run: /^[\w-]+$/,
  issue: /^[\w.-]+\/[\w.-]+#\d+$/,
  refinement: UUID,
  repo: UUID,
  flow: /^[\w-]+$/,
};
export const TYPES = Object.keys(ID_SHAPE);

const validRef = (r) =>
  !!r && typeof r.type === "string" && typeof r.id === "string" && r.id.length <= ID_MAX && Object.hasOwn(ID_SHAPE, r.type) && ID_SHAPE[r.type].test(r.id);
const sameRef = (a, b) => a.type === b.type && a.id === b.id;

// ---- commands ------------------------------------------------------------------------------------

/** The commands whose label or hint contains every word of `q` (any case). */
export function filterCommands(list, q) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((c) => {
    const text = `${c.label} ${c.hint ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** True when `hit` is complete and its `href` is a page this role has (no redirect, no foreign address). */
export function allowedHit(role, hit) {
  if (!hit || typeof hit !== "object") return false;
  if (typeof hit.type !== "string" || typeof hit.id !== "string" || typeof hit.title !== "string" || typeof hit.href !== "string") return false;
  if (!hit.href.startsWith("#/")) return false;
  const to = resolve(role, hit.href);
  return !to.redirected && to.hash === hit.href;
}

/** What the page that opens for a hit should do: { page, wish }, or null. */
export function wishFor(role, hit) {
  if (hit?.type === "flow" && role === "user" && hit.href === "#/start") return { page: "start", wish: { flow: hit.id } };
  if (hit?.type === "repo" && hit.href === "#/repos") return { page: "repos", wish: { repo: hit.id } };
  if (hit?.type === "repo" && hit.href === "#/all-repos") return { page: "all-repos", wish: { repo: hit.id } };
  return null;
}

// ---- recent items --------------------------------------------------------------------------------

export const recentKey = (userId) => `scf-recent:${userId}`;

/** The stored refs of an account: only `{ type, id }` that the server would accept, each once, at most 8. Never throws. */
export function readRecents(store, userId) {
  try {
    const list = JSON.parse(store.getItem(recentKey(userId)) ?? "[]");
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const r of list) {
      if (validRef(r) && !out.some((o) => sameRef(o, r))) out.push({ type: r.type, id: r.id });
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function writeRecents(store, userId, list) {
  try { store.setItem(recentKey(userId), JSON.stringify(list.map((r) => ({ type: r.type, id: r.id })))); } catch { /* storage is off: nothing is kept */ }
}

/** Puts `ref` (type and id only) first. Returns the new list. */
export function addRecent(store, userId, ref) {
  if (!validRef(ref)) return readRecents(store, userId);
  const list = [{ type: ref.type, id: ref.id }, ...readRecents(store, userId).filter((r) => !sameRef(r, ref))].slice(0, RECENT_MAX);
  writeRecents(store, userId, list);
  return list;
}

/**
 * Keeps the stored order and removes what the server did not return (`returned`: refs). A type the server could not
 * search (`incomplete`) is kept as it is. Returns the kept list and writes it.
 */
export function pruneRecents(store, userId, returned, incomplete = []) {
  const kept = readRecents(store, userId).filter((r) => incomplete.includes(r.type) || returned.some((x) => sameRef(x, r)));
  writeRecents(store, userId, kept);
  return kept;
}

// ---- keys ----------------------------------------------------------------------------------------

const TYPING_ROLES = new Set(["textbox", "combobox", "searchbox"]);

/** True for a place where a key is text: a field, a menu of choices, editable text. */
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName ?? el.tag ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  const edit = el.getAttribute?.("contenteditable");
  if (edit === "" || edit === "true" || edit === "plaintext-only") return true;
  return TYPING_ROLES.has(el.getAttribute?.("role"));
}

export const KEYS_OFF = "scf-keys";
export const keysOff = (store) => {
  try { return store.getItem(KEYS_OFF) === "off"; } catch { return false; }
};
export function setKeysOff(store, off) {
  try { store.setItem(KEYS_OFF, off ? "off" : "on"); } catch { /* the choice lasts until reload */ }
}

/**
 * What one key press means. `st`: { off (single keys are switched off), typing, blocked (another dialog or the drawer),
 * open (the palette is open), prefix (time of the last `g`, 0 none), now, letters (the letters after `g`) }.
 * Returns { open, go, prevent, prefix }: open the palette, go to the page of the letter `go`, stop the browser's own action, the new prefix.
 */
export function decodeKey(e, st) {
  const none = { open: false, go: null, prevent: false, prefix: 0 };
  const key = e.key;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && typeof key === "string" && key.toLowerCase() === "k") {
    return { ...none, open: !st.open && !e.repeat, prevent: true };
  }
  if (st.off || st.typing || st.blocked || st.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return none;
  if (key === "/") return { ...none, open: true, prevent: true };
  const live = st.prefix > 0 && st.now - st.prefix <= PREFIX_MS;
  if (live) {
    // The second key ends the prefix, whatever it is.
    return typeof key === "string" && st.letters.includes(key) ? { ...none, go: key } : none;
  }
  return key === "g" ? { ...none, prefix: st.now } : none;
}

// ---- intents -------------------------------------------------------------------------------------

// A wish is what the page that opens next should do ("choose this flow"). It is kept for 5 seconds, taken when the
// page draws, or handed to a page that is already open. A wish for a new tab goes through localStorage, once, per account.
const pending = new Map();
const handlers = new Map();
const scope = { user: "", store: null, tab: `${Date.now()}-${Math.floor(Math.random() * 1e9)}` };
const wishKey = () => `scf-wish:${scope.user}`;

/** Sets the account and store of the hand-off to another tab. Called by initPalette. */
export function setWishScope(userId, store) {
  scope.user = String(userId ?? "");
  scope.store = store ?? null;
}

/** A page that is open registers what it does with a wish. Returns a function that removes this very handler (not a newer one). */
export function onWish(page, fn) {
  handlers.set(page, fn);
  return () => { if (handlers.get(page) === fn) handlers.delete(page); };
}

/** Gives the wish to the open page, or keeps it for the page that opens next. */
export function sendWish(page, wish) {
  const fn = handlers.get(page);
  if (fn) {
    pending.delete(page);
    fn(wish);
    return;
  }
  pending.set(page, { wish, at: Date.now() });
}

/** The wish for `page`, once; null when there is none or it is older than 5 seconds. */
export function takeWish(page) {
  const mine = pending.get(page);
  pending.delete(page);
  if (mine && Date.now() - mine.at <= WISH_MS) return mine.wish;
  return takeHandoff(page);
}

/** Forgets a wish that was not taken (the navigation was refused). */
export function dropWish(page) {
  pending.delete(page);
}

/** Leaves a wish for another tab of this account: the first page of another tab that draws `page` takes it. */
export function handoffWish(page, wish) {
  if (!scope.store || !scope.user) return;
  try { scope.store.setItem(wishKey(), JSON.stringify({ tab: scope.tab, page, wish, at: Date.now() })); } catch { /* no hand-off without storage */ }
}

function takeHandoff(page) {
  if (!scope.store || !scope.user) return null;
  try {
    const raw = scope.store.getItem(wishKey());
    if (!raw) return null;
    const w = JSON.parse(raw);
    // Not the tab that wrote it, only the page it was meant for, only while fresh.
    if (!w || w.tab === scope.tab || w.page !== page) return null;
    scope.store.setItem(wishKey(), "");
    return typeof w.at === "number" && Date.now() - w.at <= WISH_MS ? (w.wish ?? null) : null;
  } catch {
    return null;
  }
}

/** For tests: forget every wish, handler and the scope. */
export function resetWishes() {
  pending.clear();
  handlers.clear();
  scope.user = "";
  scope.store = null;
}
