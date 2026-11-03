import { parse, stringify } from "yaml";
import { isStatusComment, STATUS_MARKER } from "../github.js";
import type { StoryState } from "./store.js";

/**
 * A story as a file: `.scf/stories/<number>-<slug>.md`. Front matter (YAML), then the Markdown body,
 * then an optional final `## Comments` section. Pure functions only: no file, process or clock access.
 */
export type StoryKind = "story" | "epic";
export interface StoryComment { author: string; createdAt: string; body: string }
export interface FileStory {
  number: number; title: string; state: StoryState; kind: StoryKind;
  labels: string[]; epic?: number; dependsOn: number[];
  createdAt?: string; updatedAt?: string; closedAt?: string;
  body: string; comments: StoryComment[];
}
export type ParsedStoryFile = { ok: true; story: FileStory } | { ok: false; reason: string };

const COMMENTS_HEADING = "## Comments";
const HEADER_RE = /^### Comment by (.+) on (\S+)$/gm;
const ESCAPE_RE = /^\\*(## Comments$|### Comment by |\\cr:)/;
const UNESCAPE_RE = /^\\(\\*(?:## Comments$|### Comment by |\\cr:))/;
/** A line with a carriage return is written as `\cr:` plus the line with `\` and CR escaped; no CR reaches the file. */
const CR_LINE_RE = /^\\cr:/;
const SLUG_MAX = 50;

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function storyFileName(number: number, title: string): string {
  if (!isWhole(number)) throw new RangeError(`story number must be a positive whole number: ${number}`);
  const slug = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX).replace(/-+$/, "") || "story";
  return `${number}-${slug}.md`;
}

const encodeLine = (l: string): string => {
  if (!l.includes("\r")) return ESCAPE_RE.test(l) ? `\\${l}` : l;
  return `\\cr:${l.replace(/\\/g, "\\\\").replace(/\r/g, "\\r")}`;
};
const decodeLine = (l: string): string => {
  if (!CR_LINE_RE.test(l)) return l.replace(UNESCAPE_RE, "$1");
  return l.slice(4).replace(/\\([\\r])/g, (_, c: string) => (c === "r" ? "\r" : "\\"));
};
const escapeText = (t: string): string => t.split("\n").map(encodeLine).join("\n");
const unescapeText = (t: string): string => t.split("\n").map(decodeLine).join("\n");
/** Short text for a reason: a list or mapping is named, not printed (a mapping can carry its own toString). */
const show = (v: unknown): string => (typeof v === "object" && v !== null ? (Array.isArray(v) ? "a list" : "a mapping") : String(v));

/** Body and comment text are kept exactly: the formatter only adds fixed separators, which the parser removes again. */
export function formatStoryFile(story: FileStory): string {
  if (!story.title.trim()) throw new Error("the story title is empty");
  for (const c of story.comments) {
    if (!c.author || /[\r\n]/.test(c.author)) throw new Error("a comment author is empty or has a line break");
    if (!c.createdAt || /\s/.test(c.createdAt)) throw new Error("a comment time is empty or has white space");
  }
  const fm: Record<string, unknown> = { number: story.number, title: story.title, kind: story.kind, state: story.state, labels: story.labels };
  if (story.epic !== undefined) fm.epic = story.epic;
  fm.depends_on = story.dependsOn;
  if (story.createdAt !== undefined) fm.created = story.createdAt;
  if (story.updatedAt !== undefined) fm.updated = story.updatedAt;
  if (story.closedAt !== undefined) fm.closed = story.closedAt;
  let out = `---\n${stringify(fm, { lineWidth: 0 })}---\n\n${escapeText(story.body)}`;
  if (story.comments.length) {
    const blocks = story.comments.map((c) => `### Comment by ${c.author} on ${c.createdAt}\n\n${escapeText(c.body)}`);
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
  const state = has("state") ? f.state : undefined;
  if (state !== "open" && state !== "closed") return fail(`state is unknown: ${state === undefined ? "(none)" : show(state)} (use open or closed)`);
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
    const heads = [...commentsText.matchAll(HEADER_RE)];
    const first = heads[0]?.index ?? commentsText.length;
    if (!heads.length || commentsText.slice(0, first).trim() !== "") {
      return fail("the text after ## Comments must start with a comment heading (### Comment by <name> on <time>)");
    }
    heads.forEach((h, i) => {
      const last = i === heads.length - 1;
      let t = commentsText!.slice(h.index + h[0].length, heads[i + 1]?.index ?? commentsText!.length);
      t = t.startsWith("\n\n") ? t.slice(2) : t.startsWith("\n") ? t.slice(1) : t;
      if (!last) t = dropSeparator(t);
      comments.push({ author: h[1]!, createdAt: h[2]!, body: unescapeText(t) });
    });
  }

  const story: FileStory = { number, title: f.title, state, kind, labels: labels as string[], dependsOn: dependsOn as number[], body: unescapeText(bodyText), comments };
  if (has("epic")) story.epic = f.epic as number;
  if (has("created")) story.createdAt = f.created as string;
  if (has("updated")) story.updatedAt = f.updated as string;
  if (has("closed")) story.closedAt = f.closed as string;
  return { ok: true, story };
}

/** The story with its status comment replaced in place (or appended when it has none). The marker stays the last line. */
export function withStatusComment(story: FileStory, c: StoryComment): FileStory {
  const body = isStatusComment({ body: c.body }) ? c.body : `${c.body}\n\n${STATUS_MARKER}`;
  const next: StoryComment = { author: c.author, createdAt: c.createdAt, body };
  const comments = [...story.comments];
  let i = comments.length - 1;
  while (i >= 0 && !isStatusComment(comments[i]!)) i--;
  if (i >= 0) comments[i] = next;
  else comments.push(next);
  return { ...story, comments };
}
