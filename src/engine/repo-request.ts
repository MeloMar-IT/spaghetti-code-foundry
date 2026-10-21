import { z } from "zod";
import type { ToolKind } from "../tool-profile/schema.js";

/**
 * The requests the repository broker accepts, and the rules about their words. Pure: no file, process or network.
 * A request never names a repository, URL or remote: the target is the run's own (see repo-broker.ts).
 */

export const REPO_OPERATIONS = ["clone", "fetch", "branch", "commit", "push", "pull-request", "status"] as const;
export type RepoOperation = (typeof REPO_OPERATIONS)[number];

/** What evidence can name: the operations, and "unknown" for a request that names none of them. */
export const REPO_EVIDENCE_OPERATIONS = [...REPO_OPERATIONS, "unknown"] as const;
export type RepoEvidenceOperation = (typeof REPO_EVIDENCE_OPERATIONS)[number];

/** Operations that touch no network, so never get a credential. */
export const LOCAL_OPERATIONS: readonly RepoOperation[] = ["branch", "commit", "status"];

export const REPO_REFUSALS = ["invalid-request", "no-target", "not-in-profile", "approval-required", "deploy-key", "no-credential", "unsafe-git-settings", "policy", "not-empty"] as const;
export type RepoRefusal = (typeof REPO_REFUSALS)[number];

export const REPO_OUTCOMES = ["done", "failed", "refused"] as const;

/** A branch name by the rules of `git check-ref-format --branch`, and one that evidence can hold (one line, no white space). */
export function validBranchName(name: string): boolean {
  if (typeof name !== "string" || name.length < 1 || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name) || /\s/.test(name) || /[~^:?*[\\]/.test(name)) return false;
  if (name === "@" || name === "HEAD") return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

const branch = z.string().refine(validBranchName, "must be a valid branch name");
const text = z.string().refine((s) => s.length >= 1 && s.length <= 5000 && !s.includes("\0"), "must be 1 to 5000 characters without NUL");
const title = z.string().refine((s) => s.length >= 1 && s.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(s), "must be 1 to 256 characters on one line");

export const RepoRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("clone") }).strict(),
  z.object({ op: z.literal("fetch"), branch: branch.optional() }).strict(),
  z.object({ op: z.literal("branch"), name: branch, from: branch.optional() }).strict(),
  z.object({ op: z.literal("commit"), message: text }).strict(),
  z.object({ op: z.literal("push"), branch }).strict(),
  z.object({ op: z.literal("pull-request"), head: branch, base: branch, title, body: text.optional(), draft: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("status") }).strict(),
]);
export type RepoRequest = z.infer<typeof RepoRequestSchema>;

/** The tool of the profile an operation is: `git.<op>`, or `github.pull-request.write` for a pull request. */
export function repoToolOf(op: RepoOperation): { kind: Extract<ToolKind, "git" | "github">; operation: string } {
  return op === "pull-request" ? { kind: "github", operation: "pull-request.write" } : { kind: "git", operation: op };
}

/** The repository-level git settings a workspace may have. Anything else could redirect git or read a token. */
const ALLOWED_KEYS: readonly string[] = [
  ...["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks"].map((k) => `core.${k}`),
  "remote.origin.url",
  "remote.origin.fetch",
  "user.name",
  "user.email",
];
const ALLOWED_BRANCH_KEY = /^branch\..+\.(remote|merge)$/;
export const ALLOWED_GIT_SETTINGS = ALLOWED_KEYS;

/** The keys of a `git config --list --null` listing (entries "key\nvalue" or "key", split by NUL) that are not allowed. */
export function unsafeGitSettings(listing: string): string[] {
  const bad: string[] = [];
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const key = entry.split("\n", 1)[0]!;
    if (!ALLOWED_KEYS.includes(key) && !ALLOWED_BRANCH_KEY.test(key) && !bad.includes(key)) bad.push(key);
  }
  return bad;
}

/** The last `max` UTF-8 bytes of the text, never splitting a character. 0 gives "". */
export function tailBytes(value: string, max: number): string {
  if (max <= 0) return "";
  if (Buffer.byteLength(value) <= max) return value;
  const chars = Array.from(value);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const n = Buffer.byteLength(chars[start - 1]!);
    if (bytes + n > max) break;
    bytes += n;
    start--;
  }
  return chars.slice(start).join("");
}
