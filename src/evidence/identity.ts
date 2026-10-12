import { createHash } from "node:crypto";
import { z } from "zod";
import { AGENTS, type Step } from "../flow/schema.js";

/**
 * The building blocks of evidence: who and what an event is about. Pure schemas and helpers.
 *
 * Nothing here can hold a secret by design: there is no free text. Every text field is a short one-line label
 * (a name, an id, a code), every object refuses unknown fields, and file contents are never stored: a file is
 * named by its path inside the run folder and its SHA-256.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A short name on one line: 1 to `max` characters, no control characters, no space at either end. */
const label = (max: number) =>
  z.string().refine((s) => s.length >= 1 && s.length <= max && s === s.trim() && !CONTROL.test(s), `must be one line of 1 to ${max} characters, without control characters or spaces at the ends`);

/** A SHA-256 as 64 lower-case hex characters, no prefix. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256: 64 lower-case hex characters");
/** A full Git commit id: 40 hex characters (SHA-1) or 64 (SHA-256 repositories). Never a short id, branch or tag. */
export const CommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full commit id: 40 or 64 lower-case hex characters");
/** A moment in UTC, ISO 8601 with a `Z`, e.g. "2026-01-31T12:00:00.000Z". */
export const TimeSchema = z.iso.datetime({ error: "must be a UTC time such as 2026-01-31T12:00:00.000Z" });
/** The id of a run: the name of its folder under `runs/`. */
export const RunIdSchema = z.string().regex(/^[\w-]{1,128}$/, "must be a run id: 1 to 128 letters, digits, _ or -");
/** The id of a step as the flow names it. */
export const StepIdSchema = z.string().regex(/^[a-zA-Z][\w-]{0,127}$/, "must be a step id: a letter, then letters, digits, _ or -");

export const RELATIVE_PATH_MAX = 1024;
/**
 * True for a path that stays inside the folder it is relative to: `/` between parts, no empty part, no `.` or `..`,
 * no backslash, no drive letter, no control character. So it can never name a file of the machine outside the run.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length < 1 || path.length > RELATIVE_PATH_MAX) return false;
  if (CONTROL.test(path) || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part === part.trim());
}
/** A path relative to the run folder, with `/` between its parts (see isSafeRelativePath). */
export const RelativePathSchema = z.string().refine(isSafeRelativePath, "must be a path inside the run folder: relative, with / between parts, and without . or .. parts");

export const ARTIFACT_KINDS = ["log", "transcript", "diff", "flow", "skill-lock", "test-report", "other"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * A file of the run, named and not copied. `sha256` and `bytes` are of the whole file as it was when the reference was
 * made. `required: true` means the evidence is broken when the file is gone or changed; `false` means the file may be
 * removed later (for example by retention) without breaking it — a changed optional file is still a failure.
 */
export const ArtifactRefSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    path: RelativePathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().min(0),
    required: z.boolean(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The reference to a file with these contents (text is read as UTF-8). Throws when the path is not a safe relative path. */
export function artifactRef(kind: ArtifactKind, path: string, contents: string | Uint8Array, required: boolean): ArtifactRef {
  const bytes = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
  return ArtifactRefSchema.parse({ kind, path, sha256: sha256Hex(contents), bytes, required });
}

/** Who did something. An account is named by its id only; a name or e-mail address never appears. */
export const ActorSchema = z.discriminatedUnion("kind", [
  /** A signed-in account, by its id. */
  z.object({ kind: z.literal("user"), id: z.uuid() }).strict(),
  /** Someone at the command line of the machine the Foundry runs on. */
  z.object({ kind: z.literal("cli") }).strict(),
  /** A watcher, by the id it has in the settings. */
  z.object({ kind: z.literal("watcher"), id: z.string().regex(/^[\w-]{1,128}$/, "must be a watcher id") }).strict(),
  /** The Foundry itself (the scheduler, a restart, a limit). */
  z.object({ kind: z.literal("system") }).strict(),
]);
export type Actor = z.infer<typeof ActorSchema>;

export const STEP_TYPES = ["claude", "shell", "approval", "parallel", "flow"] as const;
// Fails the build when the flow format gets a step type this list does not have (that is a new evidence version).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const stepTypesMatchTheFlowFormat: Same<(typeof STEP_TYPES)[number], Step["type"]> = true;
void stepTypesMatchTheFlowFormat;

/** One visit of one step. `visit` counts from 1. `parent` is the path of the sub-flow steps above it, e.g. "build/test". */
export const StepIdentitySchema = z
  .object({
    id: StepIdSchema,
    visit: z.number().int().min(1),
    type: z.enum(STEP_TYPES),
    parent: z
      .string()
      .refine((p) => p.length <= 1024 && p.split("/").every((part) => StepIdSchema.safeParse(part).success), "must be step ids with / between them")
      .optional(),
  })
  .strict();
export type StepIdentity = z.infer<typeof StepIdentitySchema>;

/** The model a step ran on: the three parts of a target such as "codex:openai:gpt-5". Labels only; never a key or an address. */
export const ModelIdentitySchema = z
  .object({
    /** The agent program. */
    agent: z.enum(AGENTS),
    /** The provider as the settings name it, e.g. "anthropic". */
    provider: label(100),
    /** The model name as it was given to the agent, e.g. "gpt-5". */
    model: label(200),
    /** The effort the step ran with, when one was set. */
    effort: label(32).optional(),
  })
  .strict();
export type ModelIdentity = z.infer<typeof ModelIdentitySchema>;

/** The model identity of an agent target ("agent:provider:model"); undefined when the text is not one. */
export function modelIdentityOf(target: unknown, effort?: string): ModelIdentity | undefined {
  if (typeof target !== "string") return undefined;
  const first = target.indexOf(":");
  const second = first < 0 ? -1 : target.indexOf(":", first + 1);
  if (second < 0) return undefined;
  const res = ModelIdentitySchema.safeParse({
    agent: target.slice(0, first),
    provider: target.slice(first + 1, second),
    model: target.slice(second + 1),
    ...(effort !== undefined ? { effort } : {}),
  });
  return res.success ? res.data : undefined;
}

/** A tool by its name as the agent calls it, e.g. "Bash" or "mcp__server__tool". Never its arguments or its output. */
export const ToolIdentitySchema = z.object({ name: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/, "must be a tool name: letters, digits, _ . : or -") }).strict();
export type ToolIdentity = z.infer<typeof ToolIdentitySchema>;

const slug = (what: string) => z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, `must be ${what}: lower-case letters, digits, . _ or -`);

/** One version of one policy. */
export const PolicyIdentitySchema = z.object({ id: slug("a policy id"), version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "must be a policy version") }).strict();
export type PolicyIdentity = z.infer<typeof PolicyIdentitySchema>;
/** Why a policy decided as it did: a fixed code of that policy, never a sentence. */
export const ReasonCodeSchema = slug("a reason code");

/** The decision of a person (or the Foundry for them) at an approval step. */
export const ApprovalSchema = z.object({ decision: z.enum(["approved", "rejected"]), by: ActorSchema }).strict();
export type Approval = z.infer<typeof ApprovalSchema>;

/**
 * The result of one test run. `suite` is the name the flow gives it (usually the step id), never a command line.
 * The counts are tests, when the test program reported them. `report` is its output file, when one was kept.
 */
export const TestResultSchema = z
  .object({
    suite: label(200),
    outcome: z.enum(["passed", "failed"]),
    passed: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    skipped: z.number().int().min(0).optional(),
    report: ArtifactRefSchema.optional(),
  })
  .strict();
export type TestResult = z.infer<typeof TestResultSchema>;

/** A repository on its host as "owner/name". Never a folder of this machine and never an address with a token. */
export const RepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/, 'must be a repository as "owner/name"');
const BranchSchema = label(255).refine((b) => !/\s/.test(b), "must be a branch name without spaces");

/** One commit. `repository` and `branch` say where it was at that moment, when known. */
export const GitIdentitySchema = z.object({ commit: CommitSchema, branch: BranchSchema.optional(), repository: RepositorySchema.optional() }).strict();
export type GitIdentity = z.infer<typeof GitIdentitySchema>;

/** True for an https address with a host and a path only: no user, password, port, query or fragment. */
export function isPlainHttpsUrl(text: string): boolean {
  if (text.length > 2000 || CONTROL.test(text) || /\s/.test(text)) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && url.hash === "" && !text.includes("?") && !text.includes("#") && !text.includes("@");
}

/** A pull request. `url` is its page: https, with no sign-in data, query or fragment. `head` is its newest commit when the event was made. */
export const PullRequestIdentitySchema = z
  .object({
    repository: RepositorySchema,
    number: z.number().int().min(1),
    url: z.string().refine(isPlainHttpsUrl, "must be an https address without user, password, port, query or fragment"),
    head: CommitSchema.optional(),
  })
  .strict();
export type PullRequestIdentity = z.infer<typeof PullRequestIdentitySchema>;
