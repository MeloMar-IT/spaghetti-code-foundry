import { AGENTS } from "../flow/schema.js";
import { ADAPTER_CAPABILITIES, RESTRICTIONS, unenforceable, type EnforcementGap, type Restriction } from "./adapters.js";
import { LEGACY_PROFILE_IDENTITY, legacyToolProfile, type LegacyToolSettings } from "./legacy.js";
import { parseToolProfile } from "./parse.js";
import { toolProfileExcess, toolProfileRef, type Excess, type ExcessField } from "./resolve.js";
import { SANDBOX_FILESYSTEM, TOOL_KINDS, type ToolKind, type ToolProfile, type ToolProfileRef } from "./schema.js";
import { ToolProfileSchemaError } from "./version.js";

/**
 * The tool profile of one agent session, and how well one agent can hold it. Pure: no engine types, no files.
 *
 * - A session has one profile: the one generated from the step's settings (only recorded), or a declared one (checked,
 *   and refused when the settings allow more than it, or when the agent cannot hold it).
 * - The mapping from a declared profile to the settings only narrows. It never turns on Claude's sandbox (that would
 *   auto-allow Bash) and never makes the Codex sandbox wider than today.
 */

type Agent = (typeof AGENTS)[number];

export const PROFILE_SOURCES = ["generated", "declared"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];
export const FIT_OUTCOMES = ["enforced", "partial", "refused"] as const;
export type FitOutcome = (typeof FIT_OUTCOMES)[number];
export const FIT_RESTRICTIONS = [...RESTRICTIONS, "data-class"] as const;
export type FitRestriction = Restriction | "data-class";
export const HELD_BY = ["codex-sandbox"] as const;
/** Why a declared profile could not be read (the codes of ToolProfileSchemaError, or "error" for anything else). */
export const UNREADABLE = ["not-an-object", "no-version", "unsupported-version", "invalid", "error"] as const;
/** Fields the settings cannot say: the data class and the network of a command. They go through their own checks. */
export const NOT_FROM_SETTINGS: readonly ExcessField[] = ["dataClassification", "sandbox.network"];

export interface FitGap {
  kind: ToolKind;
  restriction: FitRestriction;
}
export interface HeldGap extends FitGap {
  by: (typeof HELD_BY)[number];
}
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export interface SessionMapping {
  claudeSandbox: boolean;
  codexSandbox: CodexSandboxMode;
}
export interface ToolSession {
  source: ProfileSource;
  profile: ToolProfile;
  ref: ToolProfileRef;
  settings: LegacyToolSettings;
  /** The profile the settings give. */
  generated: ToolProfile;
  /** Where the settings allow more than a declared profile. */
  excess: Excess[];
  /** Rules of `allowed_tools` that have no meaning in a profile. */
  unmappedRules: number;
  /** Kinds a declared profile grants with a data class below `restricted`. */
  dataClassGaps: FitGap[];
}
export interface AgentFacts {
  agent: Agent;
  /** The session would load the personal setup of the machine. */
  personalSetup: boolean;
  codex?: { sandbox: CodexSandboxMode; shellFilesystem: (typeof SANDBOX_FILESYSTEM)[number]; noNetwork: boolean };
  /** The settings the session really gets; the excess is checked once more against them. */
  mapping?: SessionMapping;
}
export interface AdapterFit {
  agent?: Agent;
  outcome: FitOutcome;
  unsupported: FitGap[];
  held: HeldGap[];
  excess: Excess[];
  dataClassGaps: FitGap[];
  unmappedRules: number;
  personalSetup: boolean;
}

/** A declared profile of the current version. The id of generated profiles is reserved. Throws ToolProfileSchemaError (its message names no value). */
export function declaredToolProfile(raw: unknown): ToolProfile {
  const parsed = parseToolProfile(raw);
  if (parsed.profile.id === LEGACY_PROFILE_IDENTITY.id) {
    throw new ToolProfileSchemaError("profile", "invalid", "tool profile: not valid", [{ path: "profile.id", message: "is reserved for generated profiles" }]);
  }
  return parsed;
}

/** The declared profile as plain JSON (what run.json keeps), or null when it cannot be read or saved. Never throws. */
export function snapshotToolProfile(raw: unknown): ToolProfile | null {
  try {
    return JSON.parse(JSON.stringify(declaredToolProfile(raw))) as ToolProfile;
  } catch {
    return null;
  }
}

/** Where the generated profile `settingsProfile` allows more than `declared`, leaving out what settings cannot say. */
export function settingsExcess(settingsProfile: ToolProfile, declared: ToolProfile): Excess[] {
  return toolProfileExcess(settingsProfile, declared).filter((e) => !NOT_FROM_SETTINGS.includes(e.field));
}

export function toolSession(settings: LegacyToolSettings, declared?: ToolProfile): ToolSession {
  const g = legacyToolProfile(settings);
  if (!declared) {
    return { source: "generated", profile: g.profile, ref: toolProfileRef(g.profile), settings, generated: g.profile, excess: [], unmappedRules: g.unmapped.length, dataClassGaps: [] };
  }
  const kinds = new Set(declared.grants.filter((x) => x.dataClassification !== "restricted").map((x) => x.kind));
  return {
    source: "declared",
    profile: declared,
    ref: toolProfileRef(declared),
    settings,
    generated: g.profile,
    excess: settingsExcess(g.profile, declared),
    unmappedRules: g.unmapped.length,
    dataClassGaps: TOOL_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, restriction: "data-class" as const })),
  };
}

const level = (l: (typeof SANDBOX_FILESYSTEM)[number]) => SANDBOX_FILESYSTEM.indexOf(l);

/** The strictest file-system level any shell grant of the profile asks for; undefined without a shell grant. */
function strictestShell(profile: ToolProfile): (typeof SANDBOX_FILESYSTEM)[number] | undefined {
  let out: (typeof SANDBOX_FILESYSTEM)[number] | undefined;
  for (const g of profile.grants) if (g.kind === "shell" && (out === undefined || level(g.sandbox.filesystem) < level(out))) out = g.sandbox.filesystem;
  return out;
}

/** What the session runs with. Generated: today's settings. Declared: only narrower than today. */
export function mapSessionSettings(session: ToolSession, today: SessionMapping): SessionMapping {
  if (session.source === "generated") return today;
  const writes = session.profile.grants.some((g) => g.kind === "files" && (g.operations as readonly string[]).includes("write"));
  const shell = strictestShell(session.profile);
  let codexSandbox = today.codexSandbox;
  if (!writes || shell === "read-only") codexSandbox = "read-only";
  else if (today.codexSandbox === "danger-full-access" && shell === "workspace-write") codexSandbox = "workspace-write";
  return { claudeSandbox: today.claudeSandbox, codexSandbox };
}

/** Where the settings, with the mapping applied, still allow more than the declared profile. */
export function mappedExcess(session: ToolSession, mapping: SessionMapping): Excess[] {
  if (session.source === "generated") return [];
  const sandbox = session.settings.boxed ? false : mapping.claudeSandbox;
  return settingsExcess(legacyToolProfile({ ...session.settings, sandbox }).profile, session.profile);
}

/** The level a command of Codex really runs at. A boxed step is held by the OS profile (workspace-write, or read-only). */
export function codexShellFilesystem(codexSandbox: CodexSandboxMode, boxed: boolean): (typeof SANDBOX_FILESYSTEM)[number] {
  if (boxed) return codexSandbox === "read-only" ? "read-only" : "workspace-write";
  return codexSandbox === "read-only" ? "read-only" : codexSandbox === "workspace-write" ? "workspace-write" : "unrestricted";
}

const same = (a: { kind: string; operation?: string; field?: string }, b: typeof a) => a.kind === b.kind && a.operation === b.operation && a.field === b.field;

/** How well one agent can hold the profile of the session. Without `facts` only what is true of every agent is checked. */
export function adapterFit(session: ToolSession, facts?: AgentFacts): AdapterFit {
  const declared = session.source === "declared";
  const base = { excess: session.excess, dataClassGaps: session.dataClassGaps, unmappedRules: session.unmappedRules };
  if (!facts) {
    const refused = declared && (base.excess.length > 0 || base.unmappedRules > 0 || base.dataClassGaps.length > 0);
    return { outcome: refused ? "refused" : "enforced", unsupported: declared ? [...base.dataClassGaps] : [], held: [], ...base, personalSetup: false };
  }
  let gaps: EnforcementGap[] = unenforceable(session.profile, ADAPTER_CAPABILITIES[facts.agent]);
  const c = facts.codex;
  if (facts.agent === "codex" && c) {
    const asked = session.profile.grants.some((g) => g.kind === "shell" && level(g.sandbox.filesystem) < level(c.shellFilesystem));
    if (asked && !gaps.some((g) => g.kind === "shell" && g.restriction === "sandbox-filesystem")) {
      const added: EnforcementGap = { kind: "shell", restriction: "sandbox-filesystem" };
      gaps = [...gaps, added].sort((a, b) => TOOL_KINDS.indexOf(a.kind) - TOOL_KINDS.indexOf(b.kind) || RESTRICTIONS.indexOf(a.restriction) - RESTRICTIONS.indexOf(b.restriction));
    }
  }
  const holdsNetwork = Boolean(facts.agent === "codex" && c && c.sandbox === "workspace-write" && c.noNetwork);
  const held: HeldGap[] = holdsNetwork ? gaps.filter((g) => g.kind === "shell" && g.restriction === "sandbox-network").map((g) => ({ ...g, by: "codex-sandbox" as const })) : [];
  const unsupported: FitGap[] = [...gaps.filter((g) => !held.some((h) => same(h, g) && h.restriction === g.restriction)), ...base.dataClassGaps];
  const excess = [...base.excess];
  if (facts.mapping) for (const e of mappedExcess(session, facts.mapping)) if (!excess.some((x) => same(x, e))) excess.push(e);
  const refused = declared && (excess.length > 0 || base.unmappedRules > 0 || base.dataClassGaps.length > 0 || unsupported.length > 0 || facts.personalSetup);
  const outcome: FitOutcome = refused ? "refused" : !declared && unsupported.length > 0 ? "partial" : "enforced";
  return { agent: facts.agent, outcome, unsupported, held, excess, dataClassGaps: base.dataClassGaps, unmappedRules: base.unmappedRules, personalSetup: facts.personalSetup };
}
