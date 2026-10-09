import { h } from "./dom.js";
import { whereLink, whereTarget, whoClass } from "./next.js";
import { ownerLabel } from "./runs.js";
import { issueLink } from "./work-list.js";
import { ageText, keyOf } from "./work-model.js";

// The side panel of the Work page: what is in the way of one story, in the order it must finish. Every word
// comes from the server's record (the same GET /api/board answer); this file only orders and draws.

export const PANEL_ID = "work-panel";

/** [{ issue, direct, item? }] — every story in the way of `item`, each after the ones it waits for. Pure. */
export function chainOrder(item, items) {
  const byKey = new Map(items.map((i) => [keyOf(i), i]));
  const after = item.after ?? [];
  const seen = new Set([item.issue]);
  const out = [];
  const add = (issue) => {
    const card = byKey.get(`${item.repo}#${issue}`);
    out.push({ issue, direct: after.includes(issue), ...(card ? { item: card } : {}) });
  };
  const walk = (blockers) => {
    for (const b of [...blockers].sort((x, y) => x.issue - y.issue)) {
      if (seen.has(b.issue)) continue;
      seen.add(b.issue);
      walk(b.next?.blockers ?? byKey.get(`${item.repo}#${b.issue}`)?.next?.blockers ?? []);
      add(b.issue);
    }
  };
  walk(item.next?.blockers ?? []);
  for (const issue of [...(item.chain ?? [])].sort((x, y) => x - y)) {
    if (seen.has(issue)) continue;
    seen.add(issue);
    add(issue);
  }
  return out;
}

/** The next move of a story: who, action and the where link. */
function moveParts(n, leave, focus) {
  return [
    n.who ? h("span", { class: `pill ${whoClass(n)}` }, n.who) : null, n.who ? " " : null, n.action ?? "",
    n.where?.label ? h("span", { onClick: () => { if (whereTarget(n.where)?.external) leave(); } }, " ", whereLink(n.where, focus)) : null,
  ];
}

/**
 * The panel of one story. It is a div with an explicit role (an <aside> would be hidden by `.no-side aside`).
 * handlers: { onClose, onBack?, onPick(item), onLeave(item), now?, narrow? }
 */
export function panelView(item, items, handlers = {}) {
  const n = item.next ?? {};
  const leave = () => handlers.onLeave?.(item);
  const role = handlers.narrow ? { role: "dialog", "aria-modal": "true" } : { role: "complementary" };
  const chain = chainOrder(item, items);
  const entries = chain.map((e) => {
    const m = e.item?.next ?? {};
    const own = () => handlers.onLeave?.(e.item);
    return h("li", {},
      e.item
        ? [h("button", { type: "button", class: "ghost small", "data-focus": `work-panel-chain-${e.issue}`, onClick: () => handlers.onPick?.(e.item) }, `#${e.issue} ${e.item.title}`),
          " ", m.status || e.item.columnTitle, " ", ...moveParts(m, own, `work-panel-chain-where-${e.issue}`)]
        : [issueLink(item.repo, e.issue, leave, `work-panel-chain-${e.issue}`), " ", h("span", { class: "muted" }, "not on the board")],
      e.direct ? [" ", h("span", { class: "pill" }, "directly")] : null);
  });
  const age = ageText(item.since, handlers.now ?? new Date());
  return h("div", { class: "work-panel", "aria-label": `#${item.issue} ${item.title}`, ...role },
    h("div", { class: "work-panel-head" },
      h("h2", { tabindex: "-1", "data-focus": "work-panel-title" }, `#${item.issue} ${item.title}`),
      handlers.onBack ? h("button", { type: "button", class: "small", "data-focus": "work-panel-back", onClick: () => handlers.onBack() }, "Back") : null,
      h("button", { type: "button", class: "small", "data-focus": "work-panel-close", onClick: () => handlers.onClose?.() }, "Close")),
    h("div", {}, issueLink(item.repo, item.issue, leave, "work-panel-issue")),
    h("div", {}, h("span", { class: "pill" }, n.status || item.columnTitle)),
    n.text ? h("p", {}, n.text) : null,
    h("div", {}, ...moveParts(n, leave, "work-panel-where")),
    ownerLabel(item.ownerName) ? h("div", { class: "muted" }, ownerLabel(item.ownerName)) : null,
    age ? h("div", { class: "muted" }, h("span", { "data-since": item.since }, age)) : null,
    item.runId ? h("div", {}, h("a", { href: `#/runs/${item.runId}`, "data-focus": "work-panel-run" }, "Open run")) : null,
    h("h3", {}, `In the way of #${item.issue}`),
    entries.length ? h("ol", { class: "work-panel-chain" }, ...entries) : h("p", { class: "muted" }, "Nothing is in the way."));
}
