// The information architecture: which pages exist, where they live in the navigation, and how an address
// resolves. No imports, so both displays and the tests can load it.

export const MAX_PRIMARY = 7;
export const FALLBACK = { admin: "#/home", user: "#/runs" };

export const AREAS = [
  { id: "home", label: "Home" },
  { id: "work", label: "Work" },
  { id: "runs", label: "Runs" },
  { id: "repositories", label: "Repositories" },
  { id: "build", label: "Build" },
  { id: "administration", label: "Administration" },
];

const A = ["admin"];
const AU = ["admin", "user"];

// nav: "primary" | "secondary" | "action" | "detail". dest: destination id, null for the Start work action.
// section: id from SECTIONS, optional (administration pages only).
const adminPage = (id, title, section) => ({ id, path: `#/${id}`, title, area: "administration", dest: "administration", parent: null, nav: "secondary", label: { admin: title }, roles: A, section });
export const PAGES = [
  { id: "home", path: "#/home", title: "Home", area: "home", dest: "home", parent: null, nav: "primary", label: { admin: "Home", user: "Home" }, roles: AU },
  { id: "board", path: "#/board", title: "Board", area: "work", dest: "board", parent: null, nav: "primary", label: { admin: "Board" }, roles: A },
  { id: "board-repo", path: "#/board/:id", title: "Board", area: "work", dest: "board", parent: "board", nav: "detail", label: {}, roles: A },
  { id: "refinement", path: "#/refinement", title: "Refinement", area: "work", dest: "refinement", parent: null, nav: "primary", label: { admin: "Refinement", user: "Refinement" }, roles: AU },
  { id: "refinement-backlog", path: "#/refinement/backlog", title: "Backlog readiness", area: "work", dest: "refinement", parent: "refinement", nav: "detail", label: {}, roles: AU },
  { id: "refinement-session", path: "#/refinement/:id", title: "Refinement session", area: "work", dest: "refinement", parent: "refinement", nav: "detail", label: {}, roles: AU },
  { id: "start", path: "#/start", title: "Start work", area: "work", dest: null, parent: null, nav: "action", label: { admin: "Start work", user: "Start work" }, roles: AU },
  { id: "runs", path: "#/runs", title: "Runs", area: "runs", dest: "runs", parent: null, nav: "primary", label: { admin: "Runs", user: "My runs" }, roles: AU },
  { id: "run", path: "#/runs/:id", title: (id) => `Run ${id}`, area: "runs", dest: "runs", parent: "runs", nav: "detail", label: {}, roles: AU },
  { id: "repos", path: "#/repos", title: "My repositories", area: "repositories", dest: "repos", parent: null, nav: "secondary", label: { admin: "My repositories", user: "My repositories" }, roles: AU },
  { id: "flows", path: "#/flows", title: "Flows", area: "build", dest: "flows", parent: null, nav: "secondary", label: { admin: "Flows" }, roles: A },
  { id: "flow", path: "#/flows/:name", title: (name) => name, area: "build", dest: "flows", parent: "flows", nav: "detail", label: {}, roles: A },
  { id: "new-flow", path: "#/new", title: "New flow", area: "build", dest: "flows", parent: "flows", nav: "detail", label: {}, roles: A },
  { id: "library", path: "#/library", title: "Library", area: "build", dest: "flows", parent: null, nav: "secondary", label: { admin: "Library" }, roles: A },
  adminPage("operations", "Overview", "operations"),
  adminPage("problems", "Problems", "operations"),
  adminPage("watchers", "Watchers", "operations"),
  { id: "problem", path: "#/problems/:id", title: (id) => id, area: "administration", dest: "administration", parent: "problems", nav: "detail", label: {}, roles: A },
  { id: "watcher", path: "#/watchers/:id", title: (id) => id, area: "administration", dest: "administration", parent: "watchers", nav: "detail", label: {}, roles: A },
  adminPage("models", "Models", "operations"),
  { id: "model", path: "#/models/:name", title: (name) => name, area: "administration", dest: "administration", parent: "models", nav: "detail", label: {}, roles: A },
  adminPage("dashboard", "Dashboard", "operations"),
  adminPage("users", "Users", "access"),
  adminPage("all-repos", "All repositories", "access"),
  adminPage("credentials", "Credentials", "access"),
  adminPage("audit", "Audit", "access"),
  adminPage("settings", "Settings", "system"),
  adminPage("maintenance", "Maintenance", "system"),
];

// group "work" = daily work; "setup" = configuration, drawn smaller and apart.
export const DESTINATIONS = [
  { id: "home", label: { admin: "Home", user: "Home" }, landing: "home", group: "work", roles: AU },
  { id: "board", label: { admin: "Board" }, landing: "board", group: "work", roles: A },
  { id: "refinement", label: { admin: "Refinement", user: "Refinement" }, landing: "refinement", group: "work", roles: AU, rank: { user: 9 } },
  { id: "runs", label: { admin: "Runs", user: "My runs" }, landing: "runs", group: "work", roles: AU },
  { id: "repos", label: { admin: "Repositories", user: "My repositories" }, landing: "repos", group: "work", roles: AU },
  { id: "flows", label: { admin: "Flows" }, landing: "flows", group: "setup", roles: A },
  { id: "administration", label: { admin: "Administration" }, landing: "operations", group: "setup", roles: A },
];

/** The groups of the sidebar, in order. */
export const GROUPS = [{ id: "work", label: "Work" }, { id: "setup", label: "Setup" }];

/** The labelled sections of the Administration secondary row, in order. */
export const SECTIONS = [{ id: "operations", label: "Operations" }, { id: "access", label: "People and access" }, { id: "system", label: "System" }];

export const ALIASES = [{ from: "#/your-turn", to: "#/home", roles: A }];

const forRole = (role) => (x) => x.roles.includes(role);
const pageById = (id) => PAGES.find((p) => p.id === id);
const destById = (id) => DESTINATIONS.find((d) => d.id === id);
const labelOf = (p, role) => p.label[role] ?? p.title;
const patternOf = (p) => p.path.split("/");

/** Primary destinations of a role, in order (daily work first, setup last). */
export function primaryFor(role) {
  const rank = (d) => d.rank?.[role] ?? DESTINATIONS.indexOf(d);
  return DESTINATIONS.filter(forRole(role)).sort((a, b) => rank(a) - rank(b)).map((d) => ({ id: d.id, label: d.label[role], href: pageById(d.landing).path, group: d.group }));
}

/** The action buttons of a role (Start work). */
export function actionsFor(role) {
  return PAGES.filter((p) => p.nav === "action" && forRole(role)(p)).map((p) => ({ id: p.id, label: labelOf(p, role), href: p.path }));
}

/** The secondary pages of a destination; [] when there are fewer than two. */
export function subnavFor(role, destId) {
  const list = PAGES.filter((p) => p.nav === "secondary" && p.dest === destId && forRole(role)(p));
  return list.length < 2 ? [] : list.map((p) => ({ id: p.id, label: labelOf(p, role), href: p.path, ...(p.section ? { section: p.section } : {}) }));
}

function match(role, parts) {
  const section = parts[1];
  for (const p of PAGES) {
    if (!forRole(role)(p)) continue;
    const pat = patternOf(p);
    if (pat[1] !== section) continue;
    // A fixed last part ("#/refinement/backlog") is listed before the pattern with a variable part, so it wins.
    if (pat.length === parts.length && (pat.length === 2 || pat[2].startsWith(":") || pat[2] === parts[2])) return { page: p, arg: parts[2] };
  }
  return null;
}

function describe(role, page, arg, hash, reason) {
  const dest = page.dest ? destById(page.dest) : null;
  const crumbs = [];
  if (dest) {
    const landing = pageById(dest.landing);
    crumbs.push({ label: dest.label[role] ?? dest.label.admin, href: landing.path });
    const own = page.nav === "detail" && page.parent ? pageById(page.parent) : page;
    if (labelOf(own, role) !== crumbs[0].label) crumbs.push({ label: labelOf(own, role), href: own.path });
  } else {
    crumbs.push({ label: labelOf(page, role), href: page.path });
  }
  const name = typeof page.title === "function" ? page.title(arg) : page.title;
  if (page.nav === "detail") crumbs.push({ label: name, href: null });
  else crumbs[crumbs.length - 1].href = null;
  const title = page.nav === "detail" || typeof page.title === "function" ? name : labelOf(page, role);
  return {
    page, arg, hash, redirected: reason !== null, reason, dest: page.dest, title,
    crumbs: crumbs.length > 1 ? crumbs : [],
    back: page.nav === "detail" && page.parent ? pageById(page.parent).path : null,
  };
}

const REPO_OK = /^[\w.-]+\/[\w.-]+$/;
const OWNER_OK = /^[\w-]+$/;
const VALID = { repo: (v) => v.length <= 200 && REPO_OK.test(v), owner: (v) => v.length <= 64 && OWNER_OK.test(v) };

/** Splits an address into its path and the text after the first "?" ("" when there is none). */
export function splitHash(hash) {
  const text = typeof hash === "string" ? hash : "";
  const i = text.indexOf("?");
  return i < 0 ? { path: text, query: "" } : { path: text.slice(0, i), query: text.slice(i + 1) };
}

/** The known filters of a query text ("?repo=…&owner=…", with or without the "?"): { repo?, owner? }. Anything else is dropped. */
export function parseQuery(text) {
  const out = {};
  const raw = typeof text === "string" ? text.replace(/^\?/, "") : "";
  for (const part of raw.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i);
    if (!Object.hasOwn(VALID, key) || Object.hasOwn(out, key)) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    if (VALID[key](value)) out[key] = value;
  }
  return out;
}

/** Resolves an address for a role to the page to draw. The data above is the source of truth; the document that describes it is still to be written. */
export function resolve(role, hash) {
  const fallback = (reason) => {
    const to = FALLBACK[role];
    const r = resolve(role, to);
    return { ...r, hash: to, redirected: true, reason };
  };
  if (typeof hash !== "string") return fallback("none");
  const { path, query } = splitHash(hash);
  if (path === "" || path === "#" || path === "#/") return fallback("none");
  let parts;
  try {
    parts = path.split("/").map(decodeURIComponent);
  } catch {
    return fallback("unknown");
  }
  if (parts.length > 3 || (parts.length === 3 && parts[2] === "")) return fallback("unknown");
  const alias = ALIASES.find((a) => a.from === path && a.roles.includes(role));
  if (alias) return { ...resolve(role, alias.to), hash: alias.to, redirected: true, reason: "alias" };
  const m = match(role, parts);
  if (!m) return fallback("unknown");
  return { ...describe(role, m.page, m.arg, hash, null), query: parseQuery(query) };
}
