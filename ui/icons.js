// Icons from Lucide (ISC License, © Lucide Contributors). Portions come from Feather (MIT License, © Cole Bemis 2013-2022).
// Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
// provided that the above copyright notice and this permission notice appear in all copies.
// The path data was written down from memory, not copied from a Lucide release. An icon that differs from Lucide
// counts as drawn by hand in the Lucide grid (24 by 24, stroke 2, round caps and joins). Check it in the demo page.
import { h, svg } from "./dom.js";

const C = ["circle", { cx: "12", cy: "12", r: "10" }];
const p = (d) => ["path", { d }];

/** name → list of [tag, attrs] */
export const ICONS = {
  "check": [p("M20 6 9 17l-5-5")],
  "x": [p("M18 6 6 18"), p("m6 6 12 12")],
  "circle": [C],
  "circle-dot": [C, ["circle", { cx: "12", cy: "12", r: "1" }]],
  "circle-check": [C, p("m9 12 2 2 4-4")],
  "circle-x": [C, p("m15 9-6 6"), p("m9 9 6 6")],
  "triangle-alert": [p("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"), p("M12 9v4"), p("M12 17h.01")],
  "info": [C, p("M12 16v-4"), p("M12 8h.01")],
  "loader-circle": [p("M21 12a9 9 0 1 1-6.219-8.56")],
  "clock": [C, p("M12 6v6l4 2")],
  "ban": [C, p("m4.9 4.9 14.2 14.2")],
  "circle-help": [C, p("M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"), p("M12 17h.01")],
  "chevron-down": [p("m6 9 6 6 6-6")],
  "external-link": [p("M15 3h6v6"), p("M10 14 21 3"), p("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")],
  "sun": [
    ["circle", { cx: "12", cy: "12", r: "4" }], p("M12 2v2"), p("M12 20v2"), p("m4.93 4.93 1.41 1.41"), p("m17.66 17.66 1.41 1.41"),
    p("M2 12h2"), p("M20 12h2"), p("m6.34 17.66-1.41 1.41"), p("m19.07 4.93-1.41 1.41"),
  ],
  "moon": [p("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z")],
  "monitor": [
    ["rect", { width: "20", height: "14", x: "2", y: "3", rx: "2" }],
    ["line", { x1: "8", x2: "16", y1: "21", y2: "21" }],
    ["line", { x1: "12", x2: "12", y1: "17", y2: "21" }],
  ],
  "rows-2": [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], p("M3 12h18")],
  "rows-3": [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], p("M21 9H3"), p("M21 15H3")],
};

/** An SVG that takes the text colour. Without a label it is hidden from screen readers; with one it is an image. */
export function icon(name, { label, small = false, spin = false } = {}) {
  if (!Object.hasOwn(ICONS, name)) throw new Error(`unknown icon "${name}"`);
  const named = typeof label === "string" && label.trim() !== "";
  return svg("svg", {
    class: "ico" + (small ? " ico-sm" : "") + (spin ? " spin" : ""),
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    ...(named ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
  }, ICONS[name].map(([tag, attrs]) => svg(tag, attrs)));
}

/** A button with only an icon. The label is its accessible name and its title. */
export function iconButton(name, label, props = {}) {
  if (typeof label !== "string" || label.trim() === "") throw new Error("an icon button needs a label");
  return h("button", { type: "button", ...props, class: `icon ${props.class ?? ""}`.trim(), "aria-label": label, title: label }, icon(name));
}

export const STATUS = {
  neutral: "circle", accent: "circle-dot", success: "circle-check", warning: "triangle-alert",
  danger: "circle-x", info: "info", running: "loader-circle", waiting: "clock", disabled: "ban",
};

/** NextKind → semantic. Presentation only: the status text and its meaning come from the server. */
export const KIND_SEMANTIC = {
  done: "success",
  running: "running", checking: "running", starting: "running",
  failed: "danger", watcher_error: "danger", monitor_stopped: "danger", watcher_stale: "danger",
  usage_limit: "warning", daily_budget: "warning", user_limit: "warning", interrupted: "warning", restart: "warning", closed_elsewhere: "warning",
  questions: "waiting", planner_questions: "waiting", approve_plan: "waiting", approve_split: "waiting", approval: "waiting",
  monitor_needs_you: "waiting", dependency: "waiting", one_at_a_time: "waiting", area_lock: "waiting", queued: "waiting", release: "waiting",
  stopped: "waiting", bug_first: "waiting",
  cancelled: "disabled", superseded: "disabled", issue_closed: "disabled",
};
export const semanticOf = (kind) => (Object.hasOwn(KIND_SEMANTIC, kind) ? KIND_SEMANTIC[kind] : "neutral");

/** Semantic of a watcher state name (its words come from the server). */
export const watcherSemanticOf = (name) => ({ active: "success", error: "danger" })[name] ?? "disabled";

/** A status pill: icon and text. Strict: throws on an unknown semantic or empty text. */
export function statusPill(semantic, text, cls = "") {
  if (!Object.hasOwn(STATUS, semantic)) throw new Error(`unknown status "${semantic}"`);
  if (typeof text !== "string" || text.trim() === "") throw new Error("a status needs text");
  return h("span", { class: `pill sem-${semantic} ${cls}`.trim() }, icon(STATUS[semantic], { small: true }), text);
}

/** Name of a flow in the sidebar: a flow with errors gets an icon with a label, not only red text. */
export const flowNameMark = (f) => h("span", {}, f.error ? icon("triangle-alert", { label: "Has errors", small: true }) : null, f.name);
