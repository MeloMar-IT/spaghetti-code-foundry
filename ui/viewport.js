import { PAGES } from "./ia.js";

/** The widest viewport of each named layout, in CSS px; wide is everything above medium. Keep in step with ui/css and docs/DESIGN.md "Breakpoints". */
export const BREAKPOINTS = Object.freeze({ compact: 767, medium: 1023 });

/** At this width and below, two panes stack (editor, run page, dashboard). */
export const STACKED_MAX = 1100;

/** "compact" | "medium" | "wide" | "stacked" → a media query string. Throws on any other name. */
export function queryFor(name) {
  switch (name) {
    case "compact": return `(max-width: ${BREAKPOINTS.compact}px)`;
    case "medium": return `(min-width: ${BREAKPOINTS.compact + 1}px) and (max-width: ${BREAKPOINTS.medium}px)`;
    case "wide": return `(min-width: ${BREAKPOINTS.medium + 1}px)`;
    case "stacked": return `(max-width: ${STACKED_MAX}px)`;
    default: throw new Error(`Unknown layout: ${name}`);
  }
}

/** The MediaQueryList for a named layout; undefined where matchMedia does not exist. */
export function mediaFor(name, win = globalThis) {
  return win.matchMedia?.(queryFor(name));
}

const FLOW_PAGES = new Set(["flows", "flow", "new-flow"]);

function kindOf(pageId) {
  if (FLOW_PAGES.has(pageId)) return "flow";
  return PAGES.find((p) => p.id === pageId)?.area === "administration" ? "admin" : null;
}

/** "full" | "read-only" for a page id from ui/ia.js at a viewport width in CSS px. Unknown id or no usable width: "full". */
export function supportLevel(pageId, width) {
  if (!Number.isFinite(width)) return "full";
  const kind = kindOf(pageId);
  if (kind === "admin") return width <= BREAKPOINTS.compact ? "read-only" : "full";
  if (kind === "flow") return width <= BREAKPOINTS.medium ? "read-only" : "full";
  return "full";
}

/** The text of the notice for a page that can be read-only, or null. `dirty`: a flow draft has unsaved changes. */
export function levelNotice(pageId, { dirty = false } = {}) {
  const kind = kindOf(pageId);
  if (kind === "admin") return `Editing needs a wider screen (${BREAKPOINTS.compact + 1} px or more).`;
  if (kind === "flow") return `Editing a flow needs a wider screen (${BREAKPOINTS.medium + 1} px or more)${dirty ? "; unsaved changes are kept" : ""}.`;
  return null;
}
