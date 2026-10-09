import { h } from "./dom.js";

// ── bound inputs: each writes into obj[key] (deleting when empty) and calls onChange ──

export function setKey(obj, key, v) {
  if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete obj[key];
  else obj[key] = v;
}

// `label` sets `aria-label`, for a control that no <label> wraps.
export function text(obj, key, onChange, { placeholder, mono, list, type = "text", onCommit, label } = {}) {
  return h("input", {
    type, placeholder, list, "aria-label": label, class: mono ? "mono" : null,
    value: obj[key] ?? "",
    onInput: (e) => {
      const raw = e.target.value;
      setKey(obj, key, type === "number" ? (raw === "" ? "" : Number(raw)) : raw);
      onChange();
    },
    onChange: onCommit,
  });
}

export function area(obj, key, onChange, { rows = 4, placeholder, label } = {}) {
  return h("textarea", {
    rows, placeholder, "aria-label": label, value: obj[key] ?? "",
    onInput: (e) => { setKey(obj, key, e.target.value); onChange(); },
  });
}

export function select(obj, key, options, onChange, { emptyLabel, label } = {}) {
  const opts = emptyLabel != null ? [["", emptyLabel], ...options] : options;
  return h("select", { "aria-label": label, onChange: (e) => { setKey(obj, key, e.target.value); onChange(); } },
    opts.map(([v, l]) => h("option", { value: v, selected: (obj[key] ?? "") === v }, l)));
}

export function list(obj, key, onChange, placeholder, { label } = {}) {
  return h("input", {
    placeholder, "aria-label": label, class: "mono", value: (obj[key] ?? []).join(", "),
    onInput: (e) => {
      setKey(obj, key, e.target.value.split(",").map((s) => s.trim()).filter(Boolean));
      onChange();
    },
  });
}

let seq = 0;

const tokens = (el) => (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);

/** Adds `id` to the `aria-describedby` of `el`, keeping what is already there. */
function describe(el, id) {
  const ids = tokens(el);
  if (!ids.includes(id)) ids.push(id);
  el.setAttribute("aria-describedby", ids.join(" "));
}

export function field(label, input, hint) {
  let small = null;
  if (hint) {
    const id = `field-hint-${++seq}`;
    small = h("small", { id }, hint);
    describe(input, id);
  }
  return h("label", { class: "field" }, h("span", {}, label), input, small);
}

/** Like `field`, for several controls: a named group, because labels cannot nest. */
export function group(label, content, hint) {
  const n = ++seq;
  const small = hint ? h("small", { id: `field-hint-${n}` }, hint) : null;
  return h("div", { class: "field", role: "group", "aria-labelledby": `field-group-${n}`, "aria-describedby": small ? `field-hint-${n}` : null },
    h("span", { id: `field-group-${n}` }, label), content, small);
}

/** Marks `input` invalid and links the message element `messageId` to it. */
export function markInvalid(input, messageId) {
  input.setAttribute("aria-invalid", "true");
  describe(input, messageId);
}

/** Undoes `markInvalid`. */
export function clearInvalid(input, messageId) {
  input.removeAttribute("aria-invalid");
  const ids = tokens(input).filter((x) => x !== messageId);
  if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  else input.removeAttribute("aria-describedby");
}

export function insertAtCursor(textarea, snippet) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + snippet + value.slice(b);
  textarea.selectionStart = textarea.selectionEnd = a + snippet.length;
  textarea.dispatchEvent(new Event("input"));
  textarea.focus();
}
