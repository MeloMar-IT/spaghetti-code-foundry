// Form controls: field, textInput, textArea, select and checkbox. Unbound: they take `value` and `onInput`/`onChange`.
// Styles are in forms.css.
import { h } from "../dom.js";
import { cx, nextId, rest } from "./core.js";

const blank = (s) => typeof s !== "string" || s.trim() === "";

function textControl(tag, { value, onInput, onChange, placeholder, mono = false, disabled = false, class: cls, ...more }, extra, classes) {
  rest(more);
  return h(tag, { ...more, ...extra, value: value ?? "", placeholder, disabled, class: cx("scf-input", ...classes, mono && "scf-input--mono", cls), onInput, onChange });
}

export const textInput = (props = {}) => textControl("input", props, { type: props.type ?? "text" }, []);

export const textArea = ({ rows = 4, ...props } = {}) => textControl("textarea", props, { rows }, ["scf-input--area"]);

/** `options`: [value, label] pairs or plain strings. `emptyLabel` adds an empty first option. */
export function select({ options, value, emptyLabel, onChange, disabled = false, class: cls, ...more } = {}) {
  rest(more);
  if (!Array.isArray(options)) throw new Error("a select needs an options array");
  const all = [...(emptyLabel != null ? [["", emptyLabel]] : []), ...options.map((o) => (Array.isArray(o) ? o : [o, o]))];
  const current = String(value ?? "");
  return h("select", { ...more, disabled, class: cx("scf-input", "scf-input--select", cls), onChange },
    all.map(([v, label]) => h("option", { value: v, selected: String(v) === current }, label)));
}

/** A native checkbox inside its label. */
export function checkbox({ label, checked = false, onChange, disabled = false, class: cls, ...more } = {}) {
  rest(more);
  if (blank(label)) throw new Error("a checkbox needs a label");
  return h("label", { class: cx("scf-checkbox", cls) },
    h("input", { ...more, type: "checkbox", class: "scf-checkbox__input", checked: checked === true, disabled, onChange }),
    h("span", { class: "scf-checkbox__label" }, label));
}

/** A label, a control, a hint and an error, joined by `for`/`id` and `aria-describedby`. */
export function field({ label, hint, error, required = false, class: cls, ...more } = {}, control) {
  rest(more);
  if (blank(label)) throw new Error("a field needs a label");
  const id = control.getAttribute("id") ?? nextId("scf-field");
  control.setAttribute("id", id);
  const describedBy = [control.getAttribute("aria-describedby"), hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  if (describedBy) control.setAttribute("aria-describedby", describedBy);
  if (error) control.setAttribute("aria-invalid", "true");
  if (required) control.setAttribute("required", "");
  return h("div", { class: cx("scf-field", error && "scf-field--error", cls) },
    h("label", { class: "scf-field__label", for: id }, label, required ? h("span", { class: "scf-field__required", "aria-hidden": "true" }, " *") : null),
    control,
    hint ? h("small", { class: "scf-field__hint", id: `${id}-hint` }, hint) : null,
    error ? h("div", { class: "scf-field__error", role: "alert", id: `${id}-error` }, error) : null);
}
