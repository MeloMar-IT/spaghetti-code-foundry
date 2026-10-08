import { ownerLabel } from "./runs.js";

// The Work page's data work: flatten the board answer, filter, group, order. Pure; the server's
// record decides status, column, sentence and blockers — nothing here computes them.

export const DEFAULTS = { layout: "board", repo: "", owner: "", status: [], who: "", text: "", group: "status", order: "issue", props: ["repo", "next", "blockers", "owner", "age"], compact: false };

export const GROUPS = [
  { id: "status", label: "Group by status" },
  { id: "repo", label: "Group by repository" },
  { id: "owner", label: "Group by owner" },
  { id: "next", label: "Group by next move" },
  { id: "none", label: "No grouping" },
];
export const ORDERS = [
  { id: "issue", label: "Order by issue" },
  { id: "age", label: "Order by age (oldest first)" },
  { id: "title", label: "Order by title" },
];
/** The values of `next.who` the server sends, "You" first. */
export const WHO = ["You", "Something is wrong", "Foundry", "Another story", "A time limit"];
export const COLUMN_IDS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];

const NO_OWNER = "No owner";
const time = (iso) => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** Every card of every repository: `{ ...card, repo, columnTitle }`. */
export function workItems(data) {
  const out = [];
  for (const r of data?.repos ?? []) {
    for (const col of r.columns ?? []) for (const card of col.cards ?? []) out.push({ ...card, repo: r.repo, columnTitle: col.title });
  }
  return out;
}

/** The columns (`{ id, title }`) in the server's order. */
export const columnsOf = (data) => (data?.repos?.[0]?.columns ?? []).map((c) => ({ id: c.id, title: c.title }));

export const isFiltered = (prefs) => !!(prefs.repo || prefs.owner || prefs.status?.length || prefs.who || prefs.text?.trim());

export function applyFilters(items, prefs) {
  const text = (prefs.text ?? "").trim().toLowerCase().replace(/^#/, "");
  return items.filter((i) =>
    (!prefs.repo || i.repo === prefs.repo) &&
    (!prefs.owner || i.owner === prefs.owner) &&
    (!prefs.status?.length || prefs.status.includes(i.column)) &&
    (!prefs.who || i.next?.who === prefs.who) &&
    (!text || String(i.title ?? "").toLowerCase().includes(text) || String(i.issue).includes(text)));
}

const byIssue = (a, b) => a.issue - b.issue || a.repo.localeCompare(b.repo);
const byTitle = (a, b) => String(a.title).localeCompare(String(b.title)) || a.repo.localeCompare(b.repo) || a.issue - b.issue;

/** A sorted copy. Done stays newest first when ordered by issue. */
export function orderItems(items, order, groupId) {
  const since = (i) => time(i.since);
  const dated = (sign) => (a, b) => {
    const x = since(a);
    const y = since(b);
    if (x === undefined || y === undefined) return x === y ? byIssue(a, b) : x === undefined ? 1 : -1;
    return sign * (x - y) || byIssue(a, b);
  };
  const cmp = order === "title" ? byTitle : order === "age" ? dated(1) : groupId === "done" ? dated(-1) : byIssue;
  return [...items].sort(cmp);
}

const ownerName = (i) => ownerLabel(i.ownerName) || i.owner;

/** `[{ id, title, items }]`; status groups keep the server's column order and include empty columns. */
export function groupItems(items, prefs, columns = []) {
  const order = (id, list) => orderItems(list, prefs.order, id);
  const make = (id, title, list) => ({ id, title, items: order(id, list) });
  switch (prefs.group) {
    case "none":
      return [make("all", "", items)];
    case "repo":
      return [...new Set(items.map((i) => i.repo))].sort().map((r) => make(r, r, items.filter((i) => i.repo === r)));
    case "owner": {
      const owners = new Map();
      for (const i of items) if (i.owner && !owners.has(i.owner)) owners.set(i.owner, ownerName(i));
      const named = [...owners].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => make(id, name, items.filter((i) => i.owner === id)));
      const none = items.filter((i) => !i.owner);
      return none.length ? [...named, make("", NO_OWNER, none)] : named;
    }
    case "next": {
      const found = [...new Set(items.map((i) => i.next?.who))];
      const known = WHO.filter((w) => found.includes(w));
      const rest = found.filter((w) => !WHO.includes(w)).sort();
      return [...known, ...rest].map((w) => make(w, w, items.filter((i) => i.next?.who === w)));
    }
    default: {
      const wanted = prefs.status?.length ? columns.filter((c) => prefs.status.includes(c.id)) : columns;
      return wanted.map((c) => make(c.id, c.title, items.filter((i) => i.column === c.id)));
    }
  }
}

/** "3 d", "5 h", "12 min"; "" when the time is missing, not a time, or in the future. */
export function ageText(since, now = new Date()) {
  const t = time(since);
  if (t === undefined) return "";
  const min = Math.floor((now.getTime() - t) / 60_000);
  if (min < 0) return "";
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 1440)} d`;
}

/**
 * The choices of the filters, with counts: `{ repos, owners, who }`, each `[{ id, name, count }]`.
 * Pass the board answer as `data` so a repository without cards is still offered.
 */
export function facets(items, data) {
  const repos = new Map((data?.repos ?? []).map((r) => [r.repo, 0]));
  const owners = new Map();
  const who = new Map();
  for (const i of items) {
    repos.set(i.repo, (repos.get(i.repo) ?? 0) + 1);
    if (i.owner) {
      const o = owners.get(i.owner) ?? { id: i.owner, name: ownerName(i), count: 0 };
      o.count++;
      owners.set(i.owner, o);
    }
    if (i.next?.who) who.set(i.next.who, (who.get(i.next.who) ?? 0) + 1);
  }
  const rank = (w) => (WHO.includes(w) ? WHO.indexOf(w) : WHO.length);
  return {
    repos: [...repos].sort((a, b) => a[0].localeCompare(b[0])).map(([id, count]) => ({ id, name: id, count })),
    owners: [...owners.values()].sort((a, b) => a.name.localeCompare(b.name)),
    who: [...who].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([id, count]) => ({ id, name: id, count })),
  };
}
