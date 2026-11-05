import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findLocalRepo, findOwnedRepo } from "../auth/repos.js";
import { githubNameOf } from "../auth/repo-url.js";
import { dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import { type GhSession, withGhEnv } from "../github.js";
import { DEP_REF_SOURCE, DEPS_MARK, DEPS_MARK_END, dependencyRange } from "../queue/deps.js";
import { type RepoGhIdentity, repoGhIdentity } from "../queue/gh-identity.js";
import { listRepoWatchers } from "../repos/watchers.js";
import { GitHubStore } from "./github-store.js";
import { type Entry, GO_LABEL, scan, UNREADABLE_TITLE } from "./local-map.js";
import { LocalStore } from "./local-store.js";
import { STORIES_BRANCH } from "./story-commit.js";
import { type FileStory, GO_STATE } from "./story-file.js";
import { pidAlive } from "./story-lock.js";

// Moves the open stories of a connected local project into a GitHub repository the same owner has connected.
// Pass 1 creates the issues and saves each number and repository in the story file at once (the resume point).
// Pass 2 rewrites every moved body from the local text with the full number map, then (once per story) sets the build label,
// the closed state and the one combined comment. Every GitHub call goes through GitHubStore inside the target's own sign-in.

export const CONNECT_FIRST = "connect this repository to GitHub first";
/** First line of the combined comment: a move that stopped looks for it before it posts the comment again. */
export const MOVED_COMMENTS_MARKER = "<!-- scf-moved-comments -->";
/** GitHub takes at most 65,536 characters in a comment; a combined comment over this is never created. */
export const MAX_COMMENT_CHARS = 65_000;
const CALL_MS = 30_000;
const BUILD_LABEL_COLOR = "0e8a16";
const BUILD_LABEL_TEXT = "Ready to build";
const AUTH_RE = /\b401\b|bad credentials|authentication/i;

export class MoveError extends Error {
  constructor(message: string, readonly story?: number, readonly issue?: number) {
    super(message);
    this.name = "MoveError";
  }
}

export type MoveStatus = "create" | "already-moved" | "unreadable" | "too-large";
export interface PlanItem { number: number; title: string; state: string; status: MoveStatus; githubIssue?: number; reason?: string }
export interface MoveOptions {
  /** The `local:…` name of the connected local project. */
  local: string;
  /** The GitHub `owner/name` of the target, connected by the same owner. */
  target: string;
  /** The user id of the owner of both records. */
  owner: string;
  config: () => Config;
  dryRun?: boolean;
  includeClosed?: boolean;
  /** The build label for `go` stories. Default: the label of the target's first issues watcher, else `go`. */
  buildLabel?: string;
}
export interface MoveResult {
  target: string;
  dryRun: boolean;
  plan: PlanItem[];
  /** Stories made into issues in this run. */
  created: { story: number; issue: number }[];
  /** Stories whose issue is complete (labels, state and comment are set). */
  done: number[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---- links in the text -------------------------------------------------------------------------------------------------

/** The whole "Depends on" section: from after the header to the next heading or the end. `dependencyRange` stops at 1,000 characters; this does not. */
function sectionRange(body: string): { start: number; end: number } | undefined {
  const r = dependencyRange(body);
  if (!r) return undefined;
  const lines = body.slice(r.start).split("\n");
  let len = lines[0]!.length;
  for (const line of lines.slice(1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line)) break;
    len += 1 + line.length;
  }
  return { start: r.start, end: r.start + body.slice(r.start, r.start + len).trimEnd().length };
}

type Range = { start: number; end: number };

/** The pieces GitHub reads as dependencies: the whole "Depends on" section and the Foundry dependency markers (not epic lines). */
function dependencyRanges(body: string): Range[] {
  const found: Range[] = [];
  const section = sectionRange(body);
  if (section) found.push(section);
  for (let from = body.indexOf(DEPS_MARK); from >= 0; from = body.indexOf(DEPS_MARK, from + DEPS_MARK.length)) {
    const e = body.indexOf(DEPS_MARK_END, from + DEPS_MARK.length);
    if (e < 0) break;
    found.push({ start: from, end: e + DEPS_MARK_END.length });
  }
  return found;
}

/** The pieces where a `#N` is a link to another story: the dependency ranges and the `**Epic:**` lines. Overlapping pieces are merged. */
function linkRanges(body: string): Range[] {
  const found = dependencyRanges(body);
  for (const m of body.matchAll(/^\*\*Epic:\*\*.*$/gm)) found.push({ start: m.index, end: m.index + m[0].length });
  found.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of found) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

const refsIn = (text: string): number[] => [...text.matchAll(new RegExp(DEP_REF_SOURCE, "g"))].map((m) => Number(m[1]));

/** The body with the epic and the dependencies that are only in the front matter written into the text (with local numbers). */
export function withFrontMatterLinks(story: FileStory): string {
  let body = story.body;
  if (story.epic !== undefined && !/^\*\*Epic:\*\*/m.test(body)) body = `**Epic:** #${story.epic}${body ? `\n\n${body}` : ""}`;
  // Only dependency places count: an epic line is not a dependency, so `depends_on: [epic]` still gets its line.
  const have = new Set(dependencyRanges(body).flatMap((r) => refsIn(body.slice(r.start, r.end))));
  const missing = story.dependsOn.filter((n) => !have.has(n));
  if (!missing.length) return body;
  const lines = missing.map((n) => `- #${n}`).join("\n");
  const section = sectionRange(body);
  if (section) return `${body.slice(0, section.end)}\n${lines}${body.slice(section.end)}`;
  return `${body}${body ? "\n\n" : ""}## Depends on\n${lines}`;
}

/**
 * The text with every `#N` in a link place (see `linkRanges`) replaced by its GitHub number. A story that has no number (it was not
 * moved) becomes the plain note `local story N, not moved`: with no `#`, it is never read as a dependency on a GitHub issue.
 */
export function mapRefs(body: string, map: ReadonlyMap<number, number>): string {
  let out = "";
  let pos = 0;
  for (const r of linkRanges(body)) {
    const piece = body.slice(r.start, r.end).replace(new RegExp(DEP_REF_SOURCE, "g"), (_m, n: string) => {
      const to = map.get(Number(n));
      return to === undefined ? `local story ${n}, not moved` : `#${to}`;
    });
    out += body.slice(pos, r.start) + piece;
    pos = r.end;
  }
  return out + body.slice(pos);
}

const movedBody = (story: FileStory, map: ReadonlyMap<number, number>): string => mapRefs(withFrontMatterLinks(story), map);

// ---- comments and labels -----------------------------------------------------------------------------------------------

/**
 * All comments of the story as the text of one GitHub comment, or undefined without comments. Nothing is cut. Status markers are
 * removed and any other Foundry marker is made harmless, so the real classifiers never read the text as written by the Foundry.
 */
export function movedComments(story: FileStory): string | undefined {
  if (!story.comments.length) return undefined;
  const blocks = story.comments.map((c) => `### Comment by ${c.author} on ${c.createdAt}\n\n${c.body}`);
  const text = `${MOVED_COMMENTS_MARKER}\nComments moved from the local story:\n\n${blocks.join("\n\n")}`;
  return text.split("\n").filter((l) => !/^\s*<!--\s*(?:claude-factory|spaghetti-code-foundry) status\s*-->\s*$/.test(l)).join("\n")
    .replace(/<!-- claude-factory/g, "<!-- moved: claude-factory").replace(/<!-- spaghetti-code-foundry/g, "<!-- moved: spaghetti-code-foundry");
}

/** The labels of the issue: the file's labels without a literal `go`; the build label is added for a `go` story only when `withBuild`. */
export function issueLabels(story: FileStory, buildLabel: string, withBuild: boolean): string[] {
  const out: string[] = [];
  for (const l of [...story.labels.filter((x) => !same(x, GO_LABEL)), ...(withBuild && story.state === GO_STATE ? [buildLabel] : [])]) {
    if (!out.some((x) => same(x, l))) out.push(l);
  }
  return out;
}

// ---- the plan ----------------------------------------------------------------------------------------------------------

/** The open (`open`/`go`) stories, and the closed ones with `includeClosed`, each with what the move does with it. Broken files are always listed. */
export function planFrom(entries: readonly Entry[], includeClosed = false): PlanItem[] {
  const plan: PlanItem[] = [];
  for (const e of entries) {
    if (!e.ok) { plan.push({ number: e.n, title: UNREADABLE_TITLE, state: "unknown", status: "unreadable", reason: e.reason }); continue; }
    const s = e.story;
    if (s.state === "closed" && !includeClosed) continue;
    const item: PlanItem = { number: e.n, title: s.title, state: s.state, status: "create" };
    if (s.githubIssue !== undefined) { item.status = "already-moved"; item.githubIssue = s.githubIssue; }
    else if ((movedComments(s)?.length ?? 0) > MAX_COMMENT_CHARS) item.status = "too-large";
    plan.push(item);
  }
  return plan;
}

// ---- lock --------------------------------------------------------------------------------------------------------------

/** One move per local folder across processes: an exclusive lock file in the data folder, with the pid. A dead pid's file is taken over. */
export function moveLockFile(dir: string, kind = "move"): string {
  let real: string;
  try { real = realpathSync(dir); } catch { throw new MoveError("the folder of the local project cannot be read"); }
  return join(dataHome(), `${kind}-${createHash("sha256").update(real).digest("hex").slice(0, 32)}.lock`);
}
export function takeMoveLock(dir: string, kind = "move"): () => void {
  const file = moveLockFile(dir, kind);
  mkdirSync(dataHome(), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid = NaN;
    let ageMs = 0;
    try {
      pid = Number(readFileSync(file, "utf8").trim());
      ageMs = Date.now() - statSync(file).mtimeMs;
    } catch { continue; } // gone in the meantime
    const stale = Number.isSafeInteger(pid) && pid > 0 ? !pidAlive(pid) : ageMs > 10_000;
    if (!stale) throw new MoveError("a move of this project is already running");
    rmSync(file, { force: true });
  }
  throw new MoveError("a move of this project is already running");
}

// ---- the move ----------------------------------------------------------------------------------------------------------

/** Why the stories cannot be moved to `repo` (already moved elsewhere, or a number without its repository); undefined when they can. */
export function moveRefusal(entries: readonly Entry[], repo: string): string | undefined {
  const other = entries.find((e) => e.ok && e.story.githubRepo !== undefined && !same(e.story.githubRepo, repo));
  if (other?.ok) return `this project was already moved to ${other.story.githubRepo}`;
  // A number without its repository cannot be checked against the target, so it is refused before any GitHub write.
  const numberOnly = entries.find((e) => e.ok && e.story.githubIssue !== undefined && e.story.githubRepo === undefined);
  if (numberOnly?.ok) return `story #${numberOnly.n} has github_issue but no github_repo; add github_repo: ${repo} to its file if it was moved there, or remove github_issue`;
  return undefined;
}

const errorText = (e: unknown): string => {
  const o = e as { stderr?: unknown; message?: unknown } | undefined;
  return `${typeof o?.stderr === "string" ? o.stderr : ""}\n${typeof o?.message === "string" ? o.message : ""}`;
};

async function signIn(id: RepoGhIdentity): Promise<GhSession> {
  if (id.usesHostLogin()) throw new MoveError(CONNECT_FIRST);
  try {
    return await id.prepare();
  } catch (e) {
    throw new MoveError(`${CONNECT_FIRST} (${(e as Error).message})`);
  }
}

/** Plans (and with `dryRun: false` does) the move. A dry run changes nothing: no GitHub call except the sign-in preparation, no file. */
export async function moveToGithub(o: MoveOptions): Promise<MoveResult> {
  const local = findLocalRepo(o.local);
  if (!local || local.owner !== o.owner) throw new MoveError("this local project is not in My repositories");
  const rec = findOwnedRepo(o.owner, o.target);
  const repo = rec ? githubNameOf(rec.url) : undefined;
  if (!rec || !repo) throw new MoveError(CONNECT_FIRST);
  const dir = local.url;
  const release = takeMoveLock(dir);
  const id = repoGhIdentity(rec.id, { config: o.config });
  try {
    const entries = scan(dir);
    const refusal = moveRefusal(entries, repo);
    if (refusal) throw new MoveError(refusal);
    const plan = planFrom(entries, o.includeClosed);
    const session = await signIn(id);
    const result: MoveResult = { target: repo, dryRun: o.dryRun === true, plan, created: [], done: [] };
    if (o.dryRun) return result;
    const watcher = listRepoWatchers().filter((w) => w.repoId === rec.id && w.source === "issues").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    const build = o.buildLabel ?? watcher?.label ?? GO_LABEL;
    await withGhEnv(session, () => run({ dir, name: o.local, repo, build, plan, result, includeClosed: o.includeClosed === true }));
    return result;
  } catch (e) {
    if (!(e instanceof MoveError) && AUTH_RE.test(errorText(e))) throw new MoveError(CONNECT_FIRST, undefined, undefined);
    throw e;
  } finally {
    id.dispose();
    release();
  }
}

interface Run { dir: string; name: string; repo: string; build: string; plan: PlanItem[]; result: MoveResult; includeClosed: boolean }

const storyOf = (entries: readonly Entry[], n: number): FileStory | undefined => {
  const e = entries.find((x) => x.n === n);
  return e?.ok ? e.story : undefined;
};
const numberMap = (entries: readonly Entry[]): Map<number, number> => {
  const map = new Map<number, number>();
  for (const e of entries) if (e.ok && e.story.githubIssue !== undefined) map.set(e.n, e.story.githubIssue);
  return map;
};

async function run(r: Run): Promise<void> {
  const store = new GitHubStore(r.repo);
  const files = new LocalStore(r.dir, r.name, { branch: STORIES_BRANCH });
  const commented = new Set<number>();
  let labelReady = false;

  // Pass 1: the issues, lowest number first. The number is saved in the file before anything else happens to the issue.
  const map = numberMap(scan(r.dir));
  for (const item of r.plan.filter((p) => p.status === "create").sort((a, b) => a.number - b.number)) {
    const story = storyOf(scan(r.dir), item.number);
    if (!story || story.githubIssue !== undefined) continue;
    const made = await store.create({ title: story.title, body: movedBody(story, map), labels: issueLabels(story, r.build, false) }, CALL_MS);
    try {
      await files.setGithubIssue(item.number, made.number, r.repo, CALL_MS);
    } catch (e) {
      if (!(e instanceof Error) || e.name === "StoryCommitError") throw e; // saved, only the commit is missing: the next run commits it
      throw new MoveError(`story #${item.number} was created as issue #${made.number} on GitHub, but its number could not be saved: ${e.message}. Add github_issue: ${made.number} and github_repo: ${r.repo} to the story file before you move again`, item.number, made.number);
    }
    map.set(item.number, made.number);
    r.result.created.push({ story: item.number, issue: made.number });
    const text = movedComments(story);
    if (text !== undefined) {
      await store.comment(made.number, text, CALL_MS);
      commented.add(item.number);
    }
  }

  // Pass 2: every body from the local text with the full map; labels, state and comment once per story.
  const entries = scan(r.dir);
  const full = numberMap(entries);
  for (const item of r.plan.filter((p) => p.status === "create" || p.status === "already-moved").sort((a, b) => a.number - b.number)) {
    const story = storyOf(entries, item.number);
    const issue = story?.githubIssue;
    if (!story || issue === undefined) continue;
    await store.edit(issue, { body: movedBody(story, full) }, CALL_MS);
    if (story.githubDone) { r.result.done.push(item.number); continue; }
    await files.setGithubIssue(item.number, issue, r.repo, CALL_MS); // commits a file whose earlier commit failed
    if (story.state === GO_STATE) {
      if (!labelReady) { await store.createLabelIfMissing(r.build, BUILD_LABEL_COLOR, BUILD_LABEL_TEXT, CALL_MS); labelReady = true; }
      await store.setLabels(issue, r.build, [], CALL_MS);
    }
    if (story.state === "closed") await store.close(issue, "completed", CALL_MS);
    const text = movedComments(story);
    if (text !== undefined && !commented.has(item.number) && !(await store.comments(issue, CALL_MS)).some((c) => c.body.includes(MOVED_COMMENTS_MARKER))) {
      await store.comment(issue, text, CALL_MS);
    }
    await files.markGithubDone(item.number, CALL_MS);
    r.result.done.push(item.number);
  }
}
