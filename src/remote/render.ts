/** Plain-text output for the command line: tables for lists, "key: value" lines for one thing. */

const cell = (v: unknown, max = 60): string => {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** A value by a dotted path, e.g. "today.costUsd". */
export const pick = (row: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), row);

export interface Column { key: string; head?: string; max?: number }
export const cols = (...keys: string[]): Column[] => keys.map((k) => ({ key: k }));

export function table(rows: unknown[], columns: Column[], empty = "nothing to show"): string {
  if (!rows.length) return empty;
  const heads = columns.map((c) => (c.head ?? c.key.split(".").pop()!).toUpperCase());
  const body = rows.map((r) => columns.map((c) => cell(pick(r, c.key), c.max)));
  const width = heads.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(width[i]!))).join("  ").trimEnd();
  return [line(heads), ...body.map(line)].join("\n");
}

/** One thing as "key: value" lines; nested values as compact JSON. */
export function fields(obj: unknown, keys?: string[]): string {
  if (!obj || typeof obj !== "object") return cell(obj, 10_000);
  const entries = keys ? keys.map((k) => [k, pick(obj, k)] as const) : Object.entries(obj as Record<string, unknown>);
  const shown = entries.filter(([, v]) => v !== undefined && v !== null && v !== "");
  const width = Math.max(0, ...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${cell(v, 200)}`).join("\n");
}

/** The default look of an answer: a list of things as a table of its simple fields, one thing as lines. */
export function auto(data: unknown): string {
  if (data === undefined || data === null) return "done";
  if (typeof data !== "object") return String(data);
  if (Array.isArray(data)) {
    if (!data.length) return "nothing to show";
    if (data.every((d) => d && typeof d === "object" && !Array.isArray(d))) {
      const simple = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
      const keys = [...new Set(data.flatMap((d) => Object.entries(d as object).filter(([, v]) => simple(v)).map(([k]) => k)))].slice(0, 7);
      return table(data, cols(...keys));
    }
    return data.map((d) => cell(d, 200)).join("\n");
  }
  // an answer like { runs: [...] }: show the list
  const lists = Object.entries(data as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
  if (lists.length === 1 && Object.keys(data as object).length <= 3) return auto(lists[0]![1]);
  return fields(data);
}
