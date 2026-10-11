// The repository switcher in the top bar: builds the DOM from a model and reports events through handlers.
// It keeps no state. Document listeners exist only while the panel is open; cleanup() removes them.
import { glyph, h, mount } from "./dom.js";

const COMPACT = "(max-width: 767px)";

/**
 * model: { state: "failed"|"none"|"one"|"many", label, open, search, text, sections: [{ title, rows }] }
 * handlers: { onToggle, onClose({ focus }), onChoose(name), onStar(name), onSearch(text), onRetry }
 * Returns { node, cleanup, update(model) }.
 */
export function switcherView(model, handlers) {
  const node = h("span", { class: "context-box" });
  let listBox = null;
  const removers = [];

  const row = (r) => {
    const key = r.name || "all";
    return h("li", { class: "context-row" },
      h("button", { type: "button", class: "context-item", "data-focus": `context-item-${key}`, "aria-current": r.current ? "true" : null, onClick: () => handlers.onChoose(r.name) }, r.label),
      r.group === "all" ? null : h("button", { type: "button", class: "context-star", "data-focus": `context-star-${r.name}`, "aria-pressed": r.favourite ? "true" : "false", "aria-label": `Favourite ${r.name}`, onClick: () => handlers.onStar(r.name) }, glyph(r.favourite ? "★" : "☆")));
  };
  const fill = (m) => {
    const parts = m.sections.length
      ? m.sections.map((s) => [
        s.title ? h("div", { class: "context-head", "aria-hidden": "true" }, s.title) : null,
        h("ul", { class: "context-list", "aria-label": s.title || null }, s.rows.map(row)),
      ])
      : [h("p", { class: "context-empty" }, "No repository matches.")];
    mount(listBox, ...parts.flat());
  };

  if (model.state === "failed") {
    node.append(h("span", { class: "context-note" }, "Repositories could not be loaded."),
      h("button", { type: "button", "data-focus": "context-retry", onClick: () => handlers.onRetry() }, "Retry"));
  } else if (model.state === "none") {
    node.append(h("span", { class: "context-note" }, "No repository yet."), h("a", { href: "#/repos", "data-focus": "context-add" }, "Add one"));
  } else if (model.state === "one") {
    node.append(h("span", { class: "context-label" }, model.label));
  } else {
    node.append(h("button", { type: "button", class: "context-btn", "data-focus": "context-btn", "aria-haspopup": "true", "aria-expanded": model.open ? "true" : "false", onClick: () => handlers.onToggle() },
      h("span", { class: "sr-only" }, "Repository: "), model.label, glyph("▾")));
    if (model.open) {
      listBox = h("div", {});
      const input = model.search
        ? h("input", { type: "search", "data-focus": "context-search", "aria-label": "Find a repository", value: model.text, onInput: () => handlers.onSearch(input.value) })
        : null;
      const panel = h("div", { id: "context-panel", class: "context-panel", role: "group", "aria-label": "Repositories" }, input, listBox);
      node.append(panel);
      fill(model);

      const onKey = (e) => {
        if (e.key !== "Escape") return;
        if (document.getElementById("modal-root")?.children?.length) return;
        handlers.onClose({ focus: true });
      };
      const onDown = (e) => {
        if (!node.contains(e.target)) handlers.onClose({ focus: false });
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onDown);
      removers.push(() => document.removeEventListener("keydown", onKey), () => document.removeEventListener("mousedown", onDown));

      // At the compact width the panel is fixed: put it just under the real bottom of the top bar, which may wrap.
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        const place = () => {
          const bar = node.closest?.("header");
          const compact = window.matchMedia(COMPACT).matches;
          panel.style.top = compact && bar ? `${Math.round(bar.getBoundingClientRect().bottom)}px` : "";
        };
        // The node is not in the page yet (the caller mounts it after this returns): measure on the next frame.
        const frame = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(place) : (place(), null);
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place);
        removers.push(() => window.removeEventListener("resize", place), () => window.removeEventListener("scroll", place),
          () => frame != null && window.cancelAnimationFrame?.(frame));
      }
    }
  }

  return {
    node,
    cleanup() {
      while (removers.length) removers.pop()();
    },
    update(next) {
      if (listBox) fill(next);
    },
  };
}
