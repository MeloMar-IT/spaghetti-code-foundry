import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { listView, refreshAges } from "./work-list.js";
import { DEFAULTS, GROUPS, ORDERS, applyFilters, columnsOf, facets, groupItems, isFiltered, workItems } from "./work-model.js";
import { cleanPrefs, loadPrefs, savePrefs } from "./work-prefs.js";

// The Work page (redesign): every story as a list, from GET /api/board. Status, column, sentence and
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
  nodes.push(...listView(groupItems(shown, prefs, columnsOf(data)), prefs, handlers));
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
    pick("work-group", "Group the stories", prefs.group, GROUPS.map((g) => ({ id: g.id, name: g.label })), (group) => onChange({ group })),
    pick("work-order", "Order the stories", prefs.order, ORDERS.map((o) => ({ id: o.id, name: o.label })), (order) => onChange({ order })));
  return [toolbar, body];
}

/** Opens the page and returns at once a function that closes it. */
export function renderWork(main, wantedRepo, { user, store, now } = {}) {
  let closed = false;
  let data;
  let last;
  let left; // the watcher of a card whose GitHub link was opened: check GitHub again when the user comes back
  let bodyEl;
  let prefs = loadPrefs(user, store);
  if (wantedRepo) prefs = { ...prefs, repo: wantedRepo };
  const heading = h("div", { class: "toolbar" }, h("h1", {}, "Work"));

  const handlers = {
    onChange: (patch) => { prefs = { ...prefs, ...patch }; savePrefs(user, prefs, store); draw(); },
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
    onLeave: (card) => { if (card.watcher) left = card.watcher; },
    get now() { return now?.(); },
  };

  function draw() {
    const nodes = workView(data, prefs, handlers);
    bodyEl = nodes[nodes.length - 1];
    mount(main, nodes);
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
    draw();
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
  return () => {
    closed = true;
    clearInterval(timer);
    clearInterval(ageTimer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
