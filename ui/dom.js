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

/** A glyph for the eye only: hidden from screen readers. The control around it needs its own name. */
export const glyph = (g) => h("span", { "aria-hidden": "true" }, g);

export const AI_LABEL = "Written by AI";
/** Props that make an element a named region of AI-written content: "Written by AI: <what>". */
export const aiProps = (what) => ({ role: "region", "aria-label": `${AI_LABEL}: ${what}` });

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
  if (!name) return;
  const same = [...target.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === name);
  if (same) return same.focus();
  // The control is gone: the heading of this part takes the focus, so it never drops to `<body>`.
  const heading = target.querySelector("h1, h2, h3") ?? target.parentNode?.querySelector?.("h1, h2, h3") ?? target;
  heading.setAttribute("tabindex", "-1");
  heading.focus();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const TOAST_MS = 3500;
const TOAST_SAME_MS = 5000;
let toastTimer;
let toastText; // the text shown last; the same text again within 5 s of its last call is announced once
let toastAt = 0;
let toastMsg; // the message node; kept while the same text repeats, so the live region does not announce it again
let toastRun; // the action of the newest toast
let toastOpener; // what had the focus when the toast was shown

/** Where the focus goes after the toast: the opener while it is on the page, else the main area. */
function toastFocusBack() {
  const back = toastOpener && toastOpener.isConnected !== false ? toastOpener : document.getElementById("main");
  if (!back) return;
  if (back.id === "main") back.setAttribute("tabindex", "-1");
  back.focus?.();
}

/**
 * Hides the toast and empties it (a hidden toast has no Tab stops and nothing for a screen reader to find).
 * `back: false`: the caller puts the focus back itself, after its work.
 */
function closeToast(back = true) {
  const el = document.getElementById("toast");
  clearTimeout(toastTimer);
  const inside = !!el.contains?.(document.activeElement) && document.activeElement !== el;
  el.className = "";
  toastRun = undefined;
  // The message goes too: a hidden toast must not stay in the accessibility tree, and removing text is not announced.
  el.replaceChildren();
  if (inside && back) toastFocusBack();
}

/**
 * Feedback after an action. `kind` "error" (or `sticky`) stays until the ✕ is pressed; the others go after 3.5 s.
 * `action: { label, run }` draws one button (Undo); it runs once and closes the toast.
 */
export function toast(msg, kind = "info", { action, sticky = false } = {}) {
  const el = document.getElementById("toast");
  const stays = kind === "error" || sticky;
  const text = String(msg ?? "");
  const now = Date.now();
  const same = text === toastText && now - toastAt < TOAST_SAME_MS && !!toastMsg && el.children[0] === toastMsg;
  toastAt = now;
  if (!same) {
    toastText = text;
    toastMsg = h("span", { class: "toast-msg" }, text);
  }
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  toastRun = action?.run;
  toastOpener = document.activeElement;
  const buttons = [];
  if (action) {
    buttons.push(h("button", { type: "button", class: "toast-action", onClick: async () => {
      const run = toastRun;
      if (!run) return;
      const inside = !!el.contains?.(document.activeElement);
      closeToast(false);
      try {
        await run();
      } catch (e) {
        toast(e?.message || "Something went wrong.", "error");
      }
      // After the work: a redraw may have replaced the opener.
      if (inside) toastFocusBack();
    } }, action.label));
  }
  if (stays) buttons.push(h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", onClick: () => closeToast() }));
  el.replaceChildren(toastMsg, ...buttons);
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  if (!stays) toastTimer = setTimeout(() => closeToast(), TOAST_MS);
}

/** The one confirmation dialog. Resolves true only on the confirm button; Escape, ✕, the backdrop and Cancel give false. */
export function confirmDialog({ title, text, confirm = "Delete", cancel = "Cancel", danger = true } = {}) {
  let cancelBtn;
  const done = modal(title, (close) => {
    cancelBtn = h("button", { type: "button", onClick: () => close(false) }, cancel);
    return h("div", { class: "stack" }, h("p", {}, text),
      h("div", { class: "row" }, h("span", { class: "spacer" }), cancelBtn,
        h("button", { type: "button", class: danger ? "danger" : "primary", onClick: () => close(true) }, confirm)));
  });
  cancelBtn.focus();
  return done.then((answer) => answer === true);
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
      h("div", { class: "modal-head" }, h("h2", { id: titleId }, title), h("button", { class: "icon", onClick: dismiss, "aria-label": "Close" }, glyph("✕"))),
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

export function timeAgo(iso, now = Date.now()) {
  const s = (now -new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
