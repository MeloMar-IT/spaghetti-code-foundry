import { h, modal, mount } from "./dom.js";
import { icon } from "./icons.js";

// Theme, density and look, kept in the browser per account (localStorage) and shared by its tabs, so every write
// reads the store first. `prefs-boot.js` reads the same key before the page is drawn.

export const THEMES = ["system", "light", "dark"];
export const DENSITIES = ["comfortable", "compact"];
export const LOOKS = ["calm", "midnight", "friendly", "editorial", "bento"];
export const DEFAULTS = { theme: "system", density: "comfortable", look: "calm" };
export const KEY = "scf.prefs";
export const MAX_ACCOUNTS = 20;

const THEME_OPTIONS = [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]];
const DENSITY_OPTIONS = [["comfortable", "Comfortable", "rows-2"], ["compact", "Compact", "rows-3"]];
const LOOK_OPTIONS = [["calm", "Calm", null], ["midnight", "Midnight", null], ["friendly", "Friendly", null], ["editorial", "Editorial", null], ["bento", "Bento", null]];

const defaultStore = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const isObject = (x) => x && typeof x === "object" && !Array.isArray(x);
const validId = (id) => typeof id === "string" && id !== "";

/** Unknown or missing values become the defaults. */
export function cleanPrefs(x) {
  const o = isObject(x) ? x : {};
  return {
    theme: THEMES.includes(o.theme) ? o.theme : DEFAULTS.theme,
    density: DENSITIES.includes(o.density) ? o.density : DEFAULTS.density,
    look: LOOKS.includes(o.look) ? o.look : DEFAULTS.look,
  };
}

/** The stored state: { v: 1, last, accounts }; empty when storage is missing, throws, or holds anything else. */
function readState(store) {
  try {
    const s = JSON.parse(store.getItem(KEY));
    return isObject(s) && s.v === 1 ? s : {};
  } catch {
    return {};
  }
}

/** Returns false when the store refused the write (no storage, quota, or a throw). */
function writeState(state, store) {
  try {
    store.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    // no storage: nothing is remembered
    return false;
  }
}

const accountsOf = (state) => (isObject(state.accounts) ? state.accounts : {});

function pick(state, accountId) {
  const accounts = accountsOf(state);
  if (validId(accountId) && Object.hasOwn(accounts, accountId)) return cleanPrefs(accounts[accountId]);
  return cleanPrefs(state.last);
}

/** The account's choice, else the last one made in this browser, else the defaults. */
export function readPrefs(accountId, store = defaultStore()) {
  return pick(readState(store), accountId);
}

/** Saves the account's choice and makes it the last one. At most 20 accounts are kept; the oldest go first. */
export function writePrefs(accountId, prefs, store = defaultStore()) {
  saveAccount(accountId, prefs, store);
  return cleanPrefs(prefs);
}

/** Like writePrefs, and says whether the store accepted the write. */
function saveAccount(accountId, prefs, store) {
  const state = readState(store);
  const p = cleanPrefs(prefs);
  let accounts = accountsOf(state);
  if (validId(accountId)) {
    const entries = Object.entries(accounts).filter(([id]) => id !== accountId);
    entries.push([accountId, p]);
    accounts = Object.fromEntries(entries.slice(-MAX_ACCOUNTS));
  }
  return writeState({ ...state, v: 1, last: p, accounts }, store);
}

/** Sets the three attributes on <html>. "system", "comfortable" and "calm" match no CSS rule. */
export function applyPrefs(prefs, root = document.documentElement) {
  const p = cleanPrefs(prefs);
  try {
    root.setAttribute("data-theme", p.theme);
    root.setAttribute("data-density", p.density);
    root.setAttribute("data-look", p.look);
  } catch {
    // no page to style
  }
  return p;
}

/** Applies the account's choice and makes it the last one, from one read of the store. */
export function initPrefs(user, { store = defaultStore(), root, target } = {}) {
  const state = readState(store);
  const p = applyPrefs(pick(state, user?.id), root);
  const last = cleanPrefs(state.last);
  if (!state.last || last.theme !== p.theme || last.density !== p.density || last.look !== p.look) {
    writeState({ ...state, v: 1, last: p, accounts: accountsOf(state) }, store);
  }
  watchPrefs(user, { store, root, target });
  return p;
}

let stopWatching = null;

/**
 * Applies a change made in another tab of this browser (a "storage" event for our key) to this page,
 * for this account. Only one watcher lives at a time; a new call replaces the old one. Returns a stop function.
 */
export function watchPrefs(user, { store = defaultStore(), root, target = globalThis } = {}) {
  if (stopWatching) stopWatching();
  stopWatching = null;
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const onStorage = (e) => {
    if (e && e.key != null && e.key !== KEY) return;
    applyPrefs(readPrefs(user?.id, store), root);
  };
  target.addEventListener("storage", onStorage);
  const stop = () => {
    try {
      target.removeEventListener("storage", onStorage);
    } catch {
      // nothing to remove
    }
    if (stopWatching === stop) stopWatching = null;
  };
  stopWatching = stop;
  return stop;
}

/** The Appearance dialog: a click applies the choice at once and saves it. */
export function appearanceDialog(user, { store = defaultStore(), root } = {}) {
  return modal("Appearance", () => {
    let cur = readPrefs(user?.id, store);
    let unsaved = new Set(); // keys changed here that the store refused, kept on screen until a write succeeds
    const body = h("div", { class: "prefs" });
    const note = h("p", { class: "muted" }, "Kept in this browser for your account. Not sent to the server.");

    const group = (label, key, options) => {
      const button = ([value, text, iconName]) => {
        const on = cur[key] === value;
        return h("button", {
          type: "button",
          class: on ? "on" : null,
          "aria-pressed": String(on),
          "data-focus": `${key}-${value}`,
          onClick: () => {
            // Start from the store, so changes made in other tabs since the dialog opened are kept.
            // Choices the store refused stay as they are on screen.
            const base = readPrefs(user?.id, store);
            for (const k of unsaved) base[k] = cur[k];
            base[key] = value;
            cur = applyPrefs(base, root);
            unsaved = saveAccount(user?.id, cur, store) ? new Set() : new Set([...unsaved, key]);
            draw();
          },
        }, iconName ? icon(iconName, { small: true }) : null, text, on ? icon("check", { small: true }) : null);
      };
      return h("div", { class: "field" },
        h("span", {}, label),
        h("div", { class: "seg", role: "group", "aria-label": label }, options.map(button)));
    };

    function draw() {
      mount(body, group("Theme", "theme", THEME_OPTIONS), group("Density", "density", DENSITY_OPTIONS), group("Look", "look", LOOK_OPTIONS), note);
    }
    draw();
    return body;
  });
}

export function appearanceButton(user, opts) {
  return h("button", { class: "small", type: "button", onClick: () => appearanceDialog(user, opts) }, icon("monitor", { small: true }), "Appearance");
}

// The names the issue gave to this API; the UI word is "Appearance".
export const displayDialog = appearanceDialog;
export const displayButton = appearanceButton;
