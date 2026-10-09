import { api } from "./api.js";
import { h, mount, tabStops, toast, trapTarget } from "./dom.js";
import { workBoard } from "./work-board.js";
import { displayMenu } from "./work-display.js";
import { listView, refreshAges } from "./work-list.js";
import { DEFAULTS, applyFilters, boardPrefs, columnsOf, facets, groupItems, isFiltered, keyOf, workItems } from "./work-model.js";
import { PANEL_ID, panelView } from "./work-panel.js";
import { cleanPrefs, loadPrefs, savePrefs } from "./work-prefs.js";

// The Work page (redesign): every story as a board or a list, from GET /api/board. Status, column, sentence and
// blockers come from the server's record; this file only filters, groups, orders and draws.

const AGE_MS = 60_000;

/** A select; `choices` are `{ id, name }`. */
const pick = (focus, title, value, choices, onPick) =>
  h("select", { class: "small-select", "data-focus": focus, title, "aria-label": title, onChange: (e) => onPick(e.target.value) },
    choices.map((c) => h("option", { value: c.id, selected: c.id === value }, c.name)));

/** The count line, the list or an empty state: returns nodes. */
export function workBody(data, prefs, handlers) {
  const items = workItems(data);
  if (!items.length && data?.empty) return [h("div", { class: "empty" }, data.empty)];
  const shown = applyFilters(items, prefs);
  const nodes = [];
  if (shown.length < items.length) nodes.push(h("div", { class: "muted work-count" }, `${shown.length} of ${items.length} stories`));
  if (!shown.length && isFiltered(prefs)) {
    nodes.push(h("div", { class: "empty" }, "No story matches the filters.", " ",
      h("button", { class: "small", "data-focus": "work-clear", onClick: () => handlers.onClear() }, "Clear filters")));
    return nodes;
  }
  const groups = groupItems(shown, boardPrefs(prefs), columnsOf(data));
  nodes.push(...(prefs.layout === "list" ? listView(groups, prefs, handlers) : [workBoard(groups, prefs, handlers)]));
  return nodes;
}

/** The toolbar and the body: returns nodes (the body is the last). */
export function workView(data, prefs, handlers) {
  const items = workItems(data);
  const body = h("div", { class: "work-body" }, workBody(data, prefs, handlers));
  if (!items.length && data?.empty) return [h("div", { class: "toolbar work-bar" }, h("h1", {}, "Work")), body];
  const f = facets(items, data);
  const withAll = (all, list) => [{ id: "", name: all }, ...list.map((c) => ({ id: c.id, name: `${c.name} (${c.count})` }))];
  const { onChange } = handlers;
  const status = new Set(prefs.status);
  const toggle = (id) => onChange({ status: columnsOf(data).map((c) => c.id).filter((x) => (x === id ? !status.has(id) : status.has(x))) });
  const toolbar = h("div", { class: "toolbar work-bar" },
    h("h1", {}, "Work"),
    pick("work-repo", "Show one repository", prefs.repo, withAll("All repositories", f.repos), (repo) => onChange({ repo })),
    pick("work-owner", "Show the stories of one account", prefs.owner, withAll("All owners", f.owners), (owner) => onChange({ owner })),
    pick("work-who", "Show the stories by who has the next move", prefs.who, withAll("Any next move", f.who), (who) => onChange({ who })),
    columnsOf(data).map((c) => h("button", {
      class: status.has(c.id) ? "small primary" : "small", "data-focus": `work-status-${c.id}`, "aria-pressed": status.has(c.id) ? "true" : "false",
      title: `Show only ${c.title}`, onClick: () => toggle(c.id),
    }, c.title)),
    h("input", {
      type: "search", placeholder: "Title or #issue", title: "Find a story by title or issue number", "aria-label": "Find a story", "data-focus": "work-text",
      value: prefs.text, onInput: (e) => handlers.onText(e.target.value),
    }),
    h("div", { class: "seg", role: "group", "aria-label": "Layout" },
      ["board", "list"].map((id) => h("button", {
        class: prefs.layout === id ? "on" : "", "data-focus": `work-layout-${id}`,
        "aria-pressed": prefs.layout === id ? "true" : "false", onClick: () => onChange({ layout: id }),
      }, id === "board" ? "Board" : "List"))),
    displayMenu(prefs, onChange, { open: handlers.menuOpen, onToggle: handlers.onMenu }));
  return [toolbar, body];
}

/** Opens the page and returns at once a function that closes it. */
export function renderWork(main, wantedRepo, { user, store, now, media = globalThis.matchMedia?.("(max-width: 760px)") } = {}) {
  let closed = false;
  let data;
  let last;
  let left; // the watcher of a card whose GitHub link was opened: check GitHub again when the user comes back
  let bodyEl;
  let menuOpen = false; // the Display menu stays open when the page draws itself again
  const stops = new Map(); // the card with the Tab stop of each board column
  // The side panel: the key of the open story, the stories before it (for Back), the control that opened it. Never saved.
  let open = null;
  let history = [];
  let opener = null;
  let slot;
  let prefs = loadPrefs(user, store);
  if (wantedRepo) prefs = { ...prefs, repo: wantedRepo };
  const heading = h("div", { class: "toolbar" }, h("h1", {}, "Work"));

  const handlers = {
    onChange: (patch) => {
      if (Object.entries(patch).every(([k, v]) => JSON.stringify(prefs[k]) === JSON.stringify(v))) return; // nothing changed: no redraw
      prefs = { ...prefs, ...patch };
      savePrefs(user, prefs, store);
      draw();
    },
    onText: (value) => {
      prefs = { ...prefs, text: value };
      savePrefs(user, prefs, store);
      mount(bodyEl, workBody(data, prefs, handlers));
    },
    onClear: () => {
      prefs = { ...prefs, repo: DEFAULTS.repo, owner: DEFAULTS.owner, status: [], who: DEFAULTS.who, text: DEFAULTS.text };
      savePrefs(user, prefs, store);
      draw();
    },
    stops,
    get menuOpen() { return menuOpen; },
    onMenu: (v) => { menuOpen = v; },
    onLeave: (card) => { if (card.watcher) left = card.watcher; },
    get now() { return now?.(); },
    get openKey() { return open; },
    onOpen: (item, focusName) => openPanel(item, focusName),
  };

  function panelNodes() {
    const items = workItems(data);
    const item = open && items.find((i) => keyOf(i) === open);
    if (!item) return [];
    return [panelView(item, items, {
      onClose: closePanel, onBack: history.length ? back : undefined, onPick: pickStory, onLeave: handlers.onLeave, now: now?.(), narrow: !!media?.matches,
    })];
  }

  /** Draws the panel in its slot. The focus stays on the same control of the panel; `focusTitle` moves it to the heading. */
  function showPanel(focusTitle) {
    const active = document.activeElement;
    const name = active && slot.contains(active) ? active.getAttribute("data-focus") : null;
    slot.replaceChildren(...panelNodes());
    for (const el of main.querySelectorAll("[data-way]")) el.setAttribute("aria-expanded", String(el.getAttribute("data-way") === open));
    const same = !focusTitle && name ? [...slot.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === name) : null;
    (same ?? (focusTitle || name ? slot.querySelector("h2") : null))?.focus({ preventScroll: true });
  }

  function openPanel(item, focusName) {
    if (open === keyOf(item)) return closePanel();
    history = [];
    opener = focusName;
    open = keyOf(item);
    showPanel(true);
  }

  function pickStory(item) {
    history.push(open);
    open = keyOf(item);
    showPanel(true);
  }

  function back() {
    open = history.pop();
    showPanel(true);
  }

  function focusOpener() {
    const to = opener && [...main.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === opener);
    if (to) to.focus({ preventScroll: true });
    else {
      const top = main.querySelector("h1");
      top?.setAttribute("tabindex", "-1");
      top?.focus({ preventScroll: true });
    }
    opener = null;
  }

  function closePanel() {
    open = null;
    history = [];
    showPanel(false);
    focusOpener();
  }

  function draw() {
    const nodes = workView(data, prefs, handlers);
    bodyEl = nodes[nodes.length - 1];
    slot = h("div", { id: PANEL_ID, class: "work-panel-slot" }, panelNodes());
    mount(main, [...nodes.slice(0, -1), h("div", { class: "work-split" }, bodyEl, slot)]);
  }

  const fetchOnce = async () => {
    let next;
    try {
      next = await api.board();
    } catch (e) {
      if (!closed && !data) {
        mount(main, heading, h("div", { class: "errors" }, e.message), h("button", { "data-focus": "work-retry", onClick: () => load() }, "Retry"));
      }
      return;
    }
    if (closed) return;
    const text = JSON.stringify(next);
    if (text === last) return;
    last = text;
    data = next;
    prefs = cleanPrefs(prefs, data);
    // The panel follows the data: a story that is gone closes it (and drops out of Back).
    const keys = new Set(workItems(data).map(keyOf));
    history = history.filter((k) => keys.has(k));
    let inPanel = false;
    if (open && !keys.has(open)) {
      toast(`#${open.slice(open.lastIndexOf("#") + 1)} is no longer on the board`);
      inPanel = !!slot?.contains(document.activeElement);
      open = null;
      history = [];
    }
    draw();
    if (inPanel) focusOpener();
  };

  // One request at a time: a slow server is never asked again before it answered.
  let busy = false;
  let again = false; // asked for while busy: ask once more when done
  const load = async () => {
    if (closed) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      await fetchOnce();
    } finally {
      busy = false;
      if (again && !closed) { again = false; load(); }
    }
  };

  mount(main, heading, h("p", { class: "muted" }, "Loading…"));
  const timer = setInterval(() => { if (!busy) load(); }, 5000);
  // The age of a story grows while the answer stays the same: update those cells only.
  const ageTimer = setInterval(() => { if (data) refreshAges(main, now?.()); }, AGE_MS);
  load();
  const onVisible = async () => {
    if (document.visibilityState !== "visible" || !left) return;
    const id = left;
    left = undefined;
    await api.tickWatcher(id).catch(() => {});
    if (!closed) load();
  };
  document.addEventListener("visibilitychange", onVisible);
  const onKey = (e) => {
    if (!open) return;
    if (e.key === "Escape") return closePanel();
    if (e.key !== "Tab" || !media?.matches) return;
    const to = trapTarget(tabStops(slot), document.activeElement, e.shiftKey);
    if (to) {
      e.preventDefault();
      to.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  const onMedia = () => { if (open) showPanel(!!media?.matches); }; // into the dialog: the focus goes in with it
  media?.addEventListener?.("change", onMedia);
  return () => {
    document.removeEventListener("keydown", onKey);
    media?.removeEventListener?.("change", onMedia);
    closed = true;
    clearInterval(timer);
    clearInterval(ageTimer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
