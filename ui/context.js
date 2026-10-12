// The repository context: "my current repository" (or All), the favourites and the recent ones, kept per account
// in this browser, plus the pure rules for the addresses and the rows of the switcher, and the controller of the
// switcher (`initContext`), which draws it into `#context` with ui/context-view.js.
// Same store pattern as ui/work-prefs.js and ui/since.js: missing, throwing or garbage storage means the empty state.
import { api } from "./api.js";
import { switcherView } from "./context-view.js";
import { mount, toast } from "./dom.js";
import { ALL_REPOS, parseQuery, resolve } from "./ia.js";
import { refreshContextOffer, sameRepo, setContextOffer, splitHash, withQuery } from "./filters.js";
import { setViewAccount } from "./views.js";

export const MAX_RECENTS = 5;
export const ALL_LABEL = "All repositories";

const defaultStore = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** True for a non-empty "owner/name"; "all" is not one. Never throws. */
export function validName(name) {
  if (typeof name !== "string" || name === ALL_REPOS) return false;
  try {
    return parseQuery(`repo=${encodeURIComponent(name)}`).repo === name;
  } catch {
    return false; // e.g. an unpaired surrogate
  }
}

export const emptyState = () => ({ repo: "", favourites: [], recents: [] });

const names = (v) => {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) if (validName(x) && !out.some((y) => sameRepo(x, y))) out.push(x);
  return out;
};

/** Cleans what storage held: unknown keys dropped, anything not valid replaced by the empty state. */
export function cleanState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
  return { repo: validName(raw.repo) ? raw.repo : "", favourites: names(raw.favourites), recents: names(raw.recents).slice(0, MAX_RECENTS) };
}

/**
 * The store of one account. `storage` defaults to localStorage; null means memory only. Each change first
 * reads storage again, so a change made in another tab is picked up; two tabs that change at the same moment
 * can still overwrite each other (last writer wins).
 */
export function contextStore(userId, storage = defaultStore()) {
  const key = `scf.context.${userId || "local"}`;
  let memory = emptyState();
  let broken = !storage;
  const read = () => {
    if (broken) return;
    let text;
    try {
      text = storage.getItem(key);
    } catch {
      return; // keep what is in memory
    }
    try {
      memory = cleanState(JSON.parse(text));
    } catch {
      memory = emptyState();
    }
  };
  const write = () => {
    if (broken) return;
    try {
      storage.setItem(key, JSON.stringify(memory));
    } catch {
      broken = true; // no storage: from now on memory only, and storage is not called again
    }
  };
  const get = () => ({ repo: memory.repo, favourites: [...memory.favourites], recents: [...memory.recents] });
  read();
  return {
    key,
    get,
    reload() {
      read();
      return get();
    },
    choose(name) {
      read();
      if (name === "" || name === ALL_REPOS) memory.repo = "";
      else if (validName(name)) {
        memory.repo = name;
        memory.recents = [name, ...memory.recents.filter((x) => !sameRepo(x, name))].slice(0, MAX_RECENTS);
      } else return get();
      write();
      return get();
    },
    toggleFavourite(name) {
      if (!validName(name)) return get();
      read();
      memory.favourites = memory.favourites.some((x) => sameRepo(x, name)) ? memory.favourites.filter((x) => !sameRepo(x, name)) : [...memory.favourites, name];
      write();
      return get();
    },
    /** Drops the names that are not in `known` from all three lists; answers what went. */
    prune(known) {
      read();
      const list = Array.isArray(known) ? known : [];
      const has = (x) => list.some((k) => sameRepo(k, x));
      const gone = { repo: "", favourites: memory.favourites.filter((x) => !has(x)), recents: memory.recents.filter((x) => !has(x)) };
      if (memory.repo && !has(memory.repo)) gone.repo = memory.repo;
      if (!gone.repo && !gone.favourites.length && !gone.recents.length) return gone;
      if (gone.repo) memory.repo = "";
      memory.favourites = memory.favourites.filter(has);
      memory.recents = memory.recents.filter(has);
      write();
      return gone;
    },
  };
}

const boardOf = (name) => `#/board/${encodeURIComponent(name)}`;
const nameOf = (ctx) => (validName(ctx?.repo) ? ctx.repo : "");

/** The address a bare scoped page gets in the current context, or null. `ctx` = { active, repo, own }. */
export function scopedHash(role, hash, ctx) {
  if (!ctx?.active || typeof hash !== "string" || hash.includes("?")) return null;
  const to = resolve(role, hash);
  if (to.redirected || !to.page.scope || to.page.nav === "detail") return null;
  const name = nameOf(ctx);
  if (to.page.id === "board") return name ? boardOf(name) : `#/board?repo=${ALL_REPOS}`;
  if (to.page.id === "repos" && ctx.own !== true) return `#/repos?repo=${ALL_REPOS}`;
  return withQuery(to.page.path, { repo: name || ALL_REPOS });
}

/** The address after a choice in the switcher: the repository replaced, `owner` kept. Null on a page without scope. */
export function chosenHash(role, hash, ctx) {
  if (typeof hash !== "string") return null;
  const to = resolve(role, hash);
  if (to.redirected || !to.page.scope) return null;
  const owner = to.query.owner ? { owner: to.query.owner } : {};
  const name = nameOf(ctx);
  if (to.page.id === "board" || to.page.id === "board-repo") return name ? withQuery(boardOf(name), owner) : withQuery("#/board", { repo: ALL_REPOS, ...owner });
  if (to.page.id === "repos" && ctx?.own !== true) return withQuery("#/repos", { repo: ALL_REPOS, ...owner });
  return withQuery(to.page.path, { repo: name || ALL_REPOS, ...owner });
}

/**
 * The address after Clear filters or removing the repository chip: with an active context, a page that follows it and
 * has no repository in its address gets `repo=all` (`owner` kept), so the next navigation does not put the context back.
 * Anything else is returned unchanged.
 */
export function clearedHash(role, hash, ctx) {
  if (!ctx?.active || typeof hash !== "string") return hash;
  const to = resolve(role, hash);
  if (to.redirected || !to.page.scope || to.page.nav === "detail") return hash;
  if (parseQuery(splitHash(hash).query).repo) return hash; // resolve() drops repo=all, so the raw query is read
  return withQuery(to.page.path, { repo: ALL_REPOS, ...(to.query.owner ? { owner: to.query.owner } : {}) });
}

/**
 * What the filter bar offers as "Use as my context": { repo, label } (repo is "" for All), or null. `list` is
 * [{ name, own }] from repoList. `shownRepo` names the repository the page really shows when the address does not
 * (the classic Board shows the first one).
 */
export function offerFor(role, hash, ctx, list, shownRepo) {
  if (!ctx?.active || typeof hash !== "string") return null;
  const to = resolve(role, hash);
  if (to.redirected || !to.page.scope) return null;
  const shown = shownRepo !== undefined ? shownRepo : to.page.id === "board-repo" ? to.arg : to.query.repo ?? "";
  const mine = nameOf(ctx);
  if (!shown) {
    if (!mine) return null;
    if (to.page.id === "repos" && ctx.own !== true) return null;
    return { repo: "", label: ALL_LABEL };
  }
  const item = (Array.isArray(list) ? list : []).find((i) => sameRepo(i.name, shown));
  if (!item || sameRepo(item.name, mine)) return null;
  if (to.page.id === "repos" && !item.own) return null;
  return { repo: item.name, label: `Repository: ${item.name}` };
}

/** The repositories to choose from: [{ name, own }], sorted by name. Rows without `github` are left out. */
export function repoList(rows) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!validName(r?.github)) continue;
    const id = r.github.toLowerCase();
    const old = by.get(id);
    if (!old) by.set(id, { name: r.github, own: r.own === true });
    else if (r.own === true && !old.own) by.set(id, { name: r.github, own: true });
  }
  return [...by.values()].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The rows of the switcher: All, Favourites, Recent, the rest; narrowed by `text`. */
export function switcherRows(list, state, text = "") {
  const items = Array.isArray(list) ? list : [];
  const repo = state?.repo ?? "";
  const find = (n) => items.find((i) => sameRepo(i.name, n));
  const row = (group, i) => ({ group, name: i.name, label: i.name, own: i.own, favourite: group === "favourite", current: sameRepo(i.name, repo) });
  const used = [];
  const take = (group, wanted) => {
    const out = [];
    for (const n of wanted ?? []) {
      const i = find(n);
      if (i && !used.includes(i)) {
        used.push(i);
        out.push(row(group, i));
      }
    }
    return out;
  };
  const favourites = take("favourite", state?.favourites);
  const recents = take("recent", state?.recents);
  const rest = items.filter((i) => !used.includes(i)).map((i) => row("rest", i));
  const all = { group: "all", name: "", label: ALL_LABEL, own: false, favourite: false, current: repo === "" };
  const t = String(text ?? "").trim().toLowerCase();
  const rows = [all, ...favourites, ...recents, ...rest];
  return t ? rows.filter((r) => r.label.toLowerCase().includes(t)) : rows;
}

export const UNKNOWN_OWNER = "Unknown account";
export const SEARCH_FROM = 8;
export const goneText = (name) => `${name} is no longer in your list. The switcher shows All repositories now.`;

// The same text as `ownerText` in ui/admin-repos.js (copied, so the user display reaches no admin module).
const ownerText = (row) => (row.account ? `${row.account.name} (${row.account.email})` : UNKNOWN_OWNER);

/**
 * The sections of the panel from `switcherRows`: All (no title), Favourites, Recent, then the rest. The rest is one
 * "Repositories" section for a user; for an admin (`ownerOf(name)` → heading) one section per owner, sorted
 * ignoring case, "Unknown account" last. Empty sections are left out.
 */
export function switcherSections(rows, ownerOf = null) {
  const list = Array.isArray(rows) ? rows : [];
  const of = (group) => list.filter((r) => r.group === group);
  const rest = of("rest");
  const out = [{ title: null, rows: of("all") }, { title: "Favourites", rows: of("favourite") }, { title: "Recent", rows: of("recent") }];
  if (!ownerOf) out.push({ title: "Repositories", rows: rest });
  else {
    const by = new Map();
    for (const r of rest) {
      const t = ownerOf(r.name) || UNKNOWN_OWNER;
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(r);
    }
    const key = (t) => t.toLowerCase();
    const titles = [...by.keys()].sort((x, y) => (x === UNKNOWN_OWNER) - (y === UNKNOWN_OWNER) || (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
    for (const t of titles) out.push({ title: t, rows: by.get(t) });
  }
  return out.filter((s) => s.rows.length);
}

let live = null;

/**
 * The live repository context of this page: loads the list, owns the store state and the switcher in `#context`.
 * Returns { ready, scoped, keep, current, account, refresh, stop }. `account()` is { id, readOnly, repos } (repos is
 * null until the list is loaded); the live context registers it with ui/views.js for the saved views. `ready` never rejects. Only one context is live.
 * `keep(hash)` is `clearedHash` for the live context (filter changes go through it); the live context also registers
 * the "Use as my context" offer with ui/filters.js.
 */
export function initContext(role, me, { readOnly = false, go = () => {}, a = api, where = () => location.hash, notify = (text) => toast(text), store = contextStore(me?.id, readOnly ? null : undefined) } = {}) {
  live?.stop();
  const box = document.getElementById("context");
  let state = store.get();
  let list = [];
  let owners = new Map();
  let open = false;
  let text = "";
  let gen = 0;
  let stopped = false;
  let loaded = false;
  let failed = false;
  let view = null;

  const current = () => {
    const item = list.find((i) => sameRepo(i.name, state.repo));
    return { active: loaded && !stopped && list.length >= 2, repo: item?.name ?? "", own: item?.own ?? false };
  };
  const ownerOf = role === "admin" ? (name) => owners.get(String(name).toLowerCase()) : null;

  const model = () => {
    if (failed) return { state: "failed", label: "", open: false, search: false, text: "", sections: [] };
    const n = list.length;
    const search = n >= SEARCH_FROM;
    return {
      state: n === 0 ? "none" : n === 1 ? "one" : "many",
      label: n === 1 ? list[0].name : current().repo || ALL_LABEL,
      open: n >= 2 && open,
      search,
      text,
      sections: n >= 2 && open ? switcherSections(switcherRows(list, state, search ? text : ""), ownerOf) : [],
    };
  };
  const draw = () => {
    if (stopped) return;
    view?.cleanup();
    view = switcherView(model(), handlers);
    mount(box, view.node);
  };
  const focusTrigger = () => [...box.querySelectorAll("[data-focus]")].find((x) => x.getAttribute("data-focus") === "context-btn")?.focus();

  /** Loads the list. → { ok, gone }; ok is false for a failure and for an answer that came too late. */
  const load = async () => {
    const mine = ++gen;
    let got;
    try {
      got = await (role === "admin" ? a.allRepos() : a.repos());
    } catch {
      if (stopped || mine !== gen) return { ok: false, gone: "" };
      if (!loaded) {
        failed = true;
        draw();
      }
      return { ok: false, gone: "" };
    }
    if (stopped || mine !== gen) return { ok: false, gone: "" };
    const rows = (Array.isArray(got) ? got : []).map((r) => ({ ...r, own: role === "admin" ? r?.owner === me?.id : true }));
    list = repoList(rows);
    owners = new Map();
    if (role === "admin") {
      for (const r of rows) {
        if (!validName(r?.github)) continue;
        const id = r.github.toLowerCase();
        if (!owners.has(id) || r.own) owners.set(id, ownerText(r));
      }
    }
    loaded = true;
    failed = false;
    const gone = store.prune(list.map((i) => i.name));
    state = store.get();
    if (list.length < 2) {
      open = false;
      text = "";
    }
    draw();
    refreshContextOffer(); // an offer on the page may name a repository that went
    if (gone.repo) notify(goneText(gone.repo));
    return { ok: true, gone: gone.repo };
  };

  // The offer for the page now, worked out when a bar is drawn: a click makes the shown repository the context.
  const offer = (shownRepo) => {
    const o = offerFor(role, where(), current(), list, shownRepo);
    return o && {
      label: o.label,
      onUse: () => {
        // The list may have changed since the offer was drawn: a repository that is gone is not stored again.
        if (stopped || (o.repo && !list.some((i) => sameRepo(i.name, o.repo)))) return;
        state = store.choose(o.repo);
        open = false;
        text = "";
        draw();
        focusTrigger();
      },
    };
  };

  const refresh = async () => {
    if (stopped) return;
    const r = await load();
    if (!r.ok || r.gone) return; // a repository that went is told by the notice; the page is not moved
    const to = scopedHash(role, where(), current());
    if (!to) return;
    const at = resolve(role, to);
    go(to, { replace: true, draw: Boolean(at.query.repo) || at.page.id === "board-repo" });
  };

  const handlers = {
    onToggle() {
      open = !open;
      if (!open) text = "";
      draw();
    },
    onClose({ focus } = {}) {
      if (!open) return;
      open = false;
      text = "";
      if (focus) focusTrigger();
      else if (box.contains(document.activeElement)) document.activeElement.blur?.();
      draw();
    },
    onChoose(name) {
      state = store.choose(name);
      open = false;
      text = "";
      focusTrigger();
      draw();
      refreshContextOffer(); // a bar already on the page may no longer have an offer
      const to = chosenHash(role, where(), current());
      if (to) go(to);
    },
    onStar(name) {
      state = store.toggleFavourite(name);
      view?.update(model());
    },
    onSearch(t) {
      text = t;
      view?.update(model());
    },
    onRetry: () => refresh(),
  };

  const ctx = {
    ready: load().then(() => {}, () => {}),
    scoped: (hash) => scopedHash(role, hash, current()),
    keep: (hash) => clearedHash(role, hash, current()),
    current,
    account: () => ({ id: me?.id ?? "", readOnly, repos: loaded && !stopped ? list.map((i) => i.name) : null }),
    refresh,
    stop() {
      if (stopped) return;
      stopped = true;
      gen++;
      view?.cleanup();
      if (view && view.node.parentNode === box) box.replaceChildren(); // the box may belong to a newer context now
      view = null;
      if (live === ctx) {
        live = null;
        setContextOffer(null);
        setViewAccount(null);
      }
    },
  };
  live = ctx;
  setContextOffer((arg) => offer(arg?.repo));
  setViewAccount(ctx.account);
  return ctx;
}

/** Loads the list again for the live context; nothing when there is none. */
export function reposChanged() {
  return live ? live.refresh() : undefined;
}
