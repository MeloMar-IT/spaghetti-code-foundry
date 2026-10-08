import { h } from "./dom.js";
import { whereLink, whereTarget, whoClass } from "./next.js";
import { ownerLabel } from "./runs.js";
import { ageText } from "./work-model.js";

// The list layout of the Work page: one table per group. Every word comes from the server's record.

const REPO_OK = /^[\w.-]+\/[\w.-]+$/;

/** A link to an issue on GitHub; plain text when the repository is not a GitHub name. */
function issueLink(repo, issue, onClick) {
  return REPO_OK.test(repo ?? "")
    ? h("a", {
      href: `https://github.com/${repo}/issues/${issue}`, target: "_blank", rel: "noopener", class: "mono",
      onClick: (e) => { e?.stopPropagation?.(); onClick(); },
    }, `#${issue}`)
    : h("span", { class: "mono" }, `#${issue}`);
}

function rowView(item, cols, handlers) {
  const n = item.next ?? {};
  const now = handlers.now ?? new Date();
  const leave = () => handlers.onLeave?.(item);
  const open = () => { globalThis.location.hash = `#/runs/${item.runId}`; };
  const own = item.runId && n.where?.url === `#/runs/${item.runId}`;
  const cells = [
    h("td", {}, issueLink(item.repo, item.issue, leave), " ", h("b", {}, item.title), n.text ? h("div", { class: "muted" }, n.text) : null),
  ];
  if (cols.repo) cells.push(h("td", { class: "muted" }, item.repo));
  cells.push(h("td", {}, n.status || item.columnTitle));
  if (cols.next) {
    cells.push(h("td", {},
      h("span", { class: `pill ${whoClass(n)}` }, n.who), " ", n.action ?? "",
      !own && n.where?.label
        ? h("span", { onClick: (e) => { e?.stopPropagation?.(); if (whereTarget(n.where)?.external) leave(); } }, " ", whereLink(n.where))
        : null));
  }
  if (cols.blockers) {
    cells.push(h("td", {}, ...(item.after ?? []).flatMap((i, k) => [k ? ", " : null, issueLink(item.repo, i, leave)])));
  }
  if (cols.owner) cells.push(h("td", { class: "muted" }, ownerLabel(item.ownerName)));
  if (cols.age) cells.push(h("td", { class: "muted", "data-since": item.since }, ageText(item.since, now)));
  const props = { "data-focus": `row-${item.repo}#${item.issue}` };
  if (item.runId) {
    Object.assign(props, { class: "link", role: "link", tabindex: "0", onClick: open, onKeydown: (e) => { if (e?.key === "Enter" && e.target === e.currentTarget) open(); } });
  }
  return h("tr", props, ...cells);
}

/** Brings the age cells under `root` up to date without drawing the list again. */
export function refreshAges(root, now = new Date()) {
  for (const el of root.querySelectorAll("td[data-since]")) {
    const text = ageText(el.getAttribute("data-since"), now);
    if (el.textContent !== text) el.textContent = text;
  }
}

/** The groups (`[{ id, title, items }]`) as tables: returns nodes. */
export function listView(groups, prefs, handlers = {}) {
  const props = prefs.props ?? [];
  const cols = {
    repo: props.includes("repo") && new Set(groups.flatMap((g) => g.items.map((i) => i.repo))).size > 1,
    next: props.includes("next"),
    blockers: props.includes("blockers"),
    owner: props.includes("owner"),
    age: props.includes("age"),
  };
  const head = ["Story", cols.repo ? "Repository" : null, "Status", cols.next ? "Next move" : null, cols.blockers ? "After" : null, cols.owner ? "Owner" : null, cols.age ? "Age" : null]
    .filter(Boolean);
  const headRow = () => h("tr", {}, ...head.map((t) => h("th", {}, t))); // fresh nodes for every table
  return groups.map((g) => h("div", { class: "work-group" },
    g.title ? h("h3", {}, g.title, " ", h("span", { class: "muted" }, String(g.items.length))) : null,
    g.items.length
      ? h("table", { class: "table work-list" }, h("thead", {}, headRow()), h("tbody", {}, ...g.items.map((i) => rowView(i, cols, handlers))))
      : null));
}
