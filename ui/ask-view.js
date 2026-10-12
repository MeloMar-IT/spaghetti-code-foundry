import { glyph, h, timeAgo } from "./dom.js";

// The nodes of the Ask SCF drawer. No decisions here (those are in ui/ask-model.js) and no calls (ui/ask.js).
// Every text of a conversation is put in as text: `h` never reads a string as HTML.

/** The button in the top bar that opens the drawer. */
export function askButton(onClick) {
  return h("button", { type: "button", id: "ask-btn", class: "ask-btn", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "ask-drawer", onClick }, "Ask SCF");
}

/**
 * The drawer and its backdrop, hidden. Returns the two nodes and the parts the drawer changes later.
 * `on`: close(), submit(), attach(checked), key(event) for the question box, fresh(), history(), archived().
 */
export function askFrame(on, { questionMax, hints = {} }) {
  const thread = h("section", { class: "ask-thread", "aria-label": "Conversation" });
  const actions = h("div", { class: "ask-actions", role: "group", "aria-label": "This conversation" });
  const suggest = h("div", { class: "ask-suggest" });
  const suggestBox = h("div", { class: "ask-suggest-box" }, h("h3", { id: "ask-suggest-title" }, "Suggested questions"), suggest);
  const status = h("p", { id: "ask-status", class: "ask-status muted", role: "status", "aria-live": "polite" });
  const context = h("p", { id: "ask-context", class: "ask-context muted text-sm" });
  const error = h("p", { id: "ask-error", class: "ask-error", role: "alert" });
  const question = h("textarea", { id: "ask-question", rows: "3", maxlength: String(questionMax), "aria-describedby": "ask-context ask-error", "data-focus": "ask-question", onKeydown: (e) => on.key(e) });
  const attach = h("input", { type: "checkbox", id: "ask-attach", checked: true, "data-focus": "ask-attach", onChange: (e) => on.attach(!!e.target.checked) });
  const send = h("button", { type: "submit", class: "primary", "data-focus": "ask-send" }, "Send");
  const fresh = h("button", { type: "button", class: "small", title: hints.fresh, "data-focus": "ask-new", onClick: () => on.fresh() }, "New conversation");
  const historyBtn = h("button", { type: "button", class: "small", "aria-expanded": "false", "aria-controls": "ask-history", "data-focus": "ask-history-btn", onClick: () => on.history() }, "History");
  const close = h("button", { type: "button", class: "icon", "aria-label": "Close Ask SCF", onClick: () => on.close() }, glyph("✕"));
  const form = h("form", { class: "ask-form", "aria-label": "Your question to Ask SCF", onSubmit: (e) => { e.preventDefault?.(); on.submit(); } },
    h("label", { for: "ask-question" }, "Your question"),
    question,
    h("label", { class: "check-row", for: "ask-attach" }, attach, " Send the page I am on with my question"),
    context,
    error,
    h("div", { class: "row" }, h("span", { class: "spacer" }), send));
  const talk = h("div", { id: "ask-talk", class: "ask-talk" }, thread, actions, suggestBox, form);
  const archivedBtn = h("button", { type: "button", class: "small", "aria-pressed": "false", "data-focus": "ask-archived", onClick: () => on.archived() }, "Show archived");
  const list = h("ul", { class: "ask-list" });
  const history = h("section", { id: "ask-history", class: "ask-history", "aria-labelledby": "ask-history-title" },
    h("div", { class: "ask-head" }, h("h3", { id: "ask-history-title" }, "Your conversations"), archivedBtn),
    list);
  history.hidden = true;
  const drawer = h("aside", { id: "ask-drawer", class: "ask-drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "ask-title", tabindex: "-1" },
    h("div", { class: "ask-head" }, h("h2", { id: "ask-title" }, "Ask SCF"), fresh, historyBtn, close),
    h("p", { class: "muted text-sm" }, "Ask SCF explains how the Foundry works. It reads and explains. It changes nothing."),
    status,
    talk,
    history);
  drawer.hidden = true;
  const scrim = h("div", { class: "ask-scrim", onMousedown: () => on.close() });
  scrim.hidden = true;
  return { drawer, scrim, talk, thread, actions, suggest, suggestBox, status, context, error, question, attach, send, close, fresh, historyBtn, history, archivedBtn, list };
}

/** One message of the conversation. */
export function entryNode(entry) {
  return h("div", { class: `ask-entry ask-${entry.kind}` },
    h("span", { class: "ask-who" }, entry.who),
    entry.kind === "waiting" ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
    entry.kind === "waiting" ? " " : null,
    entry.text,
    entry.note ? h("span", { class: "ask-note" }, entry.note) : null);
}

/** The suggested questions as buttons. Picking one fills the question box; it does not send. */
export function suggestionNodes(list, onPick) {
  return list.map((text, i) => h("button", { type: "button", class: "small", "data-focus": `ask-suggest-${i}`, onClick: () => onPick(text) }, text));
}

const ACTIONS = [["stop", "Stop"], ["retry", "Try again"], ["archive", "Archive"], ["restore", "Take back from the archive"], ["remove", "Delete"]];

/**
 * The controls of the open conversation: only the ones `controls` offers. Each says what it does, as a tooltip and,
 * for a screen reader, as its description. `on[name]()` runs it.
 */
export function actionNodes(controls, hints, on) {
  return ACTIONS.filter(([name]) => controls[name]).flatMap(([name, label]) => [
    h("button", { type: "button", class: name === "remove" ? "small danger" : "small", title: hints[name], "aria-describedby": `ask-hint-${name}`, "data-focus": `ask-${name}`, onClick: () => on[name]() }, label),
    h("span", { id: `ask-hint-${name}`, class: "sr-only" }, hints[name]),
  ]);
}

/** The list of conversations: one button per row, or a sentence when there is none. */
export function historyNodes(rows, { current, archived, onOpen, now }) {
  if (!rows.length) return [h("li", { class: "muted" }, archived ? "You have no archived conversations." : "You have no conversations yet. Ask a question to start one.")];
  return rows.map((r, i) => h("li", {},
    h("button", { type: "button", class: "ask-row", "aria-current": r.id === current ? "true" : null, "data-focus": `ask-row-${i}`, onClick: () => onOpen(r.id) },
      h("span", { class: "ask-row-title" }, r.title),
      h("span", { class: "ask-row-meta muted" }, r.updated ? `${r.word} · ${timeAgo(r.updated, now)}` : r.word))));
}
