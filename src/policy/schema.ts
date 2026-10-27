import { z } from "zod";
import { CONTEXT_CLASSIFICATIONS } from "../context/schema.js";
import { PolicyIdentitySchema, RelativePathSchema, RunIdSchema, Sha256Schema, StepIdSchema, TimeSchema } from "../evidence/identity.js";
import { ReasonCodeSchema, RuleReasonCodeSchema, type ReasonCode } from "./reasons.js";
import { POLICY_DECISION_VERSION, POLICY_INPUT_VERSION, POLICY_PACK_VERSION, type POLICY_PACK_VERSIONS } from "./version.js";

/**
 * The three policy contracts. Types and schemas only: nothing here reads a file, asks a model or looks at a clock.
 *
 * - `PolicyPack`: the rules of one version of one policy.
 * - `PolicyInput`: one question: "may this happen?", with the facts the caller already knows.
 * - `PolicyDecision`: the answer, and what is needed to check it later.
 *
 * Every object refuses unknown fields, so a field can only be added with a new version (see version.ts).
 */

/** What a decision can be, from least to most restrictive. `warn` lets the action go on and says so. */
export const OUTCOMES = ["allow", "warn", "require_approval", "deny"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** `observe`: the decision is recorded and nothing is stopped. `enforce`: the decision is acted on. */
export const MODES = ["observe", "enforce"] as const;
export type Mode = (typeof MODES)[number];

/** The moments at which a question is asked. A rule names the moments it is about. */
export const BOUNDARIES = ["run.start", "step.before", "step.after", "repository.access", "agent.write", "push", "approval.consume", "context.select", "run.complete"] as const;
export type Boundary = (typeof BOUNDARIES)[number];

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const oneLine = (max: number, what: string) =>
  z.string().refine((s) => s.length >= 1 && s.length <= max && !CONTROL.test(s) && !/\s/.test(s), `must be ${what}: 1 to ${max} characters without spaces or control characters`);
const amount = (what: string) => z.number().refine((n) => Number.isFinite(n) && n >= 0, `must be ${what}: a number of 0 or more`);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const WORKSPACES = ["worktree", "inplace", "empty"] as const;
export const OWNERS = ["admin", "user", "none"] as const;
export const CREDENTIALS = ["machine", "repository", "none"] as const;
export const MAX_PATHS = 5000;
export const MAX_RULES = 500;
export const MAX_PATTERNS = 100;

/**
 * What the caller knows when it asks. Every fact is optional: a caller gives the ones that are true knowledge at that
 * moment and leaves the others out (never a guess, never a default). A rule that needs a fact that is not there
 * denies (see evaluate.ts). Facts are short values only: no file contents, no command lines, no tokens.
 */
export const FactsSchema = z
  .object({
    /** The repository the run works on, as "owner/name" in lower case. */
    repository: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/, 'must be a repository as "owner/name" in lower case'),
    /** The branch a push goes to, without "refs/heads/". */
    branch: oneLine(255, "a branch name"),
    /** The name of the flow of the run. */
    flow: oneLine(200, "a flow name"),
    /** The id of the step the question is about. */
    step: StepIdSchema,
    /** The tool an agent asks for, by the name the agent uses. */
    tool: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/, "must be a tool name: letters, digits, _ . : or -"),
    /** Where the flow works: a branch of the server's folder, the server's folder itself, or an empty folder. */
    workspace: z.enum(WORKSPACES),
    /** The role of the account that owns the run; "none" for a run without an owner. */
    owner: z.enum(OWNERS),
    /** The sign-in the step gets: the machine's own, the stored one of the repository, or none. */
    credential: z.enum(CREDENTIALS),
    /** The files the work changed, as paths inside the repository. */
    paths: z.array(RelativePathSchema).max(MAX_PATHS),
    /** How many secrets the secret scan found in the commits that would be pushed. */
    secretsFound: count,
    /** How many bytes the step printed. */
    outputBytes: count,
    /** How long the step has run, in milliseconds. */
    elapsedMs: count,
    /** What the step has cost, in US dollars. */
    stepCostUsd: amount("a cost"),
    /** What the run has cost so far, in US dollars. */
    runCostUsd: amount("a cost"),
    /** What all runs have cost today, in US dollars. */
    dailyCostUsd: amount("a cost"),
    /** The step runs inside a sandbox (the agent's own, an OS sandbox or a container). */
    sandboxed: z.boolean(),
    /** The step runs without the sign-in and the settings of the machine. */
    isolated: z.boolean(),
    /** The flow is a built-in flow exactly as it was shipped: no step, variable, limit or sandbox setting changed. */
    shippedFlow: z.boolean(),
    /** A name and an e-mail address to commit with are known. */
    commitIdentity: z.boolean(),
    /** The issue of the run is closed. */
    issueClosed: z.boolean(),
    /** The flow of the run is in none of the flow folders any more. */
    flowRetired: z.boolean(),
    /** How many sources the run's context bundle has. */
    contextSources: count,
    /** How many bytes of text the sources of the context bundle have together. */
    contextBytes: count,
    /** How many sources were left out of the context bundle. */
    contextOmitted: count,
    /** The most private class among the sources of the context bundle. Left out when there are no sources. */
    contextClassification: z.enum(CONTEXT_CLASSIFICATIONS),
  })
  .partial()
  .strict();
export type Facts = z.infer<typeof FactsSchema>;
export type FactName = keyof Facts;

/** A pattern for a text fact: the text itself, where `*` stands for any characters (also none, also "/"). Nothing else is special. */
export const PatternSchema = oneLine(255, "a pattern");
const patterns = (lower: boolean) =>
  z
    .array(lower ? PatternSchema.refine((p) => p === p.toLowerCase(), "must be in lower case") : PatternSchema)
    .min(1)
    .max(MAX_PATTERNS)
    .refine((list) => new Set(list).size === list.length, "names the same pattern twice");
const values = <T extends readonly [string, ...string[]]>(of: T) =>
  z
    .array(z.enum(of))
    .min(1)
    .refine((list) => new Set(list).size === list.length, "names the same value twice");
const oneOfTwo = <S extends z.ZodType>(list: S) =>
  z
    .object({ in: list.optional(), notIn: list.optional() })
    .strict()
    .refine((c) => (c.in === undefined) !== (c.notIn === undefined), "must have exactly one of in and notIn");

/** True when the text matches one of the patterns (`in`), or none of them (`notIn`). */
const text = (lower = false) => oneOfTwo(patterns(lower));
/** True when the value is one of the listed ones (`in`), or none of them (`notIn`). */
const choice = <T extends readonly [string, ...string[]]>(of: T) => oneOfTwo(values(of));
/** True when the number is more than `over` (never when it is equal). */
const over = z.object({ over: amount("a limit") }).strict();
/** True when the fact has this value. */
const flag = z.boolean();

/**
 * When a rule applies: every condition that is named must be true. No condition at all: the rule always applies at
 * its boundaries. One condition per fact, with the name of the fact.
 */
export const ConditionsSchema = z
  .object({
    repository: text(true),
    branch: text(),
    flow: text(),
    step: text(),
    tool: text(),
    workspace: choice(WORKSPACES),
    owner: choice(OWNERS),
    credential: choice(CREDENTIALS),
    /** True when at least one changed file matches one of the patterns. */
    paths: z.object({ anyIn: patterns(false) }).strict(),
    secretsFound: over,
    outputBytes: over,
    elapsedMs: over,
    stepCostUsd: over,
    runCostUsd: over,
    dailyCostUsd: over,
    sandboxed: flag,
    isolated: flag,
    shippedFlow: flag,
    commitIdentity: flag,
    issueClosed: flag,
    flowRetired: flag,
    contextSources: over,
    contextBytes: over,
    contextOmitted: over,
    contextClassification: choice(CONTEXT_CLASSIFICATIONS),
  })
  .partial()
  .strict();
export type Conditions = z.infer<typeof ConditionsSchema>;

// Fails the build when a fact has no condition or a condition has no fact.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const everyFactHasACondition: Same<keyof Facts, keyof Conditions> = true;
void everyFactHasACondition;

const slug = (what: string) => z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, `must be ${what}: lower-case letters, digits, . _ or -`);
const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

/** One rule: at these boundaries, when these conditions hold, this is the outcome and this is why. */
export const PolicyRuleV1Schema = z
  .object({
    /** The name of the rule inside its pack: unique there, and not given to another rule in a later version. */
    id: slug("a rule id"),
    /** The moments the rule is about: at least one, each once. At any other moment the rule is passed over. */
    boundaries: z.array(z.enum(BOUNDARIES)).min(1).refine(unique, "names the same boundary twice"),
    when: ConditionsSchema,
    outcome: z.enum(OUTCOMES),
    reasonCode: RuleReasonCodeSchema,
  })
  .strict();

/** A rule of a version 2 pack: a rule of version 1, and it may have its own mode. A rule without mode has the mode of its pack. */
export const PolicyRuleSchema = PolicyRuleV1Schema.extend({ mode: z.enum(MODES).optional() }).strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/** The pack object of one version of the format, built from the rule of that version. */
const packSchema = <V extends number, R extends z.ZodType<{ id: string }>>(version: V, rule: R) =>
  z
    .object({
      version: z.literal(version),
      policy: PolicyIdentitySchema,
      mode: z.enum(MODES),
      rules: z.array(rule).max(MAX_RULES),
      defaultOutcome: z.enum(["allow", "deny"]),
    })
    .strict()
    .superRefine((pack, ctx) => {
      const seen = new Set<string>();
      pack.rules.forEach((r, i) => {
        if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: "the same rule id is used twice" });
        seen.add(r.id);
      });
    });

/** A pack of version 1: no rule has a mode. It is read and hashed as written, never rewritten to version 2. */
export const PolicyPackV1Schema = packSchema(1, PolicyRuleV1Schema);

/**
 * One version of one policy. `version` is the version of this format; `policy` is the id of the pack and the version
 * its author gave its contents (the same pair evidence carries). The rules are read from the first to the last and the
 * first one that applies decides; `defaultOutcome` decides when none does.
 */
export const PolicyPackSchema = packSchema(POLICY_PACK_VERSION, PolicyRuleSchema);
/** A pack of any version this build reads: a version 1 rule fits, since the mode of a rule is optional. */
export type PolicyPack = Omit<z.infer<typeof PolicyPackSchema>, "version"> & { version: (typeof POLICY_PACK_VERSIONS)[number] };

/** One question. `runId` says which run asks; `facts` is everything a rule may look at. */
export const PolicyInputSchema = z
  .object({
    version: z.literal(POLICY_INPUT_VERSION),
    boundary: z.enum(BOUNDARIES),
    runId: RunIdSchema,
    facts: FactsSchema,
  })
  .strict();
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

/** Reasons that are not the work of a rule, so a decision with one of them names no rule. */
export const NO_RULE_REASONS: readonly ReasonCode[] = ["policy.no-rule-matched", "policy.invalid", "policy.unavailable", "policy.break-glass"];
/** Reasons for which no pack was read or used, so a decision with one of them has no pack hash. */
export const NO_PACK_REASONS: readonly ReasonCode[] = ["policy.invalid", "policy.unavailable", "policy.break-glass"];
/** Reasons that always deny. */
export const DENY_ONLY_REASONS: readonly ReasonCode[] = ["policy.input-incomplete", "policy.invalid", "policy.unavailable"];

/**
 * One answer. Everything in it follows from the pack, the input and `evaluatedAt`; nothing else.
 */
export const PolicyDecisionSchema = z
  .object({
    version: z.literal(POLICY_DECISION_VERSION),
    /** The pack that decided: its id and the version of its contents. */
    policy: PolicyIdentitySchema,
    /** The SHA-256 of the pack in its canonical form. Absent only when no pack could be read (see NO_PACK_REASONS). */
    packSha256: Sha256Schema.optional(),
    /** The mode of the rule that decided, or of the pack when the rule has none or no rule decided: whether this decision is to be acted on or only recorded. */
    mode: z.enum(MODES),
    /** The moment in the run the question was about (the `boundary` of the input). */
    boundary: z.enum(BOUNDARIES),
    /** The SHA-256 of the input in its canonical form. The input itself is not kept in the decision. */
    inputSha256: Sha256Schema,
    outcome: z.enum(OUTCOMES),
    reasonCode: ReasonCodeSchema,
    /** The rule that decided. Absent when no rule did (see NO_RULE_REASONS). */
    rule: PolicyRuleSchema.shape.id.optional(),
    /** The moment of the evaluation, as the caller gave it. */
    evaluatedAt: TimeSchema,
  })
  .strict()
  .superRefine((d, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (NO_RULE_REASONS.includes(d.reasonCode) && d.rule !== undefined) add("rule", "no rule decides with this reason code");
    if (!NO_RULE_REASONS.includes(d.reasonCode) && d.rule === undefined) add("rule", "is missing: this reason code comes from a rule");
    if (NO_PACK_REASONS.includes(d.reasonCode) !== (d.packSha256 === undefined)) add("packSha256", "is absent exactly when the pack could not be read");
    if (DENY_ONLY_REASONS.includes(d.reasonCode) && d.outcome !== "deny") add("outcome", 'must be "deny" with this reason code');
    if (d.reasonCode === "policy.break-glass") {
      if (d.outcome !== "warn") add("outcome", 'must be "warn" with this reason code');
      if (d.mode !== "enforce") add("mode", 'must be "enforce" with this reason code');
    }
    if (d.reasonCode === "policy.no-rule-matched" && d.outcome !== "allow" && d.outcome !== "deny") add("outcome", 'must be "allow" or "deny" when no rule matched');
  });
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
