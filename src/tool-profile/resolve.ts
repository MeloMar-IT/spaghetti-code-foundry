import { sha256Hex } from "../evidence/identity.js";
import type { Denial } from "../evidence/schema.js";
import { canonicalJson, matchesPattern } from "../policy/evaluate.js";
import type { RuleReasonCode } from "../policy/reasons.js";
import { invalid, parseToolProfile } from "./parse.js";
import {
  CREDENTIAL_ORDER, DATA_CLASSES, isTarget, OPERATIONS, SANDBOX_FILESYSTEM, SANDBOX_NETWORK, TOOL_KINDS, ToolProfileIdentitySchema, ToolProfileRefSchema,
  type ApprovalRequirement, type Credential, type DataClass, type Sandbox, type ToolKind, type ToolProfile, type ToolProfileIdentity, type ToolProfileRef,
} from "./schema.js";
import { TOOL_PROFILE_VERSION } from "./version.js";

/**
 * Working with tool profiles: one canonical form and its hash, "is this profile at most as permissive as that one",
 * the least-privilege result of several profiles, and the answer for one call. Pure and deterministic.
 * Every function checks the profiles it is given first and throws ToolProfileSchemaError: nothing is decided on bad data.
 */

/** One operation of one kind with everything its grant declares: the unit all comparing is done in. */
export interface OperationGrant {
  kind: ToolKind;
  operation: string;
  targets: string[];
  dataClassification: DataClass;
  credential: Credential;
  timeoutMs: number | null;
  maxConcurrent: number | null;
  outputCapBytes: number | null;
  approval: ApprovalRequirement;
  /** Set for the kind `shell`, and only for it. */
  sandbox?: Sandbox;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rank = <T extends string>(order: readonly T[], value: T) => order.indexOf(value);

/** Every operation a profile grants, one entry each. */
export function operationGrants(profile: ToolProfile): OperationGrant[] {
  return parseToolProfile(profile).grants.flatMap((g) => {
    const { kind, operations, targets, ...rest } = g;
    const sandbox = g.kind === "shell" ? { sandbox: { ...g.sandbox } } : {};
    return operations.map((operation) => ({ kind, operation, ...rest, targets: [...targets], ...sandbox }));
  });
}

/**
 * The profile that grants exactly these operations, in its canonical form: operations with the same targets and
 * conditions share one grant, grants are in the order of TOOL_KINDS, operations in the order of OPERATIONS and targets
 * in code-unit order, each once. Throws ToolProfileSchemaError when the result is not a valid profile.
 */
export function assembleToolProfile(identity: ToolProfileIdentity, entries: readonly OperationGrant[]): ToolProfile {
  const groups = new Map<string, { rest: Omit<OperationGrant, "operation">; operations: string[] }>();
  for (const { operation, ...e } of entries) {
    const rest = { ...e, targets: [...new Set(e.targets)].sort(byText) };
    const key = canonicalJson(rest);
    const group = groups.get(key) ?? { rest, operations: [] };
    group.operations.push(operation);
    groups.set(key, group);
  }
  const place = (kind: ToolKind, operation: string) => (OPERATIONS[kind] as readonly string[]).indexOf(operation);
  const grants = [...groups.values()]
    .map(({ rest, operations }) => ({ ...rest, operations: [...operations].sort((a, b) => place(rest.kind, a) - place(rest.kind, b)) }))
    .sort((a, b) => TOOL_KINDS.indexOf(a.kind) - TOOL_KINDS.indexOf(b.kind) || place(a.kind, a.operations[0]!) - place(b.kind, b.operations[0]!));
  return parseToolProfile({ version: TOOL_PROFILE_VERSION, profile: identity, grants });
}

/** The canonical form of a profile (see assembleToolProfile). Two profiles that grant the same have the same form. */
export function normalizeToolProfile(profile: ToolProfile): ToolProfile {
  const p = parseToolProfile(profile);
  const base = assembleToolProfile(p.profile, operationGrants(p));
  // Descriptions count only when there is one: a profile without them keeps the hash it always had.
  return p.descriptions && Object.keys(p.descriptions).length > 0 ? { ...base, descriptions: { ...p.descriptions } } : base;
}

/** The SHA-256 of a profile: of the canonical JSON of its canonical form, so the order it was written in does not count. */
export const toolProfileSha256 = (profile: ToolProfile): string => sha256Hex(canonicalJson(normalizeToolProfile(profile)));

/** What a run keeps of a profile: its id, the version of its contents and its hash. */
export function toolProfileRef(profile: ToolProfile): ToolProfileRef {
  const p = parseToolProfile(profile);
  return ToolProfileRefSchema.parse({ id: p.profile.id, version: p.profile.version, sha256: toolProfileSha256(p) });
}

/** What joins or redirects commands in a command line: ; & | < > a backquote, "$(" and a line break. */
const SHELL_JOIN = /[;&|<>`\n\r]|\$\(/;

/**
 * Does the pattern of a profile allow this target? The target is read as plain text.
 * - For files, a relative path (in the workspace) and a path of the machine are never compared, except that "/*"
 *   allows every file.
 * - For the shell, a command line that joins or redirects commands (see SHELL_JOIN) is only allowed by the target "*":
 *   a pattern is text, not a parser, and cannot tell what the second command is.
 */
export function targetCovers(kind: ToolKind, pattern: string, target: string): boolean {
  if (kind === "files" && pattern.startsWith("/") !== target.startsWith("/")) return pattern === "/*";
  if (kind === "shell" && pattern !== "*" && SHELL_JOIN.test(target)) return false;
  return matchesPattern(pattern, target);
}

/**
 * Is everything pattern `inner` allows also allowed by pattern `outer`? Never yes when it is not so; for two unusual
 * patterns that happen to allow the same it may say no, which only makes a result narrower.
 */
export const patternWithin = (kind: ToolKind, inner: string, outer: string): boolean => targetCovers(kind, outer, inner);

const targetsWithin = (kind: ToolKind, inner: readonly string[], outer: readonly string[]) => inner.every((t) => outer.some((o) => patternWithin(kind, t, o)));
/** True when limit `a` allows more than limit `b` (null: no limit). */
const over = (a: number | null, b: number | null) => b !== null && (a === null || a > b);
const lower = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const stricter = <T extends string>(order: readonly T[], a: T, b: T): T => (rank(order, a) <= rank(order, b) ? a : b);

/** The parts of a grant in which one profile can allow more than another. */
export const EXCESS_FIELDS = ["operation", "targets", "dataClassification", "credential", "timeoutMs", "maxConcurrent", "outputCapBytes", "approval", "sandbox.filesystem", "sandbox.network"] as const;
export type ExcessField = (typeof EXCESS_FIELDS)[number];
/** One point where a profile allows more than the profile it is compared with. `operation`: the other does not grant it at all. */
export interface Excess {
  kind: ToolKind;
  operation: string;
  field: ExcessField;
}

/**
 * Every point where profile `a` allows more than profile `b`, in the order of the canonical form of `a`.
 * Empty: `a` is at most as permissive as `b`.
 */
export function toolProfileExcess(a: ToolProfile, b: ToolProfile): Excess[] {
  const other = new Map(operationGrants(b).map((e) => [`${e.kind} ${e.operation}`, e]));
  const out: Excess[] = [];
  for (const e of operationGrants(normalizeToolProfile(a))) {
    const o = other.get(`${e.kind} ${e.operation}`);
    const add = (field: ExcessField) => out.push({ kind: e.kind, operation: e.operation, field });
    if (!o) {
      add("operation");
      continue;
    }
    if (!targetsWithin(e.kind, e.targets, o.targets)) add("targets");
    if (rank(DATA_CLASSES, e.dataClassification) > rank(DATA_CLASSES, o.dataClassification)) add("dataClassification");
    if (rank(CREDENTIAL_ORDER, e.credential) > rank(CREDENTIAL_ORDER, o.credential)) add("credential");
    if (over(e.timeoutMs, o.timeoutMs)) add("timeoutMs");
    if (over(e.maxConcurrent, o.maxConcurrent)) add("maxConcurrent");
    if (over(e.outputCapBytes, o.outputCapBytes)) add("outputCapBytes");
    if (e.approval === "none" && o.approval === "required") add("approval");
    if (e.sandbox && o.sandbox) {
      if (rank(SANDBOX_FILESYSTEM, e.sandbox.filesystem) > rank(SANDBOX_FILESYSTEM, o.sandbox.filesystem)) add("sandbox.filesystem");
      if (rank(SANDBOX_NETWORK, e.sandbox.network) > rank(SANDBOX_NETWORK, o.sandbox.network)) add("sandbox.network");
    }
  }
  return out;
}

/** Is profile `a` at most as permissive as profile `b`: does it allow nothing that `b` does not? */
export const isAtMostAsPermissive = (a: ToolProfile, b: ToolProfile): boolean => toolProfileExcess(a, b).length === 0;

/**
 * The least-privilege result of several profiles (for example the ceiling of the administrator, the profile of a flow
 * and the one of a step): what all of them allow, under the strictest condition any of them sets.
 * - An operation stays only when every profile grants it.
 * - A target stays only when every profile has a target that allows all of it. Two targets that overlap in part are
 *   both dropped, and an operation that keeps no target is dropped.
 * - Of every condition the strictest one is taken: the lowest data class, sign-in, limit and sandbox level, and
 *   approval as soon as one profile requires it.
 * The result is at most as permissive as each of the profiles and does not depend on the order they are given in.
 * `identity` names the result; the profiles keep their own.
 *
 * Throws ToolProfileSchemaError when there is no profile, or when one of them or the identity is not valid.
 */
export function resolveToolProfile(identity: ToolProfileIdentity, profiles: readonly ToolProfile[]): ToolProfile {
  const id = ToolProfileIdentitySchema.safeParse(identity);
  if (!id.success) throw invalid("profile", id.error.issues.map((i) => ({ path: ["profile", ...i.path.map(String)].join("."), message: i.message })));
  if (profiles.length === 0) throw invalid("profile", [{ path: "(root)", message: "at least one profile is needed to resolve" }]);
  const layers = profiles.map((p) => new Map(operationGrants(p).map((e) => [`${e.kind} ${e.operation}`, e])));
  const out: OperationGrant[] = [];
  for (const [key, first] of layers[0]!) {
    const all = layers.map((l) => l.get(key));
    if (!all.every((e): e is OperationGrant => e !== undefined)) continue;
    const targets = all.flatMap((e) => e.targets).filter((t) => all.every((e) => e.targets.some((p) => patternWithin(first.kind, t, p))));
    if (targets.length === 0) continue;
    const pick = <T extends string>(order: readonly T[], of: (e: OperationGrant) => T): T => all.map(of).reduce((a, b) => stricter(order, a, b));
    out.push({
      kind: first.kind,
      operation: first.operation,
      targets,
      dataClassification: pick(DATA_CLASSES, (e) => e.dataClassification),
      credential: pick(CREDENTIAL_ORDER, (e) => e.credential),
      timeoutMs: all.map((e) => e.timeoutMs).reduce(lower),
      maxConcurrent: all.map((e) => e.maxConcurrent).reduce(lower),
      outputCapBytes: all.map((e) => e.outputCapBytes).reduce(lower),
      approval: all.some((e) => e.approval === "required") ? "required" : "none",
      ...(first.sandbox ? { sandbox: { filesystem: pick(SANDBOX_FILESYSTEM, (e) => e.sandbox!.filesystem), network: pick(SANDBOX_NETWORK, (e) => e.sandbox!.network) } } : {}),
    });
  }
  return assembleToolProfile(id.data, out);
}

/** One use of a tool that is asked for. Plain text: a kind or an operation the format does not know is refused, not an error. */
export interface ToolCall {
  kind: string;
  operation: string;
  /** What the call is about: a path, a command line, a repository, a host, an MCP tool as "server/tool", or a tool name. */
  target: string;
}

export const CALL_REFUSALS = ["unknown-kind", "unknown-operation", "invalid-target", "kind-not-granted", "operation-not-granted", "target-not-granted"] as const;
export type CallRefusal = (typeof CALL_REFUSALS)[number];

export type ToolCallDecision =
  | { outcome: "allow" }
  | { outcome: "require_approval"; reasonCode: Extract<RuleReasonCode, "approval.required"> }
  | { outcome: "deny"; reasonCode: Extract<RuleReasonCode, "tool.not-allowed" | "repository.not-allowed">; refusal: CallRefusal };

const isKind = (kind: string): kind is ToolKind => (TOOL_KINDS as readonly string[]).includes(kind);
const REPOSITORY_KINDS: readonly ToolKind[] = ["git", "github"];

/**
 * May this call happen under this profile? Closed: the answer is "deny" unless a grant names the kind, the operation
 * and a target that covers the target of the call. The outcomes and reason codes are those of the policy contracts:
 * `tool.not-allowed`, `repository.not-allowed` for a repository that is not a target, and `approval.required`.
 */
export function checkToolCall(profile: ToolProfile, call: ToolCall): ToolCallDecision {
  const p = parseToolProfile(profile);
  const deny = (refusal: CallRefusal, reasonCode: "tool.not-allowed" | "repository.not-allowed" = "tool.not-allowed"): ToolCallDecision => ({ outcome: "deny", reasonCode, refusal });
  if (typeof call.kind !== "string" || !isKind(call.kind)) return deny("unknown-kind");
  const kind = call.kind;
  if (typeof call.operation !== "string" || !(OPERATIONS[kind] as readonly string[]).includes(call.operation)) return deny("unknown-operation");
  if (typeof call.target !== "string" || !isTarget(kind, call.target)) return deny("invalid-target");
  const ofKind = p.grants.filter((g) => g.kind === kind);
  if (ofKind.length === 0) return deny("kind-not-granted");
  const grant = ofKind.find((g) => (g.operations as readonly string[]).includes(call.operation));
  if (!grant) return deny("operation-not-granted");
  if (!grant.targets.some((pattern) => targetCovers(kind, pattern, call.target))) return deny("target-not-granted", REPOSITORY_KINDS.includes(kind) ? "repository.not-allowed" : "tool.not-allowed");
  return grant.approval === "required" ? { outcome: "require_approval", reasonCode: "approval.required" } : { outcome: "allow" };
}

/** The name evidence and policy facts use for an operation of a kind, e.g. "git.push". */
export const toolNameOf = (kind: ToolKind, operation: string): string => `${kind}.${operation}`;

/** The `denial` of a `step.denied` evidence event for a call a profile refused; undefined when the decision is not "deny" or the kind is not a known one. */
export function toolCallDenial(call: ToolCall, decision: ToolCallDecision): Denial | undefined {
  if (decision.outcome !== "deny" || !isKind(call.kind) || !(OPERATIONS[call.kind] as readonly string[]).includes(call.operation)) return undefined;
  return { kind: "tool", tool: { name: toolNameOf(call.kind, call.operation) } };
}
