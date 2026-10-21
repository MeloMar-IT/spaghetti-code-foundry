import type { z } from "zod";
import { PolicyDecisionSchema, PolicyInputSchema, PolicyPackSchema, PolicyPackV1Schema, type PolicyDecision, type PolicyInput, type PolicyPack } from "./schema.js";
import { POLICY_DECISION_VERSION, POLICY_INPUT_VERSION, POLICY_PACK_VERSION, POLICY_PACK_VERSIONS, PolicySchemaError, policyKindName, type PolicyIssue, type PolicyKind } from "./version.js";

/**
 * Reading a policy contract: the version is looked at first, then the record is checked. Pure: these take the parsed
 * JSON, never a file name. Every failure is a PolicySchemaError with a code and the fields that are wrong.
 */

/** `schemaFor` gives the schema of a version this build reads; versions from `oldest` to `current` are read. */
function check<T>(schemaFor: (version: number) => z.ZodType<T> | undefined, raw: unknown, kind: PolicyKind, current: number, oldest = current): T {
  const name = policyKindName(kind);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new PolicySchemaError(kind, "not-an-object", `${name}: not a JSON object`);
  const version = (raw as Record<string, unknown>).version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new PolicySchemaError(kind, "no-version", `${name}: "version" is missing or is not a whole number above 0`);
  }
  const schema = version > current || version < oldest ? undefined : schemaFor(version);
  if (schema === undefined) {
    const why = version > current ? "It was written for a newer Foundry: update to read it" : "This Foundry can no longer read it";
    const reads = oldest === current ? `version ${current}` : `versions ${oldest} to ${current}`;
    throw new PolicySchemaError(kind, "unsupported-version", `${name}: version ${version} is not supported; this Foundry reads ${reads}. ${why}`);
  }
  const res = schema.safeParse(raw);
  if (res.success) return res.data;
  const issues: PolicyIssue[] = res.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
  throw new PolicySchemaError(kind, "invalid", `${name}: not valid\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`, issues);
}

/** A policy pack of version 1 or 2, each read with its own schema and given back as written. Throws PolicySchemaError. */
export const parsePolicyPack = (raw: unknown): PolicyPack =>
  check<PolicyPack>((v) => (v === 1 ? (PolicyPackV1Schema as z.ZodType<PolicyPack>) : v === POLICY_PACK_VERSION ? (PolicyPackSchema as z.ZodType<PolicyPack>) : undefined), raw, "pack", POLICY_PACK_VERSION, POLICY_PACK_VERSIONS[0]);
/** A policy input of the current version. Throws PolicySchemaError. */
export const parsePolicyInput = (raw: unknown): PolicyInput => check(() => PolicyInputSchema, raw, "input", POLICY_INPUT_VERSION);
/** A policy decision of the current version. Throws PolicySchemaError. */
export const parsePolicyDecision = (raw: unknown): PolicyDecision => check(() => PolicyDecisionSchema, raw, "decision", POLICY_DECISION_VERSION);
