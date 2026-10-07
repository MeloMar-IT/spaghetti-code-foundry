import { h, modal } from "./dom.js";
import { REASON_MAX } from "./refinement-suggest.js";

// The Definition of Ready on the draft page: the check, the results and "Accept anyway". Every text is set as text, never as HTML.

export const READY_TITLE = "Definition of Ready";
export const CHECK = "Check readiness";
export const RESULT_WORDS = { met: "Met", "not-met": "Not met", unsure: "Unsure" };
export const NOT_CHECKED = "Not checked yet";
export const BY_WORDS = { code: "checked by code", architect: "judged by the architect" };
export const DRAFT_STATES = { ready: "Ready", drafting: "Drafting" };
export const ACCEPT = "Accept anyway";
export const ACCEPTED = "Accepted anyway";
export const NOT_NEEDED = "not needed: the item is met";
export const REMOVE = "Remove reason";
export const REMOVE_ASK = "Remove this reason? The item then counts as not accepted.";
export const PLAN_NOTE = "A plan belongs in the build step. This item cannot be accepted anyway.";
export const NEEDS_BRIEF = "The architect has to judge the unsure items. Ask it to look at the code first (Context brief), then check readiness again.";
export const LIST_CHANGED = "The list changed after the last check. Check readiness again.";

/** The architect's run when it is a readiness check of this draft, else null. */
export const readyRun = (s, did) => {
  const a = s?.architect;
  return a?.kind === "ready" && a.draft === did ? a : null;
};

/** The state of a draft in words: "Ready" or "Drafting". */
export const draftStateText = (d) => DRAFT_STATES[d?.state] ?? "Drafting";

/** What the check shows: { kind: "line" | "none" | "button", again? }. A brief is not needed here: code may decide every item alone. */
export function readyState(s, d) {
  const a = readyRun(s, d.id);
  const st = a?.state;
  if (a && (st === "queued" || st === "running")) return { kind: "line", again: "" };
  if (a && st === "paused") return { kind: "line", again: "Ask again" };
  if (a && st === "failed") return { kind: "line", again: "Try again" };
  const other = s.architect?.state;
  if (other === "queued" || other === "running" || other === "paused") return { kind: "none" };
  return { kind: "button" };
}

/** True when the last check left items for the architect and there is no brief it could use. */
const needsBrief = (s, d) => !s.brief && (d.readiness?.items ?? []).some((i) => i.result === "unsure");

/** One row per item of the list: { id, text, plan, result, reason, by, accepted, canAccept }. */
export function readyRows(s, d) {
  const list = s.readyList ?? d.readiness?.items ?? [];
  return list.map((item) => {
    const r = d.readiness?.items?.find((i) => i.id === item.id);
    const result = r?.result ?? "none";
    const accepted = d.acceptedAnyway?.find((a) => a.id === item.id);
    const plan = (item.rule ?? item.id) === "no-plan";
    return {
      id: item.id,
      text: item.text ?? r?.text ?? item.id,
      plan,
      result,
      reason: r?.reason ?? "",
      by: r?.by,
      accepted,
      canAccept: !plan && !accepted && (result === "not-met" || result === "unsure"),
    };
  });
}

export const readyKey = (s, d) => JSON.stringify([readyState(s, d), readyRun(s, d.id), s.readyList ?? null, s.brief ? 1 : 0, d.readiness ?? null, d.acceptedAnyway ?? null, d.state]);

/** "Checked <date and time>". */
export const checkedMeta = (r) => `Checked ${new Date(r.at).toLocaleString()}`;

/** Asks for the reason. Resolves true when the item was accepted. */
function acceptDialog(act, row) {
  let busy = false;
  return modal(ACCEPT, (close) => {
    const area = h("textarea", { name: "reason", rows: 3, maxlength: REASON_MAX });
    const error = h("p", { class: "status bad" });
    const run = async () => {
      if (busy) return;
      const reason = String(area.value ?? "").trim();
      if (!reason) {
        error.textContent = "Give a reason.";
        return;
      }
      error.textContent = "";
      busy = true;
      const ok = await act.accept(accept, row, reason);
      busy = false;
      close(ok ? true : undefined);
    };
    const accept = h("button", { class: "primary", onClick: run }, ACCEPT);
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("p", { class: "said" }, row.text),
      h("label", { class: "field" }, h("span", {}, "Reason"), area), error, h("div", { class: "row" }, h("span", { class: "spacer" }), accept));
  }, { busy: () => busy });
}

function rowNode(row, act) {
  const checked = row.result !== "none";
  return h("li", {},
    h("span", { class: `pill ready-${row.result}` }, RESULT_WORDS[row.result] ?? NOT_CHECKED), " ",
    h("b", {}, row.text),
    checked ? [h("span", { class: "said" }, row.reason), h("small", { class: "muted" }, BY_WORDS[row.by] ?? row.by ?? "")] : null,
    row.accepted ? h("p", { class: "said" }, h("b", {}, `${ACCEPTED}${row.accepted.notNeeded ? ` (${NOT_NEEDED})` : ""}: `), row.accepted.reason) : null,
    row.accepted && act ? h("button", { class: "small", "data-focus": `ready-remove-${row.id}`, onClick: (e) => {
      if (!confirm(REMOVE_ASK)) return undefined;
      return act.remove(e.currentTarget, row);
    } }, REMOVE) : null,
    row.plan && (row.result === "not-met" || row.result === "unsure") ? h("small", { class: "muted" }, PLAN_NOTE) : null,
    row.canAccept && act ? h("button", { class: "small", "data-focus": `ready-accept-${row.id}`, "aria-label": `${ACCEPT}: ${row.text}`, onClick: async () => {
      await acceptDialog(act, row);
    } }, ACCEPT) : null);
}

/**
 * The nodes of the part. `act` null: a read-only view, nothing when there is no check and no mark, and no button.
 * Otherwise `act`: { line(architect), ask(btn), accept(btn, row, reason), remove(btn, row) }.
 */
export function readyNodes(s, d, act) {
  if (!act && !d.readiness && !d.acceptedAnyway) return [];
  const out = [h("h4", {}, READY_TITLE), h("span", { class: `pill state-${d.state}` }, draftStateText(d))];
  if (act) {
    const st = readyState(s, d);
    const ask = (label) => h("button", { class: "small", "data-focus": "ready-check", onClick: (e) => act.ask(e.currentTarget) }, label);
    if (st.kind === "line") {
      out.push(act.line(s.architect));
      if (st.again) out.push(ask(st.again));
    } else if (st.kind === "button") out.push(ask(CHECK));
    if (st.kind !== "line" && needsBrief(s, d)) out.push(h("p", { class: "muted" }, NEEDS_BRIEF));
  }
  if (d.readiness) out.push(h("p", { class: "muted" }, checkedMeta(d.readiness) + (d.readiness.stale ? ` · ${LIST_CHANGED}` : "")));
  out.push(h("ol", {}, readyRows(s, d).map((row) => rowNode(row, act))));
  return out;
}

const COUNTS = /^\d+ met, \d+ not met, \d+ unsure$/;

/** A log line of the readiness check in words, or "" when the line is not one of them. */
export function readyLogText(entry) {
  const who = entry.who || "Someone";
  const counts = COUNTS.test(entry.detail ?? "") ? `: ${entry.detail}` : "";
  const quoted = entry.detail ? `: "${entry.detail}"` : "";
  switch (entry.what) {
    case "ready-checked": return `${who} checked a story draft against the Definition of Ready${counts}`;
    case "ready-asked": return `${who} asked the architect to judge the readiness of a story draft`;
    case "architect-judged": return `The architect judged the readiness of a story draft${counts}`;
    case "ready-accepted": return `${who} accepted an item anyway${quoted}`;
    case "ready-unaccepted": return `${who} removed the reason of an item accepted anyway${quoted}`;
    default: return "";
  }
}
