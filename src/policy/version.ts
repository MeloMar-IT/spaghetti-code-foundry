/**
 * Versions of the policy contracts. Pure: no file access.
 * Every record carries its own `version`; a reader never guesses it. Raise a number for any change of shape or meaning.
 */

/** The version of the policy pack format (the file an administrator writes). */
export const POLICY_PACK_VERSION = 2;
/** Every version of the pack format this build reads, oldest first. A pack of an older version is read and hashed as written. */
export const POLICY_PACK_VERSIONS = [1, 2] as const;
/** The version of the policy input format (what is asked). */
export const POLICY_INPUT_VERSION = 2;
/** The version of the policy decision format (what was answered). */
export const POLICY_DECISION_VERSION = 1;

export type PolicyKind = "pack" | "input" | "decision";
export type PolicyErrorCode = "not-an-object" | "no-version" | "unsupported-version" | "invalid";

export interface PolicyIssue {
  /** Where in the record, e.g. "rules.0.when.branch"; "(root)" for the record itself. */
  path: string;
  message: string;
}

const NAMES: Record<PolicyKind, string> = { pack: "policy pack", input: "policy input", decision: "policy decision" };
export const policyKindName = (kind: PolicyKind): string => NAMES[kind];

/** A record that cannot be read as a policy contract. The message names fields, never the values of the record. */
export class PolicySchemaError extends Error {
  constructor(
    readonly kind: PolicyKind,
    readonly code: PolicyErrorCode,
    message: string,
    readonly issues: PolicyIssue[] = [],
  ) {
    super(message);
    this.name = "PolicySchemaError";
  }
}
