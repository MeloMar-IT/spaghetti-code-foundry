import { sha256Hex, TimeSchema, type PolicyIdentity } from "../evidence/identity.js";
import type { Denial } from "../evidence/schema.js";
import { parsePolicyDecision, parsePolicyInput, parsePolicyPack } from "./parse.js";
import type { Conditions, FactName, Facts, PolicyDecision, PolicyInput, PolicyPack, PolicyRule } from "./schema.js";
import { POLICY_DECISION_VERSION, PolicySchemaError } from "./version.js";

/**
 * Deciding: a pack, an input and a moment give one decision. Pure and deterministic: no file, no network, no model,
 * no clock (the caller gives the time) and no randomness. The same three arguments always give the same decision.
 */

/**
 * The one text form of a JSON value that hashes are made of: object keys in code-unit order, no spaces, arrays in
 * their own order. Only plain JSON values; anything else (undefined, a function, NaN, a class instance) is refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: not a finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  throw new TypeError("canonicalJson: not a JSON value");
}

/** The SHA-256 of a pack (after it is checked). Two packs with the same contents have the same hash, whatever the order of their keys. */
export const policyPackSha256 = (pack: PolicyPack): string => sha256Hex(canonicalJson(parsePolicyPack(pack)));
/** The SHA-256 of an input (after it is checked). The order of `facts.paths` counts: give the paths sorted. */
export const policyInputSha256 = (input: PolicyInput): string => sha256Hex(canonicalJson(parsePolicyInput(input)));

/** Does the text match the pattern? `*` stands for any characters (also none); every other character stands for itself. */
export function matchesPattern(pattern: string, text: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

const anyPattern = (list: readonly string[], text: string): boolean => list.some((p) => matchesPattern(p, text));
const listed = <T>(c: { in?: readonly T[]; notIn?: readonly T[] }, hit: (list: readonly T[]) => boolean): boolean => (c.in !== undefined ? hit(c.in) : !hit(c.notIn ?? []));

/** One condition against its fact, for every fact there is. */
const TESTS: { [K in FactName]-?: (c: NonNullable<Conditions[K]>, fact: NonNullable<Facts[K]>) => boolean } = {
  repository: (c, f) => listed(c, (l) => anyPattern(l, f)),
  branch: (c, f) => listed(c, (l) => anyPattern(l, f)),
  flow: (c, f) => listed(c, (l) => anyPattern(l, f)),
  step: (c, f) => listed(c, (l) => anyPattern(l, f)),
  tool: (c, f) => listed(c, (l) => anyPattern(l, f)),
  workspace: (c, f) => listed(c, (l) => l.includes(f)),
  owner: (c, f) => listed(c, (l) => l.includes(f)),
  credential: (c, f) => listed(c, (l) => l.includes(f)),
  paths: (c, f) => f.some((path) => anyPattern(c.anyIn, path)),
  secretsFound: (c, f) => f > c.over,
  outputBytes: (c, f) => f > c.over,
  elapsedMs: (c, f) => f > c.over,
  stepCostUsd: (c, f) => f > c.over,
  runCostUsd: (c, f) => f > c.over,
  dailyCostUsd: (c, f) => f > c.over,
  sandboxed: (c, f) => c === f,
  isolated: (c, f) => c === f,
  shippedFlow: (c, f) => c === f,
  commitIdentity: (c, f) => c === f,
  issueClosed: (c, f) => c === f,
  flowRetired: (c, f) => c === f,
};

/** The facts a rule looks at, in the order of their names. */
export const factsNeeded = (rule: Pick<PolicyRule, "when">): FactName[] => (Object.keys(rule.when) as FactName[]).filter((k) => rule.when[k] !== undefined).sort();

type RuleResult = "applies" | "does-not-apply" | "fact-missing";

function test(rule: PolicyRule, facts: Facts): RuleResult {
  const names = factsNeeded(rule);
  // A missing fact counts before any condition that is false, so the answer does not depend on which was looked at first.
  if (names.some((name) => facts[name] === undefined)) return "fact-missing";
  const holds = names.every((name) => (TESTS[name] as (c: unknown, f: unknown) => boolean)(rule.when[name], facts[name]));
  return holds ? "applies" : "does-not-apply";
}

/**
 * The decision of one pack about one input.
 *
 * The rules are read from the first to the last. A rule that does not name the boundary of the input is passed over.
 * The first rule whose conditions all hold decides: its outcome, its reason code. A rule that needs a fact the input
 * does not have cannot be judged, and the answer is then "deny" with `policy.input-incomplete` and the id of that
 * rule: an unknown never allows. When no rule applies, `defaultOutcome` decides with `policy.no-rule-matched`.
 *
 * `mode` is the mode of the rule that decided, or the mode of the pack when that rule has none or no rule decided. It
 * changes nothing in the answer: in `observe` the same decision is made and the caller only records it.
 *
 * Throws PolicySchemaError when the pack, the input or the time is not valid: nothing is decided on bad data.
 */
export function evaluatePolicy(pack: PolicyPack, input: PolicyInput, evaluatedAt: string): PolicyDecision {
  const p = parsePolicyPack(pack);
  const i = parsePolicyInput(input);
  if (!TimeSchema.safeParse(evaluatedAt).success) {
    throw new PolicySchemaError("decision", "invalid", "policy decision: not valid\n  - evaluatedAt: must be a UTC time such as 2026-01-31T12:00:00.000Z", [{ path: "evaluatedAt", message: "must be a UTC time such as 2026-01-31T12:00:00.000Z" }]);
  }
  const head = {
    version: POLICY_DECISION_VERSION,
    policy: { id: p.policy.id, version: p.policy.version },
    packSha256: sha256Hex(canonicalJson(p)),
    boundary: i.boundary,
    inputSha256: sha256Hex(canonicalJson(i)),
  } as const;
  for (const rule of p.rules) {
    if (!rule.boundaries.includes(i.boundary)) continue;
    const result = test(rule, i.facts);
    if (result === "does-not-apply") continue;
    const answer = result === "applies" ? ({ outcome: rule.outcome, reasonCode: rule.reasonCode } as const) : ({ outcome: "deny", reasonCode: "policy.input-incomplete" } as const);
    return parsePolicyDecision({ ...head, mode: rule.mode ?? p.mode, ...answer, rule: rule.id, evaluatedAt });
  }
  return parsePolicyDecision({ ...head, mode: p.mode, outcome: p.defaultOutcome, reasonCode: "policy.no-rule-matched", evaluatedAt });
}

/** The policy identity evidence carries for a decision: the id and the version of the pack that decided. */
export const policyIdentityOf = (decision: Pick<PolicyDecision, "policy">): PolicyIdentity => ({ id: decision.policy.id, version: decision.policy.version });

/**
 * The `denial` of a `step.denied` evidence event for a decision; undefined when the decision did not refuse anything:
 * any outcome but "deny", or a decision in `observe` mode (it only says what it would have done). `tool` is the tool the
 * question was about, when it was about one.
 */
export function policyDenial(decision: PolicyDecision, tool?: string): Denial | undefined {
  if (decision.outcome !== "deny" || decision.mode !== "enforce") return undefined;
  return { kind: "policy", policy: policyIdentityOf(decision), reasonCode: decision.reasonCode, ...(tool !== undefined ? { tool: { name: tool } } : {}) };
}
