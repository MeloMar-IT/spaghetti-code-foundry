import { z } from "zod";
import { PERMISSION_MODES } from "../flow/schema.js";
import { CREDENTIALS } from "../policy/schema.js";
import type { SkillToolProfile } from "../skills/schema.js";
import { invalid, parseToolProfile } from "./parse.js";
import { assembleToolProfile, type OperationGrant } from "./resolve.js";
import { isTarget, type Sandbox, type ToolKind, type ToolProfile, type ToolProfileIdentity } from "./schema.js";

/**
 * The bridge to what exists today. Pure.
 *
 * - `legacyToolProfile`: the tool settings of a flow step (permission mode, allowed tools, sandbox) as a generated
 *   profile, so a flow written before tool profiles has one without being changed.
 * - `skillCapabilitiesOf`: a profile in the three words a skill uses for what it needs (`tool_profile` in skill.yaml:
 *   shell, network, filesystem). A skill's `tool_profile` is a need; a ToolProfile is what a session is given.
 */

/** The identity of every generated profile. The version is the version of the mapping below: raise it when a rule changes. */
export const LEGACY_PROFILE_IDENTITY: ToolProfileIdentity = { id: "generated.flow-settings", version: "1" };

/** The tool settings one agent step runs with, after the step, the flow defaults and the server settings are combined. */
export const LegacyToolSettingsSchema = z
  .object({
    /** The permission mode of the step. */
    permissionMode: z.enum(PERMISSION_MODES),
    /** The `allowed_tools` rules of the step, as written in the flow, e.g. "Read" or "Bash(npm test:*)". */
    allowedTools: z.array(z.string()),
    /** The agent's own sandbox is on for this step (never together with `boxed`). */
    sandbox: z.boolean(),
    /** The step runs inside the sandbox of a user's run. */
    boxed: z.boolean(),
    /** The step is given no tools of the agent at all. */
    noTools: z.boolean(),
    /** The session loads MCP servers (false for a session without the personal setup). */
    mcpServers: z.boolean(),
    /** The sign-in the session runs with. */
    credential: z.enum(CREDENTIALS),
  })
  .strict()
  .refine((s) => !(s.sandbox && s.boxed), { path: ["sandbox"], message: "must be false when boxed is true: the sandbox of the run holds the step" });
export type LegacyToolSettings = z.infer<typeof LegacyToolSettingsSchema>;

export interface LegacyToolProfile {
  profile: ToolProfile;
  /** Rules of `allowedTools` that have no meaning in a profile and so grant nothing, as written, each once. */
  unmapped: string[];
}

const FILE_READ = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const FILE_WRITE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RULE = /^([A-Za-z][A-Za-z0-9_]*)(?:\(([^]*)\))?$/;
const MCP_RULE = /^mcp__([A-Za-z0-9_.-]+?)(?:__([A-Za-z0-9_.*-]+))?$/;

/** A path rule as a files target: only a relative path whose every `*` is part of `**`. Anything else is not mapped. */
function filePattern(spec: string): string | undefined {
  const s = spec.trim().replace(/^\.\//, "");
  if (s.startsWith("/") || s.startsWith("~") || /(^|[^*])\*([^*]|$)/.test(s) || /\*{3,}/.test(s) || /[?[\]{}!]/.test(s)) return undefined;
  const pattern = s.replace(/\*\*/g, "*");
  return isTarget("files", pattern) ? pattern : undefined;
}

/** A command rule as shell targets. "npm test:*" is the command itself or the command with arguments. */
function shellPatterns(spec: string): string[] | undefined {
  const s = spec.trim();
  const patterns = s.endsWith(":*") ? [s.slice(0, -2), `${s.slice(0, -2)} *`] : [s];
  return patterns.every((p) => p.length > 0 && isTarget("shell", p)) ? patterns : undefined;
}

/**
 * The generated profile for the tool settings of one agent step. It names no agent program: the same settings give the
 * same profile for Claude Code and Codex.
 *
 * It follows what the settings mean today (`sessionTools` in src/skills/tool-policy.ts, `readOnlyStep`, `codexSandbox`):
 * - the files of the workspace can always be read; they can be written in the modes `acceptEdits`, `default`, `auto`
 *   and `bypassPermissions`, or when a rule names a writing tool;
 * - a shell is given in `auto` and `bypassPermissions`, by a `Bash` rule, or by the agent's own sandbox;
 * - web tools and MCP tools are given in `auto` and `bypassPermissions`, or by a rule; MCP only when servers are loaded;
 * - `plan` gives nothing but reading; `noTools` gives no tool of the agent at all;
 * - only `bypassPermissions` without any sandbox reaches files outside the workspace;
 * - the other tools of the agent program are not limited by any setting of today, so they are all granted.
 * No setting of today gives an agent a Git or GitHub operation, so none is granted: pushing is a decision of the flow.
 * No setting limits one call, asks for approval or classifies data, so every grant has no limit, no approval and the
 * highest data class. The time limit of a step stays a limit of the step.
 *
 * Throws ToolProfileSchemaError when the settings are not valid.
 */
export function legacyToolProfile(settings: LegacyToolSettings): LegacyToolProfile {
  const res = LegacyToolSettingsSchema.safeParse(settings);
  if (!res.success) throw invalid("profile", res.error.issues.map((i) => ({ path: ["settings", ...i.path.map(String)].join("."), message: i.message })));
  const s = res.data;
  const plan = s.permissionMode === "plan";
  const all = s.permissionMode === "bypassPermissions" || s.permissionMode === "auto";
  const everyFile = s.permissionMode === "bypassPermissions" && !s.sandbox && !s.boxed ? "/*" : "*";

  const unmapped: string[] = [];
  const write: string[] = [];
  const shell: string[] = [];
  const fetch: string[] = [];
  const mcp: string[] = [];
  let search = false;
  for (const raw of s.allowedTools) {
    const rule = raw.trim();
    const viaMcp = MCP_RULE.exec(rule);
    const m = RULE.exec(rule);
    const [name, spec] = [m?.[1] ?? "", m?.[2]];
    let ok = true;
    if (viaMcp) {
      const target = `${viaMcp[1]}/${viaMcp[2] ?? "*"}`;
      ok = s.mcpServers && isTarget("mcp", target);
      if (ok) mcp.push(target);
    } else if (!m) ok = false;
    else if (FILE_READ.has(name)) ok = spec === undefined || filePattern(spec) !== undefined;
    else if (FILE_WRITE.has(name)) {
      const target = spec === undefined ? everyFile : filePattern(spec);
      if (target) write.push(target);
      else ok = false;
    } else if (name === "Bash") {
      const targets = spec === undefined ? ["*"] : shellPatterns(spec);
      if (targets) shell.push(...targets);
      else ok = false;
    } else if (name === "WebFetch") {
      const host = spec === undefined ? "*" : /^domain:/.test(spec) ? spec.slice(7).trim().toLowerCase() : "";
      if (isTarget("web", host)) fetch.push(host);
      else ok = false;
    } else if (name === "WebSearch") {
      if (spec === undefined) search = true;
      else ok = false;
    }
    // Any other name is a tool of the agent program itself: all of those are granted below.
    if (!ok && !unmapped.includes(raw)) unmapped.push(raw);
  }

  const entries: OperationGrant[] = [];
  const give = (kind: ToolKind, operation: string, targets: string[], more: { credential?: OperationGrant["credential"]; sandbox?: Sandbox } = {}) =>
    entries.push({ kind, operation, targets, dataClassification: "restricted", credential: more.credential ?? "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none", ...(more.sandbox ? { sandbox: more.sandbox } : {}) });
  const rules = !plan;
  if (!s.noTools) {
    give("files", "read", [everyFile]);
    const writes = plan ? [] : all || s.permissionMode === "acceptEdits" || s.permissionMode === "default" ? [everyFile] : write;
    if (writes.length) give("files", "write", writes);
    const commands = plan ? [] : all || s.sandbox ? ["*"] : shell;
    if (commands.length) give("shell", "run", commands, { credential: s.credential, sandbox: { filesystem: s.sandbox || s.boxed ? "workspace-write" : "unrestricted", network: "unrestricted" } });
    const hosts = all ? ["*"] : rules ? fetch : [];
    if (hosts.length) give("web", "fetch", hosts);
    if (all || (rules && search)) give("web", "search", ["*"]);
    give("builtin", "call", ["*"]);
  }
  const servers = !s.mcpServers || plan ? [] : all ? ["*"] : mcp;
  if (servers.length) give("mcp", "call", servers, { credential: s.credential });
  return { profile: assembleToolProfile(LEGACY_PROFILE_IDENTITY, entries), unmapped };
}

/**
 * A profile in the words of a skill's `tool_profile`: is there a shell, are there web tools ("network"), and can
 * files be written, only read, or not touched. This is the one place the two notions meet: a skill says what it needs
 * in these three words, and a session can give it when the profile of the session has at least that.
 */
export function skillCapabilitiesOf(profile: ToolProfile): SkillToolProfile {
  const p = parseToolProfile(profile);
  const has = (kind: ToolKind, operation?: string) => p.grants.some((g) => g.kind === kind && (operation === undefined || (g.operations as readonly string[]).includes(operation)));
  return { shell: has("shell"), network: has("web"), filesystem: has("files", "write") ? "write" : has("files", "read") ? "read" : "none" };
}

const FILESYSTEM_ORDER: readonly SkillToolProfile["filesystem"][] = ["none", "read", "write"];

/** Does this profile give what a skill's `tool_profile` asks for? */
export function meetsSkillToolProfile(need: SkillToolProfile, profile: ToolProfile): boolean {
  const given = skillCapabilitiesOf(profile);
  return (!need.shell || given.shell) && (!need.network || given.network) && FILESYSTEM_ORDER.indexOf(need.filesystem) <= FILESYSTEM_ORDER.indexOf(given.filesystem);
}
