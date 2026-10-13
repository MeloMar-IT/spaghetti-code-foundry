import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";
import { currentGhSession, listAllIssues, type RestIssue } from "../github.js";
import { DEP_REF_SOURCE, dependencies, titleIndex, type DepIssue, type TitleIndex } from "./deps.js";

/**
 * A small record of every issue of a repository, one file per repository. It holds titles and label names, never an issue body.
 * Not to be confused with `issueRecord()` in src/issue-record.ts.
 */
export interface IssueRecord {
  number: number;
  title: string;
  state: "open" | "closed";
  stateReason?: string; // "completed" | "not_planned" | "reopened"
  labels: string[];
  createdAt: string;
  closedAt?: string;
  epic?: number; // **Epic:** #N
  parent?: number; // Parent: #N
  partOf?: number; // Part of #N / Part 2 of 4 of #N
  epicLabel?: { name: string; issue?: number };
  dependsOn: number[];
  stories?: number[]; // left out when empty
}
export interface RepoIssueList { repo: string; readAt: string; cut: boolean; issues: IssueRecord[] }
/** `saved`: the list of this read is in the file. It is false without `saveError` when nobody wanted the write or a newer read wrote first. */
export type FreshIssueList =
  | { ok: true; issues: RestIssue[]; cut: boolean; saved: boolean; saveError?: string }
  | { ok: false; error: string };
/** Built once per list: the issues, their normalised titles, and the lowest issue number per lower-cased title. */
export interface RecordContext { all: DepIssue[]; titles: TitleIndex; byTitle: Map<string, number> }

const MAX_NUMBER = 2147483647;

/** One file per repository, so two repositories (or two processes) never overwrite each other. */
export const issueListsDir = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "issue-lists");
const fileOf = (repo: string) => join(issueListsDir(), `${encodeURIComponent(repo)}.json`);

export function recordContext(all: DepIssue[]): RecordContext {
  const byTitle = new Map<string, number>();
  for (const i of all) {
    const t = i.title.trim().toLowerCase();
    const prev = byTitle.get(t);
    if (prev === undefined || i.number < prev) byTitle.set(t, i.number);
  }
  return { all, titles: titleIndex(all), byTitle };
}

/** The body without carriage returns and without the lines inside code fences (and the fence lines). */
function plainLines(body: string): string[] {
  const out: string[] = [];
  let open: string | undefined; // the opening fence: only a fence of the same character and at least that length closes it
  for (const line of body.replace(/\r/g, "").split("\n")) {
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === undefined) {
      if (m) { open = m[1]!; continue; }
      out.push(line);
    } else if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && !m[2]!.trim()) {
      open = undefined;
    }
  }
  return out;
}

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]/;
const BOLD_LINE = /^[ \t]*\*\*[^*]+\*\*:?[ \t]*$/;
const STORIES_HEAD = /^[ \t]{0,3}(?:#{1,6}[ \t]+(?:user[ \t]+)?stories[ \t]*:?|\*\*(?:user[ \t]+)?stories:?\*\*:?)[ \t]*$/i;

function storiesOf(lines: string[], valid: (n: number) => boolean): number[] {
  const found = new Set<number>();
  const add = (text: string) => { for (const m of text.matchAll(new RegExp(DEP_REF_SOURCE, "g"))) if (valid(Number(m[1]))) found.add(Number(m[1])); };
  const start = lines.findIndex((l) => STORIES_HEAD.test(l));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (HEADING.test(line) || BOLD_LINE.test(line)) break;
      if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]/.test(line)) add(line);
    }
  } else {
    for (const line of lines) {
      const m = /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+(#\d+\b.*)$/.exec(line);
      if (m) add(m[1]!.slice(0, m[1]!.search(/\s|$/)));
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function toRecord(issue: RestIssue, ctx: RecordContext): IssueRecord {
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER && n !== issue.number;
  const lines = plainLines(issue.body ?? "");
  const text = lines.join("\n");
  const pick = (re: RegExp): number | undefined => {
    const m = re.exec(text);
    return m && valid(Number(m[1])) ? Number(m[1]) : undefined;
  };
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
  const r: IssueRecord = { number: issue.number, title: issue.title, state: issue.state === "closed" ? "closed" : "open", labels, createdAt: issue.created_at, dependsOn: [] };
  if (issue.state_reason) r.stateReason = issue.state_reason;
  if (issue.closed_at) r.closedAt = issue.closed_at;
  const epic = pick(/^\*\*Epic:\*\* #([1-9]\d*)\s*$/m);
  if (epic !== undefined) r.epic = epic;
  const parent = pick(/^[ \t]*(?:\*\*)?Parent:(?:\*\*)?[ \t]*#([1-9]\d*)\b/im);
  if (parent !== undefined) r.parent = parent;
  const partOf = pick(/^[ \t]*Part(?:[ \t]+\d+[ \t]+of[ \t]+\d+)?[ \t]+of[ \t]+#([1-9]\d*)\b/im);
  if (partOf !== undefined) r.partOf = partOf;
  for (const l of labels) {
    const m = /^epic:\s*(.+)$/i.exec(l);
    if (!m) continue;
    const t = m[1]!.trim();
    const num = /^#?([1-9]\d*)$/.exec(t);
    if (num) {
      const n = Number(num[1]);
      r.epicLabel = valid(n) ? { name: String(n), issue: n } : { name: String(n) };
    } else {
      const n = ctx.byTitle.get(t.toLowerCase());
      r.epicLabel = n !== undefined && n !== issue.number ? { name: t, issue: n } : { name: t };
    }
    break;
  }
  r.dependsOn = dependencies(issue.body ?? "", issue.number, ctx.all, ctx.titles).filter(valid);
  const stories = storiesOf(lines, valid);
  if (stories.length) r.stories = stories;
  return r;
}

const isTime = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isNumber = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_NUMBER;
const isNumbers = (v: unknown) => Array.isArray(v) && v.every(isNumber);
const absent = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);

function validRecord(v: unknown): boolean {
  const i = v as Record<string, unknown> | null;
  if (!i || typeof i !== "object" || Array.isArray(i)) return false;
  const label = i.epicLabel as Record<string, unknown> | null | undefined;
  return isNumber(i.number) && typeof i.title === "string" && (i.state === "open" || i.state === "closed") &&
    Array.isArray(i.labels) && i.labels.every((l) => typeof l === "string") && isTime(i.createdAt) && isNumbers(i.dependsOn) &&
    absent(i.stateReason, (x) => typeof x === "string") && absent(i.closedAt, isTime) &&
    absent(i.epic, isNumber) && absent(i.parent, isNumber) && absent(i.partOf, isNumber) && absent(i.stories, isNumbers) &&
    absent(label, (x) => !!x && typeof x === "object" && !Array.isArray(x) && typeof label!.name === "string" && absent(label!.issue, isNumber));
}

function parse(text: string): RepoIssueList | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown> | null;
    if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
    if (typeof j.repo !== "string" || !j.repo || !isTime(j.readAt) || typeof j.cut !== "boolean") return undefined;
    if (!Array.isArray(j.issues) || !j.issues.every(validRecord)) return undefined;
    return j as unknown as RepoIssueList;
  } catch {
    return undefined;
  }
}

/** Written to a temporary file and renamed, so a reader never sees half a file. */
export function saveIssueList(repo: string, records: IssueRecord[], at: Date, cut: boolean): void {
  const file = fileOf(repo);
  mkdirSync(issueListsDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ repo, readAt: at.toISOString(), cut, issues: records } satisfies RepoIssueList));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** What is stored for a repository; undefined when there is no (valid) file. */
export function readIssueList(repo: string): RepoIssueList | undefined {
  let text: string;
  try {
    text = readFileSync(fileOf(repo), "utf8");
  } catch {
    return undefined;
  }
  const v = parse(text);
  return v && v.repo === repo ? v : undefined;
}

/** The repositories that have a file. */
export function storedIssueListRepos(): string[] {
  try {
    return readdirSync(issueListsDir()).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try { return [decodeURIComponent(f.slice(0, -".json".length))]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

interface Entry {
  order: number;
  startedAt: number;
  gen: number;
  wanted: (() => boolean)[];
  done: boolean;
  promise: Promise<void>;
  issues?: RestIssue[];
  records?: IssueRecord[];
  readAt?: Date;
  cut?: boolean;
  error?: string;
  saved: boolean;
  saveError?: string;
}

/** Repository → sign-in → the read in flight or the last finished one. The sign-in is a key in memory only. */
const reads = new Map<string, Map<string, Entry>>();
const gens = new Map<string, number>();
/** Per repository: the order number of the read whose list is in the file. */
const savedOrder = new Map<string, number>();
let order = 0;

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.trim() || "unknown error";
const genOf = (repo: string) => gens.get(repo) ?? 0;
const bump = (repo: string) => gens.set(repo, genOf(repo) + 1);
const isWanted = (w: () => boolean) => { try { return w(); } catch { return false; } };

/** Saves the list of a finished read when it is still wanted, still current and not older than what is in the file. */
function saveStep(repo: string, e: Entry): void {
  if (e.saved || e.saveError || e.gen !== genOf(repo) || e.order < (savedOrder.get(repo) ?? 0) || !e.wanted.some(isWanted)) return;
  try {
    saveIssueList(repo, e.records!, e.readAt!, e.cut!);
    e.saved = true;
    savedOrder.set(repo, e.order);
  } catch (err) {
    e.saveError = firstLine(err);
  }
}

async function runRead(repo: string, who: string, e: Entry, o: { pages?: number; timeoutMs?: number }): Promise<void> {
  try {
    const r = await listAllIssues(repo, { pages: o.pages ?? 20, timeoutMs: o.timeoutMs ?? 30_000 });
    const ctx = recordContext(r.issues.map((i) => ({
      number: i.number, title: i.title, state: i.state, labels: (i.labels ?? []).map((l) => ({ name: typeof l === "string" ? l : l.name ?? "" })),
    })));
    e.records = r.issues.map((i) => toRecord(i, ctx));
    e.issues = r.issues;
    e.cut = r.cut;
    e.readAt = new Date();
    e.done = true;
    saveStep(repo, e);
  } catch (err) {
    e.error = firstLine(err);
    e.done = true;
    const m = reads.get(repo);
    if (m?.get(who) === e) m.delete(who);
  }
}

/**
 * Reads the whole issue list of a repository and saves it, sharing one read between callers with the same sign-in.
 * A caller joins a read that started at or after `since` (the start of its check). `wanted` says whether the caller still
 * wants the file written when the read ends. Never rejects.
 */
export function freshIssueList(repo: string, o: { since: number; wanted?: () => boolean; pages?: number; timeoutMs?: number }): Promise<FreshIssueList> {
  const who = currentGhSession()?.stamp ?? "host";
  const wanted = o.wanted ?? (() => true);
  const gen = genOf(repo);
  const have = reads.get(repo)?.get(who);
  let e: Entry;
  if (have && have.gen === gen && have.startedAt >= o.since) {
    e = have;
    e.wanted.push(wanted);
    if (e.done) saveStep(repo, e);
  } else {
    const byWho = reads.get(repo) ?? new Map<string, Entry>();
    reads.set(repo, byWho);
    for (const [k, v] of byWho) if (v.done) byWho.delete(k);
    e = { order: ++order, startedAt: Date.now(), gen, wanted: [wanted], done: false, promise: Promise.resolve(), saved: false };
    byWho.set(who, e);
    e.promise = runRead(repo, who, e, o);
  }
  const entry = e;
  return entry.promise.then((): FreshIssueList =>
    entry.error !== undefined
      ? { ok: false, error: entry.error }
      : { ok: true, issues: entry.issues!, cut: entry.cut!, saved: entry.saved, ...(entry.saveError ? { saveError: entry.saveError } : {}) });
}

/** Forgets the reads of a repository and removes its file; a read in flight will not write it. */
export function dropIssueList(repo: string): void {
  bump(repo);
  reads.delete(repo);
  savedOrder.delete(repo);
  rmSync(fileOf(repo), { force: true });
}

/** For tests: forgets every read (also one in flight), so a test never joins the read of the test before it. */
export function resetIssueListReads(): void {
  for (const repo of reads.keys()) bump(repo);
  reads.clear();
  savedOrder.clear();
}
