import type { z } from "zod";
import { AdapterCapabilitiesSchema, ToolProfileSchema, type AdapterCapabilities, type ToolProfile } from "./schema.js";
import { ADAPTER_CAPABILITIES_VERSION, TOOL_PROFILE_VERSION, ToolProfileSchemaError, toolContractName, type ToolContractIssue, type ToolContractKind } from "./version.js";

/**
 * Reading a tool-isolation contract: the version is looked at first, then the record is checked. Pure: these take the
 * parsed JSON, never a file name. Every failure is a ToolProfileSchemaError with a code and the fields that are wrong.
 */

/** The error for a record that is not valid: one line per field, with its place and what it must be. */
export function invalid(kind: ToolContractKind, issues: ToolContractIssue[]): ToolProfileSchemaError {
  return new ToolProfileSchemaError(kind, "invalid", `${toolContractName(kind)}: not valid\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`, issues);
}

function check<S extends z.ZodType>(schema: S, raw: unknown, kind: ToolContractKind, current: number): z.output<S> {
  const name = toolContractName(kind);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ToolProfileSchemaError(kind, "not-an-object", `${name}: not a JSON object`);
  const version = (raw as Record<string, unknown>).version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ToolProfileSchemaError(kind, "no-version", `${name}: "version" is missing or is not a whole number above 0`);
  }
  if (version !== current) {
    const why = version > current ? "It was written for a newer Foundry: update to read it" : "This Foundry can no longer read it";
    throw new ToolProfileSchemaError(kind, "unsupported-version", `${name}: version ${version} is not supported; this Foundry reads version ${current}. ${why}`);
  }
  const res = schema.safeParse(raw);
  if (res.success) return res.data;
  throw invalid(kind, res.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message })));
}

/** A tool profile of the current version. Throws ToolProfileSchemaError. */
export const parseToolProfile = (raw: unknown): ToolProfile => check(ToolProfileSchema, raw, "profile", TOOL_PROFILE_VERSION);
/** The capabilities of an adapter, of the current version. Throws ToolProfileSchemaError. */
export const parseAdapterCapabilities = (raw: unknown): AdapterCapabilities => check(AdapterCapabilitiesSchema, raw, "capabilities", ADAPTER_CAPABILITIES_VERSION);
