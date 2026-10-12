import { glyph, h } from "./dom.js";

// The nodes of the Ask SCF drawer. No decisions here (those are in ui/ask-model.js) and no calls (ui/ask.js).
// Every text of a conversation is put in as text: `h` never reads a string as HTML.

/** The button in the top bar that opens the drawer. */
export function askButton(onClick) {
  return h("button", { type: "button", id: "ask-btn", class: "ask-btn", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "ask-drawer", onClick }, "Ask SCF");
}

/**
 * The drawer and its backdrop, hidden. Returns the two nodes and the parts the drawer changes later.
 * `on`: close(), submit(), attach(checked), key(event) for the question box.
 */
export function askFrame(on, { questionMax }) {
  const thread = h("section", { class: "ask-thread", "aria-label": "Conversation" });
  const suggest = h("div", { class: "ask-suggest" });
  const status = h("p", { id: "ask-status", class: "ask-status muted", role: "status", "aria-live": "polite" });
  const context = h("p", { id: "ask-context", class: "ask-context muted text-sm" });
  const error = h("p", { id: "ask-error", class: "ask-error", role: "alert" });
  const question = h("textarea", { id: "ask-question", rows: "3", maxlength: String(questionMax), "aria-describedby": "ask-context ask-error", "data-focus": "ask-question", onKeydown: (e) => on.key(e) });
  const attach = h("input", { type: "checkbox", id: "ask-attach", checked: true, "data-focus": "ask-attach", onChange: (e) => on.attach(!!e.target.checked) });
  const send = h("button", { type: "submit", class: "primary", "data-focus": "ask-send" }, "Send");
  const close = h("button", { type: "button", class: "icon", "aria-label": "Close Ask SCF", onClick: () => on.close() }, glyph("✕"));
  const form = h("form", { class: "ask-form", "aria-label": "Your question to Ask SCF", onSubmit: (e) => { e.preventDefault?.(); on.submit(); } },
    h("label", { for: "ask-question" }, "Your question"),
    question,
    h("label", { class: "check-row", for: "ask-attach" }, attach, " Send the page I am on with my question"),
    context,
    error,
    h("div", { class: "row" }, h("span", { class: "spacer" }), send));
  const drawer = h("aside", { id: "ask-drawer", class: "ask-drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "ask-title", tabindex: "-1" },
    h("div", { class: "ask-head" }, h("h2", { id: "ask-title" }, "Ask SCF"), close),
    h("p", { class: "muted text-sm" }, "Ask SCF explains how the Foundry works. It reads and explains. It changes nothing."),
    thread,
    h("h3", { id: "ask-suggest-title" }, "Suggested questions"),
    suggest,
    status,
    form);
  drawer.hidden = true;
  const scrim = h("div", { class: "ask-scrim", onMousedown: () => on.close() });
  scrim.hidden = true;
  return { drawer, scrim, thread, suggest, status, context, error, question, attach, send, close };
}

/** One message of the conversation. */
export function entryNode(entry) {
  return h("div", { class: `ask-entry ask-${entry.kind}` },
    h("span", { class: "ask-who" }, entry.who),
    entry.kind === "waiting" ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
    entry.kind === "waiting" ? " " : null,
    entry.text);
}

/** The suggested questions as buttons. Picking one fills the question box; it does not send. */
export function suggestionNodes(list, onPick) {
  return list.map((text, i) => h("button", { type: "button", class: "small", "data-focus": `ask-suggest-${i}`, onClick: () => onPick(text) }, text));
}
