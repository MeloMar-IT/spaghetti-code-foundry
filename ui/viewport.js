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
