/** "Depends on" / "Blocked by" in an issue body: which other issues must be done first. */

export interface DepIssue {
  number: number;
  title: string;
  state?: string;
  labels?: { name: string }[];
}

const HEADER = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:depends[ \t]+on|blocked[ \t]+by)\b[*:\s]*(.*)$/im;

/** The text of the "Depends on" line or section (up to the next heading), or "". Exactly the piece of the body that dependencyRange names. */
export function dependencyText(body: string): string {
  const text = body ?? "";
  const r = dependencyRange(text);
  return r ? text.slice(r.start, r.end) : "";
}

/** The source of the pattern for a "#12" reference: not part of a longer word or "owner/repo#12". */
export const DEP_REF_SOURCE = "(?<![\\w/])#(\\d+)\\b";

/** Where the "Depends on" text is in the body (what dependencyText gives), or undefined without a header. At most 1000 characters. */
export function dependencyRange(body: string): { start: number; end: number } | undefined {
  const text = body ?? "";
  const m = HEADER.exec(text);
  if (!m) return undefined;
  const headEnd = m.index + m[0].length;
  const first = headEnd - (m[1] ?? "").length;
  const rest = text.slice(headEnd).split("\n");
  let pos = headEnd + rest[0]!.length;
  for (const line of rest.slice(1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line)) break;
    pos += 1 + line.length;
  }
  const raw = text.slice(first, pos);
  const start = first + (raw.length - raw.trimStart().length);
  const full = first + raw.trimEnd().length;
  return { start, end: Math.max(start, Math.min(full, start + 1000)) };
}

const norm =(s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The normalised titles of a list, as dependencies() uses them. A snapshot: build a new one when the list changes. */
export type TitleIndex = readonly { n: number; t: string }[];
export function titleIndex(all: readonly DepIssue[]): TitleIndex {
  return all.map((i) => ({ n: i.number, t: norm(i.title) })).filter((i) => i.t.length >= 3);
}

/** Start and end of the part the Foundry keeps in the "Depends on" section. */
export const DEPS_MARK = "<!-- claude-factory depends-on -->";
export const DEPS_MARK_END = "<!-- claude-factory depends-on end -->";

const eolOf = (body: string) => (body.includes("\r\n") ? "\r\n" : "\n");

/** Where the Foundry's part is (markers included), or undefined. The start marker nearest the end marker wins. */
function foundryRange(body: string): { start: number; end: number } | undefined {
  const s0 = body.indexOf(DEPS_MARK);
  if (s0 < 0) return undefined;
  const e = body.indexOf(DEPS_MARK_END, s0 + DEPS_MARK.length);
  if (e < 0) return undefined;
  return { start: body.lastIndexOf(DEPS_MARK, e), end: e + DEPS_MARK_END.length };
}

function renderPart(issues: readonly number[], reason: string, eol: string): string {
  const reasonLine = reason ? `_Added by the Spaghetti Code Foundry: ${reason}_` : "_Added by the Spaghetti Code Foundry._";
  return [DEPS_MARK, ...issues.map((n) => "- #" + n), reasonLine, DEPS_MARK_END].join(eol);
}

/** The issues in the Foundry's marked part, sorted, no length limit. */
export function foundryDependsOn(body: string): number[] {
  const text = body ?? "";
  const r = foundryRange(text);
  if (!r) return [];
  const found = new Set<number>();
  for (const m of text.slice(r.start, r.end).matchAll(new RegExp(DEP_REF_SOURCE, "g"))) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * The body without the Foundry's part (and the line end after it). When the part ends the body and
 * the line before it is a "Depends on" header, the line end that mergeDependsOn added after the header goes too.
 * Any other line end before the part is the person's and stays.
 */
export function withoutFoundryPart(body: string): string {
  const text = body ?? "";
  const r = foundryRange(text);
  if (!r) return text;
  const after = text.slice(r.end);
  const rest = after.startsWith("\r\n") ? after.slice(2) : after.startsWith("\n") ? after.slice(1) : after;
  let before = text.slice(0, r.start);
  if (after === "") {
    const cut = before.endsWith("\r\n") ? 2 : before.endsWith("\n") ? 1 : 0;
    const head = before.slice(0, before.length - cut);
    if (cut && HEADER.test(head.slice(head.lastIndexOf("\n") + 1))) before = head;
  }
  return before + rest;
}

/** A reason that is safe in one line inside the part: no < or >, no #N, at most 200 characters. */
export function cleanReason(text: string): string {
  return (text ?? "")
    .replace(/[<>]/g, "")
    .replace(/#(\d+)/g, "issue $1")
    .replace(/\s+/g, " ").trim()
    .slice(0, 200).trimEnd();
}

/** Adds issues to the Foundry's part (made if missing). The text outside the part is never changed. */
export function mergeDependsOn(body: string, issues: readonly number[], reason: string): string {
  const b = body ?? "";
  const eol = eolOf(b);
  const add = issues.filter((n) => Number.isInteger(n) && n > 0);
  const all = [...new Set([...foundryDependsOn(b), ...add])].sort((x, y) => x - y);
  if (!all.length) return b;
  const part = renderPart(all, cleanReason(reason), eol);
  const r = foundryRange(b);
  if (r) return b.slice(0, r.start) + part + b.slice(r.end);
  const m = HEADER.exec(b);
  if (m) {
    const p = b.indexOf("\n", m.index);
    return p >= 0 ? b.slice(0, p + 1) + part + eol + b.slice(p + 1) : b + eol + part;
  }
  return b + eol + eol + "### Depends on" + eol + part;
}

/** Takes issues out of the Foundry's part. When none are left, the part goes. */
export function removeFromDependsOn(body: string, issues: readonly number[]): string {
  const r = foundryRange(body);
  if (!r) return body;
  const have = foundryDependsOn(body);
  const left = have.filter((n) => !issues.includes(n));
  if (left.length === have.length) return body;
  if (!left.length) return withoutFoundryPart(body);
  const oldReason = /^_Added by the Spaghetti Code Foundry(?:: (.*?))?_[ \t]*\r?$/m.exec(body.slice(r.start, r.end))?.[1] ?? "";
  return body.slice(0, r.start) + renderPart(left, cleanReason(oldReason), eolOf(body)) + body.slice(r.end);
}

/** Issue numbers this body depends on: "#12" references, items matching another issue's title, and the issues in the Foundry's marked part (no length limit). */
export function dependencies(body: string, self: number, all: DepIssue[], titleList?: TitleIndex): number[] {
  const found = new Set<number>(foundryDependsOn(body));
  const text = dependencyText(withoutFoundryPart(body));
  if (text) addPersonsDependencies(text, self, all, titleList, found);
  found.delete(self);
  return [...found].sort((a, b) => a - b);
}

/** The person's text: "#12" references, and items matching another issue's title. */
function addPersonsDependencies(text: string, self: number, all: DepIssue[], titleList: TitleIndex | undefined, found: Set<number>): void {
  for (const m of text.matchAll(new RegExp(DEP_REF_SOURCE, "g"))) found.add(Number(m[1]));
  const titles = titleList ?? titleIndex(all);
  const selfTitle = ` ${norm(all.find((i) => i.number === self)?.title ?? "")} `;
  for (const raw of text.split(/[;\n]/)) {
    const item = norm(raw.replace(/^\s*[-*+]\s*(\[[ x]\]\s*)?/i, "").replace(/#\d+/g, ""));
    if (item.length < 3 || /^(none|n a|nothing|no)$/.test(item)) continue;
    // Best: the title starts with the text (or the other way round). Else: the text appears in a
    // title as whole words — e.g. "Story 7 — Daily check" in "Website Story 7 — Daily check …".
    let hits = titles.filter(({ t }) => item === t || item.startsWith(t + " ") || t.startsWith(item + " "));
    if (!hits.length && item.split(" ").length >= 2) hits = titles.filter(({ t }) => ` ${t} `.includes(` ${item} `));
    // Last resort: the same numbered story in this issue's own epic — "Story 6 — …(reworded)" from
    // "Website Story 5" means "Website Story 6".
    const key = /^([a-z]+ \d+[a-z]?)\b/.exec(item)?.[1];
    if (!hits.length && key && selfTitle.includes(` ${key.split(" ")[0]} `)) {
      const family = selfTitle.slice(0, selfTitle.indexOf(` ${key.split(" ")[0]} `)).trim();
      hits = titles.filter(({ t }) => t.startsWith(`${family ? `${family} ` : ""}${key} `));
    }
    for (const { n } of hits) found.add(n);
  }
}

/** When a "Depends on" issue counts as done. */
export interface DoneRule {
  /** dependency_done_labels of the watcher */
  doneLabels: readonly string[];
  /** the watcher's done label; counts only with gitflow */
  doneLabel?: string;
  /** the flow merges into a develop branch (develop_branch set): the done label is a completion signal there */
  gitflow?: boolean;
}

/** Is this dependency done: closed, a done label, or (gitflow) the watcher's done label. An unknown issue counts as done. */
export function dependencyDone(issue: DepIssue | undefined, rule: DoneRule): boolean {
  if (!issue) return true; // unknown issue (other repo, typo): don't block on it
  if (issue.state && issue.state.toUpperCase() !== "OPEN") return true;
  const names = (issue.labels ?? []).map((l) => l.name);
  if (names.some((l) => rule.doneLabels.includes(l))) return true;
  return !!rule.gitflow && !!rule.doneLabel && names.includes(rule.doneLabel);
}

/** Dependencies that are not done yet. A string list is the old form: { doneLabels }. */
export function openDependencies(deps: number[], all: DepIssue[], done: readonly string[] | DoneRule): number[] {
  const rule: DoneRule = Array.isArray(done) ? { doneLabels: done as readonly string[] } : (done as DoneRule);
  return deps.filter((n) => !dependencyDone(all.find((x) => x.number === n), rule));
}
