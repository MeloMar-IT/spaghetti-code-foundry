import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { defaultGo, filterBar, filterEmpty, filterGone, sameRepo, withQuery } from "./filters.js";
import { ALL_REPOS } from "./ia.js";
import { keepScroll, liveStates, poller } from "./live.js";
import { whereLink } from "./next.js";
import { fieldFocused, ownerLabel } from "./runs.js";
import { boardPage } from "./templates.js";
import { pageViews } from "./views.js";

// The board page: where every story is, from GET /api/board. No wording or rules of its own
// except labels; the sentence on each card comes from its next-step record.

export const boardHash = (repo) => `#/board/${encodeURIComponent(repo)}`;

/** The wanted repository (ignoring case); undefined when it is not there. Without a wanted one, the first, else undefined. */
export const pickRepo = (data, wanted) => (wanted ? data?.repos?.find((r) => sameRepo(r.repo, wanted)) : data?.repos?.[0]);

const REPO_OK = /^[\w.-]+\/[\w.-]+$/;

/** A link to an issue on GitHub; plain text when the repository is not a GitHub name. */
function issueLink(repo, issue, onClick, focus) {
  return REPO_OK.test(repo ?? "")
    ? h("a", {
      href: `https://github.com/${repo}/issues/${issue}`, target: "_blank", rel: "noopener", class: "mono", "data-focus": focus,
      onClick: (e) => { e?.stopPropagation?.(); onClick(); },
    }, `#${issue}`)
    : h("span", { class: "mono" }, `#${issue}`);
}

/** One card. `lit` is the set of issues of a highlighted chain, or null. */
export function cardView(card, repo, { lit, onChain, onLeave }) {
  const n = card.next;
  const k = card.key;
  const link = (issue, focus) => issueLink(repo, issue, () => onLeave(card), focus);
  const open = () => { globalThis.location.hash = `#/runs/${card.runId}`; };
  const own = card.runId && n.where?.url === `#/runs/${card.runId}`;
  const cls = ["board-card", card.runId ? "link" : "", lit ? (lit.has(card.issue) ? "chain" : "dim") : ""].filter(Boolean).join(" ");
  const props = { class: cls };
  if (card.runId) {
    Object.assign(props, { role: "link", tabindex: "0", "data-focus": `card-${k}`, onClick: open, onKeydown: (e) => { if (e?.key === "Enter" && e.target === e.currentTarget) open(); } });
  }
  return h("div", props,
    h("div", {}, link(card.issue, `card-${k}-issue`), " ", h("b", {}, card.title), card.goesFirst ? " " : null, card.goesFirst ? h("span", { class: "pill first" }, "goes first") : null),
    h("div", { class: "muted" }, n.text),
    card.step ? h("div", { class: "board-step" }, card.step) : null,
    ownerLabel(card.ownerName) ? h("div", { class: "muted board-owner" }, `Owner: ${ownerLabel(card.ownerName)}`) : null,
    card.after.length
      ? h("div", { class: "board-deps muted" }, "after ", ...card.after.flatMap((i, j) => [j ? ", " : null, link(i, `card-${k}-after-${i}`)]))
      : null,
    !own && n.where?.label ? h("div", { "data-a11y-skip": "stop", onClick: (e) => e?.stopPropagation?.() }, whereLink(n.where, `card-${k}-where`)) : null,
    card.chain.length
      ? h("button", { class: "ghost small", "data-focus": `card-${k}-chain`, onClick: (e) => { e?.stopPropagation?.(); onChain(card.issue); } }, `What is in the way of #${card.issue}?`)
      : null);
}

/** The accounts that own cards: `{ id, name, cards }`, sorted by name. */
export function boardOwners(cards) {
  const found = new Map();
  for (const c of cards) {
    if (!c.owner) continue;
    const o = found.get(c.owner) ?? { id: c.owner, name: ownerLabel(c.ownerName) || c.owner, cards: 0 };
    o.cards++;
    found.set(c.owner, o);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The cards of a column that show: all, or those of one owner. */
export const shownCards = (col, owner = "") => (owner ? col.cards.filter((c) => c.owner === owner) : col.cards);

/** The id of the column a narrow screen shows: `wanted` while it exists, else the first column with shown cards, else the first. Undefined without columns. */
export function pickColumn(columns, wanted, owner = "") {
  if (wanted != null && columns.some((c) => c.id === wanted)) return wanted;
  return (columns.find((c) => shownCards(c, owner).length) ?? columns[0])?.id;
}

/** The page for one answer of the server: returns nodes. `owner` hides the cards of other accounts (and cards without an owner). */
export function boardView(data, wanted, { highlight, owner = "", column, onOwner, onColumn, onChain, onClear, onLeave, views }) {
  const picked = pickRepo(data, wanted);
  const repos = data?.repos ?? [];
  const all = picked ? picked.columns.flatMap((c) => c.cards) : [];
  const owners = boardOwners(all);
  const filter = h("select", { class: "small-select", title: "Show the cards of one account", "aria-label": "Show the cards of one account", "data-focus": "owner-filter", onChange: (e) => onOwner?.(e.target.value) },
    h("option", { value: "" }, "All owners"),
    owners.map((o) => h("option", { value: o.id, selected: o.id === owner }, `${o.name} (${o.cards})`)));
  const gone = Boolean(wanted) && Boolean(data) && !picked;
  const repoPart = repos.length > 1 || (gone && repos.length)
    ? repos.map((r) => h("a", { class: r.repo === picked?.repo ? "btn primary" : "btn", href: withQuery(boardHash(r.repo), owner ? { owner } : {}), "data-focus": `repo-${r.repo}` }, r.repo))
    : picked ? h("span", { class: "muted" }, picked.repo) : null;
  const page = (top, columns) => [boardPage({ title: "Board", actions: [repoPart, filter], filters: top, columns })];
  const filters = owner ? { owner } : {};
  const labels = { owner: owners.find((o) => o.id === owner)?.name || owner };
  const clearOwner = () => onOwner?.("");
  // Without a wanted repository the Board shows the first one: the offer is for that one, and none when there is none.
  const scope = wanted ? {} : picked ? { shown: picked.repo } : { onContext: null };
  // Saved views: `views` is { row, onSave, onDelete, stale } from pageViews("board").parts, or undefined.
  const vp = views ?? {};
  const bar = filterBar(filters, { labels, onRemove: clearOwner, onClear: clearOwner, row: vp.row, onSave: vp.onSave, ...scope });
  const none = () => filterEmpty("cards", filters, { labels, onClear: clearOwner, onDelete: vp.onDelete });
  if (!picked) {
    const toAll = () => { globalThis.location.hash = withQuery("#/board", { repo: ALL_REPOS, ...(owner ? { owner } : {}) }); };
    return page(bar, gone ? filterGone({ onClear: toAll, onDelete: vp.onDelete }) : owner ? none() : data?.empty ? h("div", { class: "empty" }, data.empty) : null);
  }
  if (vp.stale) {
    // An out-of-date saved view is open: the empty state, even when the server still sent cards.
    const clearAll = () => { globalThis.location.hash = withQuery("#/board", { repo: ALL_REPOS }); };
    return page(bar, filterEmpty("cards", { ...(wanted ? { repo: wanted } : {}), ...filters }, { labels, onClear: clearAll, onDelete: vp.onDelete }));
  }

  const target = highlight == null ? undefined : all.find((c) => c.issue === highlight);
  const lit = target ? new Set([target.issue, ...target.chain]) : null;
  const handlers = { lit, onChain, onLeave };
  const chainLine = target
    ? h("div", { class: "board-chain" },
      `In the way of #${target.issue}:`,
      ...target.chain.flatMap((i) => [" ", issueLink(picked.repo, i, () => onLeave(target), `chain-${i}`)]),
      " ", h("button", { class: "small", "data-focus": "chain-clear", onClick: () => onClear() }, "Show all"))
    : null;

  const current = pickColumn(picked.columns, column, owner);
  const label = (col) => {
    const shown = shownCards(col, owner);
    return `${col.title} (${shown.length})${lit && shown.some((c) => lit.has(c.issue)) ? " — in the chain" : ""}`;
  };
  const picker = h("label", { class: "board-pick" }, "Column",
    h("select", { class: "small-select", "aria-label": "Show one column", "data-focus": "column-picker", onChange: (e) => onColumn?.(e.target.value) },
      picked.columns.map((col) => h("option", { value: col.id, selected: col.id === current }, label(col)))));

  const cols = picked.columns.map((col) => {
    let group;
    const body = [];
    const shown = shownCards(col, owner);
    for (const card of shown) {
      if (card.group && card.group !== group) body.push(h("div", { class: "board-sub muted" }, card.group));
      group = card.group;
      body.push(cardView(card, picked.repo, handlers));
    }
    return h("div", { class: `board-col ${col.id}${col.id === current ? " picked" : ""}` },
      h("h3", {}, col.title, " ", h("span", { class: "muted" }, String(shown.length))),
      ...body);
  });
  if (owner && !all.some((c) => c.owner === owner)) return page([bar, chainLine], none());
  return page([bar, chainLine, picker], h("div", { class: "board", "data-scroll": "board" }, ...cols));
}

/** Opens the page and returns at once a function that closes it. */
export function renderBoard(main, wanted, { query = {}, go = defaultGo, views = pageViews("board"), loadOwners = () => api.runOwners() } = {}) {
  let data;
  let highlight;
  let owner = query.owner ?? "";
  let column; // the column a narrow screen shows; undefined until the user picks one
  let left; // the watcher of a card whose GitHub link was opened: check GitHub again when the user comes back
  let live;
  const body = h("div");
  const slot = h("div");
  const states = liveStates({
    body: slot,
    label: "Loading the board", rows: 6, shape: "cards",
    what: "Could not load the board.",
    retry: () => live.refresh(),
    focus: "board",
  });
  mount(body, boardPage({ title: "Board", columns: slot }));
  mount(main, states.alert, body, states.note);

  // The run owners (the list the owner filter of Runs uses), read once, only when there are saved views. Unknown when
  // it fails: no view is then marked out of date because of its owner.
  let ownerIds = null;
  let closed = false;
  if (views) {
    Promise.resolve().then(loadOwners).then((list) => {
      if (closed || !Array.isArray(list)) return;
      ownerIds = list.map((o) => o?.id).filter((id) => typeof id === "string");
      if (data) redraw();
    }, () => {});
  }
  const redraw = () => keepScroll(body, () => mount(body, boardView(data, wanted, {
    highlight, owner, column,
    views: views?.parts({ ...(wanted ? { repo: wanted } : {}), ...(owner ? { owner } : {}) }, { owners: ownerIds, redraw }),
    onColumn: (id) => { column = id; redraw(); },
    onOwner: (id) => {
      owner = id;
      go(withQuery(wanted ? boardHash(wanted) : "#/board", owner ? { owner } : {}));
      redraw();
    },
    onChain: (issue) => { highlight = issue; redraw(); },
    onClear: () => { highlight = undefined; redraw(); },
    onLeave: (card) => { if (card.watcher) left = card.watcher; },
  })));

  const isHeld = () => fieldFocused(main); // a select has the focus: do not change the list under the reader's hands
  live = poller({
    load: () => api.board(),
    draw: (next) => {
      data = next;
      // keep what the screen showed: a default or a fallback becomes the choice, unless it is an empty column (then the first column with cards may still come)
      const columns = pickRepo(data, wanted)?.columns ?? [];
      if (!columns.some((c) => c.id === column)) {
        const id = pickColumn(columns, undefined, owner);
        column = columns.find((c) => c.id === id && shownCards(c, owner).length) ? id : undefined;
      }
      if (highlight != null && !pickRepo(data, wanted)?.columns.some((c) => c.cards.some((k) => k.issue === highlight))) highlight = undefined;
      redraw();
    },
    every: 5000,
    onState: states.onState,
    hold: isHeld,
    wake: async () => {
      if (!left) return;
      const id = left;
      left = undefined;
      await api.tickWatcher(id).catch(() => {});
    },
  });
  return () => {
    closed = true;
    live.stop();
  };
}
