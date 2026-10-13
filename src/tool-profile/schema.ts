import { z } from "zod";
import { isSafeRelativePath, Sha256Schema } from "../evidence/identity.js";
import { AGENTS } from "../flow/schema.js";
import { CREDENTIALS } from "../policy/schema.js";
import { ADAPTER_CAPABILITIES_VERSION, TOOL_PROFILE_VERSION } from "./version.js";

/**
 * The tool-isolation contracts. Types and schemas only: nothing here reads a file, starts a program or looks at a clock.
 *
 * - `ToolProfile`: what one agent session may do, with which tools, on which targets. It names no agent program.
 * - `AdapterCapabilities`: what one agent program can be made to hold of a profile, and what it cannot.
 * - `ToolProfileRef`: the id and the hash of a profile, the two things a run keeps of it.
 *
 * A profile is closed: a kind, an operation or a target it does not name is refused. Every object refuses unknown
 * fields, so a field, a kind or an operation can only be added with a new version (see version.ts).
 */

/**
 * The kinds of tool a profile can speak about.
 * - `files`: the agent's own tools that read, search and change files (not what a shell command does to files).
 * - `shell`: running a command line.
 * - `git`, `github`: operations on a repository, by whatever means they are done (a command, a broker).
 * - `web`: the agent's own tools that fetch a page or search the web (not what a shell command does on the network).
 * - `mcp`: a tool of an MCP server.
 * - `builtin`: any other tool the agent program brings itself, by the name that program gives it (e.g. "Task").
 */
export const TOOL_KINDS = ["files", "shell", "git", "github", "web", "mcp", "builtin"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Every operation there is, per kind. A profile cannot name another one. */
export const OPERATIONS = {
  files: ["read", "write"],
  shell: ["run"],
  git: ["status", "clone", "fetch", "branch", "commit", "push"],
  github: ["issue.read", "issue.write", "pull-request.read", "pull-request.write", "pull-request.merge", "checks.read"],
  web: ["fetch", "search"],
  mcp: ["call"],
  builtin: ["call"],
} as const satisfies Record<ToolKind, readonly [string, ...string[]]>;
export type OperationOf<K extends ToolKind> = (typeof OPERATIONS)[K][number];

/** How sensitive data is, from least to most. */
export const DATA_CLASSES = ["public", "internal", "confidential", "restricted"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** The sign-ins there are (the list of the policy contracts), from least to most powerful. */
export const CREDENTIAL_ORDER = ["none", "repository", "machine"] as const satisfies readonly (typeof CREDENTIALS)[number][];
export type Credential = (typeof CREDENTIALS)[number];

/** `none`: a call runs at once. `required`: a person has to agree before every call. */
export const APPROVALS = ["none", "required"] as const;
export type ApprovalRequirement = (typeof APPROVALS)[number];

/** Where a command may write, from least to most: nowhere, the workspace of the run, anywhere the account may. */
export const SANDBOX_FILESYSTEM = ["read-only", "workspace-write", "unrestricted"] as const;
/** What a command may reach on the network, from least to most. */
export const SANDBOX_NETWORK = ["none", "unrestricted"] as const;

export const MAX_GRANTS = 50;
export const MAX_TARGETS = 100;
export const TARGET_MAX = 255;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_CONCURRENT = 64;
export const MAX_OUTPUT_CAP_BYTES = 1024 * 1024 * 1024;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const REPOSITORY = /^(?:\*|[a-z0-9*][a-z0-9_.*-]{0,99}\/[a-z0-9_.*-]{1,100})$/;
const HOST = /^[a-z0-9*](?:[a-z0-9.*-]*[a-z0-9*])?$/;
const MCP_TOOL = /^(?:\*|[A-Za-z0-9_.*-]{1,100}\/[A-Za-z0-9_.*-]{1,100})$/;
const BUILTIN_TOOL = /^[A-Za-z0-9_.:*-]{1,200}$/;
const filePath = (t: string) => isSafeRelativePath(t.startsWith("/") ? t.slice(1) : t);

/**
 * What a target is, per kind. A target of a profile is a pattern: `*` stands for any characters (also none, also
 * "/"); every other character stands for itself. A target of a call is the same text without that meaning.
 */
export const TARGET_FORMATS: Record<ToolKind, { test: (target: string) => boolean; what: string }> = {
  files: { test: filePath, what: 'a path with / between parts and without . or .. parts: relative for a file in the workspace, or starting with / for a file of the machine ("/*" is every file)' },
  shell: { test: (t) => t === t.trim() && !CONTROL.test(t), what: "a command line on one line, without control characters or spaces at the ends" },
  git: { test: (t) => REPOSITORY.test(t), what: 'a repository as "owner/name" in lower case, or *' },
  github: { test: (t) => REPOSITORY.test(t), what: 'a repository as "owner/name" in lower case, or *' },
  web: { test: (t) => HOST.test(t), what: "a host name in lower case, without scheme, port or path, or *" },
  mcp: { test: (t) => MCP_TOOL.test(t), what: 'an MCP tool as "server/tool", or *' },
  builtin: { test: (t) => BUILTIN_TOOL.test(t), what: "a tool name: letters, digits, _ . : or -" },
};

/** True when the text can be a target of that kind (a pattern of a profile, or the target of a call). */
export const isTarget = (kind: ToolKind, target: string): boolean => target.length >= 1 && target.length <= TARGET_MAX && TARGET_FORMATS[kind].test(target);

/** The one pattern that stands for every target of a kind. */
export const ALL_TARGETS: Record<ToolKind, string> = { files: "/*", shell: "*", git: "*", github: "*", web: "*", mcp: "*", builtin: "*" };

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;
const known = (what: string, values: readonly string[]) => ({ error: `must be ${what}: ${values.join(", ")}` });
/** A limit: a whole number from `min` to `max`, or null for "no limit of its own" (null is the most permissive value). */
const limit = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

export const SandboxSchema = z
  .object({
    filesystem: z.enum(SANDBOX_FILESYSTEM, known("a known file-system level", SANDBOX_FILESYSTEM)),
    network: z.enum(SANDBOX_NETWORK, known("a known network level", SANDBOX_NETWORK)),
  })
  .strict();
export type Sandbox = z.infer<typeof SandboxSchema>;

/** What every grant declares. Nothing is optional and nothing has a default: a profile says all of it. */
const declared = {
  /** The most sensitive data a call may be given, read or return. */
  dataClassification: z.enum(DATA_CLASSES, known("a known data class", DATA_CLASSES)),
  /** The sign-in a call runs with. */
  credential: z.enum(CREDENTIALS, known("a known credential", CREDENTIAL_ORDER)),
  /** The longest one call may take, in milliseconds. */
  timeoutMs: limit(1, MAX_TIMEOUT_MS),
  /** How many calls may run at the same moment in one session. */
  maxConcurrent: limit(1, MAX_CONCURRENT),
  /** The most bytes of output one call may hand back. */
  outputCapBytes: limit(0, MAX_OUTPUT_CAP_BYTES),
  approval: z.enum(APPROVALS, known("a known approval requirement", APPROVALS)),
};

const grant = <K extends ToolKind, X extends z.ZodRawShape>(kind: K, extra: X) =>
  z
    .object({
      kind: z.literal(kind),
      /** The operations this grant allows: at least one, each once. */
      operations: z
        .array(z.enum(OPERATIONS[kind] as unknown as [OperationOf<K>, ...OperationOf<K>[]], known(`a known ${kind} operation`, OPERATIONS[kind])))
        .min(1)
        .refine(unique, "names the same operation twice"),
      /** The targets those operations may be used on: at least one pattern, each once. */
      targets: z
        .array(z.string().refine((t) => isTarget(kind, t), `must be ${TARGET_FORMATS[kind].what} (1 to ${TARGET_MAX} characters)`))
        .min(1)
        .max(MAX_TARGETS)
        .refine(unique, "names the same target twice"),
      ...declared,
      ...extra,
    })
    .strict();

/**
 * One grant: these operations of this kind, on these targets, under these conditions.
 * Only a `shell` grant has a `sandbox`: what a command it starts may do to the files and the network of the machine.
 */
export const ToolGrantSchema = z.discriminatedUnion(
  "kind",
  [grant("files", {}), grant("shell", { sandbox: SandboxSchema }), grant("git", {}), grant("github", {}), grant("web", {}), grant("mcp", {}), grant("builtin", {})],
  known("a grant of a known kind", TOOL_KINDS),
);
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

const slug = (what: string) => z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, `must be ${what}: lower-case letters, digits, . _ or -`);
/** One version of one profile: the same two parts as the identity of a policy. */
export const ToolProfileIdentitySchema = z.object({ id: slug("a profile id"), version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "must be a profile version") }).strict();
export type ToolProfileIdentity = z.infer<typeof ToolProfileIdentitySchema>;

/** Kinds that never run with a sign-in: the agent's own file, web and other tools. */
export const NO_CREDENTIAL_KINDS: readonly ToolKind[] = ["files", "web", "builtin"];

/**
 * One version of one tool profile. `version` is the version of this format; `profile` is the id of the profile and the
 * version its author gave the contents. `grants` is everything that is allowed; with no grant, nothing is.
 */
export const ToolProfileSchema = z
  .object({
    version: z.literal(TOOL_PROFILE_VERSION),
    profile: ToolProfileIdentitySchema,
    grants: z.array(ToolGrantSchema).max(MAX_GRANTS),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seen = new Map<string, number>();
    p.grants.forEach((g, i) => {
      g.operations.forEach((op, j) => {
        const key = `${g.kind} ${op}`;
        const before = seen.get(key);
        if (before !== undefined && before !== i) ctx.addIssue({ code: "custom", path: ["grants", i, "operations", j], message: "another grant of this kind already names this operation" });
        if (before === undefined) seen.set(key, i);
      });
      if (NO_CREDENTIAL_KINDS.includes(g.kind) && g.credential !== "none") {
        ctx.addIssue({ code: "custom", path: ["grants", i, "credential"], message: 'must be "none": a tool of this kind has no sign-in' });
      }
      if (g.kind === "web" && g.operations.includes("search") && (g.targets.length !== 1 || g.targets[0] !== ALL_TARGETS.web)) {
        ctx.addIssue({ code: "custom", path: ["grants", i, "targets"], message: 'must be ["*"] for the operation search: a search names no host' });
      }
    });
  });
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

/** What a run keeps of the profile it resolved: its id, the version of its contents, and its hash (see toolProfileSha256). */
export const ToolProfileRefSchema = z.object({ ...ToolProfileIdentitySchema.shape, sha256: Sha256Schema }).strict();
export type ToolProfileRef = z.infer<typeof ToolProfileRefSchema>;

/**
 * What an adapter can do about one kind, each by itself:
 * - `deny-kind`: keep the agent from the whole kind when the profile does not grant it;
 * - `limit-operations`: allow some operations of the kind and not the others;
 * - `limit-targets`: allow the named targets and no other;
 * - `require-approval`: hold a call until a person has agreed;
 * - `timeout`, `concurrency`, `output-cap`: hold `timeoutMs`, `maxConcurrent` and `outputCapBytes` for each call.
 */
export const CONTROLS = ["deny-kind", "limit-operations", "limit-targets", "require-approval", "timeout", "concurrency", "output-cap"] as const;
export type Control = (typeof CONTROLS)[number];

/** `own-tools`: the agent has tools of its own for the kind. `shell`: it can only do this by running a command. */
export const REACH = ["own-tools", "shell"] as const;
/** Kinds an agent may reach through the shell only: repository operations. */
export const SHELL_REACH_KINDS: readonly ToolKind[] = ["git", "github"];

const KindCapabilitySchema = z
  .object({
    through: z.enum(REACH, known("a known way", REACH)),
    controls: z.array(z.enum(CONTROLS, known("a known control", CONTROLS))).refine(unique, "names the same control twice"),
  })
  .strict();
const levels = <T extends readonly [string, ...string[]]>(of: T) => z.array(z.enum(of, known("a known level", of))).min(1).refine(unique, "names the same level twice");

/**
 * What one agent program can be made to hold of a tool profile. A control that is not listed is one the adapter
 * cannot hold; nothing is assumed. The sign-in and the data class of a grant are not here: the Foundry decides what it
 * hands to a session, whatever the agent program.
 *
 * A kind the agent reaches `through: "shell"` has no control of its own (the adapter cannot tell such a command from
 * any other), so it is only held where the agent has no shell at all.
 */
export const AdapterCapabilitiesSchema = z
  .object({
    version: z.literal(ADAPTER_CAPABILITIES_VERSION),
    /** The agent program this is about. */
    agent: z.enum(AGENTS, known("a known agent", AGENTS)),
    /** Every kind, each with the controls the adapter can hold for it. */
    kinds: z.object({ files: KindCapabilitySchema, shell: KindCapabilitySchema, git: KindCapabilitySchema, github: KindCapabilitySchema, web: KindCapabilitySchema, mcp: KindCapabilitySchema, builtin: KindCapabilitySchema }).strict(),
    /** The sandbox levels the adapter can hold a command to. */
    sandbox: z.object({ filesystem: levels(SANDBOX_FILESYSTEM), network: levels(SANDBOX_NETWORK) }).strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const kind of TOOL_KINDS) {
      const k = c.kinds[kind];
      if (k.through === "shell" && !SHELL_REACH_KINDS.includes(kind)) ctx.addIssue({ code: "custom", path: ["kinds", kind, "through"], message: 'must be "own-tools": only git and github can be reached through the shell' });
      else if (k.through === "shell" && k.controls.length > 0) ctx.addIssue({ code: "custom", path: ["kinds", kind, "controls"], message: "must be empty for a kind that is reached through the shell" });
    }
  });
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;
