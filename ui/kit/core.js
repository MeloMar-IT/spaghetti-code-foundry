// Small helpers shared by the kit modules (ui/kit/*.js).

/** Joins class names; empty values are skipped. */
export const cx = (...names) => names.filter((n) => typeof n === "string" && n.trim() !== "").join(" ");

let counter = 0;
/** A new id such as "scf-field-3". */
export const nextId = (prefix) => `${prefix}-${++counter}`;

/** The props that pass through to the element. Throws when a caller sends inline styles: the kit uses classes only. */
export function rest(props) {
  if (Object.hasOwn(props, "style")) throw new Error("a kit component takes no inline styles");
  return props;
}

/** Throws Error(`unknown ${what} "${value}"`) unless `allowed` has `value`. */
export function oneOf(what, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`unknown ${what} "${value}"`);
  return value;
}
