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

/** How a default of a setting description reads in a hint. */
export function shownDefault(d) {
  if (typeof d === "boolean") return d ? "yes" : "no";
  if (d === undefined || (Array.isArray(d) && d.length === 0)) return "none";
  if (Array.isArray(d)) return d.map((x) => (typeof x === "object" && x !== null ? Object.values(x).join(" ") : String(x))).join(", ");
  return String(d);
}

/** The hint of a setting description: help, list format (unless format is false), default, range and when it takes effect. */
export function settingHint(d, { format = true } = {}) {
  const lineFormat = format && d.kind === "list" && !d.fields ? " One per line." : "";
  const bounds = d.min !== undefined && d.max !== undefined ? ` Allowed: ${d.min} to ${d.max}.` : d.min !== undefined ? ` At least ${d.min}.` : d.max !== undefined ? ` At most ${d.max}.` : "";
  const range = `${bounds}${d.exclusiveMin !== undefined ? ` More than ${d.exclusiveMin}.` : ""}${d.maxItems !== undefined ? ` At most ${d.maxItems} items.` : ""}`;
  return `${d.help}${lineFormat} Default: ${shownDefault(d.default)}.${range} Takes effect ${d.effectText}.`;
}
