// Form controls: field, textInput, textArea, select, checkbox and settingControl (a list of records is a row editor). Unbound: they take `value` and `onInput`/`onChange`.
// Styles are in forms.css.
import { h, mount } from "../dom.js";
import { button, iconButton } from "./actions.js";
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

/** The row editor for a list of records: one input per field and row, Remove per row, "Add a row". Empty fields and rows are left out of the value. */
function recordRows(d, { value, onChange, error, disabled, cls, hint }) {
  const id = nextId("scf-field");
  const blankRow = () => Object.fromEntries(d.fields.map((f) => [f.key, ""]));
  const rows = (Array.isArray(value) ? value : []).map((r) => Object.fromEntries(d.fields.map((f) => [f.key, r?.[f.key] == null ? "" : String(r[f.key])])));
  const clean = () => rows
    .map((r) => Object.fromEntries(d.fields.flatMap((f) => { const v = r[f.key].trim(); return v ? [[f.key, v]] : []; })))
    .filter((r) => Object.keys(r).length > 0);
  const group = h("div", {
    class: cx("scf-field", "scf-rows", error && "scf-field--error", cls),
    role: "group",
    "aria-labelledby": `${id}-label`,
    "aria-describedby": [`${id}-hint`, error ? `${id}-error` : ""].filter(Boolean).join(" "),
  });
  const draw = (focusName) => {
    mount(group,
      h("span", { class: "scf-field__label", id: `${id}-label` }, d.label),
      rows.map((r, i) => h("div", { class: "scf-rows__row" },
        d.fields.map((f) => textInput({
          value: r[f.key], mono: true, disabled,
          "aria-label": `Row ${i + 1}, ${f.key}`, "data-focus": `${id}-${i}-${f.key}`,
          onChange: (e) => { rows[i][f.key] = e.target.value; onChange(clean()); },
        })),
        iconButton({
          icon: "x", label: `Remove row ${i + 1}`, disabled, "data-focus": `${id}-rm-${i}`,
          onClick: () => { rows.splice(i, 1); draw(); onChange(clean()); },
        }))),
      button({
        size: "small", disabled: disabled || (d.maxItems !== undefined && rows.length >= d.maxItems), "data-focus": `${id}-add`,
        onClick: () => { rows.push(blankRow()); draw(`${id}-${rows.length - 1}-${d.fields[0].key}`); },
      }, "Add a row"),
      h("small", { class: "scf-field__hint", id: `${id}-hint` }, hint),
      error ? h("div", { class: "scf-field__error", role: "alert", id: `${id}-error` }, error) : null);
    if (focusName) [...group.querySelectorAll("input")].find((el) => el.getAttribute("data-focus") === focusName)?.focus();
  };
  draw();
  return group;
}

/** A control made from one setting description of GET /api/settings. `onChange(value)` gets the typed value. */
export function settingControl(description, { value, onChange, error, disabled = false, class: cls, ...more } = {}) {
  rest(more);
  const d = description ?? {};
  oneOf("setting kind", d.kind, SETTING_KINDS);
  if (blank(d.label)) throw new Error("a setting control needs a label");
  const emit = (v) => onChange?.(v);
  const hint = settingHint(d);
  if (d.kind === "list" && d.fields) return recordRows(d, { value, onChange: emit, error, disabled, cls, hint });
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
    control = textArea({ value: items.join("\n"), disabled, onChange: (e) => emit(lines(e.target.value)) });
  } else {
    control = select({ options: d.choices ?? [], value, emptyLabel: d.optional ? "Not set" : undefined, disabled, onChange: (e) => emit(e.target.value === "" ? undefined : e.target.value) });
  }
  return field({ label: d.label, hint, error, class: cls }, control);
}
