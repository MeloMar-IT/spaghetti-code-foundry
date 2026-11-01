import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { button } from "./kit/actions.js";
import { list } from "./kit/display.js";
import { banner, errorState, explainError } from "./states.js";

// Promotion state as text: the editor's notice and the "Promoted versions" card of Settings. Pure model first, then the parts.

const FAILED_TEXT = "The promotion state could not be read.";

/** One blocking item as a line: `Not promoted: <suite> (<reason>). <remediation>`; without a suite `Not promoted (<reason>). <remediation>`. */
export function blockedLine(b) {
  const why = b?.suite ? `: ${b.suite} (${b.code})` : ` (${b?.code ?? "unknown"})`;
  return `Not promoted${why}. ${b?.remediation ?? ""}`.trim();
}

/** `{ tone: "ok" | "neutral" | "warn", text, more }` for one row of the answer; `more` counts the blocks after the first. */
export function promotionSummary(row) {
  if (row?.state === "promoted" && row.record) return { tone: "ok", text: `Promoted: report ${row.record.reportId}`, more: 0 };
  if (row?.state === "promotable") return { tone: "neutral", text: "Ready to promote: every required suite passes.", more: 0 };
  if (row?.state === "blocked" && Array.isArray(row.blocking) && row.blocking.length) return { tone: "warn", text: blockedLine(row.blocking[0]), more: row.blocking.length - 1 };
  return { tone: "warn", text: FAILED_TEXT, more: 0 };
}

/** The editor's banner for a row, `{ failed: true }` when the state could not be read, or null when there is nothing to say. */
export function promotionNotice(row) {
  if (!row) return null;
  if (row.failed) return banner("warn", FAILED_TEXT);
  const s = promotionSummary(row);
  const actions = [];
  if (s.more > 0) actions.push({ label: `${s.more} more blocked in Settings`, href: "#/settings" });
  if (row.state === "promotable") actions.push({ label: "Promote it in Settings", href: "#/settings" });
  return banner(s.tone === "warn" ? "warn" : "info", s.text, actions);
}

const refText = (ref) => `${ref.kind} ${ref.id} v${ref.version}`;

function rowItem(row, { readOnly, onPromote }) {
  const s = promotionSummary(row);
  const all = row.state === "blocked" && row.blocking.length > 1 ? row.blocking : [];
  const promote = !readOnly && row.state === "promotable" && row.reports?.length
    ? button({ size: "small", onClick: () => onPromote(row), "data-focus": `promote-${row.ref.kind}-${row.ref.id}` }, "Promote")
    : null;
  return h("div", { class: "promotion-row" },
    h("strong", {}, refText(row.ref)),
    h("div", { class: s.tone === "warn" ? "status bad" : "muted" }, s.text),
    all.length ? h("details", {}, h("summary", {}, `All ${all.length} blocks`), list({ items: all.map(blockedLine) })) : null,
    promote);
}

/** The "Promoted versions" card of Settings. It loads by itself; Promote is drawn only when `readOnly` is false. */
export function promotionPanel({ readOnly = false } = {}) {
  const body = h("div", {});
  let loads = 0; // the number of the newest load
  const load = async () => {
    const my = ++loads;
    // plain text, not a skeleton: the card loads by itself and must not make the whole page look busy
    mount(body, h("p", { class: "muted", role: "status" }, "Loading promoted versions…"));
    let r;
    try {
      r = await api.promotions();
    } catch (e) {
      if (my === loads) mount(body, errorState(explainError(e, { what: "The promoted versions could not be loaded." }), { onRetry: load }));
      return;
    }
    if (my !== loads) return;
    const rows = Array.isArray(r?.components) ? r.components : [];
    const notes = [];
    if (r?.recordProblem) notes.push(h("p", { class: "status bad", role: "alert" }, `The promotion records cannot be used: ${r.recordProblem}`));
    for (const p of Array.isArray(r?.problems) ? r.problems : []) notes.push(h("p", { class: "muted" }, `${p.kind} ${p.id} ${p.reason}`));
    mount(body, notes,
      rows.length ? list({ items: rows.map((row) => rowItem(row, { readOnly, onPromote: promote })) }) : h("p", { class: "muted" }, "No published flows or other components to promote yet."));
  };
  const promote = async (row) => {
    try {
      await api.promote(row.ref.kind, row.ref.id, row.reports[0].id);
      toast(`Promoted ${refText(row.ref)}`);
    } catch (e) {
      toast(explainError(e, { what: `${refText(row.ref)} was not promoted.` }).what, "error");
    }
    await load();
  };
  void load();
  return h("div", { class: "card mb-14" }, h("h3", {}, "Promoted versions"),
    h("p", { class: "muted flush" }, "A component version is promoted when a recorded report of every required safety suite passes for it."), body);
}
