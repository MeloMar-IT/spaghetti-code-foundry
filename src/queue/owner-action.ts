import { isBot, isStatusComment, type Comment } from "../github.js";
import { redactText } from "../credentials/redact.js";
import { beforeDecided, countQuestions } from "../next-step.js";

/** The hidden mark of the comment the watcher writes when a file a question waited for is there. */
export const OWNER_FILE_MARK = "<!-- spaghetti-code-foundry owner-file -->";
export const ACTION_MAX = 200;
export const FILES_MAX = 5;

export type QuestionKind = "technical" | "product" | "policy" | "owner_action";
export interface OwnerAction { n: number; action: string; file?: string }
export interface OwnerAsk { actions: OwnerAction[]; questions: number; since?: string }

// These mirror tools/decide-questions.mjs readQuestions (a test keeps the kinds equal); src/ does not import from tools/.
const HEAD = /^\*\*Q(\d+)\.(.*)$/;
const KIND_MARK = /\*\*\s*kind\s*(?::\s*\*\*|\*\*\s*:?)/gi;
const NEEDS_LINE = /^\s*\*\*\s*needs\s*(?::\s*\*\*|\*\*\s*:?)\s*(.*)$/gim;
const KINDS: readonly string[] = ["technical", "product", "policy", "owner_action"];

/** Every question of the open part: number, title, kind (as tools/decide-questions.mjs reads it), the raw Needs value (undefined: none, or more than one). */
export function questionKinds(body: string): { n: number; title: string; kind: QuestionKind; needs?: string }[] {
  const lines = beforeDecided(String(body ?? "").replace(/\r\n?/g, "\n").split("\n").filter((l) => !l.startsWith("QUESTIONS: ")).join("\n")).split("\n");
  const blocks: { n: number; head: string; lines: string[] }[] = [];
  for (const line of lines) {
    const m = HEAD.exec(line.trimStart());
    if (m) blocks.push({ n: Number(m[1]), head: m[2]!, lines: [line] });
    else blocks.at(-1)?.lines.push(line);
  }
  return blocks.map((b) => {
    const after = b.lines.slice(1).join("\n");
    const mark = [...after.matchAll(KIND_MARK)][0];
    let kind: QuestionKind = "product";
    if (mark) {
      const value = after.slice(mark.index! + mark[0].length).split("\n")[0]!
        .toLowerCase().replace(/[`*]/g, "").trim().replace(/\.$/, "").replace(/[\s_-]+/g, "_");
      if (KINDS.includes(value)) kind = value as QuestionKind;
    }
    const needs = [...after.matchAll(NEEDS_LINE)];
    return { n: b.n, title: b.head.replace(/\*\*/g, "").trim(), kind, ...(needs.length === 1 ? { needs: needs[0]![1]!.trim() } : {}) };
  });
}

/** The path of a `file <path>` Needs value: in backticks (the path may end in a dot), or plain with a closing full stop removed. */
function needsFile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const quoted = /^file\s+`([^`]+)`\s*\.?$/i.exec(value);
  if (quoted) return safeRepoPath(quoted[1]!);
  const plain = /^file\s+(\S+)$/i.exec(value);
  return plain ? safeRepoPath(plain[1]!.replace(/\.$/, "")) : undefined;
}

/** The owner_action questions of a comment body (open part only). */
export function ownerActions(body: string): OwnerAction[] {
  return questionKinds(body).filter((q) => q.kind === "owner_action").map((q) => {
    const file = needsFile(q.needs);
    return { n: q.n, action: actionText(q.title), ...(file ? { file } : {}) };
  });
}

/** The newest Foundry comment that is not a status comment (or a file note), with no person after it, if it has owner_action questions. */
export function openOwnerActions(comments: readonly Comment[]): OwnerAsk | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (isStatusComment(c) || c.body.includes(OWNER_FILE_MARK)) continue;
    if (!isBot(c)) return undefined;
    const actions = ownerActions(c.body);
    return actions.length ? { actions, questions: countQuestions(c.body), ...(c.createdAt ? { since: c.createdAt } : {}) } : undefined;
  }
  return undefined;
}

/** The files to check: when every open question is owner_action with a valid file, and there are at most FILES_MAX of them; else []. */
export function filesToCheck(ask: OwnerAsk): string[] {
  const files = ask.actions.map((a) => a.file);
  if (ask.actions.length !== ask.questions || files.some((f) => !f)) return [];
  const unique = [...new Set(files as string[])];
  return unique.length > FILES_MAX ? [] : unique;
}

/** A safe repository path, or undefined. */
export function safeRepoPath(p: string): string | undefined {
  if (p.length < 1 || p.length > 300 || !/^[A-Za-z0-9._@+\-/]+$/.test(p)) return undefined;
  if (p.startsWith("/") || p.endsWith("/") || p.startsWith("-")) return undefined;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return undefined;
  if (segs[0] === ".git") return undefined;
  return p;
}

/** "repos/<repo>/contents/<seg>/<seg>[?ref=<branch>]", each part encoded. The repo is `owner/name`. */
export function contentsPath(repo: string, path: string, ref?: string): string {
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  return `repos/${repo}/contents/${enc(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}

/** The question title as one safe line: no secrets, no control characters, no `<` or `>` (so no hidden mark gets in), cut at ACTION_MAX. */
export function actionText(title: string): string {
  const t = redactText(title).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > ACTION_MAX ? `${t.slice(0, ACTION_MAX - 1).trimEnd()}…` : t;
}
