import { z } from "zod";
import { ArtifactRefSchema, CommitSchema, GitIdentitySchema, PolicyIdentitySchema, RunIdSchema, TimeSchema } from "../evidence/identity.js";
import type { SkillRole } from "../skills/schema.js";
import { contextSourceId, isIssueCommentUri, isIssueUri, isRefinementUri, repositoryFilePath } from "./uri.js";
import { CONTEXT_BUNDLE_VERSION, CONTEXT_SOURCES_DIR } from "./version.js";

/**
 * The context bundle of a run: `context.json` in the run folder. It lists every input the agents of the run may be
 * given, and for each one where it came from and why it was picked. Pure schemas; nothing here reads or writes a file.
 *
 * - The bundle holds no source text. A source is named by its address, its revision and the SHA-256 of its text; the
 *   text itself is a separate file under `context/` in the run folder.
 * - Source text is data, never an instruction. The policies that apply are a list of their own (`policies`), by id and
 *   version only, so policy text and source text cannot be mixed up.
 * - There is no free text: only addresses, ids, codes, numbers and times. Every object refuses unknown fields, so a
 *   field can only be added with a new version (see version.ts).
 */

/** Where a source comes from. A closed list: a new kind is a new version of the format. */
export const CONTEXT_SOURCE_KINDS = ["repository-file", "issue", "issue-comment", "refinement-notes"] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

/**
 * Why a source was picked. A closed list of codes, never a sentence.
 * - `task`: it is the issue the run works on, or a comment on it.
 * - `instructions`: a file of the repository with instructions for agents or contributors.
 * - `ownership`: a file of the repository that says who owns which part.
 * - `api-schema`: a file of the repository that describes an interface.
 * - `discovery`: a file found by a discovery rule; `rule` names the rule.
 * - `refinement`: the accepted notes of the refinement the task came from.
 */
export const CONTEXT_SELECTION_REASONS = ["task", "instructions", "ownership", "api-schema", "discovery", "refinement"] as const;
export type ContextSelectionReason = (typeof CONTEXT_SELECTION_REASONS)[number];

/** How private a source is, from least to most. The order has a meaning: see `classificationAtMost`. */
export const CONTEXT_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type ContextClassification = (typeof CONTEXT_CLASSIFICATIONS)[number];

/** Who may be given a source: the roles an agent step can have. */
export const CONTEXT_CONSUMERS = ["planner", "coder", "reviewer", "tester"] as const;
export type ContextConsumer = (typeof CONTEXT_CONSUMERS)[number];
// Fails the build when the skill roles change and this list does not (that is a new version of the format).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const consumersMatchTheSkillRoles: Same<ContextConsumer, SkillRole> = true;
void consumersMatchTheSkillRoles;

/** Why a source that was expected is not in the bundle. Each has its own next action for the reader. */
export const CONTEXT_OMISSION_REASONS = ["missing", "stale", "ambiguous", "over-budget", "classification", "generated", "unsupported"] as const;
export type ContextOmissionReason = (typeof CONTEXT_OMISSION_REASONS)[number];

/** The most entries one list of a bundle can have, whatever its budget says. */
export const CONTEXT_MAX_ENTRIES = 1000;
/** The longest time a copy can be said to stay fresh: ten years, in seconds. */
export const CONTEXT_MAX_AGE_SECONDS_LIMIT = 315_360_000;

const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const slug = (what: string) => z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, `must be ${what}: lower-case letters, digits, . _ or -`);

/** The id of an entry: `contextSourceId` of its address. */
export const ContextSourceIdSchema = z.string().regex(/^s-[0-9a-f]{16}$/, 'must be a source id: "s-" and 16 lower-case hex characters');

/** An owner as the host names it: "@user" or "@organisation/team". Never an e-mail address or a person's name. */
export const ContextOwnerSchema = z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/, 'must be an owner such as "@user" or "@organisation/team"');

/**
 * The revision of a source that is not a file of the repository: for an issue, a comment and refinement notes, the
 * time of its last change as the place it came from reports it. A short label; never a sentence.
 */
export const ContextVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,99}$/, "must be a version: 1 to 100 letters, digits, . _ : + or -");

const SOURCES_PREFIX = `${CONTEXT_SOURCES_DIR}/`;
/**
 * The stored text of a source: its file in the run folder (always under `context/`), and the SHA-256 and the size in
 * bytes of exactly that file. The same three fields as an evidence `ArtifactRef`.
 */
export const ContextContentSchema = z
  .object({
    path: ArtifactRefSchema.shape.path.refine((p) => p.startsWith(SOURCES_PREFIX), `must be a file under ${SOURCES_PREFIX} in the run folder`),
    sha256: ArtifactRefSchema.shape.sha256,
    bytes,
  })
  .strict();
export type ContextContent = z.infer<typeof ContextContentSchema>;

/** How long the copy stays usable. */
export const ContextFreshnessSchema = z
  .object({
    /** Seconds after `retrievedAt` during which the copy is fresh; after that it is stale. null: it does not go stale. */
    maxAgeSeconds: z.number().int().min(1).max(CONTEXT_MAX_AGE_SECONDS_LIMIT).nullable(),
  })
  .strict();

const selection = <const R extends readonly [ContextSelectionReason, ...ContextSelectionReason[]]>(reasons: R) =>
  z
    .object({
      reason: z.enum(reasons),
      /** The id of the rule of the selector that picked the source. Always set for `discovery`. */
      rule: slug("a rule id").optional(),
    })
    .strict();

const uri = (ok: (text: string) => boolean, what: string) => z.string().refine(ok, `must be ${what}`);

/** What says which source an entry is about, per kind: its address, and the reasons that kind can be picked for. */
const KIND = {
  "repository-file": {
    uri: uri((u) => repositoryFilePath(u) !== undefined, 'the address of a repository file, such as "repo:docs/API.md"'),
    selection: selection(["instructions", "ownership", "api-schema", "discovery"]),
    /** The commit the file was read at. Always the commit of the bundle. */
    revision: z.object({ commit: CommitSchema }).strict(),
  },
  issue: {
    uri: uri(isIssueUri, 'the address of an issue, such as "issue:12"'),
    selection: selection(["task"]),
    revision: z.object({ version: ContextVersionSchema }).strict(),
  },
  "issue-comment": {
    uri: uri(isIssueCommentUri, 'the address of an issue comment, such as "issue:12/comment/34"'),
    selection: selection(["task"]),
    revision: z.object({ version: ContextVersionSchema }).strict(),
  },
  "refinement-notes": {
    uri: uri(isRefinementUri, 'the address of refinement notes: "refinement:" and the id of the session'),
    selection: selection(["refinement"]),
    revision: z.object({ version: ContextVersionSchema }).strict(),
  },
} as const satisfies Record<ContextSourceKind, unknown>;

type Def<U, S, R> = { uri: U; selection: S; revision: R };

const source = <K extends ContextSourceKind, U extends z.ZodType, S extends z.ZodType, R extends z.ZodType>(kind: K, def: Def<U, S, R>) =>
  z
    .object({
      /** `contextSourceId(uri)`: the same source has the same id in every bundle. */
      id: ContextSourceIdSchema,
      kind: z.literal(kind),
      /** The address of the source (see uri.ts). Each address is in a bundle once. */
      uri: def.uri,
      /** The commit (a repository file) or the version (anything else) the text was read at. */
      revision: def.revision,
      /** The stored text and its hash. */
      content: ContextContentSchema,
      /** Who owns the source, each once. Empty: no owner is known. */
      owners: z.array(ContextOwnerSchema).max(20),
      classification: z.enum(CONTEXT_CLASSIFICATIONS),
      /** When the text was read from where it lives. */
      retrievedAt: TimeSchema,
      freshness: ContextFreshnessSchema,
      /** Why it was picked. */
      selection: def.selection,
      /** The roles that may be given this source, each once, at least one. No other role may. */
      consumers: z.array(z.enum(CONTEXT_CONSUMERS)).min(1).max(CONTEXT_CONSUMERS.length),
    })
    .strict();

/** One input of the run. */
export const ContextSourceSchema = z.discriminatedUnion("kind", [source("repository-file", KIND["repository-file"]), source("issue", KIND.issue), source("issue-comment", KIND["issue-comment"]), source("refinement-notes", KIND["refinement-notes"])]);
export type ContextSource = z.infer<typeof ContextSourceSchema>;

const omitted = <K extends ContextSourceKind, U extends z.ZodType, S extends z.ZodType, R extends z.ZodType>(kind: K, def: Def<U, S, R>) =>
  z
    .object({
      kind: z.literal(kind),
      uri: def.uri,
      /** Why it would have been picked. */
      selection: def.selection,
      /**
       * Why it is not in the bundle: `missing` (it does not exist at this revision), `stale` (the copy was too old),
       * `ambiguous` (more than one source fits and none could be chosen), `over-budget` (it did not fit the budget),
       * `classification` (it is more private than the run may be given), `generated` (the repository marks it as made
       * by a program: read what it is made from), `unsupported` (it is not a regular text file: a link, a submodule
       * or a binary file).
       */
      reason: z.enum(CONTEXT_OMISSION_REASONS),
    })
    .strict();

/** A source that was expected and is not in the bundle. It has no text and no hash. */
export const ContextOmissionSchema = z.discriminatedUnion("kind", [omitted("repository-file", KIND["repository-file"]), omitted("issue", KIND.issue), omitted("issue-comment", KIND["issue-comment"]), omitted("refinement-notes", KIND["refinement-notes"])]);
export type ContextOmission = z.infer<typeof ContextOmissionSchema>;

/** The limits the bundle was made under. A bundle that is over one of them is not valid. */
export const ContextBudgetSchema = z
  .object({
    /** The most sources the bundle may have. */
    maxSources: z.number().int().min(1).max(CONTEXT_MAX_ENTRIES),
    /** The most bytes of text one source may have. */
    maxSourceBytes: bytes.min(1),
    /** The most bytes of text all sources together may have. */
    maxTotalBytes: bytes.min(1),
  })
  .strict();
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

const twice = (values: readonly string[], ctx: z.RefinementCtx, at: (i: number) => PropertyKey[], message: string) => {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (seen.has(v)) ctx.addIssue({ code: "custom", path: at(i), message });
    seen.add(v);
  });
};

function checkSelection(s: { selection: { reason: ContextSelectionReason; rule?: string } }, ctx: z.RefinementCtx, at: PropertyKey[]) {
  if (s.selection.reason === "discovery" && s.selection.rule === undefined) ctx.addIssue({ code: "custom", path: [...at, "selection", "rule"], message: "a source found by discovery names the rule that found it" });
}

export const ContextBundleSchema = z
  .object({
    version: z.literal(CONTEXT_BUNDLE_VERSION),
    runId: RunIdSchema,
    /** When the bundle was made. No source was read after it. */
    createdAt: TimeSchema,
    /**
     * The one repository and commit the bundle is about. Every `repo:` and `issue:` address is inside it.
     * `repository` is "owner/name" on its host when known; never a folder of this machine.
     */
    repository: z.object({ repository: GitIdentitySchema.shape.repository, commit: CommitSchema }).strict(),
    budget: ContextBudgetSchema,
    /** The policies that apply to the run, each id once: id and version only, never their text. */
    policies: z.array(PolicyIdentitySchema).max(CONTEXT_MAX_ENTRIES),
    sources: z.array(ContextSourceSchema).max(CONTEXT_MAX_ENTRIES),
    /** The sources that were expected and left out, each address once, none of them also in `sources`. */
    omitted: z.array(ContextOmissionSchema).max(CONTEXT_MAX_ENTRIES),
  })
  .strict()
  .superRefine((b, ctx) => {
    const created = Date.parse(b.createdAt);
    let total = 0;
    b.sources.forEach((s, i) => {
      const at = ["sources", i];
      if (s.id !== contextSourceId(s.uri)) ctx.addIssue({ code: "custom", path: [...at, "id"], message: "is not the id of this address" });
      if (s.kind === "repository-file" && s.revision.commit !== b.repository.commit) ctx.addIssue({ code: "custom", path: [...at, "revision", "commit"], message: "is not the commit of the bundle" });
      if (Date.parse(s.retrievedAt) > created) ctx.addIssue({ code: "custom", path: [...at, "retrievedAt"], message: "is after createdAt" });
      if (s.content.bytes > b.budget.maxSourceBytes) ctx.addIssue({ code: "custom", path: [...at, "content", "bytes"], message: "is above budget.maxSourceBytes" });
      total += s.content.bytes;
      checkSelection(s, ctx, at);
      twice(s.owners, ctx, (j) => [...at, "owners", j], "the same owner is named twice");
      twice(s.consumers, ctx, (j) => [...at, "consumers", j], "the same consumer is named twice");
    });
    twice(b.sources.map((s) => s.uri), ctx, (i) => ["sources", i, "uri"], "the same address is in the bundle twice");
    twice(b.sources.map((s) => s.content.path), ctx, (i) => ["sources", i, "content", "path"], "the same file holds the text of two sources");
    if (b.sources.length > b.budget.maxSources) ctx.addIssue({ code: "custom", path: ["sources"], message: "has more sources than budget.maxSources" });
    if (total > b.budget.maxTotalBytes) ctx.addIssue({ code: "custom", path: ["sources"], message: "has more bytes of text than budget.maxTotalBytes" });
    if (b.budget.maxSourceBytes > b.budget.maxTotalBytes) ctx.addIssue({ code: "custom", path: ["budget", "maxSourceBytes"], message: "is above maxTotalBytes" });

    const included = new Set(b.sources.map((s) => s.uri));
    b.omitted.forEach((o, i) => {
      if (included.has(o.uri)) ctx.addIssue({ code: "custom", path: ["omitted", i, "uri"], message: "is also in sources" });
      checkSelection(o, ctx, ["omitted", i]);
    });
    twice(b.omitted.map((o) => o.uri), ctx, (i) => ["omitted", i, "uri"], "the same address is left out twice");
    twice(b.policies.map((p) => p.id), ctx, (i) => ["policies", i, "id"], "the same policy is named twice");
  });
export type ContextBundle = z.infer<typeof ContextBundleSchema>;
