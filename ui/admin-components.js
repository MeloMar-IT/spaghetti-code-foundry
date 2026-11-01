import { api } from "./api.js";
import { h, mount, table } from "./dom.js";
import { badge } from "./kit/display.js";
import { errorState, explainError } from "./states.js";

// The "Components" card of Settings: owner and review status of each component. Pure text helpers first, then the card.

const STATUS = {
  retired: { label: "Retired", tone: "neutral" },
  unapproved: { label: "Not approved", tone: "warn" },
  "review-due": { label: "Review due", tone: "warn" },
  ok: { label: "OK", tone: "ok" },
};

/** `{ label, tone }` of a status; an unknown one reads as a warning. */
export const statusInfo = (status) => (Object.hasOwn(STATUS, status) ? STATUS[status] : { label: "Unknown", tone: "warn" });
export const ownerText = (row) => row?.owner ?? "No owner";
export const reviewText = (row) => row?.lastReview ?? "Never reviewed";

const COLUMNS = ["Kind", "Id", "Version", "Owner", "Risk", "Lifecycle", "Approved version", "Last review", "Eval suite", "Status"];

function rowOf(c) {
  const s = statusInfo(c.status);
  return h("tr", {},
    h("td", {}, c.kind),
    h("td", {}, c.builtin ? `${c.id} (built-in)` : c.id),
    h("td", {}, c.version ?? "Not recorded"),
    h("td", {}, ownerText(c)),
    h("td", {}, c.risk),
    h("td", {}, c.lifecycle),
    h("td", {}, c.approvedVersion ?? "None"),
    h("td", {}, reviewText(c)),
    h("td", {}, c.evalSuite ?? "None"),
    h("td", {}, badge({ tone: s.tone, label: s.label })));
}

/** The table in a box a keyboard can scroll: a named region that Tab stops at. */
function componentsTable(rows) {
  const box = table(COLUMNS, rows.map(rowOf), { cards: true, caption: "Components" });
  box.setAttribute("tabindex", "0");
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "Components");
  return box;
}

/** The "Components" card. It loads by itself and drops an answer that a newer load has replaced. */
export function componentsPanel() {
  const body = h("div", {});
  let loads = 0;
  const load = async () => {
    const my = ++loads;
    mount(body, h("p", { class: "muted", role: "status" }, "Loading components…"));
    let r;
    try {
      r = await api.adminComponents();
    } catch (e) {
      if (my === loads) mount(body, errorState(explainError(e, { what: "The components could not be loaded." }), { onRetry: load }));
      return;
    }
    if (my !== loads) return;
    const rows = Array.isArray(r?.components) ? r.components : [];
    const notes = [];
    if (r?.governanceProblem) notes.push(h("p", { class: "status bad", role: "alert" }, `The governance records cannot be used: ${r.governanceProblem}`));
    for (const p of Array.isArray(r?.problems) ? r.problems : []) notes.push(h("p", { class: "muted" }, `${p.kind} ${p.id}: ${p.reason}`));
    mount(body, notes, rows.length ? componentsTable(rows) : h("p", { class: "muted" }, "No components yet."));
  };
  void load();
  return h("div", { class: "card mb-14" }, h("h3", {}, "Components"),
    h("p", { class: "muted flush" }, "The owner and review status of each component. Change them in promotions/governance.yaml."), body);
}
