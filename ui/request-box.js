import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { icon } from "./icons.js";
import { REQUEST, correctionText, hasAssumed, planPoints, turnItemFor } from "./request-model.js";

// The "Your request" box: what was asked and what was assumed, and Change this on an assumption. The difference between the two
// never rests on colour alone: each has its own tag word, icon and class, and an assumption has a dashed edge and italic text.

/**
 * Draws the box; null for an empty list. `points`: [{ kind, text, raw }]. `fix` (or null: read-only):
 * { open: raw text of the assumption being corrected | null, text, off, onOpen(raw), onInput(text), onSend(), onCancel() }.
 * `retry`: a function that draws a "Check again" button (the lookup of the person's rights failed).
 */
export function requestView(points, { heading = "h2", focus = "request", fix = null, note = "", retry = null } = {}) {
  if (!Array.isArray(points) || !points.length) return null;
  const off = fix?.off ? true : undefined;
  const item = (p, i) => {
    const asked = p.kind === "asked";
    const parts = [
      h("span", { class: "request-tag" }, icon(asked ? "check" : "circle-help", { small: true }), asked ? REQUEST.asked : REQUEST.assumed),
      h("span", { class: "request-text" }, p.text),
    ];
    if (!asked && fix) {
      if (fix.open === p.raw) {
        const area = h("textarea", {
          rows: 3, maxlength: 2000, disabled: off, "data-focus": `${focus}-text-${i}`, "aria-label": REQUEST.what, placeholder: REQUEST.what, value: fix.text,
          onInput: (e) => fix.onInput(String(e?.target?.value ?? area.value ?? "")),
        });
        parts.push(area,
          h("div", { class: "row" },
            h("button", { type: "button", class: "primary", disabled: off, "data-focus": `${focus}-send-${i}`, onClick: () => fix.onSend() }, REQUEST.send),
            h("button", { type: "button", disabled: off, "data-focus": `${focus}-cancel-${i}`, onClick: () => fix.onCancel() }, REQUEST.cancel)));
      } else {
        parts.push(h("button", { type: "button", disabled: off, "data-focus": `${focus}-change-${i}`, onClick: () => fix.onOpen(p.raw) }, REQUEST.change));
      }
    }
    return h("li", { class: `request-point request-${asked ? "asked" : "assumed"}` }, parts);
  };
  return h("section", { class: "card mb-16 request-box", "aria-label": REQUEST.title },
    h(heading, {}, REQUEST.title),
    h("ul", { class: "request-points" }, points.map(item)),
    note ? h("p", { class: "muted", "aria-live": "polite" }, note) : null,
    retry ? h("button", { type: "button", "data-focus": `${focus}-again`, onClick: retry }, REQUEST.again) : null);
}

const itemsOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : []);

/**
 * The box of a run page: `{ el, update(summary) }`. It asks `myTurn` once per wait (and again after a failed or refused look) whether the
 * person may reject this plan, and offers Change this only while the plan waits for a decision and the answer is yes. The draft is bound to
 * the assumption's own text and to the plan detail read when the editor was opened; a replaced plan or assumption closes the editor.
 */
export function createRequestBox({ a = api, runId, readOnly = false } = {}) {
  const el = h("div", { class: "request-host" });
  el.hidden = true;
  let points = [];
  let waiting = false;
  let fetchKey = null;
  let lookup = "idle"; // idle | loading | found | missing | failed
  let item = null;
  let open = null; // the raw text of the assumption being corrected
  let detail = null; // the plan detail read when the editor opened: its stamp and digest go with the correction
  let text = "";
  let phase = "idle"; // idle | sending | sent
  let note = "";
  let drawn = null;
  let seq = 0;

  const close = (why = "") => { open = null; detail = null; text = ""; note = why; seq++; };

  async function look(key) {
    lookup = "loading";
    try {
      const found = turnItemFor(itemsOf(await a.myTurn()), runId);
      if (fetchKey !== key) return;
      item = found;
      lookup = found ? "found" : "missing";
    } catch {
      if (fetchKey !== key) return;
      lookup = "failed";
    }
    paint();
  }
  // a look that found no item, or failed, is repeated on request: the person may have been given the right meanwhile
  const again = () => { if (fetchKey && (lookup === "failed" || lookup === "missing")) void look(fetchKey); paint(); };

  async function onOpen(raw) {
    if (phase === "sending") return;
    close();
    open = raw;
    const mine = seq;
    paint();
    try {
      const d = await a.turnDetail(item.key);
      if (!d || typeof d !== "object") throw new Error("no detail");
      if (mine !== seq) return;
      detail = d;
    } catch {
      if (mine !== seq) return;
      close(REQUEST.failed);
    }
    paint();
  }

  async function onSend() {
    if (phase === "sending" || !detail || open === null) return;
    const body = correctionText(open, text);
    if (!body) { note = REQUEST.needsWords; paint(); return; }
    const mine = seq;
    phase = "sending";
    note = REQUEST.sending;
    paint();
    try {
      await a.actTurn({ key: item.key, action: "reject", stamp: detail.stamp, digest: detail.digest, text: body });
    } catch (e) {
      if (mine !== seq) { phase = "idle"; paint(); return; }
      phase = "idle";
      if (e?.status === 409) { close(REQUEST.changed); fetchKey = null; item = null; lookup = "idle"; } else note = REQUEST.failed;
      paint();
      return;
    }
    phase = "sent";
    close(REQUEST.sent);
    paint();
  }

  function paint() {
    const canFix = item && lookup === "found" && phase !== "sent";
    let shown = note;
    if (!shown) {
      if (!waiting) shown = hasAssumed(points) ? REQUEST.notWaiting : "";
      else if (lookup === "missing") shown = REQUEST.notYours;
      else if (lookup === "failed") shown = REQUEST.lookupFailed;
    }
    const key = JSON.stringify([points, canFix ? item.key : null, lookup, open, detail !== null, phase, shown]);
    if (key === drawn) return;
    drawn = key;
    const fix = canFix ? {
      open, text, off: phase === "sending" || (open !== null && !detail),
      onOpen, onInput: (t) => { text = t; }, onSend, onCancel: () => { close(); paint(); },
    } : null;
    mount(el, requestView(points, { fix, note: shown, retry: waiting && (lookup === "failed" || lookup === "missing") ? again : null }));
  }

  return {
    el,
    update(s) {
      points = planPoints(s);
      el.hidden = points.length === 0;
      waiting = !readOnly && s?.next?.kind === "approve_plan" && hasAssumed(points);
      const key = waiting ? `${s.next.runId ?? runId}|${s.waiting?.since ?? ""}` : null;
      if (key !== fetchKey) {
        // another plan (or none): what was drawn for the old one is gone, a draft with it
        fetchKey = key;
        item = null;
        lookup = "idle";
        phase = "idle";
        close();
        if (key) void look(key);
      } else if (lookup === "failed" && key) {
        void look(key);
      }
      // the assumption being corrected is gone or was reworded: the draft does not move to another one
      if (open !== null && !points.some((p) => p.kind === "assumed" && p.raw === open)) close(REQUEST.changed);
      paint();
    },
  };
}
