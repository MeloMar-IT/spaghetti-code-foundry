// Saved views: the filters of a list or board kept under a name, per account, in this browser only (localStorage,
// never sent to the server). A view is only an address (page plus query); opening one navigates there. This module
// never calls the API. It imports no page and no context (ui/context.js imports it).
import { confirmDialog, h, modal, mount, showError, toast } from "./dom.js";
import { formatQuery, parseQuery, sameRepo, withQuery } from "./filters.js";
import { ALL_REPOS } from "./ia.js";

export const VIEW_PAGES = ["runs", "board", "refinement", "epics"];
export const MAX_VIEWS = 20;
export const MAX_NAME = 40;
export const OUT_OF_DATE = "out of date";
export const ERRORS = {
  empty: "Give the view a name.",
  long: "A name has at most 40 characters.",
  taken: "A view with this name already exists on this page.",
  full: "You have 20 saved views. Delete one first.",
  page: "This page cannot have saved views.",
  gone: "This view is gone. It may have been changed in another tab.",
  storage: "This browser cannot save views.",
};
export const deleteText = (name) =>
  `Delete the view "${name}"? Only the saved view is removed. Runs, sessions and repositories stay.`;

const defaultStore = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Only the known filter keys, valid; `repo=all` (no repository) is dropped. → { repo?, owner? } */
export function cleanFilters(filters) {
  const out = parseQuery(formatQuery(filters));
  if (out.repo === ALL_REPOS) delete out.repo;
  return out;
}

const lower = (s) => s.toLowerCase();

/** What storage held, cleaned: anything that is not the known shape gives no views; bad entries are dropped. */
export function cleanViews(raw) {
  const out = { v: 1, views: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1 || !Array.isArray(raw.views)) return out;
  const ids = new Set();
  for (const x of raw.views) {
    if (out.views.length >= MAX_VIEWS) break;
    if (!x || typeof x !== "object") continue;
    const { id, page, name } = x;
    if (typeof id !== "string" || !id || id.length > MAX_NAME || ids.has(id)) continue;
    if (!VIEW_PAGES.includes(page) || typeof name !== "string") continue;
    if (!x.filters || typeof x.filters !== "object" || Array.isArray(x.filters)) continue;
    const n = name.trim();
    if (!n || n.length > MAX_NAME) continue;
    if (out.views.some((v) => v.page === page && lower(v.name) === lower(n))) continue;
    ids.add(id);
    out.views.push({ id, page, name: n, filters: cleanFilters(x.filters) });
  }
  return out;
}

// An id is never reused, so a pending action of another tab cannot reach a newer view.
const newId = (taken) => {
  for (;;) {
    const r = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    const id = `v${r}`;
    if (!taken.some((v) => v.id === id)) return id;
  }
};

const copy = (v) => ({ id: v.id, page: v.page, name: v.name, filters: { ...v.filters } });

/**
 * The store of one account: { key, list(pageId), add(pageId, name, filters), rename(id, name), move(id, delta), remove(id) }.
 * Every call reads storage again. When storage cannot be read, `list` is empty and a change is refused (stored bytes
 * stay as they are); data that was read but is garbage counts as no views and is replaced by the next change.
 * A change answers { ok: true, … } or { ok: false, error }.
 */
export function viewStore(accountId, storage = defaultStore()) {
  const key = `scf.views.${accountId || "local"}`;
  const load = () => {
    if (!storage) return null;
    let text;
    try {
      text = storage.getItem(key);
    } catch {
      return null;
    }
    if (text == null) return cleanViews(null);
    try {
      return cleanViews(JSON.parse(text));
    } catch {
      return cleanViews(null);
    }
  };
  const save = (state) => {
    try {
      storage.setItem(key, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  };
  /** Runs `fn(state)`: it returns { error } or { result, write }. */
  const change = (fn) => {
    const state = load();
    if (!state) return { ok: false, error: ERRORS.storage };
    const r = fn(state);
    if (r.error) return { ok: false, error: r.error };
    if (r.write && !save(state)) return { ok: false, error: ERRORS.storage };
    return { ok: true, ...r.result };
  };
  const nameOf = (state, page, name, self) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n) return { error: ERRORS.empty };
    if (n.length > MAX_NAME) return { error: ERRORS.long };
    if (state.views.some((v) => v.id !== self && v.page === page && lower(v.name) === lower(n))) return { error: ERRORS.taken };
    return { name: n };
  };
  return {
    key,
    list: (pageId) => (load()?.views ?? []).filter((v) => v.page === pageId).map(copy),
    add: (pageId, name, filters) => change((state) => {
      if (!VIEW_PAGES.includes(pageId)) return { error: ERRORS.page };
      const n = nameOf(state, pageId, name);
      if (n.error) return n;
      if (state.views.length >= MAX_VIEWS) return { error: ERRORS.full };
      const view = { id: newId(state.views), page: pageId, name: n.name, filters: cleanFilters(filters) };
      state.views.push(view);
      return { write: true, result: { view: copy(view) } };
    }),
    rename: (id, name) => change((state) => {
      const view = state.views.find((v) => v.id === id);
      if (!view) return { error: ERRORS.gone };
      const n = nameOf(state, view.page, name, id);
      if (n.error) return n;
      view.name = n.name;
      return { write: true, result: { view: copy(view) } };
    }),
    move: (id, delta) => change((state) => {
      const view = state.views.find((v) => v.id === id);
      if (!view) return { error: ERRORS.gone };
      const same = state.views.filter((v) => v.page === view.page);
      const to = same[same.indexOf(view) + (delta < 0 ? -1 : 1)];
      if (!to || (delta !== -1 && delta !== 1)) return { result: { changed: false } };
      const a = state.views.indexOf(view);
      const b = state.views.indexOf(to);
      [state.views[a], state.views[b]] = [state.views[b], state.views[a]];
      return { write: true, result: { changed: true } };
    }),
    remove: (id) => change((state) => {
      const at = state.views.findIndex((v) => v.id === id);
      if (at < 0) return { error: ERRORS.gone };
      state.views.splice(at, 1);
      return { write: true, result: {} };
    }),
  };
}

/** The address of a view. Without a repository it writes `repo=all`, so an active repository context cannot change what it means. */
export function viewHash(view) {
  const f = cleanFilters(view?.filters);
  const owner = f.owner ? { owner: f.owner } : {};
  if (view?.page === "board") return f.repo ? withQuery(`#/board/${encodeURIComponent(f.repo)}`, owner) : withQuery("#/board", { repo: ALL_REPOS, ...owner });
  if (view?.page === "epics") return withQuery("#/epics", { repo: f.repo ?? ALL_REPOS });
  const path = view?.page === "refinement" ? "#/refinement" : "#/runs";
  return withQuery(path, { repo: f.repo ?? ALL_REPOS, ...(view?.page === "refinement" ? {} : owner) });
}

/** True when both give the same filters: repository ignoring case, owner exactly; "no repository" and `repo=all` are the same. */
export function sameFilters(a, b) {
  const x = cleanFilters(a);
  const y = cleanFilters(b);
  const repo = x.repo || y.repo ? sameRepo(x.repo, y.repo) : true;
  return repo && (x.owner ?? "") === (y.owner ?? "");
}

/** True when the repository of the view is not in `repos`, or its owner is not in `owners`. A list that is null is not known and marks nothing. */
export function isStale(view, { repos = null, owners = null } = {}) {
  const f = view?.filters ?? {};
  if (f.repo && Array.isArray(repos) && !repos.some((r) => sameRepo(r, f.repo))) return true;
  if (f.owner && Array.isArray(owners) && !owners.includes(f.owner)) return true;
  return false;
}

const pill = () => h("span", { class: "pill" }, OUT_OF_DATE);

/** The row of links above a list. Null without views. `active` is the id of the view the page shows. */
export function viewsRow(views, active, { stale = () => false, onManage } = {}) {
  if (!Array.isArray(views) || !views.length) return null;
  return h("nav", { class: "filter-bar", "aria-label": "Saved views" },
    views.map((v) => {
      const on = v.id === active;
      return h("a", { class: on ? "btn primary" : "btn", href: viewHash(v), "aria-current": on ? "true" : null, "data-focus": `view-${v.id}` }, v.name, stale(v) ? [" ", pill()] : null);
    }),
    h("button", { type: "button", class: "small", "data-focus": "views-manage", onClick: () => onManage?.() }, "Manage views"));
}

/** The dialog that asks for a name and stores the view. Resolves true only after a save. */
export function saveViewDialog(store, pageId, filters) {
  return modal("Save view", (close) => {
    const line = h("p", { class: "status bad", role: "alert" });
    const input = h("input", { type: "text", maxlength: String(MAX_NAME), "data-focus": "view-name", onKeydown: (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault?.();
      save();
    } });
    const save = () => {
      const r = store.add(pageId, input.value, filters);
      if (!r.ok) return showError(line, r.error, { fields: [input], field: input });
      return close(true);
    };
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Name of the view"), input),
      line,
      h("div", { class: "row" }, h("span", { class: "spacer" }),
        h("button", { type: "button", onClick: () => close(false) }, "Cancel"),
        h("button", { type: "button", class: "primary", onClick: save }, "Save")));
  }).then((answer) => answer === true);
}

/** The dialog that renames, moves and deletes the views of one page. Resolves when it is closed. */
export function manageViewsDialog(store, pageId, { stale = () => false } = {}) {
  return modal("Manage views", (close) => {
    const box = h("div", { class: "stack" });
    let mode = null; // { kind: "rename" | "delete", id }
    let error = "";
    let focus = null;
    const act = (r) => {
      error = r.ok ? "" : r.error;
      mode = null;
      draw();
    };
    const item = (v, i, all) => {
      const label = (what) => `${what} ${v.name}`;
      const name = h("span", {}, v.name, stale(v) ? [" ", pill()] : null);
      if (mode?.id === v.id && mode.kind === "rename") {
        const input = h("input", { type: "text", maxlength: String(MAX_NAME), value: v.name, "aria-label": `New name of ${v.name}`, "data-focus": `views-name-${v.id}`, onKeydown: (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault?.();
          save();
        } });
        const save = () => {
          const r = store.rename(v.id, input.value);
          if (r.ok) return act(r);
          error = r.error;
          return draw();
        };
        focus = `views-name-${v.id}`;
        return h("li", { class: "row" }, input,
          h("button", { type: "button", class: "small primary", "data-focus": `views-save-${v.id}`, onClick: save }, "Save"),
          h("button", { type: "button", class: "small", "data-focus": `views-cancel-${v.id}`, onClick: () => { error = ""; mode = null; draw(); } }, "Cancel"));
      }
      if (mode?.id === v.id && mode.kind === "delete") {
        focus = `views-keep-${v.id}`;
        return h("li", { class: "stack" }, h("p", {}, deleteText(v.name)),
          h("div", { class: "row" },
            h("button", { type: "button", class: "small danger", "data-focus": `views-confirm-${v.id}`, onClick: () => act(store.remove(v.id)) }, "Delete view"),
            h("button", { type: "button", class: "small", "data-focus": `views-keep-${v.id}`, onClick: () => { mode = null; draw(); } }, "Keep it")));
      }
      return h("li", { class: "row" }, name, h("span", { class: "spacer" }),
        h("button", { type: "button", class: "small", "aria-label": label("Rename"), "data-focus": `views-rename-${v.id}`, onClick: () => { error = ""; mode = { kind: "rename", id: v.id }; draw(); } }, "Rename"),
        h("button", { type: "button", class: "small", "aria-label": `Move ${v.name} up`, disabled: i === 0, "data-focus": `views-up-${v.id}`, onClick: () => act(store.move(v.id, -1)) }, "↑"),
        h("button", { type: "button", class: "small", "aria-label": `Move ${v.name} down`, disabled: i === all.length - 1, "data-focus": `views-down-${v.id}`, onClick: () => act(store.move(v.id, 1)) }, "↓"),
        h("button", { type: "button", class: "small danger", "aria-label": label("Delete"), "data-focus": `views-delete-${v.id}`, onClick: () => { error = ""; mode = { kind: "delete", id: v.id }; draw(); } }, "Delete"));
    };
    function draw() {
      focus = null;
      const views = store.list(pageId);
      const body = [
        views.length ? h("ul", { class: "stack" }, views.map(item)) : h("p", { class: "muted" }, "No saved views on this page."),
        h("p", { class: "status bad", role: "alert" }, error),
        h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { type: "button", class: "primary", "data-focus": "views-done", onClick: () => close() }, "Done")),
      ];
      mount(box, body);
      if (focus) [...box.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === focus)?.focus();
    }
    draw();
    return box;
  }).then(() => undefined);
}

let source = null;

/** The live context registers `() => ({ id, readOnly, repos })` here (repos is null until the list is known). Module state: tests must clear it. */
export function setViewAccount(fn) {
  source = typeof fn === "function" ? fn : null;
}

/**
 * The saved views of one page for this account, or null where there are none (no account yet, a preview, an unknown
 * page). `parts(filters, { owners, redraw })` → { row, onSave, onDelete, stale }: `stale` is true when the view the page
 * shows is out of date (the page then shows its empty state with Clear filters and `onDelete`).
 */
export function pageViews(pageId, { account = source, storage, ask = confirmDialog } = {}) {
  if (typeof account !== "function" || !VIEW_PAGES.includes(pageId)) return null;
  let acc;
  try {
    acc = account();
  } catch {
    return null;
  }
  if (!acc || acc.readOnly) return null;
  const store = viewStore(acc.id, ...(storage === undefined ? [] : [storage]));
  return {
    store,
    parts(filters, { owners = null, redraw = () => {} } = {}) {
      const list = store.list(pageId);
      const clean = cleanFilters(filters);
      const active = list.find((v) => sameFilters(v.filters, clean));
      let repos = null;
      try {
        repos = account()?.repos ?? null;
      } catch {
        repos = null;
      }
      const stale = (v) => isStale(v, { repos, owners });
      const staleActive = Boolean(active && stale(active));
      return {
        row: viewsRow(list, active?.id, {
          stale,
          onManage: async () => {
            await manageViewsDialog(store, pageId, { stale });
            redraw();
          },
        }),
        onSave: async () => {
          if (await saveViewDialog(store, pageId, clean)) redraw();
        },
        onDelete: staleActive
          ? async () => {
            if (!(await ask({ title: "Delete this view", text: deleteText(active.name), confirm: "Delete view" }))) return;
            const r = store.remove(active.id);
            if (!r.ok) toast(r.error, "error");
            redraw();
          }
          : null,
        stale: staleActive,
      };
    },
  };
}
