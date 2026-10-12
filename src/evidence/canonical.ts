import { sha256Hex } from "./identity.js";

/**
 * The canonical form of evidence: the one text a record has, whatever order its fields were written in.
 * The hash of an event is taken over this text, and every line of `evidence.jsonl` is written in it.
 *
 * The rules (the same as RFC 8785, the JSON Canonicalization Scheme):
 * - An object is `{` + its members + `}`. Members are `"name":value` with `,` between them, ordered by name. Names
 *   are compared by their UTF-16 code units (for the plain letters, digits and `_` of evidence: byte order).
 *   A member whose value is `undefined` is left out.
 * - An array is `[` + its values in their own order with `,` between them + `]`.
 * - A string is in double quotes. `"` and `\` are written `\"` and `\\`; the control characters U+0000 to U+001F are
 *   written `\b`, `\t`, `\n`, `\f`, `\r` or, for the others, `\u` with four lower-case hex digits; a lone surrogate is
 *   written the same way. Every other character is written as itself. Nothing is normalized.
 * - A number is written as ECMAScript writes it (`12`, `-3`, `0.5`, `1e+21`); negative zero is `0`. A number that
 *   is not finite is refused. Evidence itself only has whole numbers.
 * - `true`, `false` and `null` are written as these words.
 * - There is no space or line break anywhere outside a string.
 * The text is encoded as UTF-8 before it is hashed or written.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("a number that is not finite has no canonical form");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new TypeError("only plain objects have a canonical form");
      const o = value as Record<string, unknown>;
      const names = Object.keys(o).filter((k) => o[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${names.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`a ${typeof value} has no canonical form`);
  }
}

/** The SHA-256 (lower-case hex) of the canonical form of a value, as UTF-8. */
export const canonicalHash = (value: unknown): string => sha256Hex(Buffer.from(canonicalJson(value), "utf8"));

/**
 * The `hash` of an event: the SHA-256 of the canonical form of the whole event without its `hash` field.
 * `prevHash` is part of it (null for the first event), so each hash covers every event before it.
 * It is taken over the record as it is written, never over a record that was brought to a newer version.
 */
export function eventHash(event: Record<string, unknown>): string {
  const { hash: _hash, ...rest } = event;
  return canonicalHash(rest);
}
