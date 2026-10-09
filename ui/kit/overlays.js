// Overlay and navigation primitives: tabs, menu, tooltip, dialog, drawer and toast. Styles are in overlays.css.
// Keyboard and focus rules are built in, so a page writes none. Shown and hidden with the `hidden` property.
import { h, tabStops, trapTarget } from "../dom.js";
import { iconButton } from "./actions.js";
import { cx, nextId, oneOf, rest } from "./core.js";

const blank = (s) => typeof s !== "string" || s.trim() === "";
const PLACEMENTS = ["below", "above"];
const ALIGNS = ["start", "end"];

// One shared document keydown listener serves the overlay stack and the visible tooltips. It exists only while
// one of them does. `layers` is the stack of dialogs and drawers (last = top). `transients` are things that are
// open inside the page (a menu, a shown tooltip): when a layer is removed, the ones inside it are closed.
const layers = [];
const transients = new Set();

function onDocKey(e) {
  if (e.key === "Escape") {
    // Only a tooltip inside the top layer (or on the page, with no layer) takes the key; one behind the layer does not.
    const top = layers[layers.length - 1];
    const tip = [...transients].reverse().find((t) => t.onEscape && (!top || top.overlay.contains(t.node)));
    if (tip) return tip.onEscape();
    return layers[layers.length - 1]?.dismiss();
  }
  const top = layers[layers.length - 1];
  if (e.key !== "Tab" || !top) return;
  const to = trapTarget(tabStops(top.box), document.activeElement, e.shiftKey);
  if (to) {
    e.preventDefault();
    to.focus();
  }
}

let listening = false;
function syncKeys() {
  const need = layers.length > 0 || [...transients].some((t) => t.onEscape);
  if (need && !listening) document.addEventListener("keydown", onDocKey);
  if (!need && listening) document.removeEventListener("keydown", onDocKey);
  listening = need;
}

const open = (t) => { transients.add(t); syncKeys(); };
const shut = (t) => { transients.delete(t); syncKeys(); };

// ---- tabs ----

/**
 * `tabs({ label, tabs: [{ id, label, build }], selected, onSelect })`. A tab list with one panel per tab; a panel is
 * built the first time its tab is selected. Left/Right move and wrap, Home/End jump.
 */
export function tabs({ label, tabs: list, selected, onSelect, class: cls, ...more } = {}) {
  rest(more);
  if (blank(label)) throw new Error("tabs need a label");
  if (!Array.isArray(list) || list.length === 0) throw new Error("tabs need at least one tab");
  const ids = new Set();
  for (const t of list) {
    if (blank(t?.id) || blank(t?.label)) throw new Error("a tab needs an id and a label");
    if (ids.has(t.id)) throw new Error(`duplicate tab id "${t.id}"`);
    if (typeof t.build !== "function") throw new Error(`tab "${t.id}" needs a build function`);
    ids.add(t.id);
  }
  if (selected != null && !ids.has(selected)) throw new Error(`unknown tab "${selected}"`);
  const base = nextId("scf-tabs");
  let current = Math.max(0, list.findIndex((t) => t.id === selected));
  const built = new Set();
  const buttons = list.map((t, i) => h("button", {
    type: "button", role: "tab", class: "scf-tabs__tab", id: `${base}-tab-${i}`, "aria-controls": `${base}-panel-${i}`,
    onClick: () => select(i, false),
    onKeydown: (e) => {
      const to = { ArrowRight: (i + 1) % list.length, ArrowLeft: (i - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(to, true);
    },
  }, t.label));
  const panels = list.map((t, i) => h("div", { role: "tabpanel", class: "scf-tabs__panel", id: `${base}-panel-${i}`, "aria-labelledby": `${base}-tab-${i}`, tabindex: "0" }));
  function show(focus) {
    buttons.forEach((b, i) => {
      b.setAttribute("aria-selected", String(i === current));
      b.setAttribute("tabindex", i === current ? "0" : "-1");
      panels[i].hidden = i !== current;
    });
    if (!built.has(current)) {
      built.add(current);
      panels[current].append(list[current].build());
    }
    if (focus) buttons[current].focus();
  }
  function select(i, focus) {
    const changed = i !== current;
    current = i;
    show(focus);
    if (changed) onSelect?.(list[i].id);
  }
  show(false);
  return h("div", { ...more, class: cx("scf-tabs", cls) },
    h("div", { role: "tablist", class: "scf-tabs__list", "aria-label": label }, buttons), panels);
}

// ---- menu ----

/** `menu({ label, trigger, items: [{ label, onSelect, danger, disabled }], placement, align })`. A button that opens a list. */
export function menu({ label, trigger, items, placement = "below", align = "start", class: cls, ...more } = {}) {
  rest(more);
  if (blank(label)) throw new Error("a menu needs a label");
  if (!Array.isArray(items)) throw new Error("a menu needs an items array");
  oneOf("menu placement", placement, PLACEMENTS);
  oneOf("menu align", align, ALIGNS);
  let isOpen = false;
  let t;
  const btn = h("button", {
    type: "button", class: "scf-btn scf-menu__trigger", "aria-haspopup": "menu", "aria-expanded": "false",
    "aria-label": typeof trigger === "string" ? undefined : label, disabled: items.length === 0,
    onClick: () => (isOpen ? close(true) : openMenu("first")),
    onKeydown: (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      openMenu(e.key === "ArrowDown" ? "first" : "last");
    },
  }, trigger);
  const nodes = items.map((item) => {
    const off = item.disabled === true;
    return h("button", {
      type: "button", role: "menuitem", tabindex: "-1", class: cx("scf-menu__item", item.danger && "scf-menu__item--danger", off && "scf-menu__item--disabled"),
      "aria-disabled": off ? "true" : undefined,
      onClick: () => {
        if (off) return;
        close(true);
        item.onSelect?.();
      },
    }, item.label);
  });
  const list = h("div", { role: "menu", class: "scf-menu__list", "aria-label": label, tabindex: "-1", onKeydown: (e) => keys(e) }, nodes);
  list.hidden = true;
  const root = h("div", { ...more, class: cx("scf-menu", placement === "above" && "scf-menu--above", align === "end" && "scf-menu--end", cls) }, btn, list);
  const enabled = () => nodes.filter((n) => n.getAttribute("aria-disabled") !== "true");
  const onOutside = (e) => { if (!root.contains(e.target)) close(false); };

  function openMenu(where) {
    if (isOpen || items.length === 0) return;
    isOpen = true;
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside);
    t = { node: root, close: () => close(false) };
    open(t);
    const on = enabled();
    ((where === "last" ? on[on.length - 1] : on[0]) ?? list).focus();
  }
  function close(refocus) {
    if (!isOpen) return;
    isOpen = false;
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside);
    shut(t);
    if (refocus) btn.focus();
  }
  function keys(e) {
    if (e.key === "Escape") {
      e.preventDefault?.();
      e.stopPropagation?.();
      return close(true);
    }
    if (e.key === "Tab") return close(true);
    const on = enabled();
    const at = on.indexOf(document.activeElement);
    const target = {
      ArrowDown: on[(at + 1) % on.length],
      ArrowUp: at < 0 ? on[on.length - 1] : on[(at - 1 + on.length) % on.length],
      Home: on[0],
      End: on[on.length - 1],
    };
    if (!(e.key in target)) return;
    e.preventDefault();
    target[e.key]?.focus();
  }
  return root;
}

// ---- tooltip ----

/** `tooltip({ text, placement, align }, target)`. Shows on hover and focus, hides on Escape. Never the only copy of needed information. */
export function tooltip({ text, placement = "above", align = "start", class: cls, ...more } = {}, target) {
  rest(more);
  if (blank(text)) throw new Error("a tooltip needs text");
  if (!(target instanceof Node)) throw new Error("a tooltip needs a target");
  oneOf("tooltip placement", placement, PLACEMENTS);
  oneOf("tooltip align", align, ALIGNS);
  const id = nextId("scf-tooltip");
  const bubble = h("span", { role: "tooltip", id, class: cx("scf-tooltip__bubble", placement === "below" && "scf-tooltip__bubble--below", align === "end" && "scf-tooltip__bubble--end") }, text);
  bubble.hidden = true;
  target.setAttribute("aria-describedby", [target.getAttribute("aria-describedby"), id].filter(Boolean).join(" "));
  let hover = false;
  let focus = false;
  const hideNow = () => { hover = false; focus = false; update(); };
  const t = { onEscape: hideNow, close: hideNow };
  function update() {
    const on = hover || focus;
    if (on === !bubble.hidden) return;
    bubble.hidden = !on;
    if (on) open(t); else shut(t);
  }
  const wrap = h("span", {
    ...more, class: cx("scf-tooltip", cls),
    onMouseenter: () => { hover = true; update(); },
    onMouseleave: () => { hover = false; update(); },
    onFocusin: () => { focus = true; update(); },
    onFocusout: () => { focus = false; update(); },
  }, target, bubble);
  t.node = wrap;
  return wrap;
}

// ---- dialog and drawer ----

let titleSeq = 0;

/** Shows a layer in #modal-root and resolves with the value passed to `close`. Layers stack; the top one gets the keys. */
function openLayer({ kind, title, build, busy = () => false, side, dismissOnBackdrop, class: cls, ...more }) {
  rest(more);
  if (blank(title)) throw new Error(`a ${kind} needs a title`);
  if (typeof build !== "function") throw new Error(`a ${kind} needs a build function`);
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const layer = { opener: document.activeElement, mounted: false };
    const titleId = `scf-${kind}-title-${++titleSeq}`;
    let closed = false;
    const close = (value) => {
      // A second call (Escape, then the work finishing) must not touch a newer layer.
      if (closed) return;
      closed = true;
      resolve(value);
      if (!layer.mounted) return;
      const i = layers.indexOf(layer);
      const wasTop = i === layers.length - 1;
      for (const t of [...transients]) if (layer.overlay.contains(t.node)) t.close();
      layers.splice(i, 1);
      layer.overlay.remove();
      // A layer above this one was opened from inside it: its focus goes back to where this one came from.
      const above = layers[i];
      if (above && !wasTop && layer.overlay.contains(above.opener)) above.opener = layer.opener;
      refresh();
      syncKeys();
      if (wasTop) layer.opener?.focus?.();
    };
    layer.dismiss = () => (busy() ? undefined : close(undefined));
    const body = build(close);
    if (closed) return;
    layer.box = h("div", { ...more, class: cx(kind === "drawer" ? "scf-drawer" : "scf-dialog", kind === "drawer" && side === "start" && "scf-drawer--start", cls), role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" },
      h("div", { class: "scf-overlay__head" },
        h("h2", { id: titleId, class: "scf-overlay__title" }, title),
        iconButton({ icon: "x", label: "Close", variant: "ghost", onClick: () => layer.dismiss() })),
      h("div", { class: "scf-overlay__body" }, body));
    layer.overlay = h("div", {
      class: cx("scf-overlay", kind === "drawer" && "scf-overlay--drawer", kind === "drawer" && side === "start" && "scf-overlay--start"),
      onMousedown: (e) => dismissOnBackdrop && e.target === e.currentTarget && layer.dismiss(),
    }, layer.box);
    layers.push(layer);
    layer.mounted = true;
    root.append(layer.overlay);
    refresh();
    syncKeys();
    // The first enabled, visible text control; the box itself when there is none.
    const field = tabStops(layer.box).find((el) => (el.tag === "input" || el.tag === "textarea") && el.getAttribute("type") !== "hidden");
    (field ?? layer.box).focus();
  });
}

/** Only the top layer can be reached: the ones below it are inert while it is open. */
function refresh() {
  layers.forEach((l, i) => {
    if (i < layers.length - 1) l.overlay.setAttribute("inert", ""); else l.overlay.removeAttribute("inert");
  });
}

/** `dialog({ title, build, busy, dismissOnBackdrop })`: a centred dialog. `build(close)` returns the content. A backdrop click closes it by default. */
export const dialog = ({ dismissOnBackdrop = true, ...props } = {}) => openLayer({ ...props, kind: "dialog", dismissOnBackdrop });

/** `drawer({ title, side, build, busy, dismissOnBackdrop })`: the same as `dialog`, drawn as a side panel. A backdrop click does not close it by default. */
export function drawer({ side = "end", dismissOnBackdrop = false, ...props } = {}) {
  oneOf("drawer side", side, ALIGNS);
  return openLayer({ ...props, kind: "drawer", side, dismissOnBackdrop });
}

// ---- toast ----

const TONES = ["info", "ok", "warn", "fail"];
let toasts;

/**
 * `toast(message, { tone, timeout })`. Several stack. It goes away after `timeout` ms (0: stays); a `fail` toast always
 * stays until dismissed. Returns a function that dismisses it.
 */
export function toast(message, { tone = "info", timeout = 3500, ...more } = {}) {
  rest(more);
  if (blank(message)) throw new Error("a toast needs a message");
  oneOf("toast tone", tone, TONES);
  if (!toasts || toasts.parentNode !== document.body) {
    toasts = h("div", { class: "scf-toasts" });
    document.body.append(toasts);
  }
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };
  const el = h("div", { class: `scf-toast scf-toast--${tone}`, role: tone === "fail" ? "alert" : "status" },
    h("span", { class: "scf-toast__text" }, message),
    iconButton({ icon: "x", label: "Dismiss", variant: "ghost", class: "scf-toast__dismiss", onClick: dismiss }));
  toasts.append(el);
  if (tone !== "fail" && timeout > 0) timer = setTimeout(dismiss, timeout);
  return dismiss;
}
