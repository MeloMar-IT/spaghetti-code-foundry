// Form controls: field, textInput, textArea, select, checkbox and settingControl. Unbound: they take `value` and `onInput`/`onChange`.
// Styles are in forms.css.
import { h } from "../dom.js";
import { cx, nextId, oneOf, rest, settingHint } from "./core.js";

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

const SETTING_KINDS = ["number", "yes-no", "text", "list", "choice"];

const lines = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** One line of a list of records: parts in `fields` order; extra parts are joined onto the last field. */
function recordOf(line, fields) {
  const parts = line.split(/\s+/);
  const out = {};
  fields.forEach((f, i) => {
    const part = i === fields.length - 1 ? parts.slice(i).join(" ") : parts[i];
    if (part) out[f.key] = part;
  });
  return out;
}

/** A control made from one setting description of GET /api/settings. `onChange(value)` gets the typed value. */
export function settingControl(description, { value, onChange, error, disabled = false, class: cls, ...more } = {}) {
  rest(more);
  const d = description ?? {};
  oneOf("setting kind", d.kind, SETTING_KINDS);
  if (blank(d.label)) throw new Error("a setting control needs a label");
  const emit = (v) => onChange?.(v);
  const hint = settingHint(d);
  if (d.kind === "yes-no") {
    const id = nextId("scf-field");
    const describedBy = [`${id}-hint`, error ? `${id}-error` : ""].filter(Boolean).join(" ");
    return h("div", { class: cx("scf-field", error && "scf-field--error", cls) },
      checkbox({ label: d.label, checked: value === true, disabled, role: "switch", id, "aria-describedby": describedBy, "aria-invalid": error ? "true" : undefined, onChange: (e) => emit(e.target.checked === true) }),
      h("small", { class: "scf-field__hint", id: `${id}-hint` }, hint),
      error ? h("div", { class: "scf-field__error", role: "alert", id: `${id}-error` }, error) : null);
  }
  let control;
  if (d.kind === "number") {
    control = textInput({ type: "number", value: value === undefined ? "" : String(value), min: d.min, max: d.max, step: d.integer ? "1" : "any", disabled, onChange: (e) => emit(e.target.value === "" ? undefined : Number(e.target.value)) });
  } else if (d.kind === "text") {
    control = textInput({ value, disabled, onChange: (e) => emit(e.target.value === "" && d.optional ? undefined : e.target.value) });
  } else if (d.kind === "list") {
    const items = Array.isArray(value) ? value : [];
    const text = d.fields ? items.map((r) => d.fields.map((f) => r?.[f.key]).filter((p) => p !== undefined && p !== "").join(" ")).join("\n") : items.join("\n");
    control = textArea({ value: text, mono: !!d.fields, disabled, onChange: (e) => emit(d.fields ? lines(e.target.value).map((l) => recordOf(l, d.fields)) : lines(e.target.value)) });
  } else {
    control = select({ options: d.choices ?? [], value, emptyLabel: d.optional ? "Not set" : undefined, disabled, onChange: (e) => emit(e.target.value === "" ? undefined : e.target.value) });
  }
  return field({ label: d.label, hint, error, class: cls }, control);
}
