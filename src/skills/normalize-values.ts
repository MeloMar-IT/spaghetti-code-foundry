import { NORMALIZE_LIMITS } from "./normalize-rules.js";

// Checks of parsed YAML values and a canonical JSON writer. Pure; imports only the rules.

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** A fixed reason why a parsed YAML value cannot be kept exactly, or undefined. Bounded: ends on cycles, depth and size. */
export function plainProblem(value: unknown): string | undefined {
  const seen = new Set<object>();
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | undefined => {
    if (++nodes > NORMALIZE_LIMITS.yamlNodes) return `holds more than ${NORMALIZE_LIMITS.yamlNodes} values`;
    if (v === null || typeof v === "boolean" || typeof v === "string") return undefined;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "holds a number that is not finite";
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) return "holds an integer outside the safe range";
      return undefined;
    }
    if (typeof v !== "object") return "holds a value of a type that cannot be kept";
    if (seen.has(v)) return "holds the same value twice (a YAML alias)";
    seen.add(v);
    if (depth > NORMALIZE_LIMITS.yamlDepth) return `is nested deeper than ${NORMALIZE_LIMITS.yamlDepth} levels`;
    if (Array.isArray(v)) {
      for (const item of v) {
        const p = walk(item, depth + 1);
        if (p) return p;
      }
      return undefined;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return "holds a value of a type that cannot be kept";
    for (const key of Object.keys(v)) {
      const p = walk((v as Record<string, unknown>)[key], depth + 1);
      if (p) return p;
    }
    return undefined;
  };
  return walk(value, 1);
}

/** JSON with object keys in byte order. Throws a TypeError on a value plainProblem refuses; never writes null for it. */
export function canonicalJson(value: unknown): string {
  const problem = plainProblem(value);
  if (problem) throw new TypeError(`value ${problem}`);
  const write = (v: unknown): string => {
    if (Array.isArray(v)) return "[" + v.map(write).join(",") + "]";
    if (v !== null && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      return "{" + Object.keys(rec).sort(byteOrder).map((k) => JSON.stringify(k) + ":" + write(rec[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  };
  return write(value);
}
