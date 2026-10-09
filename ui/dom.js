/** Tiny hyperscript helper: h("div", {class: "x", onClick}, ...children). */
export function h(tag, props = {}, ...children) {
  const el = tag === "svg" || props?.svg
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false || k === "svg") continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.setAttribute("class", v);
    else if (k === "value" || k === "checked") el[k] = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const svg = (tag, props = {}, ...children) => h(tag, { ...props, svg: true }, ...children);

const TAB_STOPS = "a[href], button, input, select, textarea, summary, [tabindex]";
const shown = (el) => typeof el.getClientRects !== "function" || el.getClientRects().length > 0;

/** The controls of `box` that Tab stops at, in page order. */
export const tabStops = (box) => [...box.querySelectorAll(TAB_STOPS)].filter((el) => !el.disabled && el.getAttribute("tabindex") !== "-1" && shown(el));

/**
 * Where Tab must go so the focus stays in a dialog: the first stop after the last one, the last before the first
 * (`back`: Shift+Tab), and an end stop when the focus is on none of them. Null: the browser moves the focus itself.
 */
export function trapTarget(stops, current, back) {
  if (!stops.length) return null;
  const i = stops.indexOf(current);
  if (i < 0) return back ? stops[stops.length - 1] : stops[0];
  if (back && i === 0) return stops[stops.length - 1];
  if (!back && i === stops.length - 1) return stops[0];
  return null;
}

export function mount(target, ...nodes) {
  // A page that draws itself again keeps the focus on the control with the same `data-focus` name.
  const active = document.activeElement;
  const name = active && target.contains(active) ? active.getAttribute("data-focus") : null;
  target.replaceChildren(...nodes.flat().filter(Boolean));
  if (name) [...target.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === name)?.focus();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

let toastTimer;
export function toast(msg, kind = "info") {
  const el = document.getElementById("toast");
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3500);
}

let modalSeq = 0;

/** Show a modal; `build(close)` returns its content. Resolves with the value passed to close(). */
export function modal(title, build, { busy = () => false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const opener = document.activeElement;
    const titleId = `modal-title-${++modalSeq}`;
    let closed = false;
    const close = (v) => {
      // A dialog can finish its work after Escape closed it: a second call must not touch a newer dialog.
      if (closed) return;
      closed = true;
      root.replaceChildren();
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
      resolve(v);
    };
    // `busy()`: a request is in flight, so Escape, ✕ and the backdrop do nothing until it is answered.
    const dismiss = () => (busy() ? undefined : close(undefined));
    const onKey = (e) => {
      if (e.key === "Escape") return dismiss();
      if (e.key !== "Tab") return;
      const to = trapTarget(tabStops(box), document.activeElement, e.shiftKey);
      if (to) {
        e.preventDefault();
        to.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const box = h("div", { class: "modal", role: "dialog", "aria-labelledby": titleId, "aria-modal": "true", tabindex: "-1" },
      h("div", { class: "modal-head" }, h("h2", { id: titleId }, title), h("button", { class: "icon", onClick: dismiss, "aria-label": "Close" }, "✕")),
      build(close));
    mount(root, h("div", { class: "backdrop", onMousedown: (e) => e.target === e.currentTarget && dismiss() }, box));
    (box.querySelector("textarea, input") ?? box).focus();
  });
}

/** Marks `field` (may be undefined) as the one at fault and focuses it; every control in `fields` loses the mark first. */
export function markInvalid(fields, field) {
  for (const f of fields) f?.removeAttribute("aria-invalid");
  if (!field) return;
  field.setAttribute("aria-invalid", "true");
  field.focus();
}

/** Shows `message` in the alert line `line` ("" clears it) and marks `field`. */
export function showError(line, message, { fields = [], field } = {}) {
  line.textContent = message || "";
  markInvalid(fields, message ? field : undefined);
}

/** The key of the first [RegExp, key] pair that matches the message; undefined when none does. */
export const fieldFor = (message, pairs) => pairs.find(([re]) => re.test(String(message ?? "")))?.[1];

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
