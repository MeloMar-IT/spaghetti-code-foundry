import { api } from "./api.js";
import { h, mount, tabStops, timeAgo, trapTarget } from "./dom.js";
import { commandsFor, resolve } from "./ia.js";
import {
  addRecent, allowedHit, decodeKey, dropWish, filterCommands, handoffWish, isTypingTarget, keysOff, pruneRecents, readRecents,
  sendWish, setKeysOff, setWishScope, wishFor,
} from "./palette-data.js";
import { announcePage, safeStore } from "./shell.js";

// The command palette (Ctrl/⌘+K, "/", the Search button). It is a dialog of its own, drawn in #modal-root next to
// any dialog that is already open; it needs combobox and listbox semantics that the shared dialog helper has not.
// It only opens things. Entity results come from GET /api/search and nowhere else.

const DEBOUNCE_MS = 200;
const NAV_WAIT_MS = 2000;
let seq = 0;

/**
 * Sets up the palette for a signed-in account. `preview`: the read-only view of another account (no recent items,
 * no action that would start something). `search`, `recent`, `store` and `openTab` can be replaced by a test.
 * Returns a stop function.
 */
export function initPalette({
  role, user, preview = false, search = (q) => api.search(q), recent = (refs) => api.recent(refs), store = safeStore(),
  openTab = (url) => window.open(url, "_blank", "noopener"),
} = {}) {
  const uid = String(user?.id ?? "");
  setWishScope(uid, store);
  const cmds = commandsFor(role, { preview });
  const everything = [...cmds.goTo, ...cmds.actions];
  const letters = everything.filter((c) => c.key).map((c) => c.key);
  const undo = [];
  let ui = null; // the open palette
  let prefix = 0; // time of the last `g`
  let timer; // the debounce of the search
  let qGen = 0; // advances with every change of the text and when the palette closes or opens
  let rGen = 0; // the same for the request of the recent items
  let nav = null; // a navigation that waits for its hashchange

  const rootEl = () => document.getElementById("modal-root");
  const cmdEntry = (c) => ({
    label: c.label, meta: [c.hint].filter(Boolean), shortcut: c.key ? `g ${c.key}` : "", href: c.href,
    intent: c.intent ? { page: c.intent, wish: {} } : null, record: null,
  });
  const hitEntry = (hit) => ({
    label: hit.title, meta: [hit.status, hit.repo, hit.owner, hit.at ? timeAgo(hit.at) : ""].filter(Boolean), shortcut: "", href: hit.href,
    intent: wishFor(role, hit), record: { type: hit.type, id: hit.id },
  });
  const record = (en) => { if (!preview && en.record) addRecent(store, uid, en.record); };
  const alive = (u) => u.backdrop.parentNode === rootEl();
  const stopKey = (e) => e.stopPropagation?.();

  // ---- drawing -----------------------------------------------------------------------------------

  function groups() {
    const q = ui.input.value.trim();
    const out = [];
    if (!q && ui.recents.length) out.push({ label: "Recent", entries: ui.recents.map(hitEntry) });
    const go = filterCommands(cmds.goTo, q);
    if (go.length) out.push({ label: "Go to", entries: go.map(cmdEntry) });
    const actions = filterCommands(cmds.actions, q);
    if (actions.length) out.push({ label: "Actions", entries: actions.map(cmdEntry) });
    if (q) for (const g of ui.groups) out.push({ label: g.label, entries: g.hits.map(hitEntry) });
    return out;
  }

  function setActive(i) {
    const n = ui.flat.length;
    ui.active = n ? ((i % n) + n) % n : 0;
    ui.nodes.forEach((node, at) => node.setAttribute("aria-selected", String(at === ui.active)));
    const on = ui.nodes[ui.active];
    if (on) ui.input.setAttribute("aria-activedescendant", on.getAttribute("id"));
    else ui.input.removeAttribute("aria-activedescendant");
    on?.scrollIntoView?.({ block: "nearest" });
  }

  function render() {
    ui.flat = [];
    ui.nodes = [];
    const gs = groups().map((g, gi) => {
      const head = `${ui.base}-g${gi}`;
      return h("div", { role: "group", "aria-labelledby": head },
        h("div", { class: "palette-head", id: head }, g.label),
        g.entries.map((en) => {
          const i = ui.flat.push(en) - 1;
          const node = h("div", { role: "option", id: `${ui.base}-o${i}`, "aria-selected": "false", class: "palette-opt", onClick: (e) => activate(en, !!(e?.ctrlKey || e?.metaKey)) },
            h("span", {}, en.label),
            en.meta.length ? h("span", { class: "palette-meta" }, en.meta.join(" · ")) : null,
            en.shortcut ? h("span", { class: "palette-key" }, en.shortcut) : null);
          ui.nodes.push(node);
          return node;
        }));
    });
    mount(ui.list, gs);
    ui.input.setAttribute("aria-expanded", String(ui.flat.length > 0));
    setActive(0);
  }

  const say = (text) => { ui.status.textContent = text; };
  const countText = (n) => `${n} option${n === 1 ? "" : "s"}.`;

  // ---- the search and the recent items -----------------------------------------------------------

  function typed() {
    qGen++;
    clearTimeout(timer);
    ui.groups = [];
    const q = ui.input.value.trim();
    render();
    say("");
    if (!q) { say(countText(ui.flat.length)); return; }
    const mine = qGen;
    timer = setTimeout(() => ask(q, mine, ui), DEBOUNCE_MS);
  }

  async function ask(q, mine, u) {
    if (mine !== qGen || ui !== u) return;
    let ans;
    try {
      ans = await search(q);
    } catch {
      if (mine !== qGen || ui !== u) return;
      render();
      say("Search is not available. Pages and actions are still listed.");
      return;
    }
    if (mine !== qGen || ui !== u) return;
    u.groups = (Array.isArray(ans?.groups) ? ans.groups : [])
      .map((g) => ({ label: String(g?.label ?? ""), hits: (Array.isArray(g?.hits) ? g.hits : []).filter((hit) => allowedHit(role, hit)) }))
      .filter((g) => g.hits.length);
    render();
    const n = u.flat.length;
    const missing = Array.isArray(ans?.incomplete) && ans.incomplete.length ? " Some results are missing." : "";
    say((n ? `${n} result${n === 1 ? "" : "s"}.` : `No results for "${q}".`) + missing);
  }

  async function loadRecents(u) {
    if (preview) return;
    const refs = readRecents(store, uid);
    if (!refs.length) return;
    const mine = ++rGen;
    let ans;
    try {
      ans = await recent(refs);
    } catch {
      return; // nothing is shown and nothing is removed
    }
    if (mine !== rGen || ui !== u || !Array.isArray(ans?.groups)) return;
    const hits = ans.groups.flatMap((g) => (Array.isArray(g?.hits) ? g.hits : []));
    const kept = pruneRecents(store, uid, hits.filter((x) => x && typeof x.id === "string"), Array.isArray(ans.incomplete) ? ans.incomplete : []);
    u.recents = kept.map((r) => hits.find((x) => x.type === r.type && x.id === r.id)).filter((x) => x && allowedHit(role, x));
    if (u.input.value.trim()) return;
    render();
    const missing = Array.isArray(ans.incomplete) && ans.incomplete.length ? " Some recent items could not be checked." : "";
    say(countText(u.flat.length) + missing);
  }

  // ---- open and close ----------------------------------------------------------------------------

  function open(opener = document.activeElement) {
    if (ui && alive(ui)) { ui.input.focus(); return; }
    qGen++;
    const base = `palette-${++seq}`;
    const input = h("input", {
      class: "palette-input", type: "text", role: "combobox", "aria-label": "Search", "aria-autocomplete": "list", "aria-expanded": "false",
      "aria-controls": `${base}-list`, autocomplete: "off", maxlength: 100, placeholder: "Search pages, actions, runs, issues…",
    });
    const status = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    const list = h("div", { id: `${base}-list`, class: "palette-list", role: "listbox", "aria-label": "Results" });
    const keys = h("input", { type: "checkbox", checked: !keysOff(store) });
    keys.addEventListener("change", () => setKeysOff(store, !keys.checked));
    const box = h("div", { class: "modal palette", role: "dialog", "aria-modal": "true", "aria-label": "Search", tabindex: "-1" },
      input, status, list, h("label", { class: "row" }, keys, " Single-key shortcuts (/ and g)"));
    const backdrop = h("div", { class: "backdrop", onMousedown: (e) => e.target === e.currentTarget && close() }, box);
    const u = { base, input, status, list, box, backdrop, opener, groups: [], recents: [], flat: [], nodes: [], active: 0 };
    ui = u;
    input.addEventListener("input", typed);
    rootEl().append(backdrop);
    render();
    input.focus();
    void loadRecents(u);
  }

  function close({ focus = true } = {}) {
    const u = ui;
    if (!u) return;
    ui = null;
    qGen++;
    rGen++;
    clearTimeout(timer);
    u.backdrop.remove();
    if (focus) u.opener?.focus?.();
  }

  // ---- opening something -------------------------------------------------------------------------

  function activate(en, tab) {
    if (tab) {
      // A new tab: the palette stays. The wish goes through the store, because the other tab has its own memory.
      if (en.intent) handoffWish(en.intent.page, en.intent.wish);
      openTab(`${location.pathname}${location.search}${en.href}`);
      record(en);
      return;
    }
    const opener = ui?.opener ?? document.activeElement;
    close({ focus: false });
    navigate(en, opener);
  }

  function navigate(en, opener) {
    nav?.cancel();
    if (location.hash === en.href) {
      // The page is open: nothing is drawn again; the wish goes to the page as it is.
      announcePage();
      if (en.intent) sendWish(en.intent.page, en.intent.wish);
      record(en);
      return;
    }
    if (en.intent) sendWish(en.intent.page, en.intent.wish);
    let wait;
    const cancel = () => {
      window.removeEventListener("hashchange", after);
      clearTimeout(wait);
      if (nav?.cancel === cancel) nav = null;
    };
    // Our listener comes after the router's: when the router refused, the old hash is back by now.
    const finish = (ok) => {
      cancel();
      if (ok) return record(en);
      if (en.intent) dropWish(en.intent.page);
      opener?.focus?.();
    };
    const after = () => finish(resolve(role, location.hash).hash === resolve(role, en.href).hash);
    window.addEventListener("hashchange", after);
    wait = setTimeout(() => finish(false), NAV_WAIT_MS);
    nav = { cancel };
    location.hash = en.href;
  }

  // ---- keys --------------------------------------------------------------------------------------

  function paletteKey(e) {
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && typeof k === "string" && k.toLowerCase() === "k") {
      e.preventDefault?.();
      stopKey(e);
      ui.input.focus();
    } else if (k === "Escape") {
      e.preventDefault?.();
      stopKey(e);
      close();
    } else if (k === "Tab") {
      stopKey(e);
      const to = trapTarget(tabStops(ui.box), document.activeElement, e.shiftKey);
      if (to) { e.preventDefault?.(); to.focus(); }
    } else if ((k === "ArrowDown" || k === "ArrowUp") && document.activeElement === ui.input) {
      e.preventDefault?.();
      stopKey(e);
      setActive(ui.active + (k === "ArrowDown" ? 1 : -1));
    } else if (k === "Enter" && document.activeElement === ui.input) {
      e.preventDefault?.();
      stopKey(e);
      const en = ui.flat[ui.active];
      if (en) activate(en, !!(e.ctrlKey || e.metaKey));
    }
  }

  function onKey(e) {
    if (ui && !alive(ui)) close({ focus: false }); // another dialog cleared the root under it
    if (ui) return paletteKey(e);
    const blocked = (rootEl()?.children?.length ?? 0) > 0 || !!document.body?.classList?.contains?.("drawer-open");
    const r = decodeKey(e, { off: keysOff(store), typing: isTypingTarget(e.target ?? document.activeElement), blocked, open: false, prefix, now: Date.now(), letters });
    prefix = r.prefix;
    if (r.prevent) e.preventDefault?.();
    if (r.open) open();
    else if (r.go) {
      const c = everything.find((x) => x.key === r.go);
      if (c) navigate(cmdEntry(c), document.activeElement);
    }
  }

  document.addEventListener("keydown", onKey, true);
  undo.push(() => document.removeEventListener("keydown", onKey, true));
  const btn = document.getElementById("search-btn");
  const onButton = () => open(btn);
  btn?.addEventListener?.("click", onButton);
  undo.push(() => btn?.removeEventListener?.("click", onButton));

  return () => {
    close();
    nav?.cancel();
    for (const f of undo.splice(0)) f();
  };
}
