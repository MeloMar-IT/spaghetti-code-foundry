// The gallery page: the view (theme, density, width) in the address query, the control bar and the sections.
// No API call, no storage: the gallery shows made-up examples only.
import { h, mount } from "../dom.js";
import { button } from "../kit/actions.js";
import { sections } from "./registry.js";

export const CHOICES = { theme: ["light", "dark"], density: ["comfortable", "compact"], width: ["wide", "narrow"] };
const KEYS = Object.keys(CHOICES);

/** The view from a query string; a missing or unknown value becomes the first choice. */
export function readView(search) {
  const q = new URLSearchParams(search);
  return Object.fromEntries(KEYS.map((k) => [k, CHOICES[k].includes(q.get(k)) ? q.get(k) : CHOICES[k][0]]));
}

/** The query (without "?") for a view: all three keys, in order. */
export const viewQuery = (view) => new URLSearchParams(KEYS.map((k) => [k, view[k]])).toString();

/** Theme and density go on the root element, the width on the frame. */
export function applyView(root, frame, view) {
  root.setAttribute("data-theme", view.theme);
  root.setAttribute("data-density", view.density);
  frame.setAttribute("data-width", view.width);
}

/** The control groups; `onChange(key, value)` is called on a click. Returns an array of nodes. */
export function drawBar(view, onChange) {
  return KEYS.map((key) => h("div", { class: "gallery-control", role: "group", "aria-label": key },
    h("span", { class: "gallery-control__label" }, key),
    CHOICES[key].map((o) => {
      const current = view[key] === o;
      return button({ size: "small", variant: current ? "primary" : "default", "aria-pressed": String(current), "data-focus": `${key}-${o}`, onClick: () => onChange(key, o) }, o);
    })));
}

/** One <section> per registry section; an example that throws shows its message instead. */
export function drawSections(list = sections) {
  return list.map((s) => h("section", { class: "gallery-section", id: s.id },
    h("h2", {}, s.title),
    h("code", { class: "gallery-section__component" }, s.component),
    s.examples.map((ex) => {
      let body;
      try {
        body = ex.build();
      } catch (e) {
        body = h("pre", { class: "gallery-example__failed" }, String(e?.message ?? e));
      }
      return h("div", { class: "gallery-example" }, h("h3", { class: "gallery-example__name" }, ex.name), h("div", { class: "gallery-example__body" }, body));
    })));
}

/** Reads the query, applies it, draws the bar and the sections, and keeps the query in step. */
export function start({ location, history }, list = sections) {
  const bar = document.getElementById("gallery-bar");
  const frame = document.getElementById("gallery-frame");
  const main = document.getElementById("gallery-main");
  const root = document.documentElement;
  let view = readView(location.search);
  const draw = () => {
    applyView(root, frame, view);
    mount(bar, drawBar(view, change));
  };
  const change = (key, value) => {
    view = { ...view, [key]: value };
    history.replaceState(null, "", `?${viewQuery(view)}`);
    draw();
  };
  draw();
  mount(main, drawSections(list));
}
