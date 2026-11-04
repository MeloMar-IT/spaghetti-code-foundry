import { parse, stringify } from "yaml";
import { isStatusComment, STATUS_MARKER } from "../github.js";

/**
 * A story as a file: `.scf/stories/<number>-<slug>.md`. Front matter (YAML), then the Markdown body,
 * then an optional final `## Comments` section. Pure functions only: no file, process or clock access.
 */
export type StoryKind = "story" | "epic";
/** `go` is an open story that is ready to build ("Yes, build this"). */
export const GO_STATE = "go";
export type FileStoryState = "open" | "go" | "closed";
/** `id` is the stable number of the comment (the one in `#issuecomment-<id>`); a file written by hand may have none. */
export interface StoryComment { id?: number; author: string; createdAt: string; body: string }
export interface FileStory {
  number: number; title: string; state: FileStoryState; kind: StoryKind;
  labels: string[]; epic?: number; dependsOn: number[];
  createdAt?: string; updatedAt?: string; closedAt?: string;
  /** The highest comment id the story has ever used (`comment_top`). A removed comment never gives its id back. */
  commentTop?: number;
  /** Set when the story was moved to GitHub: the issue number and the repository (`owner/name`) it is in. */
  githubIssue?: number; githubRepo?: string;
  /** True once the move finished everything for the issue (labels, state, comment). */
  githubDone?: boolean;
  body: string; comments: StoryComment[];
}
/** The GitHub repository name a story file may hold in `github_repo`. */
export const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export type ParsedStoryFile = { ok: true; story: FileStory } | { ok: false; reason: string };

const COMMENTS_HEADING = "## Comments";
/** The largest comment id: 15 digits, which the heading can hold. The parser, the formatter and the allocation all use this limit. */
export const MAX_COMMENT_ID = 999_999_999_999_999;
/**
 * The format a file is written in (`format` in the front matter). A file without `format` is format 1: the headings and the escapes
 * of the first version, where a body line `### Comment 7 by …` is plain text. Format 2 adds the comment id to the heading.
 */
export const STORY_FORMAT = 2;
interface Syntax { header: RegExp; escape: RegExp; unescape: RegExp }
/** Format 1: a comment heading has no id, so an id-like line in a body is text. The group for the id is empty. */
const SYNTAX: Record<number, Syntax> = {
  1: {
    header: /^### Comment ()by (.+) on (\S+)$/gm,
    escape: /^\\*(## Comments$|### Comment by |\\cr:)/,
    unescape: /^\\(\\*(?:## Comments$|### Comment by |\\cr:))/,
  },
  2: {
    header: /^### Comment (?:([1-9]\d{0,14}) )?by (.+) on (\S+)$/gm,
    escape: /^\\*(## Comments$|### Comment (?:\d+ )?by |\\cr:)/,
    unescape: /^\\(\\*(?:## Comments$|### Comment (?:\d+ )?by |\\cr:))/,
  },
};
/** A line with a carriage return is written as `\cr:` plus the line with `\` and CR escaped; no CR reaches the file. */
const CR_LINE_RE = /^\\cr:/;
const SLUG_MAX = 50;

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const isCommentId = (n: unknown): n is number => isWhole(n) && n <= MAX_COMMENT_ID;

/**
 * The comments with an id each: one with none, or with an id an earlier comment has, gets the next free id above the highest one used,
 * in file order. `floor` is the story's high-water mark: no new id is at or below it.
 */
export function withCommentIds(comments: StoryComment[], floor = 0): (StoryComment & { id: number })[] {
  const seen = new Set<number>();
  let top = floor;
  for (const c of comments) if (isCommentId(c.id) && !seen.has(c.id)) { seen.add(c.id); top = Math.max(top, c.id); }
  const used = new Set<number>();
  return comments.map((c) => {
    if (isCommentId(c.id) && !used.has(c.id)) { used.add(c.id); return c as StoryComment & { id: number }; }
    if (top >= MAX_COMMENT_ID) throw new Error("no comment id is left");
    top++;
    used.add(top);
    return { ...c, id: top };
  });
}

/** The highest comment id the story has used: its high-water mark or a comment id, whichever is higher. */
export function highestCommentId(s: Pick<FileStory, "comments" | "commentTop">): number {
  return Math.max(s.commentTop ?? 0, ...s.comments.map((c) => (isCommentId(c.id) ? c.id : 0)));
}

/** The id for a new comment: one above the highest used, the high-water mark included. Throws when there is none left. */
export function nextCommentId(comments: StoryComment[], floor = 0): number {
  const top = Math.max(floor, ...withCommentIds(comments, floor).map((c) => c.id));
  if (top >= MAX_COMMENT_ID) throw new Error("no comment id is left");
  return top + 1;
}

export function storyFileName(number: number, title: string): string {
  if (!isWhole(number)) throw new RangeError(`story number must be a positive whole number: ${number}`);
  const slug = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX).replace(/-+$/, "") || "story";
  return `${number}-${slug}.md`;
}

const encodeLine = (l: string): string => {
  if (!l.includes("\r")) return SYNTAX[STORY_FORMAT]!.escape.test(l) ? `\\${l}` : l;
  return `\\cr:${l.replace(/\\/g, "\\\\").replace(/\r/g, "\\r")}`;
};
const decodeLine = (l: string, syn: Syntax): string => {
  if (!CR_LINE_RE.test(l)) return l.replace(syn.unescape, "$1");
  return l.slice(4).replace(/\\([\\r])/g, (_, c: string) => (c === "r" ? "\r" : "\\"));
};
const escapeText = (t: string): string => t.split("\n").map(encodeLine).join("\n");
const unescapeText = (t: string, syn: Syntax): string => t.split("\n").map((l) => decodeLine(l, syn)).join("\n");
/** Short text for a reason: a list or mapping is named, not printed (a mapping can carry its own toString). */
const show = (v: unknown): string => (typeof v === "object" && v !== null ? (Array.isArray(v) ? "a list" : "a mapping") : String(v));

/** Body and comment text are kept exactly: the formatter only adds fixed separators, which the parser removes again. */
export function formatStoryFile(story: FileStory): string {
  if (!story.title.trim()) throw new Error("the story title is empty");
  for (const c of story.comments) {
    if (!c.author || /[\r\n]/.test(c.author)) throw new Error("a comment author is empty or has a line break");
    if (!c.createdAt || /\s/.test(c.createdAt)) throw new Error("a comment time is empty or has white space");
    if (c.id !== undefined && !isCommentId(c.id)) throw new Error(`a comment id must be a whole number from 1 to ${MAX_COMMENT_ID}`);
  }
  if (story.commentTop !== undefined && !(Number.isSafeInteger(story.commentTop) && story.commentTop >= 0 && story.commentTop <= MAX_COMMENT_ID)) {
    throw new Error(`the comment id high-water mark must be a whole number from 0 to ${MAX_COMMENT_ID}`);
  }
  const fm: Record<string, unknown> = { format: STORY_FORMAT, number: story.number, title: story.title, kind: story.kind, state: story.state, labels: story.labels };
  if (story.epic !== undefined) fm.epic = story.epic;
  fm.depends_on = story.dependsOn;
  if (story.createdAt !== undefined) fm.created = story.createdAt;
  if (story.updatedAt !== undefined) fm.updated = story.updatedAt;
  if (story.closedAt !== undefined) fm.closed = story.closedAt;
  if (story.commentTop !== undefined) fm.comment_top = story.commentTop;
  if (story.githubIssue !== undefined) fm.github_issue = story.githubIssue;
  if (story.githubRepo !== undefined) fm.github_repo = story.githubRepo;
  if (story.githubDone) fm.github_done = true;
  let out = `---\n${stringify(fm, { lineWidth: 0 })}---\n\n${escapeText(story.body)}`;
  if (story.comments.length) {
    const blocks = story.comments.map((c) => `### Comment ${c.id === undefined ? "" : `${c.id} `}by ${c.author} on ${c.createdAt}\n\n${escapeText(c.body)}`);
    out += `\n\n${COMMENTS_HEADING}\n\n${blocks.join("\n\n")}`;
  }
  return `${out}\n`;
}

const fail = (reason: string): ParsedStoryFile => ({ ok: false, reason });

/** Removes one separator: two line breaks if the text ends with them, else one. */
const dropSeparator = (t: string): string => (t.endsWith("\n\n") ? t.slice(0, -2) : t.endsWith("\n") ? t.slice(0, -1) : t);

export function parseStoryFile(text: string, fileName: string): ParsedStoryFile {
  const lines = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return fail("the file has no front matter: it must start with a line `---` and end it with another `---`");
  let fm: unknown;
  try {
    fm = parse(lines.slice(1, end).join("\n"));
  } catch (e) {
    return fail(`the front matter is broken: ${String((e as Error).message).split("\n")[0]}`);
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return fail("the front matter is not a list of fields");
  const f = fm as Record<string, unknown>;
  const has = (k: string) => f[k] !== undefined && f[k] !== null;

  if (!has("number")) return fail("number is missing");
  if (!isWhole(f.number)) return fail("number is not a whole number");
  const number = f.number;
  const m = /^(\d+)-/.exec(fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1));
  if (!m) return fail("the file name does not start with the story number");
  if (Number(m[1]) !== number) return fail(`the file name says ${Number(m[1])}, but number is ${number}`);

  if (!has("title") || f.title === "") return fail("title is missing");
  if (typeof f.title !== "string") return fail("title must be text");
  const format = has("format") ? f.format : 1;
  if (format !== 1 && format !== 2) return fail(`format is unknown: ${show(format)} (use 1 or 2)`);
  const syn = SYNTAX[format as number]!;
  const state = has("state") ? f.state : undefined;
  if (state !== "open" && state !== GO_STATE && state !== "closed") return fail(`state is unknown: ${state === undefined ? "(none)" : show(state)} (use open, go or closed)`);
  const kind = has("kind") ? f.kind : "story";
  if (kind !== "story" && kind !== "epic") return fail(`kind is unknown: ${show(kind)} (use story or epic)`);
  const labels = has("labels") ? f.labels : [];
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) return fail("labels must be a list of words");
  if (has("epic") && !isWhole(f.epic)) return fail("epic must be a story number");
  const dependsOn = has("depends_on") ? f.depends_on : [];
  if (!Array.isArray(dependsOn) || !dependsOn.every(isWhole)) return fail("depends_on must be a list of story numbers");
  for (const k of ["created", "updated", "closed"]) {
    if (has(k) && typeof f[k] !== "string") return fail(`${k} must be a time`);
  }
  if (has("github_issue") && !isWhole(f.github_issue)) return fail("github_issue must be an issue number");
  if (has("github_repo") && !(typeof f.github_repo === "string" && GITHUB_REPO_RE.test(f.github_repo))) return fail("github_repo must be a repository name (owner/name)");
  if (has("github_done") && f.github_done !== true) return fail("github_done must be true");
  const top = has("comment_top") ? f.comment_top : undefined;
  if (top !== undefined && !(typeof top === "number" && Number.isSafeInteger(top) && top >= 0 && top <= MAX_COMMENT_ID)) {
    return fail(`comment_top must be a whole number from 0 to ${MAX_COMMENT_ID}`);
  }

  // One blank line separates the front matter from the body; one line break ends the file.
  let rest = lines.slice(end + 1).join("\n");
  if (rest.endsWith("\n")) rest = rest.slice(0, -1);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  let bodyText = rest;
  let commentsText: string | undefined;
  let heading = -1;
  for (let pos = 0; pos <= rest.length; ) {
    const nl = rest.indexOf("\n", pos);
    const lineEnd = nl < 0 ? rest.length : nl;
    if (rest.slice(pos, lineEnd) === COMMENTS_HEADING) { heading = pos; break; }
    pos = lineEnd + 1;
  }
  if (heading >= 0) {
    bodyText = dropSeparator(rest.slice(0, heading));
    commentsText = rest.slice(heading + COMMENTS_HEADING.length + 1);
  }

  const comments: StoryComment[] = [];
  if (commentsText !== undefined) {
    const heads = [...commentsText.matchAll(syn.header)];
    const first = heads[0]?.index ?? commentsText.length;
    if (!heads.length || commentsText.slice(0, first).trim() !== "") {
      return fail("the text after ## Comments must start with a comment heading (### Comment by <name> on <time>)");
    }
    heads.forEach((h, i) => {
      const last = i === heads.length - 1;
      let t = commentsText!.slice(h.index + h[0].length, heads[i + 1]?.index ?? commentsText!.length);
      t = t.startsWith("\n\n") ? t.slice(2) : t.startsWith("\n") ? t.slice(1) : t;
      if (!last) t = dropSeparator(t);
      comments.push({ ...(h[1] ? { id: Number(h[1]) } : {}), author: h[2]!, createdAt: h[3]!, body: unescapeText(t, syn) });
    });
  }

  const story: FileStory = { number, title: f.title, state, kind, labels: labels as string[], dependsOn: dependsOn as number[], body: unescapeText(bodyText, syn), comments };
  if (has("epic")) story.epic = f.epic as number;
  if (has("created")) story.createdAt = f.created as string;
  if (has("updated")) story.updatedAt = f.updated as string;
  if (has("closed")) story.closedAt = f.closed as string;
  if (top !== undefined) story.commentTop = top as number;
  if (has("github_issue")) story.githubIssue = f.github_issue as number;
  if (has("github_repo")) story.githubRepo = f.github_repo as string;
  if (has("github_done")) story.githubDone = true;
  return { ok: true, story };
}

/** The story with its status comment replaced in place (or appended when it has none). The marker stays the last line. */
export function withStatusComment(story: FileStory, c: StoryComment): FileStory {
  const body = isStatusComment({ body: c.body }) ? c.body : `${c.body}\n\n${STATUS_MARKER}`;
  const comments = [...story.comments];
  let i = comments.length - 1;
  while (i >= 0 && !isStatusComment(comments[i]!)) i--;
  // The replaced comment keeps its id; an appended one gets the given id, or the next free one.
  if (i >= 0) {
    const kept = comments[i]!.id;
    comments[i] = { ...(kept !== undefined ? { id: kept } : {}), author: c.author, createdAt: c.createdAt, body };
  } else {
    comments.push({ id: c.id ?? nextCommentId(comments, story.commentTop), author: c.author, createdAt: c.createdAt, body });
  }
  return { ...story, comments, commentTop: highestCommentId({ comments, commentTop: story.commentTop }) };
}
