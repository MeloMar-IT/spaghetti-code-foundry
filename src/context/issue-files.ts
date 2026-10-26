/**
 * The strict reader for the issue files in the run folder: `issue.json` and `issue-comments.jsonl`, as `pull_ticket`
 * saves them. It gives back the issue part of a context task, so a later step can build the context bundle from the
 * raw files without calling `gh`. It only reads: it never follows a link, never waits for a pipe, and a failure is
 * never read as empty text.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ContextVersionSchema } from "./schema.js";
import type { ContextTask } from "./select.js";

export const ISSUE_FILE = "issue.json";
export const ISSUE_COMMENTS_FILE = "issue-comments.jsonl";
export const ISSUE_FILE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_COMMENTS = 10_000;

export type ReadIssueFilesResult =
  | { ok: { issue: NonNullable<ContextTask["issue"]>; leftComments: number } }
  | { failed: "issue-unreadable" | "comments-unreadable" };

const IssueFileSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z
    .string()
    .nullable()
    .transform((b) => b ?? ""),
  updatedAt: ContextVersionSchema,
});

/**
 * The whole content of a regular file of at most `max` bytes, or null on any error (missing, a link, a pipe, a
 * folder, no permission, too big, changed while reading, a failed close). A 0-byte file gives an empty Buffer.
 */
function readStrict(path: string, max: number): Buffer | null {
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > max) return null;
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) {
        const n = readSync(fd, buf, got, st.size - got, got);
        if (n === 0) return null;
        got += n;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) return null;
      return buf;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readIssueFiles(runDir: string, issue: number, retrievedAt: string, maxBytes = ISSUE_FILE_MAX_BYTES): ReadIssueFilesResult {
  const issueBytes = readStrict(join(runDir, ISSUE_FILE), maxBytes);
  if (!issueBytes) return { failed: "issue-unreadable" };
  let head: z.infer<typeof IssueFileSchema>;
  try {
    const parsed = IssueFileSchema.safeParse(JSON.parse(issueBytes.toString("utf8")));
    if (!parsed.success || parsed.data.number !== issue) return { failed: "issue-unreadable" };
    head = parsed.data;
  } catch {
    return { failed: "issue-unreadable" };
  }

  const commentBytes = readStrict(join(runDir, ISSUE_COMMENTS_FILE), maxBytes);
  if (!commentBytes) return { failed: "comments-unreadable" };
  const comments: NonNullable<ContextTask["issue"]>["comments"] = [];
  const seen = new Set<number>();
  let leftComments = 0;
  for (const line of commentBytes.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const c = parseObject(line);
    if (!c) return { failed: "comments-unreadable" };
    const id = c.id;
    const body = c.body ?? "";
    const version = ContextVersionSchema.safeParse(c.updated_at);
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !version.success ||
      typeof body !== "string" ||
      seen.has(id) ||
      comments.length >= MAX_COMMENTS
    ) {
      leftComments++;
      continue;
    }
    seen.add(id);
    comments.push({ id, text: body, version: version.data, retrievedAt });
  }
  return { ok: { issue: { number: issue, text: `${head.title}\n\n${head.body}`, version: head.updatedAt, retrievedAt, comments }, leftComments } };
}
