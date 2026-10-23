import { z } from "zod";
import { canonicalHash } from "../evidence/canonical.js";
import { CommitSchema, GitIdentitySchema, PullRequestIdentitySchema, RelativePathSchema, RepositorySchema, RunIdSchema, Sha256Schema } from "../evidence/identity.js";
import { EVIDENCE_EVENTS_FILE } from "../evidence/version.js";

/**
 * The delivery contract: what a pull request was handed over with, fixed at one moment. Like evidence, it holds
 * only short labels, paths and hashes (no free text, no file contents), and every object refuses unknown fields.
 * Adding a field needs a new version.
 */

export const DELIVERY_CONTRACT_VERSION = 1;

/**
 * The fixed list of version 1, in this order. `required-check-failed` stands for a required check that is missing
 * or did not pass.
 */
export const STOP_CONDITIONS = ["commit-changed", "lock-changed", "workflow-changed", "required-check-failed", "evidence-unverified", "signature-unverified", "superseded"] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

export const WORKFLOWS_DIR = ".github/workflows/";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A short name on one line: 1 to 200 characters, no control characters, no space at either end. */
const NameSchema = z.string().refine((s) => s.length >= 1 && s.length <= 200 && s === s.trim() && !CONTROL.test(s), "must be one line of 1 to 200 characters, without control characters or spaces at the ends");
/** A git blob id: 40 hex characters (SHA-1) or 64 (SHA-256 repositories). */
export const BlobIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full git blob id: 40 or 64 lower-case hex characters");

export const LockFileSchema = z.object({ path: RelativePathSchema, sha256: Sha256Schema }).strict();
export const WorkflowFileSchema = z
  .object({
    path: RelativePathSchema.refine((p) => p.startsWith(WORKFLOWS_DIR) && p.length > WORKFLOWS_DIR.length, "must be a file under .github/workflows/"),
    blob: BlobIdSchema,
  })
  .strict();
export const RequiredArtifactSchema = z.object({ name: NameSchema, sha256: Sha256Schema.optional() }).strict();

/** Order by UTF-16 code unit: the order `canonicalJson` uses for names. */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedOnce(keys: readonly string[], ctx: z.RefinementCtx, at: string, what: string): void {
  for (let i = 1; i < keys.length; i++) {
    if (compareCodeUnits(keys[i - 1] ?? "", keys[i] ?? "") >= 0) {
      ctx.addIssue({ code: "custom", path: [at, i], message: `must be sorted by ${what}, each once` });
      return;
    }
  }
}

export const DeliveryContractSchema = z
  .object({
    version: z.literal(DELIVERY_CONTRACT_VERSION),
    runId: RunIdSchema,
    sequence: z.number().int().min(1),
    supersedes: Sha256Schema.optional(),
    repository: RepositorySchema,
    pullRequest: PullRequestIdentitySchema,
    commit: z.object({ sha: CommitSchema, branch: GitIdentitySchema.shape.branch.unwrap() }).strict(),
    dependencyLock: z.object({ files: z.array(LockFileSchema).max(1000), sha256: Sha256Schema }).strict(),
    ciWorkflows: z.array(WorkflowFileSchema).max(1000),
    requiredChecks: z.array(NameSchema).max(500),
    evidence: z.object({ path: z.literal(EVIDENCE_EVENTS_FILE), count: z.number().int().min(1), terminalHash: Sha256Schema }).strict(),
    artifacts: z.array(RequiredArtifactSchema).max(500),
    provenance: z.object({ required: z.boolean() }).strict(),
    stopConditions: z.array(z.enum(STOP_CONDITIONS)),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.sequence === 1) !== (c.supersedes === undefined)) {
      ctx.addIssue({ code: "custom", path: ["supersedes"], message: "must be set exactly when sequence is above 1" });
    }
    if (c.pullRequest.repository !== c.repository) ctx.addIssue({ code: "custom", path: ["pullRequest", "repository"], message: "must be the repository of the contract" });
    if (c.pullRequest.head !== undefined && c.pullRequest.head !== c.commit.sha) ctx.addIssue({ code: "custom", path: ["pullRequest", "head"], message: "must be the commit of the contract" });
    if (c.dependencyLock.sha256 !== canonicalHash(c.dependencyLock.files)) ctx.addIssue({ code: "custom", path: ["dependencyLock", "sha256"], message: "must be the hash of the lock files" });
    sortedOnce(c.dependencyLock.files.map((f) => f.path), ctx, "dependencyLock", "path");
    sortedOnce(c.ciWorkflows.map((f) => f.path), ctx, "ciWorkflows", "path");
    sortedOnce(c.requiredChecks, ctx, "requiredChecks", "name");
    sortedOnce(c.artifacts.map((a) => a.name), ctx, "artifacts", "name");
    if (c.stopConditions.length !== STOP_CONDITIONS.length || c.stopConditions.some((s, i) => s !== STOP_CONDITIONS[i])) {
      ctx.addIssue({ code: "custom", path: ["stopConditions"], message: "must be the fixed list of version 1" });
    }
  });
export type DeliveryContract = z.infer<typeof DeliveryContractSchema>;
