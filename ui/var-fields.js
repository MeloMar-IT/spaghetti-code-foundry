import { glyph, h } from "./dom.js";

/**
 * One form field per variable a flow describes (`var_info`): number, switch, text, list or choice. It knows nothing about
 * watchers: give it the descriptions, the flow's defaults and the stored values.
 * A field owns the stored value of its variable. A value the control cannot show (text in a number field, a value outside
 * the choices) still shows, so the person can see and correct it. Only a value that differs from the default is returned.
 */

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

const described = (info, name) => Object.hasOwn(info, name) && !info[name].set_by_run;

/** Splits stored variables: `fields` are described ones (a field shows them), `rest` the others. */
export function splitVars(vars, info) {
  const fields = {};
  const rest = {};
  for (const [k, v] of Object.entries(vars ?? {})) (described(info ?? {}, k) ? fields : rest)[k] = v;
  return { fields, rest };
}

const isPairs = (name) => name === "agent_env";

/** The items of a list value. `pairs`: KEY=value entries, split on a new line or a semicolon. */
export function listItems(text, separator, pairs = false) {
  const re = pairs ? /[\n;]/ : separator === "line" ? /\n/ : separator === "space" ? /\s+/ : /[,\n]/;
  return String(text ?? "").split(re).map((x) => x.trim()).filter(Boolean);
}

export function joinItems(items, separator) {
  return items.join(separator === "line" ? "\n" : separator === "space" ? " " : ",");
}

/** True when two values are the same for this variable: numbers by value, lists by items, the rest as text. */
function same(info, name, a, b) {
  if (info.kind === "number" && NUMBER.test(a) && NUMBER.test(b)) return Number(a) === Number(b);
  if (info.kind === "list") return JSON.stringify(listItems(a, info.separator, isPairs(name))) === JSON.stringify(listItems(b, info.separator, isPairs(name)));
  return a === b;
}

/** `edit` runs when the person types: text and lists then leave "Use default". */
const textControl = (stored, def, edit, label) => {
  const ctl = h("input", { placeholder: def, value: stored ?? "", onInput: edit, "aria-label": label });
  return { control: ctl, state: () => ctl.value, current: () => ({ value: ctl.value }) };
};

/**
 * Text and list: an empty value is a real override (it can switch a default off), so "use default" is its own box.
 * It is checked while nothing is stored; typing, adding or removing an item clears it. Checked and empty gives the default.
 */
function withDefault(make, stored, label) {
  const use = h("input", { type: "checkbox", class: "fit", checked: stored === undefined, "aria-label": `Use default for ${label}` });
  const c = make(() => { use.checked = false; });
  return {
    ...c,
    toggle: h("label", { class: "row tight" }, use, h("span", {}, "Use default")),
    state: () => JSON.stringify([use.checked, c.state()]),
    current: () => {
      const r = c.current();
      return r.error ? r : { value: use.checked && r.value === "" ? undefined : r.value };
    },
  };
}

function numberControl(info, stored, def) {
  if (stored !== undefined && !NUMBER.test(stored)) {
    const t = textControl(stored, def);
    return { ...t, current: () => ({ value: t.control.value === "" ? undefined : t.control.value }) };
  }
  const ctl = h("input", { type: "number", step: "any", min: info.min, max: info.max, placeholder: def, value: stored ?? "" });
  return { control: ctl, state: () => ctl.value, current: () => ({ value: ctl.value.trim() === "" ? undefined : ctl.value.trim() }) };
}

function choiceControl(info, stored, def) {
  const choices = info.choices ?? [];
  const extra = stored !== undefined && !choices.includes(stored);
  // Option ids are not the values: "" is a valid choice and the default option needs an id of its own.
  const id = (v) => (v === undefined ? "default" : extra ? "stored" : `c${choices.indexOf(v)}`);
  const sel = h("select", {},
    h("option", { value: "default" }, `Default (${def === "" ? "empty" : def})`),
    choices.map((c, i) => h("option", { value: `c${i}` }, c === "" ? "(empty)" : c)),
    extra ? h("option", { value: "stored" }, `${stored} (not a choice)`) : null);
  sel.value = id(stored);
  const valueOf = (v) => (v === "default" ? undefined : v === "stored" ? stored : choices[Number(v.slice(1))]);
  return { control: sel, state: () => sel.value, current: () => ({ value: valueOf(sel.value) }) };
}

/** A list of rows; `pairs` rows hold a KEY and a value. */
function listControl(name, info, stored, def, lenient, edit) {
  const pairs = isPairs(name);
  const box = h("div", { class: "stack tight", role: "group" });
  const note = h("small", { class: "muted" }, `Default: ${listItems(def, info.separator, pairs).join(", ") || "none"}`);
  const rows = [];
  const rowData = () => rows.map((r) => r.inputs.map((i) => i.value));
  const redraw = () => {
    box.replaceChildren(...rows.map((r) => r.el), note, add);
    note.hidden = rows.length > 0;
  };
  const addRow = (a = "", b = "") => {
    const inputs = pairs
      ? [h("input", { class: "mono", placeholder: "KEY", "aria-label": "Name", value: a, onInput: edit }), h("input", { placeholder: "value", "aria-label": "Value", value: b, onInput: edit })]
      : [h("input", { "aria-label": "Item", value: a, onInput: edit })];
    const row = { inputs, el: null };
    row.el = h("div", { class: "row tight" }, inputs,
      h("button", { type: "button", "aria-label": "Remove item", onClick: () => { rows.splice(rows.indexOf(row), 1); redraw(); edit(); } }, glyph("✕")));
    rows.push(row);
  };
  const add = h("button", { type: "button", onClick: () => { addRow(); redraw(); edit(); rows.at(-1).inputs[0].focus?.(); } }, "+ Add");
  for (const item of listItems(stored, info.separator, pairs)) {
    const i = pairs ? item.indexOf("=") : -1;
    addRow(...(i < 0 ? [item] : [item.slice(0, i).trim(), item.slice(i + 1).trim()]));
  }
  redraw();
  const current = () => {
    const items = [];
    for (const [a, b] of rowData()) {
      if (!pairs) {
        if (a.trim()) items.push(a.trim());
      } else if (a.trim()) items.push(`${a.trim()}=${(b ?? "").trim()}`);
      else if ((b ?? "").trim() && !lenient()) return { error: `"=${b.trim()}" should be KEY=value` };
    }
    return { value: joinItems(items, info.separator) };
  };
  return { control: box, state: () => JSON.stringify(rowData()), current };
}

function build(name, info, def, stored, lenient) {
  const label = info.label ?? name;
  const help = info.help ? h("small", {}, info.help) : null;
  const kind = info.kind ?? "text";
  const base = { name, info, def, stored };
  if (kind === "list") {
    const c = withDefault((edit) => listControl(name, info, stored, def, lenient, edit), stored, label);
    const note = isPairs(name) ? h("small", { class: "muted" }, "May contain secrets. Anyone who can open this watcher can read them.") : null;
    c.control.setAttribute("aria-label", label);
    return { ...base, ...c, el: h("div", { class: "field" }, h("span", {}, label), c.control, c.toggle, help, note) };
  }
  if (kind === "yes_no" && (stored === undefined || stored === "yes" || stored === "no")) {
    const ctl = h("input", { type: "checkbox", class: "fit", checked: (stored ?? def) === "yes" });
    const state = () => (ctl.checked ? "yes" : "no");
    return { ...base, control: ctl, state, current: () => ({ value: state() }),
      el: h("div", { class: "field" }, h("label", { class: "row tight" }, ctl, h("span", {}, label)), help) };
  }
  if (kind === "number" || (kind === "choice" && info.choices?.length)) {
    const c = kind === "number" ? numberControl(info, stored, def) : choiceControl(info, stored, def);
    return { ...base, ...c, el: h("label", { class: "field" }, h("span", {}, label), c.control, help) };
  }
  const c = withDefault((edit) => textControl(stored, def, edit, label), stored, label);
  return { ...base, ...c, el: h("div", { class: "field" }, h("span", {}, label), c.control, c.toggle, help) };
}

/**
 * `{ el, controls, read }` for the described variables of `info` (those the run sets itself are left out). `el` is null
 * with no field. `values` are the stored values, `defaults` the flow's. `read()` gives `{ values }`: for each field
 * its value, or undefined when it is at its default (the caller removes it); or `{ error: 'vars.<name>: …' }`.
 * `read({ lenient: true })` never fails: a half-filled row is dropped.
 */
export function varFields({ info, defaults, values }) {
  let lenient = false;
  const fields = Object.entries(info ?? {}).filter(([n]) => described(info, n))
    .map(([n, i]) => build(n, i, defaults?.[n] ?? "", values?.[n], () => lenient));
  for (const f of fields) f.initial = f.state();
  const read = (opts = {}) => {
    lenient = !!opts.lenient;
    try {
      const out = {};
      for (const f of fields) {
        let v;
        if (f.state() === f.initial) v = f.stored;
        else {
          const c = f.current();
          if (c.error) return { error: `vars.${f.name}: ${c.error}` };
          v = c.value;
        }
        out[f.name] = v !== undefined && same(f.info, f.name, v, f.def) ? undefined : v;
      }
      return { values: out };
    } finally {
      lenient = false;
    }
  };
  return {
    el: fields.length ? h("div", { class: "stack" }, fields.map((f) => f.el)) : null,
    controls: Object.fromEntries(fields.map((f) => [f.name, f.control])),
    read,
  };
}

/** `base` with each variable of `values` set, or removed when its value is undefined. */
export function mergeVars(base, values) {
  const out = { ...base };
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
