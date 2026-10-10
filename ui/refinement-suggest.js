import { aiProps, confirmDialog, h, modal } from "./dom.js";

// The suggestions of the architect on the draft page: the Suggest button, its status, and Accept / Edit and accept / Reject.
// Every text is set as text, never as HTML.

export const SUGGEST_FIELDS = ["title", "who", "what", "why", "criteria", "outOfScope", "dependsOn", "notes"];
/** The fields that hold one text: a suggestion replaces it. */
export const TEXT_FIELDS = ["title", "who", "what", "why", "outOfScope", "notes"];
export const FIELD_LABELS = { title: "Title", who: "As …", what: "I want …", why: "so that …", criteria: "Acceptance criteria", outOfScope: "Out of scope", dependsOn: "Depends on", notes: "Notes for the builder" };
export const REASON_MAX = 300;
export const NO_BRIEF = "Ask the architect to look at the code first. Then it can make suggestions.";
export const NO_MAP = "Accept a rule or an example for the map first. Then the architect can suggest criteria.";
export const REPLACE_ASK = "Replace the text of this field with the suggestion?";

const FIELD_WORDS = { title: "the title", who: "“As …”", what: "“I want …”", why: "“so that …”", criteria: "the acceptance criteria", outOfScope: "out of scope", dependsOn: "depends on", notes: "the notes" };
const trim = (t) => String(t ?? "").trim();

/** Where a text came from, in words; "" when it is not known. */
export function fromText(from) {
  if (from === "typed") return "typed";
  if (from === "accepted") return "accepted";
  if (from === "accepted-edited") return "accepted, then edited";
  return "";
}

/** The source to show for the value on the page: it follows what is visible, not only what is saved. */
export function shownFrom(saved, value) {
  if (!trim(value)) return "";
  if (saved && saved.text === value) return saved.from;
  if (!saved || !saved.from || saved.from === "typed") return "typed";
  return "accepted-edited";
}

/** A log line of the suggestions in words, or "" when the line is not one of them. */
export function suggestLogText(entry) {
  const who = entry.who || "Someone";
  const field = FIELD_WORDS[entry.detail];
  const of = field ? ` for ${field}` : "";
  switch (entry.what) {
    case "suggestion-asked": return `${who} asked the architect for a suggestion${of}`;
    case "architect-suggested": return `The architect made a suggestion${of}`;
    case "suggestion-accepted": return `${who} accepted a suggestion${of}`;
    case "suggestion-rejected": return `${who} rejected a suggestion${of}`;
    default: return "";
  }
}

/** The architect's run when it is a suggestion for this field of this draft, else null. */
export const runFor = (s, did, f) => {
  const a = s?.architect;
  return a?.kind === "suggest" && a.draft === did && a.field === f ? a : null;
};

/** What the box of a field shows: { kind: "line" | "none" | "hint" | "button", again?, text? }. */
export function suggestState(s, d, f) {
  const a = runFor(s, d.id, f);
  const st = a?.state;
  if (a && (st === "queued" || st === "running")) return { kind: "line", again: "" };
  if (a && st === "paused") return { kind: "line", again: "Ask again" };
  if (a && st === "failed") return { kind: "line", again: "Try again" };
  const other = s.architect?.state;
  if (other === "queued" || other === "running" || other === "paused") return { kind: "none" };
  if (!s.brief) return { kind: "none" };
  if (f === "criteria" && !s.talk?.map?.rules?.length && !s.talk?.map?.examples?.length) return { kind: "hint", text: NO_MAP };
  return { kind: "button" };
}

/** The rule or example of the map a criterion suggestion comes from: { kind, text } or null. */
export function tieOf(s, x) {
  if (!x?.tie) return null;
  const rule = s.talk?.map?.rules?.find((e) => e.id === x.tie);
  if (rule) return { kind: "rule", text: rule.text };
  const ex = s.talk?.map?.examples?.find((e) => e.id === x.tie);
  return ex ? { kind: "example", text: ex.text } : null;
}

const titleOf = (o) => String(o?.preview?.title || o?.title?.text || "Untitled draft");
const waiting = (d, f) => (d.suggestions ?? []).filter((x) => x.field === f);
const textOf = (s, x) => {
  if (x.field !== "dependsOn") return x.text ?? "";
  return x.issue !== undefined ? `#${x.issue}` : `${titleOf((s.drafts ?? []).find((o) => o.id === x.draft))} (draft)`;
};

/** Everything `suggestNodes` reads, as one string: the box is drawn again only when it changes. */
export const boxKey = (s, d, f) => JSON.stringify([
  suggestState(s, d, f),
  runFor(s, d.id, f),
  waiting(d, f),
  f === "criteria" ? waiting(d, f).map((x) => tieOf(s, x)) : null,
  f === "dependsOn" ? waiting(d, f).map((x) => textOf(s, x)) : null,
]);

/** Asks for the text of a suggestion to accept. Resolves true when it was accepted. */
function acceptDialog(act, x) {
  let busy = false;
  return modal("Edit and accept", (close) => {
    const area = h(x.field === "title" ? "input" : "textarea", { name: "text", "aria-label": act.label, value: x.text, ...(x.field === "title" ? { autocomplete: "off" } : { rows: 4 }) });
    const err = h("p", { class: "status bad flush" });
    const run = async () => {
      if (busy) return;
      const next = trim(area.value);
      if (!next) return void (err.textContent = "Write the text.");
      err.textContent = "";
      busy = true;
      const ok = await act.accept(save, x, next === x.text ? undefined : next);
      busy = false;
      close(ok ? true : undefined);
    };
    const save = h("button", { class: "primary", onClick: run }, "Accept");
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, act.label), area),
      TEXT_FIELDS.includes(x.field) && act.hasOther(x) ? h("p", { class: "muted" }, "This replaces the text of the field.") : null,
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  }, { busy: () => busy });
}

/** Asks for an optional reason. Resolves true when the suggestion was rejected. */
function rejectDialog(act, x) {
  let busy = false;
  return modal("Reject suggestion", (close) => {
    const area = h("textarea", { name: "reason", rows: 3, maxlength: REASON_MAX });
    const run = async () => {
      if (busy) return;
      busy = true;
      const ok = await act.reject(reject, x, trim(area.value) || undefined);
      busy = false;
      close(ok ? true : undefined);
    };
    const reject = h("button", { class: "primary", onClick: run }, "Reject");
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Reason (optional)"), area), h("div", { class: "row" }, h("span", { class: "spacer" }), reject));
  }, { busy: () => busy });
}

function parts(s, x, act) {
  const tie = x.field === "criteria" ? tieOf(s, x) : null;
  return [
    h("span", aiProps(`suggestion for ${FIELD_LABELS[x.field] ?? x.field}`), h("span", { class: "pill" }, "Suggested"), " ", h("span", { class: "said" }, textOf(s, x))),
    tie ? h("small", { class: "muted" }, `From the ${tie.kind}: ${tie.text}`) : null,
    act ? [
      h("button", { class: "small", "data-focus": `sug-accept-${x.id}`, "aria-label": `Accept suggestion for ${act.label}`, onClick: async (e) => {
        const btn = e.currentTarget;
        if (TEXT_FIELDS.includes(x.field) && act.hasOther(x) && !(await confirmDialog({ title: "Replace text", text: REPLACE_ASK, confirm: "Replace", danger: false }))) return undefined;
        return act.accept(btn, x);
      } }, "Accept"),
      x.field !== "dependsOn" ? h("button", { class: "small", "data-focus": `sug-edit-${x.id}`, "aria-label": `Edit and accept suggestion for ${act.label}`, onClick: async () => {
        await acceptDialog(act, x);
      } }, "Edit and accept") : null,
      h("button", { class: "small", "data-focus": `sug-reject-${x.id}`, "aria-label": `Reject suggestion for ${act.label}`, onClick: async () => {
        await rejectDialog(act, x);
      } }, "Reject"),
    ] : null,
  ];
}

/**
 * The nodes of one field's box: the status or the Suggest button, then the waiting suggestions.
 * `act` null: a read-only view, only the suggestions are drawn. Otherwise `act`: { line(architect), label, ask(btn), hasOther(x), accept(btn, x, text), reject(btn, x, reason) }.
 */
export function suggestNodes(s, d, f, act) {
  const out = [];
  if (act) {
    const st = suggestState(s, d, f);
    if (st.kind === "line") {
      out.push(act.line(s.architect));
      if (st.again) out.push(h("button", { class: "small", "data-focus": `suggest-${f}`, onClick: (e) => act.ask(e.currentTarget) }, st.again));
    } else if (st.kind === "hint") out.push(h("p", { class: "muted" }, st.text));
    else if (st.kind === "button") {
      out.push(h("button", { class: "small", "data-focus": `suggest-${f}`, "aria-label": `Suggest ${act.label}`, onClick: (e) => act.ask(e.currentTarget) }, "Suggest"));
    }
  }
  const list = waiting(d, f);
  if (list.length) out.push(TEXT_FIELDS.includes(f) ? h("div", { class: "entry" }, parts(s, list[0], act)) : h("ul", {}, list.map((x) => h("li", { class: "entry" }, parts(s, x, act)))));
  return out;
}
