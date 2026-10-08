// Actions: button, iconButton and link. Styles are in actions.css.
import { h } from "../dom.js";
import { icon as iconNode } from "../icons.js";
import { cx, oneOf, rest } from "./core.js";

const VARIANTS = ["default", "primary", "danger", "ghost"];
const SIZES = ["default", "small"];

/** A `<button type="button">` unless `type` is given. `busy` shows a spinner and ignores clicks. */
export function button({ variant = "default", size = "default", busy = false, disabled = false, type = "button", class: cls, onClick, ...more } = {}, ...children) {
  rest(more);
  oneOf("button variant", variant, VARIANTS);
  oneOf("button size", size, SIZES);
  return h("button", {
    ...more,
    type,
    class: cx("scf-btn", variant !== "default" && `scf-btn--${variant}`, size === "small" && "scf-btn--small", busy && "scf-btn--busy", cls),
    disabled: disabled === true,
    "aria-busy": busy ? "true" : undefined,
    "aria-disabled": busy ? "true" : undefined,
    onClick: busy ? (e) => e?.preventDefault?.() : onClick,
  }, busy ? iconNode("loader-circle", { small: true, spin: true }) : null, children);
}

/** A button with only an icon. `label` is required: it is the accessible name and the title. */
export function iconButton({ icon: name, label, variant = "ghost", class: cls, ...more } = {}) {
  if (typeof label !== "string" || label.trim() === "") throw new Error("an icon button needs a label");
  return button({ ...more, variant, class: cx("scf-btn--icon", cls), "aria-label": label, title: label }, iconNode(name));
}

/**
 * An `<a href>`. `external` opens a new tab without handing over the opener. `disabled` drops the href (so it is
 * no longer a link target or a tab stop) and sets aria-disabled.
 */
export function link({ href, external = false, disabled = false, class: cls, ...more } = {}, ...children) {
  rest(more);
  if (typeof href !== "string" || href.trim() === "") throw new Error("a link needs an href");
  if (disabled === true) {
    // No href, no caller handler, no tab stop; a click (or Enter) goes nowhere.
    const { onClick, onKeydown, onKeyDown, onKeyup, onKeyUp, onMousedown, onPointerdown, ...inert } = more;
    const stop = (e) => { e?.preventDefault?.(); e?.stopPropagation?.(); };
    return h("a", { ...inert, role: "link", tabindex: "-1", "aria-disabled": "true", class: cx("scf-link", "scf-link--disabled", cls), onClick: stop }, children);
  }
  return h("a", {
    ...more,
    href,
    class: cx("scf-link", cls),
    rel: external ? "noopener noreferrer" : undefined,
    target: external ? "_blank" : undefined,
  }, children);
}
