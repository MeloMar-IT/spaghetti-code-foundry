// Display primitives: card, table, list, badge, banner, skeleton and emptyState. Styles are in display.css.
import { h } from "../dom.js";
import { iconButton } from "./actions.js";
import { cx, nextId, oneOf, rest } from "./core.js";

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const ALIGNS = ["start", "end"];
const blank = (s) => typeof s !== "string" || s.trim() === "";
const renderable = (children) => children.flat(Infinity).some((c) => c != null && c !== false && c !== "");

function headingLevel(level) {
  if (!Number.isInteger(level) || level < 2 || level > 6) throw new Error(`unknown heading level "${level}"`);
  return `h${level}`;
}

/** A `<section>`. With `title` it has a heading and `aria-labelledby`; without, pass an `aria-label`. */
export function card({ title, actions, tone = "neutral", level = 2, id, class: cls, ...more } = {}, ...children) {
  rest(more);
  oneOf("card tone", tone, TONES);
  const tag = headingLevel(level);
  const cardId = id ?? nextId("scf-card");
  const hasTitle = !blank(title);
  return h("section", { ...more, id: cardId, "aria-labelledby": hasTitle ? `${cardId}-title` : undefined, class: cx("scf-card", `scf-card--${tone}`, cls) },
    hasTitle || actions ? h("div", { class: "scf-card__head" },
      hasTitle ? h(tag, { class: "scf-card__title", id: `${cardId}-title` }, title) : null,
      actions ? h("div", { class: "scf-card__actions" }, actions) : null) : null,
    h("div", { class: "scf-card__body" }, children));
}

/**
 * A real table in a scroll box. `columns`: [{ key, label, align?, cell?(row, index) }]. With `onRowOpen` the first cell holds a
 * button (its name is the cell text), so a row opens by mouse and keyboard. No rows: `empty` shows under the headers.
 */
export function table({ caption, columns, rows, onRowOpen, empty = "Nothing to show.", hideCaption = false, id, class: cls, ...more } = {}) {
  rest(more);
  if (blank(caption)) throw new Error("a table needs a caption");
  if (!Array.isArray(columns) || columns.length === 0) throw new Error("a table needs a columns array");
  if (columns.some((c) => !c || blank(c.label))) throw new Error("a table column needs a label");
  if (!Array.isArray(rows)) throw new Error("a table needs a rows array");
  if (onRowOpen != null && typeof onRowOpen !== "function") throw new Error("onRowOpen must be a function");
  columns.forEach((c) => oneOf("column align", c.align ?? "start", ALIGNS));
  const tableId = id ?? nextId("scf-table");
  const capId = `${tableId}-caption`;
  const alignClass = (c, base) => (c.align === "end" ? `${base}--end` : undefined);
  const textOf = (v) => (v != null && typeof v === "object" && "textContent" in v ? String(v.textContent ?? "") : v == null || v === false ? "" : String(v));
  const body = rows.map((row, i) => h("tr", { class: cx("scf-table__row", onRowOpen && "scf-table__row--open") },
    columns.map((c, ci) => {
      const value = typeof c.cell === "function" ? c.cell(row, i) : row?.[c.key];
      let content = value;
      if (onRowOpen && ci === 0) {
        // The opener is always a plain button named by the cell text, never a node wrapped in a button.
        const name = textOf(value).trim() || `Open row ${i + 1}`;
        content = h("button", { type: "button", class: "scf-table__open", onClick: () => onRowOpen(row, i) }, name);
      }
      return h("td", { class: cx("scf-table__td", alignClass(c, "scf-table__td")) }, content);
    })));
  return h("div", { ...more, id: tableId, role: "region", tabindex: "0", "aria-labelledby": capId, class: cx("scf-table-box", cls) },
    h("table", { class: "scf-table" },
      h("caption", { class: cx("scf-table__caption", hideCaption && "scf-visually-hidden"), id: capId }, caption),
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { scope: "col", class: cx("scf-table__th", alignClass(c, "scf-table__th")) }, c.label)))),
      h("tbody", {}, body)),
    rows.length === 0 ? (typeof empty === "string" ? h("p", { class: "scf-table__empty" }, empty) : empty) : null);
}

/** A `<ul>`, or an `<ol>` with `ordered`. An item is a string, a node or an array of them. */
export function list({ items, ordered = false, class: cls, ...more } = {}) {
  rest(more);
  if (!Array.isArray(items)) throw new Error("a list needs an items array");
  return h(ordered ? "ol" : "ul", { ...more, class: cx("scf-list", cls) }, items.map((item) => h("li", { class: "scf-list__item" }, item)));
}

/** A short status word in a tone. The text carries the meaning; the colour only helps. */
export function badge({ tone = "neutral", label, class: cls, ...more } = {}) {
  rest(more);
  oneOf("badge tone", tone, TONES);
  if (blank(label)) throw new Error("a badge needs a label");
  return h("span", { ...more, class: cx("scf-badge", `scf-badge--${tone}`, cls) }, label);
}

/** A message box. `fail` is an alert, the others are status. It does not remove itself: `onDismiss` is yours to handle. */
export function banner({ tone = "neutral", title, actions, onDismiss, class: cls, ...more } = {}, ...children) {
  rest(more);
  oneOf("banner tone", tone, TONES);
  const hasBody = renderable(children);
  if (blank(title) && !hasBody) throw new Error("a banner needs a title or content");
  if (onDismiss != null && typeof onDismiss !== "function") throw new Error("onDismiss must be a function");
  return h("div", { ...more, role: tone === "fail" ? "alert" : "status", class: cx("scf-banner", `scf-banner--${tone}`, cls) },
    h("div", { class: "scf-banner__text" },
      blank(title) ? null : h("strong", { class: "scf-banner__title" }, title),
      hasBody ? h("div", { class: "scf-banner__body" }, children) : null),
    actions ? h("div", { class: "scf-banner__actions" }, actions) : null,
    onDismiss ? iconButton({ icon: "x", label: "Dismiss", onClick: onDismiss }) : null);
}

/** Placeholder lines while data loads. Swap it for the content when loaded. */
export function skeleton({ lines = 3, label = "Loading…", class: cls, ...more } = {}) {
  rest(more);
  if (!Number.isInteger(lines) || lines < 1 || lines > 20) throw new Error("skeleton lines must be a whole number from 1 to 20");
  if (blank(label)) throw new Error("a skeleton needs a label");
  return h("div", { ...more, "aria-busy": "true", class: cx("scf-skeleton", cls) },
    h("span", { class: "scf-visually-hidden" }, label),
    h("div", { class: "scf-skeleton__lines", "aria-hidden": "true" },
      Array.from({ length: lines }, () => h("div", { class: "scf-skeleton__line" }))));
}

/** A heading, optional text and an optional action node. */
export function emptyState({ title, text, action, level = 3, class: cls, ...more } = {}) {
  rest(more);
  if (blank(title)) throw new Error("an empty state needs a title");
  return h("div", { ...more, class: cx("scf-empty", cls) },
    h(headingLevel(level), { class: "scf-empty__title" }, title),
    blank(text) ? null : h("p", { class: "scf-empty__text" }, text),
    action ? h("div", { class: "scf-empty__action" }, action) : null);
}
