import type { AGENTS } from "../flow/schema.js";
import { parseAdapterCapabilities, parseToolProfile } from "./parse.js";
import { ALL_TARGETS, CONTROLS, OPERATIONS, SANDBOX_FILESYSTEM, SANDBOX_NETWORK, TOOL_KINDS, type AdapterCapabilities, type Control, type ToolKind, type ToolProfile } from "./schema.js";

/**
 * What an adapter cannot hold of a profile, and what the two adapters of today can hold. Pure.
 * Nothing here starts or changes an agent: a later story reads the answer and refuses, or holds the rest another way.
 */

/** What a profile can ask of an adapter: a control of a kind, or a sandbox level of the shell. */
export const RESTRICTIONS = [...CONTROLS, "sandbox-filesystem", "sandbox-network"] as const;
export type Restriction = (typeof RESTRICTIONS)[number];

/** One thing a profile needs that the adapter cannot hold. */
export interface EnforcementGap {
  kind: ToolKind;
  restriction: Restriction;
}

/** The controls a profile needs for one kind: only what it really restricts. */
function controlsNeeded(profile: ToolProfile, kind: ToolKind): Control[] {
  const grants = profile.grants.filter((g) => g.kind === kind);
  if (grants.length === 0) return ["deny-kind"];
  const needed: Control[] = [];
  if (new Set(grants.flatMap((g) => g.operations as readonly string[])).size < OPERATIONS[kind].length) needed.push("limit-operations");
  if (grants.some((g) => !g.targets.includes(ALL_TARGETS[kind]))) needed.push("limit-targets");
  if (grants.some((g) => g.approval === "required")) needed.push("require-approval");
  if (grants.some((g) => g.timeoutMs !== null)) needed.push("timeout");
  if (grants.some((g) => g.maxConcurrent !== null)) needed.push("concurrency");
  if (grants.some((g) => g.outputCapBytes !== null)) needed.push("output-cap");
  return needed;
}

/**
 * Everything this profile restricts that this adapter cannot hold, in the order of TOOL_KINDS and then RESTRICTIONS.
 * Empty: the adapter can hold the whole profile.
 *
 * - A kind the profile does not grant needs `deny-kind`. A granted kind needs `limit-operations` when not every
 *   operation of the kind is granted, `limit-targets` when a grant does not name every target, `require-approval`
 *   when a grant requires approval, and `timeout`, `concurrency` or `output-cap` when a grant sets that limit.
 * - A kind the agent reaches through the shell (see AdapterCapabilities) cannot be held at all while the agent can
 *   run commands: when the profile grants `shell`, or when the adapter cannot deny it. Then every control the
 *   profile needs for that kind is a gap.
 * - A `shell` grant needs a sandbox level the adapter can hold that is at most as permissive as the one it names.
 *
 * Throws ToolProfileSchemaError when the profile or the capabilities are not valid.
 */
export function unenforceable(profile: ToolProfile, capabilities: AdapterCapabilities): EnforcementGap[] {
  const p = parseToolProfile(profile);
  const c = parseAdapterCapabilities(capabilities);
  const shellGrants = p.grants.flatMap((g) => (g.kind === "shell" ? [g] : []));
  const canRunCommands = shellGrants.length > 0 || !c.kinds.shell.controls.includes("deny-kind");
  const gaps: EnforcementGap[] = [];
  for (const kind of TOOL_KINDS) {
    const has = c.kinds[kind];
    const needed = controlsNeeded(p, kind);
    const missing = has.through === "shell" ? (canRunCommands ? needed : []) : needed.filter((control) => !has.controls.includes(control));
    for (const restriction of CONTROLS) if (missing.includes(restriction)) gaps.push({ kind, restriction });
    if (kind !== "shell") continue;
    const held = <T extends string>(order: readonly T[], can: readonly T[], asked: T) => can.some((level) => order.indexOf(level) <= order.indexOf(asked));
    if (shellGrants.some((g) => !held(SANDBOX_FILESYSTEM, c.sandbox.filesystem, g.sandbox.filesystem))) gaps.push({ kind, restriction: "sandbox-filesystem" });
    if (shellGrants.some((g) => !held(SANDBOX_NETWORK, c.sandbox.network, g.sandbox.network))) gaps.push({ kind, restriction: "sandbox-network" });
  }
  return gaps;
}

/** Can this adapter hold the whole profile? */
export const canEnforce = (profile: ToolProfile, capabilities: AdapterCapabilities): boolean => unenforceable(profile, capabilities).length === 0;

/**
 * What the Claude Code adapter (`src/steps/claude.ts`) can hold with the options Claude Code has: the list of tools
 * (`--tools`), the permission mode with allow and deny rules per tool, command, path, host and MCP tool, the choice of
 * MCP servers (`--strict-mcp-config`), and its own sandbox for commands (writes stay in the workspace).
 * It cannot hold a command to "read-only" or keep it off the network, cannot hold a call for a person (a session has
 * nobody to ask), and sets no time, concurrency or output limit per call. Git and GitHub are commands like any other.
 */
export const CLAUDE_CODE_CAPABILITIES: AdapterCapabilities = parseAdapterCapabilities({
  version: 1,
  agent: "claude",
  kinds: {
    files: { through: "own-tools", controls: ["deny-kind", "limit-operations", "limit-targets"] },
    shell: { through: "own-tools", controls: ["deny-kind", "limit-targets"] },
    git: { through: "shell", controls: [] },
    github: { through: "shell", controls: [] },
    web: { through: "own-tools", controls: ["deny-kind", "limit-operations", "limit-targets"] },
    mcp: { through: "own-tools", controls: ["deny-kind", "limit-targets"] },
    builtin: { through: "own-tools", controls: ["deny-kind", "limit-targets"] },
  },
  sandbox: { filesystem: ["workspace-write", "unrestricted"], network: ["unrestricted"] },
});

/**
 * What the Codex adapter (`src/steps/codex.ts`) can hold with the options it passes: one sandbox mode for the whole
 * session (`read-only`, `workspace-write`, `danger-full-access`) and a session without MCP servers.
 * Codex has no list of allowed tools: its shell, its file tools and its other tools cannot be taken away one by one,
 * a command or a path cannot be allowed by name, and one MCP tool cannot be allowed without the rest of its server.
 * Writing files can be switched off (the read-only mode); reading cannot, and reads are not held to the workspace.
 * The adapter does not manage web search, the network of a command, approval or limits per call.
 */
export const CODEX_CAPABILITIES: AdapterCapabilities = parseAdapterCapabilities({
  version: 1,
  agent: "codex",
  kinds: {
    files: { through: "own-tools", controls: ["limit-operations"] },
    shell: { through: "own-tools", controls: [] },
    git: { through: "shell", controls: [] },
    github: { through: "shell", controls: [] },
    web: { through: "own-tools", controls: [] },
    mcp: { through: "own-tools", controls: ["deny-kind"] },
    builtin: { through: "own-tools", controls: [] },
  },
  sandbox: { filesystem: ["read-only", "workspace-write", "unrestricted"], network: ["unrestricted"] },
});

/** The capabilities of every agent program there is. A new agent does not build until it has an entry here. */
export const ADAPTER_CAPABILITIES: Record<(typeof AGENTS)[number], AdapterCapabilities> = { claude: CLAUDE_CODE_CAPABILITIES, codex: CODEX_CAPABILITIES };
