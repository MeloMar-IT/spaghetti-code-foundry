import { h, modal, mount } from "./dom.js";
import { icon } from "./icons.js";

// Theme and density, kept in the browser per account (localStorage) and shared by its tabs, so every write
// reads the store first. `prefs-boot.js` reads the same key before the page is drawn.

export const THEMES = ["system", "light", "dark"];
export const DENSITIES = ["comfortable", "compact"];
export const DEFAULTS = { theme: "system", density: "comfortable" };
export const KEY = "scf.prefs";
export const MAX_ACCOUNTS = 20;

const THEME_OPTIONS = [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]];
const DENSITY_OPTIONS = [["comfortable", "Comfortable", "rows-2"], ["compact", "Compact", "rows-3"]];

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

function writeState(state, store) {
  try {
    store.setItem(KEY, JSON.stringify(state));
  } catch {
    // no storage: nothing is remembered
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
  const state = readState(store);
  const p = cleanPrefs(prefs);
  let accounts = accountsOf(state);
  if (validId(accountId)) {
    const entries = Object.entries(accounts).filter(([id]) => id !== accountId);
    entries.push([accountId, p]);
    accounts = Object.fromEntries(entries.slice(-MAX_ACCOUNTS));
  }
  writeState({ ...state, v: 1, last: p, accounts }, store);
  return p;
}

/** Sets both attributes on <html>. "system" and "comfortable" match no CSS rule. */
export function applyPrefs(prefs, root = document.documentElement) {
  const p = cleanPrefs(prefs);
  try {
    root.setAttribute("data-theme", p.theme);
    root.setAttribute("data-density", p.density);
  } catch {
    // no page to style
  }
  return p;
}

/** Applies the account's choice and makes it the last one, from one read of the store. */
export function initPrefs(user, { store = defaultStore(), root } = {}) {
  const state = readState(store);
  const p = applyPrefs(pick(state, user?.id), root);
  const last = cleanPrefs(state.last);
  if (!state.last || last.theme !== p.theme || last.density !== p.density) {
    writeState({ ...state, v: 1, last: p, accounts: accountsOf(state) }, store);
  }
  return p;
}

/** The Appearance dialog: a click applies the choice at once and saves it. */
export function appearanceDialog(user, { store = defaultStore(), root } = {}) {
  return modal("Appearance", () => {
    let cur = readPrefs(user?.id, store);
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
            cur = applyPrefs({ ...cur, [key]: value }, root);
            writePrefs(user?.id, cur, store);
            draw();
          },
        }, icon(iconName, { small: true }), text, on ? icon("check", { small: true }) : null);
      };
      return h("div", { class: "field" },
        h("span", {}, label),
        h("div", { class: "seg", role: "group", "aria-label": label }, options.map(button)));
    };

    function draw() {
      mount(body, group("Theme", "theme", THEME_OPTIONS), group("Density", "density", DENSITY_OPTIONS), note);
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
