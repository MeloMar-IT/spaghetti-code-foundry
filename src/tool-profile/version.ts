/**
 * Versions of the tool-isolation contracts. Pure: no file access.
 * Every record carries its own `version`; a reader never guesses it. Raise a number for any change of shape or meaning
 * (a new kind of tool, a new operation, a new field).
 */

/** The version of the tool profile format (what a session may do with which tools). */
export const TOOL_PROFILE_VERSION = 1;
/** The version of the adapter capability format (what an agent program can be made to hold). */
export const ADAPTER_CAPABILITIES_VERSION = 1;

export type ToolContractKind = "profile" | "capabilities";
export type ToolContractErrorCode = "not-an-object" | "no-version" | "unsupported-version" | "invalid";

export interface ToolContractIssue {
  /** Where in the record, e.g. "grants.0.targets.1"; "(root)" for the record itself. */
  path: string;
  message: string;
}

const NAMES: Record<ToolContractKind, string> = { profile: "tool profile", capabilities: "adapter capabilities" };
export const toolContractName = (kind: ToolContractKind): string => NAMES[kind];

/** A record that cannot be read as a tool-isolation contract. The message names fields, never the values of the record. */
export class ToolProfileSchemaError extends Error {
  constructor(
    readonly kind: ToolContractKind,
    readonly code: ToolContractErrorCode,
    message: string,
    readonly issues: ToolContractIssue[] = [],
  ) {
    super(message);
    this.name = "ToolProfileSchemaError";
  }
}
