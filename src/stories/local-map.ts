import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Comment, Issue, RestIssue } from "../github.js";
import { type FileStory, parseStoryFile, withCommentIds } from "./story-file.js";

export const STORIES_DIR = ".scf/stories";
export const UNREADABLE_TITLE = "cannot be read";
export const MAX_BYTES = 1024 * 1024;
const NAME_RE = /^(\d+)-.*\.md$/;

/** One story of the folder: readable, or broken (with the reason). */
export type Entry =
  | { ok: true; n: number; file: string; rel: string; mtimeMs: number; story: FileStory }
  | { ok: false; n: number; file: string; rel: string; mtimeMs: number; reason: string };

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Checks `.scf` and `.scf/stories` with lstat (a link or a file is refused). A missing folder is made when `create` is set. Returns false when it is missing. */
export function checkDirs(dir: string, create: boolean): boolean {
  for (const rel of [".scf", STORIES_DIR]) {
    const p = join(dir, rel);
    for (let tries = 0; ; tries++) {
      try {
        if (!lstatSync(p).isDirectory()) throw new Error(`${rel} is a link or not a folder`);
        break;
      } catch (e) {
        if (!isMissing(e)) throw e;
        if (!create) return false;
        if (tries > 0) throw e;
        try { mkdirSync(p); } catch (m) { if ((m as NodeJS.ErrnoException).code !== "EEXIST") throw m; }
      }
    }
  }
  return true;
}

/** The numbers (parsed from the file name prefix) with their file names. Other names are ignored. */
export function storyNames(folder: string): Map<number, string[]> {
  const byNumber = new Map<number, string[]>();
  for (const f of readdirSync(folder).sort()) {
    const m = NAME_RE.exec(f);
    const n = m ? Number(m[1]) : 0;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }
  return byNumber;
}

function readEntry(folder: string, n: number, files: string[]): Entry {
  const file = files[0]!;
  const rel = `${STORIES_DIR}/${file}`;
  const broken = (reason: string, mtimeMs = 0): Entry => ({ ok: false, n, file, rel, mtimeMs, reason });
  if (files.length > 1) return broken(`more than one file has number ${n}: ${files.join(", ")}`);
  const p = join(folder, file);
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return broken("the file is a link or not a plain file", st.mtimeMs);
    if (st.size > MAX_BYTES) return broken("the file is larger than 1 MiB", st.mtimeMs);
    const parsed = parseStoryFile(readFileSync(p, "utf8"), file);
    if (!parsed.ok) return broken(parsed.reason, st.mtimeMs);
    return { ok: true, n, file, rel, mtimeMs: st.mtimeMs, story: parsed.story };
  } catch (e) {
    return broken(`the file cannot be read: ${(e as Error).message}`);
  }
}

/** All stories, lowest number first. Reads the files again on every call. */
export function scan(dir: string): Entry[] {
  if (!checkDirs(dir, false)) return [];
  const folder = join(dir, STORIES_DIR);
  return [...storyNames(folder)].sort((a, b) => a[0] - b[0]).map(([n, files]) => readEntry(folder, n, files));
}

const iso = (ms: number): string => new Date(ms).toISOString();
const timeOr = (t: string | undefined, ms: number): string => (t !== undefined && !Number.isNaN(Date.parse(t)) ? t : iso(ms));

export function toRest(e: Entry): RestIssue {
  if (!e.ok) {
    return { number: e.n, state: "open", state_reason: null, title: UNREADABLE_TITLE, body: `${e.rel}: ${e.reason}`, labels: [], html_url: e.rel, created_at: iso(e.mtimeMs), updated_at: iso(e.mtimeMs), closed_at: null };
  }
  const s = e.story;
  return {
    number: e.n, state: s.state, state_reason: null, title: s.title, body: s.body, labels: s.labels.map((name) => ({ name })), html_url: e.rel,
    created_at: timeOr(s.createdAt, e.mtimeMs), updated_at: timeOr(s.updatedAt, e.mtimeMs), closed_at: s.closedAt ?? null,
  };
}

export function toIssue(e: Entry): Issue {
  const r = toRest(e);
  return { number: r.number, title: r.title, labels: r.labels as { name: string }[], body: r.body ?? "", state: r.state.toUpperCase(), createdAt: r.created_at, updatedAt: r.updated_at };
}

export function toComments(e: Entry & { ok: true }, author: string): Comment[] {
  return withCommentIds(e.story.comments, e.story.commentTop).map((c) => ({ author: { login: c.author }, body: c.body, createdAt: c.createdAt, url: `${e.rel}#issuecomment-${c.id}`, viewerDidAuthor: c.author === author }));
}

/** A comment as gh's `--json comments` has it. What a story file cannot know has a plain default. */
export interface ViewComment {
  id: string; author: { login: string }; authorAssociation: string; body: string; createdAt: string; includesCreatedEdit: boolean;
  isMinimized: boolean; minimizedReason: string; reactionGroups: unknown[]; url: string; viewerDidAuthor: boolean;
}
/** A story as gh's `issue view --json …` has it (all the fields the store can name). */
export interface StoryView {
  number: number; title: string; state: "OPEN" | "CLOSED"; body: string; url: string;
  labels: { id: string; name: string; description: string; color: string }[];
  comments: ViewComment[]; createdAt: string; updatedAt: string; closedAt: string | null;
}

/** The story as gh would show it. A broken file gets the placeholder of `toRest`, with no labels or comments. `author` is the viewer. */
export function toView(e: Entry, author: string): StoryView {
  const r = toRest(e);
  const comments: ViewComment[] = e.ok ? withCommentIds(e.story.comments, e.story.commentTop).map((c) => ({
    id: `IC_${e.n}_${c.id}`, author: { login: c.author }, authorAssociation: "NONE", body: c.body, createdAt: c.createdAt, includesCreatedEdit: false,
    isMinimized: false, minimizedReason: "", reactionGroups: [], url: `${e.rel}#issuecomment-${c.id}`, viewerDidAuthor: c.author === author,
  })) : [];
  return {
    number: r.number, title: r.title, state: r.state.toUpperCase() as "OPEN" | "CLOSED", body: r.body ?? "", url: r.html_url,
    labels: (r.labels as { name: string }[]).map(({ name }) => ({ id: "", name, description: "", color: "ededed" })),
    comments, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at, closedAt: r.closed_at ?? null,
  };
}

export const hasLabel = (e: Entry, label: string): boolean => e.ok && e.story.labels.some((l) => l.toLowerCase() === label.toLowerCase());
export const updatedMs = (e: Entry): number => Date.parse(toRest(e).updated_at ?? "") || e.mtimeMs;
