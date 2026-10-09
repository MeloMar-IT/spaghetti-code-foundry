import { z } from "zod";
import { githubKey, validGithubName } from "../auth/repo-url.js";
import type { RepoProfile } from "./repo-profile.js";
import { SkillRequestSchema, type SkillRequest } from "./request.js";
import { projectEvidence, safeEvidence, safeText, sha256Of } from "./run-lock.js";
import { SKILL_DIGEST_RE, SkillIdSchema } from "./schema.js";

// The rules of the plan record: what a record holds, how it is paired with the plan comment, what changed since.
// Pure. The rules for the plan comments mirror tools/plan-comment — keep the two the same
// (tests/skill-plan-record.test.ts checks it).

export const PLAN_RECORD_VERSION = 1;
export const MAX_PLAN_RECORD_BYTES = 64 * 1024;
export const PLAN_RECORD_KEEP = 20;
export const PLAN_COMMENTS_MARKER = "PLAN_COMMENTS: ";
export const PLAN_COMMENTS_MAX = 30;

const iso = z.iso.datetime({ offset: true });
const digest = z.string().regex(SKILL_DIGEST_RE);
/** The id in a comment link, as `commentId` (src/github.ts) reads it. */
const commentIdSchema = z.string().regex(/^\d{1,30}$/);

/** Compares two comment IDs as numbers (they can be longer than a safe integer). */
export function compareCommentIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The hash of a comment body: line ends and white space around it do not count (as `sameBody`, src/github.ts). */
export const planBodyHashOf = (body: string): string => sha256Of(body.replace(/\r\n/g, "\n").trim());

export interface PlanRecordKey {
  owner: string;
  name: string;
  issue: string;
}

/** The folder key of a repository and an issue; undefined when either is not valid. Case and a final ".git" do not count. */
export function planRecordKey(repo: string, issue: string): PlanRecordKey | undefined {
  if (!validGithubName(repo) || !/^\d{1,9}$/.test(issue)) return undefined;
  const n = Number(issue);
  if (n < 1) return undefined;
  const parts = githubKey(repo).slice("github.com/".length).split("/");
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts as [string, string];
  if (!owner || !name || name === "." || name === "..") return undefined;
  return { owner, name, issue: String(n) };
}

export const sameKey = (a: PlanRecordKey | undefined, b: PlanRecordKey | undefined): boolean =>
  a !== undefined && b !== undefined && a.owner === b.owner && a.name === b.name && a.issue === b.issue;

const request = SkillRequestSchema.superRefine((r, ctx) => {
  r.skills.forEach((s, i) => {
    if (!safeText(s.reason)) ctx.addIssue({ code: "custom", path: ["skills", i, "reason"], message: "is not safe to store" });
    s.evidence.forEach((e, j) => {
      if (!safeEvidence(e)) ctx.addIssue({ code: "custom", path: ["skills", i, "evidence", j], message: "is not safe to store" });
    });
  });
});

/** The skill request of a plan as the Foundry's own record. No host paths, secrets or issue text. */
export const PlanRecordSchema = z
  .object({
    version: z.literal(PLAN_RECORD_VERSION),
    repo: z.string().refine(validGithubName, "is not a repository name"),
    issue: z.string().regex(/^\d{1,9}$/),
    runId: z.string().regex(/^[\w-]+$/).max(100),
    planHash: digest,
    commentId: commentIdSchema,
    commentSha256: digest,
    request,
    commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    technology: digest.optional(),
    createdAt: iso,
  })
  .strict();
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

export const PurgedNoteSchema = z.object({ skills: z.array(SkillIdSchema).max(400), at: iso }).strict();
export type PurgedNote = z.infer<typeof PurgedNoteSchema>;

/** An unsafe reason becomes "omitted"; evidence is projected to its safe form. */
export function storableRequest(r: SkillRequest): SkillRequest {
  return {
    version: r.version,
    skills: r.skills.map((s) => ({
      id: s.id,
      reason: safeText(s.reason) ? s.reason : "omitted",
      evidence: [...new Set(s.evidence.map(projectEvidence))],
    })),
  };
}

export interface PlanCommentFact {
  id: string;
  sha256: string;
  mine: boolean;
  later: number;
}
export interface PlanCommentFacts {
  comments: PlanCommentFact[];
}

const FactsSchema = z
  .object({
    version: z.literal(1),
    comments: z
      .array(z.object({ id: commentIdSchema, sha256: digest, mine: z.boolean(), later: z.number().int().min(0) }).strict())
      .max(PLAN_COMMENTS_MAX),
  })
  .strict();

/** The one `PLAN_COMMENTS:` line of a step output (see tools/plan-comment); undefined for none, two or a bad one. */
export function parsePlanCommentFacts(stepOutput: string): PlanCommentFacts | undefined {
  const lines = stepOutput.split("\n").map((l) => l.trimEnd()).filter((l) => l.startsWith("PLAN_COMMENTS:"));
  if (lines.length !== 1 || !lines[0]!.startsWith(PLAN_COMMENTS_MARKER)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(lines[0]!.slice(PLAN_COMMENTS_MARKER.length));
  } catch {
    return undefined;
  }
  const r = FactsSchema.safeParse(json);
  return r.success ? { comments: r.data.comments } : undefined;
}

/** The comment ID (from its link) and the body hash of a posted plan; undefined unless both are there exactly once. */
export function planCommentRefOf(postPlanOutput: string): { id: string; sha256: string } | undefined {
  const lines = postPlanOutput.split("\n").map((l) => l.trim());
  const ids = lines.flatMap((l) => {
    const m = /^https?:\/\/\S+#issuecomment-(\d{1,30})$/.exec(l);
    return m ? [m[1]!] : [];
  });
  const hashes = lines.flatMap((l) => {
    const m = /^PLAN_COMMENT_SHA256: (sha256:[0-9a-f]{64})$/.exec(l);
    return m ? [m[1]!] : [];
  });
  return ids.length === 1 && hashes.length === 1 ? { id: ids[0]!, sha256: hashes[0]! } : undefined;
}

export type PlanRecordsRead = { records: PlanRecord[]; purged?: { skills: string[]; at: string } } | "invalid";

export type PlanPick =
  | { kind: "record"; record: PlanRecord; later: number }
  | { kind: "comment-missing" | "comment-changed" | "newer-plan" | "record-purged" | "none" | "check-unreadable" };

/** Pairs the newest stored record with the plan comment by its ID, and only a comment of ours. */
export function pickPlanRecord(read: PlanRecordsRead, facts: PlanCommentFacts | undefined): PlanPick {
  if (read === "invalid") return { kind: "check-unreadable" };
  if (read.records.length === 0) return { kind: read.purged ? "record-purged" : "none" };
  if (!facts) return { kind: "check-unreadable" };
  const r = read.records.reduce((a, b) => (compareCommentIds(b.commentId, a.commentId) > 0 ? b : a));
  const n = facts.comments.filter((c) => c.mine).reduce<PlanCommentFact | undefined>((a, c) => (!a || compareCommentIds(c.id, a.id) > 0 ? c : a), undefined);
  if (!n) return { kind: "comment-missing" };
  const cmp = compareCommentIds(n.id, r.commentId);
  if (cmp > 0) return { kind: "newer-plan" };
  if (cmp < 0) return { kind: "comment-missing" };
  return n.sha256 === r.commentSha256 ? { kind: "record", record: r, later: n.later } : { kind: "comment-changed" };
}

export function planChanges(i: { later: number; pathsChanged: boolean; technologyThen?: string; technologyNow?: string }): ("comments" | "code" | "technology")[] {
  const out: ("comments" | "code" | "technology")[] = [];
  if (i.later > 0) out.push("comments");
  if (i.pathsChanged) out.push("code");
  if (i.technologyThen !== undefined && i.technologyNow !== undefined && i.technologyThen !== i.technologyNow) out.push("technology");
  return out;
}

/** A hash of what the repository is made of: the kinds and names of its findings. Not paths, counts, values or order. */
export function technologyHashOf(profile: RepoProfile): string {
  const names = [...new Set(profile.findings.map((f) => `${f.kind}\0${f.name}`))].sort();
  return sha256Of(names.join("\n"));
}
