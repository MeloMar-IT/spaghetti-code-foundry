import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { whereLink } from "./next.js";
import { fieldFocused, ownerLabel } from "./runs.js";

// The board page: where every story is, from GET /api/board. No wording or rules of its own
// except labels; the sentence on each card comes from its next-step record.

export const boardHash = (repo) => `#/board/${encodeURIComponent(repo)}`;

/** The wanted repository, else the first, else undefined. */
export const pickRepo = (data, wanted) => data?.repos?.find((r) => r.repo === wanted) ?? data?.repos?.[0];

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

/** The page for one answer of the server: returns nodes. `owner` hides the cards of other accounts (and cards without an owner). */
export function boardView(data, wanted, { highlight, owner = "", onOwner, onChain, onClear, onLeave }) {
  const picked = pickRepo(data, wanted);
  const repos = data?.repos ?? [];
  const all = picked ? picked.columns.flatMap((c) => c.cards) : [];
  const filter = h("select", { class: "small-select", title: "Show the cards of one account", "aria-label": "Show the cards of one account", "data-focus": "owner-filter", onChange: (e) => onOwner?.(e.target.value) },
    h("option", { value: "" }, "All owners"),
    boardOwners(all).map((o) => h("option", { value: o.id, selected: o.id === owner }, `${o.name} (${o.cards})`)));
  const toolbar = h("div", { class: "toolbar" },
    h("h1", {}, "Board"),
    repos.length > 1
      ? repos.map((r) => h("a", { class: r.repo === picked?.repo ? "btn primary" : "btn", href: boardHash(r.repo), "data-focus": `repo-${r.repo}` }, r.repo))
      : picked ? h("span", { class: "muted" }, picked.repo) : null,
    filter);
  if (!picked) return [toolbar, data?.empty ? h("div", { class: "empty" }, data.empty) : null];

  const target = highlight == null ? undefined : all.find((c) => c.issue === highlight);
  const lit = target ? new Set([target.issue, ...target.chain]) : null;
  const handlers = { lit, onChain, onLeave };
  const chainLine = target
    ? h("div", { class: "board-chain" },
      `In the way of #${target.issue}:`,
      ...target.chain.flatMap((i) => [" ", issueLink(picked.repo, i, () => onLeave(target), `chain-${i}`)]),
      " ", h("button", { class: "small", "data-focus": "chain-clear", onClick: () => onClear() }, "Show all"))
    : null;

  const cols = picked.columns.map((col) => {
    let group;
    const body = [];
    const shown = owner ? col.cards.filter((c) => c.owner === owner) : col.cards;
    for (const card of shown) {
      if (card.group && card.group !== group) body.push(h("div", { class: "board-sub muted" }, card.group));
      group = card.group;
      body.push(cardView(card, picked.repo, handlers));
    }
    return h("div", { class: `board-col ${col.id}` },
      h("h3", {}, col.title, " ", h("span", { class: "muted" }, String(shown.length))),
      ...body);
  });
  return [toolbar, chainLine, h("div", { class: "board" }, ...cols)];
}

/** Opens the page and returns at once a function that closes it. */
export function renderBoard(main, wanted) {
  let closed = false;
  let data;
  let last;
  let highlight;
  let owner = "";
  let left; // the watcher of a card whose GitHub link was opened: check GitHub again when the user comes back
  const heading = h("div", { class: "toolbar" }, h("h1", {}, "Board"));

  const draw = () => mount(main, boardView(data, wanted, {
    highlight, owner,
    onOwner: (id) => { owner = id; draw(); },
    onChain: (issue) => { highlight = issue; draw(); },
    onClear: () => { highlight = undefined; draw(); },
    onLeave: (card) => { if (card.watcher) left = card.watcher; },
  }));

  const fetchOnce = async () => {
    let next;
    try {
      next = await api.board();
    } catch (e) {
      if (!closed && !data) mount(main, heading, h("div", { class: "errors" }, e.message));
      return;
    }
    if (closed) return;
    const text = JSON.stringify(next);
    if (text === last) return;
    // A select has the focus: leave the answer for the next tick, so the list under the reader's hands does not change.
    if (fieldFocused(main)) return;
    last = text;
    data = next;
    if (highlight != null && !pickRepo(data, wanted)?.columns.some((c) => c.cards.some((k) => k.issue === highlight))) highlight = undefined;
    if (owner && !pickRepo(data, wanted)?.columns.some((c) => c.cards.some((k) => k.owner === owner))) owner = "";
    draw();
  };

  // One request at a time: a slow server is never asked again before it answered.
  let busy = false;
  let again = false; // asked for while busy: ask once more when done
  const load = async () => {
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
  load();
  const onVisible = async () => {
    if (document.visibilityState !== "visible" || !left) return;
    const id = left;
    left = undefined;
    await api.tickWatcher(id).catch(() => {});
    load();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    closed = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
