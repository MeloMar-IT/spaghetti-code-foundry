import { h } from "./dom.js";
import { whoClass } from "./next.js";
import { ownerLabel } from "./runs.js";
import { issueLink } from "./work-list.js";
import { ageText } from "./work-model.js";

// The board layout of the Work page: one column per group, a compact card per story. Every word comes
// from the server's record. Keyboard: one Tab stop per column (roving tabindex), arrows move between cards.

const NAV = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * Where the focus goes. `grid` is the length of each column, `at` is `{ col, row }`; the result is the new
 * `{ col, row }`, or null when there is nowhere to go (an edge, an unknown key or a position that is not a card).
 */
export function moveFocus(grid, at, key) {
  const len = grid[at?.col];
  if (!Number.isInteger(at?.row) || !len || at.row < 0 || at.row >= len) return null;
  const { col, row } = at;
  switch (key) {
    case "ArrowDown": return row + 1 < len ? { col, row: row + 1 } : null;
    case "ArrowUp": return row > 0 ? { col, row: row - 1 } : null;
    case "Home": return row > 0 ? { col, row: 0 } : null;
    case "End": return row < len - 1 ? { col, row: len - 1 } : null;
    case "ArrowLeft":
    case "ArrowRight": {
      const step = key === "ArrowLeft" ? -1 : 1;
      for (let c = col + step; c >= 0 && c < grid.length; c += step) if (grid[c] > 0) return { col: c, row: Math.min(row, grid[c] - 1) };
      return null;
    }
    default: return null;
  }
}

const keyOf = (item) => item.key ?? `${item.repo}#${item.issue}`;

/** One story as a card: at most four lines — head, next move, blockers, small text. */
export function workCard(item, prefs, handlers = {}) {
  const props = prefs.props ?? [];
  const on = (id) => props.includes(id);
  const n = item.next ?? {};
  const now = handlers.now ?? new Date();
  const leave = () => handlers.onLeave?.(item);
  const yours = item.column === "your_turn";
  const blocked = (item.after ?? []).length > 0;
  const parts = [];
  parts.push(h("div", { class: "work-card-head" },
    issueLink(item.repo, item.issue, leave), " ", h("b", {}, item.title),
    item.goesFirst ? " " : null, item.goesFirst ? h("span", { class: "pill first" }, "goes first") : null,
    yours ? " " : null, yours ? h("span", { class: "pill who-you" }, "Your turn") : null,
    blocked ? " " : null, blocked ? h("span", { class: "pill" }, "Blocked") : null));
  if (on("next") && (n.who || n.action)) parts.push(h("div", { class: "work-card-next" }, n.who ? h("span", { class: `pill ${whoClass(n)}` }, n.who) : null, n.who ? " " : null, n.action ?? ""));
  if (on("blockers") && blocked) {
    parts.push(h("div", { class: "work-card-deps" }, "Blocked by ", ...item.after.flatMap((i, k) => [k ? ", " : null, issueLink(item.repo, i, leave)])));
  }
  const age = on("age") ? ageText(item.since, now) : "";
  const meta = [
    on("step") && item.step ? h("span", { class: "work-card-step" }, item.step) : null,
    on("repo") ? h("span", {}, item.repo) : null,
    on("owner") && ownerLabel(item.ownerName) ? h("span", {}, ownerLabel(item.ownerName)) : null,
    age ? h("span", { "data-since": item.since }, age) : null,
  ].filter(Boolean);
  if (meta.length) parts.push(h("div", { class: "work-card-meta muted" }, ...meta.flatMap((m, k) => [k ? " · " : null, m])));
  const open = () => { globalThis.location.hash = `#/runs/${item.runId}`; };
  const attrs = { class: `work-card${yours ? " yours" : ""}${item.runId ? " link" : ""}`, "data-card": keyOf(item), "data-focus": `card:${keyOf(item)}`, title: n.text, tabindex: "-1" };
  if (item.runId) Object.assign(attrs, { role: "link", onClick: open });
  const el = h("div", attrs, ...parts);
  el.open = item.runId ? open : undefined;
  return el;
}

/** The columns and their cards: `{ columns, cards }` where `cards[col][row]` is the card element. */
function build(groups, prefs, handlers) {
  const stops = handlers.stops ?? new Map();
  const cards = groups.map((g) => g.items.map((i) => workCard(i, prefs, handlers)));
  const columns = groups.map((g, c) => {
    const stop = Math.max(0, g.items.findIndex((i) => keyOf(i) === stops.get(g.id)));
    cards[c].forEach((el, r) => el.setAttribute("tabindex", r === stop ? "0" : "-1"));
    return h("section", { class: "work-col" },
      h("h3", {}, g.title, " ", h("span", { class: "muted" }, String(g.items.length))),
      h("div", { class: "work-col-body" }, cards[c]));
  });
  return { columns, cards };
}

/** The columns (one per group, with title and count): returns nodes. */
export const boardLayout = (groups, prefs, handlers = {}) => build(groups, prefs, handlers).columns;

/** The whole board: the columns inside one container that handles the keys. */
export function workBoard(groups, prefs, handlers = {}) {
  const { columns, cards } = build(groups, prefs, handlers);
  const grid = cards.map((c) => c.length);
  const box = h("div", { class: prefs.compact ? "work-board compact" : "work-board" }, columns);
  box.addEventListener("keydown", (e) => {
    const target = e?.target;
    let col = -1;
    let row = -1;
    cards.forEach((list, c) => { const r = list.indexOf(target); if (r >= 0) { col = c; row = r; } });
    if (col < 0) return; // a link or button inside a card keeps its own keys
    if (e.key === "Enter") return target.open?.();
    if (!NAV.has(e.key)) return;
    e.preventDefault(); // also at an edge: the page and the column must not scroll
    const to = moveFocus(grid, { col, row }, e.key);
    if (!to) return;
    const next = cards[to.col][to.row];
    // Each column keeps exactly one Tab stop: clear the one of the column the focus goes to.
    for (const el of cards[to.col]) if (el.getAttribute("tabindex") === "0") el.setAttribute("tabindex", "-1");
    next.setAttribute("tabindex", "0");
    handlers.stops?.set(groups[to.col].id, keyOf(groups[to.col].items[to.row]));
    next.focus();
  });
  return box;
}
