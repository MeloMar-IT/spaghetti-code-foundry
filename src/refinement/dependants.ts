import { createHash } from "node:crypto";
import { DEP_REF_SOURCE, dependencies, dependencyRange } from "../queue/deps.js";
import { BOT_MARKER } from "../github.js";
import { fenceFor } from "./publish.js";

/** Finding the issues that depend on a split issue, rewriting their "Depends on" text, and the comments about it. Pure: no I/O. */

export interface Rewrite {
  body: string;
  before: string;
  after: string;
}

const refs = (parts: readonly (number | string)[]) => parts.map((p) => (typeof p === "number" ? `#${p}` : p)).join(", ");

/** Replaces every "#<original>" in the "Depends on" text with the parts. Undefined when there is nothing to replace. */
export function rewriteDependsOn(body: string, original: number, parts: readonly (number | string)[]): Rewrite | undefined {
  const range = dependencyRange(body);
  if (!range || !parts.length) return undefined;
  const before = body.slice(range.start, range.end);
  // Match against the whole body, so a reference that runs past the end of a capped range ("#12" + "3") is not cut short.
  let after = "";
  let at = range.start;
  for (const m of body.matchAll(new RegExp(DEP_REF_SOURCE, "g"))) {
    const from = m.index!;
    if (from < range.start || from + m[0].length > range.end || Number(m[1]) !== original) continue;
    after += body.slice(at, from) + refs(parts);
    at = from + m[0].length;
  }
  after += body.slice(at, range.end);
  if (after === before) return undefined;
  return { body: body.slice(0, range.start) + after + body.slice(range.end), before, after };
}

/** SHA-256 of the "Depends on" text, or undefined without one. A change outside the text does not change it. */
export function rangeHash(body: string): string | undefined {
  const range = dependencyRange(body);
  return range ? createHash("sha256").update(body.slice(range.start, range.end)).digest("hex") : undefined;
}

export interface DependantSource {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
}

export interface Dependant {
  issue: number;
  title: string;
  byHand: boolean;
  before?: string;
  after?: string;
}

/** The open issues that depend on the original, by number. `exclude` are the parts on GitHub: they are skipped. `shown` is what the rewrite writes for the original (a number as `#n`, a string as it is). */
export function findDependants(
  open: readonly DependantSource[],
  original: { number: number; title: string },
  exclude: readonly number[],
  shown: readonly (number | string)[] = exclude,
): Dependant[] {
  // The title given for the original wins over the one in the list: it is the live one.
  const all = open.filter((i) => i.number !== original.number).map(({ number, title, state }) => ({ number, title, state }));
  all.push({ number: original.number, title: original.title, state: undefined });
  const out: Dependant[] = [];
  for (const i of open) {
    if (i.number === original.number || exclude.includes(i.number)) continue;
    if (i.state && i.state.toLowerCase() !== "open") continue;
    const body = i.body ?? "";
    if (!dependencies(body, i.number, all).includes(original.number)) continue;
    const r = rewriteDependsOn(body, original.number, shown);
    out.push(r ? { issue: i.number, title: i.title, byHand: false, before: r.before, after: r.after } : { issue: i.number, title: i.title, byHand: true });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

/** The last line of a comment about a replaced issue. It holds a hash, never the ids. */
export const replaceMarker = (sessionId: string, issue: number): string =>
  `${BOT_MARKER} replaced=${createHash("sha256").update(`replaced\n${sessionId}\n${issue}`).digest("hex")} -->`;

export type DependantKind = "rewritten" | "byHand" | "check";

/** The comment on an issue that depends on the split issue. The last line is the marker. */
export function dependantComment(o: { kind: DependantKind; original: number; parts: readonly number[]; by: string; before?: string; after?: string; marker: string }): string {
  const lines = [`**Spaghetti Code Foundry:** #${o.original} was split into ${refs(o.parts)} by ${o.by}.`];
  if (o.kind === "rewritten") {
    const before = o.before ?? "";
    const after = o.after ?? "";
    const fence = fenceFor(before, after);
    lines.push('The "Depends on" text of this issue now names the parts.', "", "**Before**", `${fence}text`, before, fence, "", "**After**", `${fence}text`, after, fence);
  } else if (o.kind === "byHand") {
    lines.push(`This issue names #${o.original} by its title under "Depends on", so the text was not changed. Please change it by hand to name the parts.`);
  } else {
    lines.push('The "Depends on" text of this issue was changed in the meantime, so it was not rewritten. Please check that it names the parts.');
  }
  return [...lines, "", o.marker].join("\n");
}

/** The comment on the split issue itself. The last line is the marker. */
export function originalComment(o: { ending: "closes" | "staysOpen"; parts: readonly number[]; by: string; marker: string }): string {
  const lines = [`**Spaghetti Code Foundry:** This issue was split into ${refs(o.parts)} by ${o.by}. The work continues there.`];
  lines.push(o.ending === "closes" ? "This issue will be closed as not planned." : "This issue stays open.");
  return [...lines, "", o.marker].join("\n");
}
