import { MCP_TOOL_PREFIX, TOOL_EFFECTS } from "./normalize-rules.js";

// What a skill assumes about its provider: Claude's tools, MCP servers, the Claude apps, the Anthropic API. Found in the
// declared tools, `compatibility` and the instructions. Pure. It declares only; it never grants a tool or blocks a skill.

export const PROVIDER_ASSUMPTIONS = ["claude-tools", "mcp-servers", "claude-surface", "anthropic-api"] as const;
export type ProviderAssumption = (typeof PROVIDER_ASSUMPTIONS)[number];

const keys = Object.keys(TOOL_EFFECTS);
// A key with an inner capital cannot be an everyday word: it matches as a whole word.
const camel = keys.filter((k) => /[a-z][A-Z]/.test(k));
// A key that is also a plain word matches only as "the `Read` tool".
const plain = keys.filter((k) => !/[a-z][A-Z]/.test(k));
const CAMEL_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${camel.join("|")})(?![A-Za-z0-9_])`);
const PLAIN_RE = new RegExp(`(?<![A-Za-z0-9_])\`?(?:${plain.join("|")})\`? tool(?![A-Za-z0-9_])`);
const MCP_RE = /\bmcp__[A-Za-z0-9_-]+/;
const SURFACE_RE = /\bclaude\.ai\b|\bclaude code\b|\bclaude desktop\b|\/mnt\/(?:skills|user-data)\b/i;
const API_RE = /\bapi\.anthropic\.com\b|\bANTHROPIC_API_KEY\b|\banthropic api\b|@anthropic-ai\//i;

export function providerAssumptions(input: { requiredTools: readonly string[]; compatibility?: string; instructions: string }): ProviderAssumption[] {
  const { requiredTools, compatibility = "", instructions } = input;
  const found = new Set<ProviderAssumption>();
  if (requiredTools.some((t) => !t.startsWith(MCP_TOOL_PREFIX)) || CAMEL_RE.test(instructions) || PLAIN_RE.test(instructions)) found.add("claude-tools");
  if (requiredTools.some((t) => t.startsWith(MCP_TOOL_PREFIX)) || MCP_RE.test(instructions)) found.add("mcp-servers");
  if (SURFACE_RE.test(compatibility) || SURFACE_RE.test(instructions)) found.add("claude-surface");
  if (API_RE.test(instructions) || API_RE.test(compatibility)) found.add("anthropic-api");
  return PROVIDER_ASSUMPTIONS.filter((c) => found.has(c));
}
