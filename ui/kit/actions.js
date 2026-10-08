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

/** An `<a href>`. `external` opens a new tab without handing over the opener. */
export function link({ href, external = false, class: cls, ...more } = {}, ...children) {
  rest(more);
  if (typeof href !== "string" || href.trim() === "") throw new Error("a link needs an href");
  return h("a", {
    ...more,
    href,
    class: cx("scf-link", cls),
    rel: external ? "noopener noreferrer" : undefined,
    target: external ? "_blank" : undefined,
  }, children);
}
