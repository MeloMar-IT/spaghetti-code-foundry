import type { StoryView, ViewComment } from "./local-map.js";

/**
 * The texts of the story steps, made from a `StoryView` the way gh and the jq programs of `github-store.ts` make them.
 * gh adds one line break to what a jq program returns; the functions here include it. Pure functions.
 */

/** gh's `(?m)^` matches after a line feed only; JavaScript's `/^/m` also matches after a carriage return, so it is not used. */
const quote = (body: string): string => body.replace(/(^|\n)--- comment by/g, "$1> --- comment by");

const isFoundry = (c: ViewComment): boolean => c.viewerDidAuthor && (c.body.includes("<!-- claude-factory") || c.body.includes("<!-- spaghetti-code-foundry"));
const commentId = (c: ViewComment): number => Number(/#issuecomment-(\d+)$/.exec(c.url)?.[1]);

export function ticketText(v: StoryView): string {
  const head = `# #${v.number}: ${v.title}\n${v.url}\nLabels: ${v.labels.map((l) => l.name).join(", ")}\n\n${quote(v.body)}\n`;
  const comments = v.comments.map((c) => `\n--- comment by ${c.author.login}${isFoundry(c) ? " (Foundry)" : ""}:\n${quote(c.body)}`);
  return `${head}${comments.join("\n")}\n`;
}

export function plainText(v: StoryView): string {
  const head = `# #${v.number}: ${v.title}\nLabels: ${v.labels.map((l) => l.name).join(", ")}\n\n${v.body}\n`;
  const comments = v.comments.map((c) => `\n--- comment by ${c.author.login}:\n${c.body}`);
  return `${head}${comments.join("\n")}\n`;
}

/** The ids of the comments the Foundry wrote, as a JSON list. */
export function foundryIds(v: StoryView): string {
  return jsonText(v.comments.filter(isFoundry).map(commentId));
}

/** One JSON line per comment, as `gh api … --jq '.[] | {id, html_url, created_at, updated_at, body}'` prints them. A story file has no edit time. */
export function commentLines(v: StoryView): string {
  return v.comments.map((c) => `${JSON.stringify({ id: commentId(c), html_url: c.url, created_at: c.createdAt, updated_at: c.createdAt, body: c.body })}\n`).join("");
}

const FIELDS = new Set(["body", "closedAt", "comments", "createdAt", "labels", "number", "state", "title", "updatedAt", "url"]);

/** The names of a `--json` field list, sorted. Throws for a bad list or an unknown field. */
export function checkFields(fields: string): string[] {
  if (typeof fields !== "string" || !/^[A-Za-z]+(?:,[A-Za-z]+)*$/.test(fields)) throw new Error("not a field list");
  const names = fields.split(",").sort();
  for (const f of names) if (!FIELDS.has(f)) throw new Error(`Unknown JSON field: "${f}"`);
  return names;
}

/** The fields of `--json`, with the keys in order. */
export function pickFields(v: StoryView, fields: string): Record<string, unknown> {
  return Object.fromEntries(checkFields(fields).map((f) => [f, v[f as keyof StoryView]]));
}

const sorted = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(sorted);
  if (x === null || typeof x !== "object") return x;
  return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, sorted(val)]));
};

/** Compact JSON with sorted keys and a line break, as gh prints a `--json` answer. */
export function jsonText(x: unknown): string {
  return `${JSON.stringify(sorted(x))}\n`;
}
