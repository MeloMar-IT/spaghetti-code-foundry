/** "Depends on" / "Blocked by" in an issue body: which other issues must be done first. */

export interface DepIssue {
  number: number;
  title: string;
  state?: string;
  /** Why it was closed, as gh (NOT_PLANNED) or REST (not_planned) gives it. */
  stateReason?: string | null;
  labels?: { name: string }[];
}

/** Was it closed as "not planned"? Both spellings count; any other value, or none, does not. */
export function closedNotPlanned(reason: string | null | undefined): boolean {
  return /^not[\s_]?planned$/i.test(String(reason ?? "").trim());
}

const HEADER = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:depends[ \t]+on|blocked[ \t]+by)\b[*:\s]*(.*)$/im;

/** The text of the "Depends on" line or section (up to the next heading), or "". Exactly the piece of the body that dependencyRange names. */
export function dependencyText(body: string): string {
  const text = body ?? "";
  const r = dependencyRange(text);
  return r ? text.slice(r.start, r.end) : "";
}

/**
 * The source of the pattern for a "#12" reference: not part of a longer word or "owner/repo#12". A name that ends in "-" or
 * "." ("owner/lib-#12") is a cross reference too, so its "#12" is not a local one. A plain "#3-#8" still counts both.
 */
export const DEP_REF_SOURCE = "(?<![\\w/])(?<!\\/[A-Za-z0-9._-]{1,100}[-.])#(\\d+)\\b";

/**
 * The source of the pattern for an "owner/name#12" reference to an issue in another GitHub repository:
 * not part of a longer word, path or address ("github.com/owner/name#12" is not one).
 */
export const CROSS_REF_SOURCE = "(?<![\\w./-])([A-Za-z0-9][A-Za-z0-9-]{0,38}\\/[A-Za-z0-9._-]{1,100})#(\\d+)\\b";

/** An issue in another GitHub repository. */
export interface CrossRef {
  /** "owner/name", as written */
  repo: string;
  issue: number;
}

function crossRefsIn(text: string, out: Map<string, CrossRef>): void {
  for (const m of text.matchAll(new RegExp(CROSS_REF_SOURCE, "g"))) {
    const issue = Number(m[2]);
    if (!Number.isInteger(issue) || issue < 1 || issue > 2147483647) continue;
    const key = `${m[1]!.toLowerCase()}#${issue}`;
    if (!out.has(key)) out.set(key, { repo: m[1]!, issue });
  }
}

const byRef = (a: CrossRef, b: CrossRef) => {
  const x = a.repo.toLowerCase(), y = b.repo.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.issue - b.issue;
};

/**
 * Issues in other repositories this body depends on: "owner/name#12" in the person's "Depends on" text and
 * "- owner/name#12" lines in the Foundry's marked part (only those with `markedOnly`). Once per repository and
 * issue (any case), sorted.
 */
export function crossDependencies(body: string, o: { markedOnly?: boolean } = {}): CrossRef[] {
  const text = body ?? "";
  const out = new Map<string, CrossRef>();
  const r = foundryRange(text);
  if (r) crossRefsIn(text.slice(r.start, r.end), out);
  if (!o.markedOnly) crossRefsIn(dependencyText(withoutFoundryPart(text)), out);
  return [...out.values()].sort(byRef);
}

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

function renderPart(issues: readonly number[], reason: string, eol: string, cross: readonly CrossRef[] = []): string {
  const reasonLine = reason ? `_Added by the Spaghetti Code Foundry: ${reason}_` : "_Added by the Spaghetti Code Foundry._";
  return [DEPS_MARK, ...issues.map((n) => "- #" + n), ...cross.map((c) => `- ${c.repo}#${c.issue}`), reasonLine, DEPS_MARK_END].join(eol);
}

/** The "- owner/name#12" lines of the Foundry's part: the writers keep them. */
const markedCross = (body: string): CrossRef[] => crossDependencies(body, { markedOnly: true });

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

const crossKey = (c: CrossRef) => `${c.repo.toLowerCase()}#${c.issue}`;
const CROSS_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const validCross = (c: CrossRef) =>
  typeof c?.repo === "string" && CROSS_REPO.test(c.repo) && Number.isInteger(c.issue) && c.issue > 0 && c.issue <= 2147483647;

/**
 * Adds issues, and the "owner/name#12" references in `cross`, to the Foundry's part (made if missing). The text outside the
 * part is never changed. A cross reference already in the part (in any case) stays as it is written.
 */
export function mergeDependsOn(body: string, issues: readonly number[], reason: string, cross: readonly CrossRef[] = []): string {
  const b = body ?? "";
  const eol = eolOf(b);
  const add = issues.filter((n) => Number.isInteger(n) && n > 0);
  const all = [...new Set([...foundryDependsOn(b), ...add])].sort((x, y) => x - y);
  const byKey = new Map<string, CrossRef>();
  for (const c of [...markedCross(b), ...cross.filter(validCross)]) if (!byKey.has(crossKey(c))) byKey.set(crossKey(c), { repo: c.repo, issue: c.issue });
  const crossLines = [...byKey.values()].sort(byRef);
  if (!all.length && !crossLines.length) return b;
  const part = renderPart(all, cleanReason(reason), eol, crossLines);
  const r = foundryRange(b);
  if (r) return b.slice(0, r.start) + part + b.slice(r.end);
  const m = HEADER.exec(b);
  if (m) {
    const p = b.indexOf("\n", m.index);
    return p >= 0 ? b.slice(0, p + 1) + part + eol + b.slice(p + 1) : b + eol + part;
  }
  return b + eol + eol + "### Depends on" + eol + part;
}

/**
 * Takes issues out of the Foundry's part, and the "- owner/name#12" lines named in `cross` (in any case); the other cross
 * lines stay. When nothing is left, the part goes.
 */
export function removeFromDependsOn(body: string, issues: readonly number[], cross: readonly CrossRef[] = []): string {
  const r = foundryRange(body);
  if (!r) return body;
  const have = foundryDependsOn(body);
  const left = have.filter((n) => !issues.includes(n));
  const gone = new Set(cross.map(crossKey));
  const haveCross = markedCross(body);
  const leftCross = haveCross.filter((c) => !gone.has(crossKey(c)));
  if (left.length === have.length && leftCross.length === haveCross.length) return body;
  if (!left.length && !leftCross.length) return withoutFoundryPart(body);
  const oldReason = /^_Added by the Spaghetti Code Foundry(?:: (.*?))?_[ \t]*\r?$/m.exec(body.slice(r.start, r.end))?.[1] ?? "";
  return body.slice(0, r.start) + renderPart(left, cleanReason(oldReason), eolOf(body), leftCross) + body.slice(r.end);
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
    // "owner/name#12" is an issue of another repository, never a title
    const item = norm(raw.replace(/^\s*[-*+]\s*(\[[ x]\]\s*)?/i, "").replace(new RegExp(CROSS_REF_SOURCE, "g"), " ").replace(/#\d+/g, ""));
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

/** Is this dependency done: closed (but not as "not planned"), a done label, or (gitflow) the watcher's done label. An unknown issue counts as done. */
export function dependencyDone(issue: DepIssue | undefined, rule: DoneRule): boolean {
  if (!issue) return true; // unknown issue (other repo, typo): don't block on it
  if (issue.state && issue.state.toUpperCase() !== "OPEN") return !closedNotPlanned(issue.stateReason);
  return labelsDone((issue.labels ?? []).map((l) => l.name), rule);
}

/** Do these labels make an open issue done: a dependency done label, or (gitflow) the watcher's done label. */
export function labelsDone(names: readonly string[], rule: DoneRule): boolean {
  if (names.some((l) => rule.doneLabels.includes(l))) return true;
  return !!rule.gitflow && !!rule.doneLabel && names.includes(rule.doneLabel);
}

/** How an issue of another repository stands as a dependency. */
export type CrossState = "open" | "done" | "not_planned";

/**
 * An issue of another repository, as the REST API gives it. Closed as not planned is not done, also with a done label;
 * any other close is done; an open issue is done with a done label (`labelsDone`).
 */
export function crossState(i: { state?: string | null; state_reason?: string | null; labels?: ({ name?: string } | string)[] }, rule: DoneRule): CrossState {
  if (String(i.state ?? "").toLowerCase() === "closed") return i.state_reason === "not_planned" ? "not_planned" : "done";
  const names = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? ""));
  return labelsDone(names, rule) ? "done" : "open";
}

/** The dependencies that are known, closed issues (not as "not planned"): they count as done because they are closed. */
export function closedDependencies(deps: number[], all: DepIssue[]): number[] {
  return deps.filter((n) => {
    const issue = all.find((x) => x.number === n);
    return !!issue?.state && issue.state.toUpperCase() !== "OPEN" && !closedNotPlanned(issue.stateReason);
  });
}

/** Dependencies that are not done yet. A string list is the old form: { doneLabels }. */
export function openDependencies(deps: number[], all: DepIssue[], done: readonly string[] | DoneRule): number[] {
  const rule: DoneRule = Array.isArray(done) ? { doneLabels: done as readonly string[] } : (done as DoneRule);
  return deps.filter((n) => !dependencyDone(all.find((x) => x.number === n), rule));
}
