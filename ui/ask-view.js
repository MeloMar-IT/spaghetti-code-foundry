import { previewOf } from "./ask-handoff.js";
import { glyph, h, modal, mount, timeAgo } from "./dom.js";

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
  const paused = h("p", { id: "ask-paused", class: "ask-paused", role: "note" }, hints.paused ?? "");
  paused.hidden = true;
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
    paused,
    status,
    talk,
    history);
  drawer.hidden = true;
  const scrim = h("div", { class: "ask-scrim", onMousedown: () => on.close() });
  scrim.hidden = true;
  return { drawer, scrim, talk, paused, thread, actions, suggest, suggestBox, status, context, error, question, attach, send, close, fresh, historyBtn, history, archivedBtn, list };
}

const sourceLine = (src, { now, onNavigate }) => [
  h("span", { class: "ask-source-kind" }, `${src.what}: `),
  src.title,
  src.ref ? " (" : null,
  // a source is a link only when the model found a page of this role for it; any other reference stays text
  src.ref ? (src.href ? h("a", { href: src.href, onClick: () => onNavigate?.() }, src.ref) : src.ref) : null,
  src.ref ? ")" : null,
  src.observedAt ? h("span", { class: "muted", title: src.observedAt }, ` seen ${timeAgo(src.observedAt, now)}`) : null,
];

/** One proposal of a reply as a card. It says whether it only reads or would change something. It has no control that does anything; a page is a plain link. */
export function cardNode(card, { onNavigate } = {}) {
  return h("div", { class: `ask-card ask-card-${card.kind}`, role: "group", "aria-label": `${card.title}. ${card.effect === "changes-state" ? "Changes state" : "Read-only"}` },
    h("div", { class: "ask-card-head" },
      h("strong", {}, card.title),
      h("span", { class: `pill ${card.effect === "changes-state" ? "sem-warning" : "sem-neutral"}` }, card.effect === "changes-state" ? "Changes state" : "Read-only")),
    card.link ? h("a", { href: card.link.href, onClick: () => onNavigate?.() }, card.link.title) : null,
    card.text ? h(card.pre ? "pre" : "p", { class: "ask-card-text" }, card.text) : null,
    h("p", { class: "ask-card-note muted" }, card.note));
}

/** An offer of a reply as a card with a button. The button asks the server; the card itself opens nothing. `onOffer(index)`. */
export function offerNode(offer, { onOffer } = {}) {
  return h("div", { class: "ask-card ask-card-offer", role: "group", "aria-label": `${offer.title}. Opens a page` },
    h("div", { class: "ask-card-head" },
      h("strong", {}, offer.title),
      h("span", { class: "pill sem-neutral" }, "Opens a page")),
    offer.text ? h("p", { class: "ask-card-text" }, offer.text) : null,
    h("button", { type: "button", class: "small", "data-offer": String(offer.index), onClick: () => onOffer?.(offer.index) }, "Open"),
    h("p", { class: "ask-card-note muted" }, offer.note));
}

const pillClass = (s) => (s.kind === "high-impact" ? "sem-danger" : s.kind === "reversible" ? "sem-warning" : "sem-neutral");

/**
 * A plan as an ordered list of cards, one per step, each with its kind. A high-impact step (or one that would be) always
 * shows its danger pill and is never folded away. The person follows it by hand or presses "I did this"; the mark is theirs
 * and nothing here runs a step or says that it worked. `onToggle(index)`, `onNavigate()`.
 */
export function planNodes(plan, { onToggle, onNavigate } = {}) {
  const total = plan.steps.length;
  return h("div", { class: "ask-plan-box" },
    h("p", { class: "ask-plan-head" }, h("strong", {}, "Plan: "), plan.header),
    h("ol", { class: "ask-plan" }, plan.steps.map((s, i) => h("li", { class: `ask-step${s.current ? " ask-step-current" : ""}${s.danger ? " ask-step-danger" : ""}`, "aria-current": s.current ? "step" : null },
      h("div", { class: "ask-card-head" },
        h("span", { class: "ask-step-n" }, `Step ${s.n} of ${total}`),
        h("span", { class: `pill ${pillClass(s)}` }, s.label),
        s.wouldBeLabel ? h("span", { class: `pill ${s.danger ? "sem-danger" : "sem-warning"}` }, s.wouldBeLabel) : null),
      h("strong", {}, s.title),
      s.proposal ? h("p", { class: "ask-step-proposal muted" }, `Proposed, not confirmed: ${s.proposal}`) : null,
      s.link ? h("a", { href: s.link.href, onClick: () => onNavigate?.() }, s.link.title) : null,
      s.instructions ? h("p", { class: "ask-card-text" }, s.instructions) : null,
      s.expected || s.failure || s.fallback ? h("dl", { class: "ask-step-signals" },
        s.expected ? [h("dt", {}, "What you should see"), h("dd", {}, s.expected)] : null,
        s.failure ? [h("dt", {}, "If it fails"), h("dd", {}, s.failure)] : null,
        s.fallback ? [h("dt", {}, "Then"), h("dd", {}, s.fallback)] : null) : null,
      h("button", { type: "button", class: "small", "data-step": String(i), "aria-pressed": String(s.done), onClick: () => onToggle?.(i) }, s.done ? "Not done yet" : "I did this"),
      s.note ? h("p", { class: "ask-card-note muted" }, s.note) : null))));
}

/** A reply by its parts: the short answer, how sure it is and what it rests on, the proposals, and the sources and assumptions to unfold. */
export function replyNodes(layout, opts = {}) {
  const { trust, basis, sources, assumptions } = layout;
  return [
    h("p", { class: "ask-summary" }, layout.summary),
    layout.explanation ? h("p", { class: "ask-explain" }, layout.explanation) : null,
    h("p", { class: `ask-trust ask-trust-${trust.state}` }, glyph(trust.glyph), " ", h("strong", {}, trust.label), ". ", trust.text),
    layout.plan ? planNodes(layout.plan, opts) : null,
    basis.sources.length ? h("ul", { class: "ask-basis", "aria-label": basis.needs === "state" ? "The current state this answer rests on" : "The documentation this answer rests on" },
      basis.sources.map((src) => h("li", {}, sourceLine(src, opts)))) : null,
    layout.cards.length ? h("div", { class: "ask-cards" }, layout.cards.map((c) => cardNode(c, opts))) : null,
    layout.offers?.length ? h("div", { class: "ask-cards", "aria-label": "Pages you can open" }, layout.offers.map((o) => offerNode(o, opts))) : null,
    trust.state === "limit" ? null : h("details", { class: "ask-sources" },
      h("summary", {}, `Sources and assumptions (${sources.length === 1 ? "1 source" : `${sources.length} sources`})`),
      h("h4", {}, "Sources"),
      sources.length ? h("ul", {}, sources.map((src) => h("li", {}, sourceLine(src, opts)))) : h("p", { class: "muted" }, "This answer names no source."),
      h("h4", {}, "Assumptions"),
      h("ul", {}, assumptions.map((a) => h("li", {}, a)))),
  ];
}

/**
 * "Was this answer helpful?": two buttons that say whether they are pressed, and, after Not helpful, the reasons as
 * checkboxes. Every control has a `data-focus` name, so the drawer can draw again and keep the focus where it was.
 * `opts`: onRate(message, vote), draftOf(message) the reasons ticked and not saved yet, onDraft(message, reasons),
 * onReasons(message, reasons) to save them.
 */
export function rateNodes(entry, opts) {
  const id = entry.id;
  const vote = entry.feedback?.vote ?? null;
  const vbtn = (v, label) => h("button", { type: "button", class: "small", "aria-pressed": String(vote === v), "data-focus": `ask-rate-${id}-${v}`, onClick: () => opts.onRate(id, v) }, label);
  const nodes = [h("div", { class: "ask-rate", role: "group", "aria-label": "Was this answer helpful?" }, h("span", { class: "muted" }, "Was this answer helpful? "), vbtn("helpful", "Helpful"), vbtn("not-helpful", "Not helpful"))];
  if (vote !== "not-helpful") return nodes;
  const chosen = new Set(opts.draftOf?.(id) ?? entry.feedback.reasons);
  const boxes = Object.entries(opts.reasonWords ?? {}).map(([reason, words]) => h("label", { class: "check-row" },
    h("input", { type: "checkbox", checked: chosen.has(reason), "data-focus": `ask-reason-${id}-${reason}`, onChange: (e) => {
      if (e.target.checked) chosen.add(reason);
      else chosen.delete(reason);
      opts.onDraft?.(id, [...chosen]);
    } }),
    ` ${words}`));
  nodes.push(h("fieldset", { class: "ask-reasons" },
    h("legend", {}, "What was wrong? (optional)"),
    boxes,
    h("button", { type: "button", class: "small", "data-focus": `ask-reasons-save-${id}`, onClick: () => opts.onReasons(id, [...chosen]) }, "Save reasons")));
  return nodes;
}

/** One message of the conversation. `opts`: now (ms) for the age of a source, onNavigate() when a link to a page is followed. The rating of an answer follows it as its own nodes (`rateNodes`). */
export function entryNode(entry, opts = {}) {
  return h("div", { class: `ask-entry ask-${entry.kind}`, "data-message": entry.id ?? null },
    h("span", { class: "ask-who" }, entry.who),
    entry.kind === "waiting" ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
    entry.kind === "waiting" ? " " : null,
    entry.layout ? replyNodes(entry.layout, { ...opts, onToggle: (i) => opts.onToggle?.(entry.id, i), onOffer: (i) => opts.onOffer?.(entry.id, i) }) : entry.text,
    entry.kind === "answer" && opts.onHandoff ? h("button", { type: "button", class: "small", "data-handoff": entry.id, onClick: () => opts.onHandoff(entry.id) }, "Continue on another page") : null,
    entry.handoffs?.length ? h("ul", { class: "muted small", "aria-label": "Where you took this answer" },
      entry.handoffs.map((r) => h("li", {}, r.href ? h("a", { href: r.href, onClick: () => opts.onNavigate?.() }, r.text) : r.text, r.at ? ` ${timeAgo(r.at, opts.now)}` : ""))) : null,
    entry.note ? h("span", { class: "ask-note" }, entry.note) : null);
}

/**
 * The content of the hand-off preview. Without `picked`: the offers as buttons. With it: what would be copied (as text),
 * the note, and Cancel / confirm. `on`: onPick(offer), onCancel(), onConfirm().
 */
export function handoffPreviewNodes(choices, on) {
  const { offers, picked } = choices;
  if (!picked) {
    return [
      h("p", { class: "muted" }, "Where do you want to take this answer? You see what is copied before anything opens."),
      ...offers.map((o) => h("div", { class: "ask-card", role: "group", "aria-label": o.title },
        h("div", { class: "ask-card-head" }, h("strong", {}, o.title), h("span", { class: "pill sem-neutral" }, o.fill ? "Copies text" : "Opens a page")),
        h("button", { type: "button", class: "small", "data-handoff-pick": o.key, onClick: () => on.onPick(o) }, "Choose"))),
      h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { type: "button", onClick: () => on.onCancel() }, "Cancel")),
    ];
  }
  const p = picked.preview;
  return [
    h("h3", {}, p.title),
    ...(p.nothing ? [h("p", {}, "Nothing is copied. The page opens.")]
      : p.rows.map((r) => h("div", { class: "stack" }, h("b", {}, r.label), h("pre", { class: "pre-wrap" }, r.text)))),
    h("p", { class: "muted small" }, p.note),
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { type: "button", "data-handoff-cancel": "1", onClick: () => on.onCancel() }, "Cancel"), h("button", { type: "button", class: "primary", "data-handoff-confirm": "1", onClick: () => on.onConfirm() }, p.confirm)),
  ];
}

/** The hand-off dialog: choose a page when there are several, see the preview, confirm. Resolves with the chosen offer, or null on Cancel or Escape. */
export async function handoffDialog({ offers, conversationTitle = "" }) {
  const chosen = await modal("Continue on another page", (close) => {
    const box = h("div", { class: "stack" });
    const show = (offer) => mount(box, handoffPreviewNodes({ offers, picked: offer ? { offer, preview: previewOf(offer, conversationTitle) } : null }, { onPick: show, onCancel: () => close(null), onConfirm: () => close(offer) }));
    show(offers.length === 1 ? offers[0] : null);
    return box;
  });
  // the close button of the dialog, Escape and a click outside resolve undefined
  return chosen ?? null;
}

/** The suggested questions as buttons. Picking one fills the question box; it does not send. */
export function suggestionNodes(list, onPick) {
  return list.map((text, i) => h("button", { type: "button", class: "small", "data-focus": `ask-suggest-${i}`, onClick: () => onPick(text) }, text));
}

const ACTIONS = [["stop", "Stop"], ["retry", "Try again"], ["solved", "This solved my problem"], ["archive", "Archive"], ["restore", "Take back from the archive"], ["remove", "Delete"]];

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
