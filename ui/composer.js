// The one text box for "What would you like to change?" and the closed "Advanced" disclosure. Start work, the project
// page's "Ask for a change" and the flow editor's Run dialog all use them, so the words and the keys are the same everywhere.
import { h } from "./dom.js";

export const COMPOSER = { what: "What would you like to change?", plan: "Make a plan", advanced: "Advanced", keys: "Ctrl/⌘+Enter" };

/** { field, box, labelEl, hintEl }. Ctrl or ⌘ + Enter calls `onSubmit`. */
export function composerBox({ id, name = "task", value = "", rows = 5, label = COMPOSER.what, hint = "", placeholder, disabled, focus, onInput, onSubmit } = {}) {
  const box = h("textarea", { id, name, rows, placeholder, "data-focus": focus, disabled: disabled ? true : undefined });
  box.value = value;
  if (onInput) box.addEventListener("input", onInput);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault?.();
      onSubmit?.();
    }
  });
  const labelEl = h("span", {}, label);
  const hintEl = hint ? h("small", { class: "muted" }, hint) : null;
  const field = h("label", { class: "field composer", for: id }, labelEl, box, hintEl);
  return { field, box, labelEl, hintEl };
}

/** A closed `details` with `body` inside. `onToggle(open)` follows the person's clicks. */
export function advancedBox(body, { open = false, onToggle, label = COMPOSER.advanced } = {}) {
  return h("details", { class: "composer-advanced", open: open ? true : undefined, onToggle: (e) => onToggle?.(!!e?.target?.open) },
    h("summary", {}, label), body);
}
