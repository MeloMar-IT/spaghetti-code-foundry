// The dialogs of the run page of an administrator. Relative imports only; ui/runs.js imports this file, not the other way.
import { api } from "./api.js";
import { errorText } from "./auth.js";
import { confirmDialog, h, modal, toast } from "./dom.js";

const NOT_CANCELLED = "The run could not be cancelled. It may have just finished.";

/**
 * The Approve and Reject dialog with an optional note. `send(note)` makes the call. A refusal shows its sentence in the
 * dialog, which stays open with the note kept. Nothing closes the dialog while the call is out. Resolves true once sent.
 */
export async function decisionDialog(kind, send) {
  const approve = kind === "approve";
  let busy = false;
  const answer = await modal(approve ? "Approve" : "Reject", (close) => {
    const note = h("textarea", { name: "note", rows: 4, "aria-label": approve ? "Note (optional)" : "Why reject? (optional)" });
    const err = h("p", { class: "status bad flush", role: "alert" });
    const submitBtn = h("button", { type: "submit", class: approve ? "primary" : "danger" }, approve ? "Approve" : "Reject");
    const closeBtn = h("button", { type: "button", onClick: () => { if (!busy) close(false); } }, "Not now");
    const submit = async (e) => {
      e?.preventDefault?.();
      if (busy) return;
      busy = true;
      submitBtn.disabled = true;
      err.textContent = "";
      try {
        await send(note.value.trim());
        busy = false;
        close(true);
      } catch (ex) {
        busy = false;
        submitBtn.disabled = false;
        err.textContent = errorText(ex);
      }
    };
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault?.();
        submit();
      }
    });
    return h("form", { class: "run-dialog", onSubmit: submit },
      h("label", { class: "field" }, h("span", {}, approve ? "Note (optional)" : "Why reject? (optional)"), note),
      err,
      h("div", { class: "row" }, submitBtn, closeBtn));
  }, { busy: () => busy });
  return answer === true;
}

/**
 * The actions of the administrator's run page. Returns run(kind, from): kind is "approve", "reject", "resume", "rerun"
 * (with `from`, a step id) or "cancel". It never rejects; it resolves true when the call was sent and accepted.
 */
export function adminRunActions(runId, { a = api, ask = confirmDialog, decide = decisionDialog, setAlert = () => {}, onDialogClosed = () => {}, onDone = () => {} } = {}) {
  let acting = false;
  const sentence = (e) => { setAlert(errorText(e)); return false; };
  const asked = async (opts) => {
    try { return await ask(opts); } finally { onDialogClosed(); }
  };
  return async (kind, from) => {
    if (acting) return false;
    acting = true;
    try {
      setAlert("");
      if (kind === "approve" || kind === "reject") {
        let sent;
        try {
          sent = await decide(kind, (note) => (kind === "approve" ? a.approveRun(runId, note) : a.rejectRun(runId, note)));
        } finally { onDialogClosed(); }
        if (!sent) return false;
        toast(kind === "approve" ? "Approved — continuing" : "Rejected");
      } else if (kind === "cancel") {
        if (!(await asked({ title: "Cancel this run?", text: "You can resume it later.", confirm: "Cancel the run", cancel: "Keep running" }))) return false;
        try {
          const r = await a.cancelRun(runId);
          if (r?.cancelled === false) { setAlert(NOT_CANCELLED); return false; }
        } catch (e) { return sentence(e); }
      } else if (kind === "rerun") {
        if (!(await asked({ title: "Re-run from this step?", text: `Re-run this run from "${from}"? Earlier step outputs are kept.`, confirm: "Re-run", cancel: "Not now", danger: false }))) return false;
        try { await a.resumeRun(runId, from); } catch (e) { return sentence(e); }
        toast(`Re-running from ${from}`);
      } else {
        try { await a.resumeRun(runId); } catch (e) { return sentence(e); }
        toast("Resuming");
      }
      onDone();
      return true;
    } finally {
      acting = false;
    }
  };
}
