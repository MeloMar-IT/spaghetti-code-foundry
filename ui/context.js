// The repository context: "my current repository" (or All), the favourites and the recent ones, kept per account
// in this browser, plus the pure rules for the addresses and the rows of the switcher. No DOM.
// Same store pattern as ui/work-prefs.js and ui/since.js: missing, throwing or garbage storage means the empty state.
import { ALL_REPOS, parseQuery, resolve } from "./ia.js";
import { sameRepo, withQuery } from "./filters.js";

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
