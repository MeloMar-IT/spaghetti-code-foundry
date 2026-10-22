import { readOnlyStep, stepRepoOps, type ClaudeStep } from "../flow/schema.js";
import { DEFAULT_PERMISSION_MODE, type Engine, type Scope } from "../engine/execute.js";
import type { CodexSandbox } from "../steps/codex.js";
import type { EvidenceEventBody } from "../evidence/stream.js";
import type { SkillPayload } from "../skills/payload.js";
import type { ToolCheck } from "../skills/tool-policy.js";
import type { LegacyToolSettings } from "../tool-profile/legacy.js";
import {
  adapterFit, codexShellFilesystem, declaredToolProfile, mapSessionSettings, mappedExcess, toolSession,
  type AdapterFit, type FitGap, type SessionMapping, type ToolSession,
} from "../tool-profile/session.js";
import { ToolProfileSchemaError } from "../tool-profile/version.js";
import { codexMustIsolate, codexPushAllowed } from "./codex-home.js";
import type { Target } from "./targets.js";

/**
 * The tool profile of an agent step, as the engine uses it. `resolveStepProfile` works the profile out once per step,
 * `gateTarget` checks it for the agent of one try. Text made here carries only fixed words, error codes, counts and
 * the first 12 characters of the profile's hash: never an id, a version, a rule or the text of an exception, so
 * nothing in it can look like a limit, an outage or a sign-in problem to the classifiers of targets.ts.
 */

/** Map Claude permission settings onto Codex's sandbox modes. */
export function codexSandbox(step: ClaudeStep, scope: Pick<Scope, "flow">, sandboxed: boolean): CodexSandbox {
  const d = scope.flow.defaults;
  const mode = step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE;
  if (readOnlyStep(step, d)) return "read-only";
  if (mode === "bypassPermissions" && !sandboxed) return "danger-full-access";
  return "workspace-write";
}

/** Does the flow ask for the agent's own sandbox on this step? */
export function agentSandboxed(step: ClaudeStep, scope: Pick<Scope, "flow">, engine: Pick<Engine, "config">): boolean {
  return step.sandbox ?? scope.flow.sandbox.claude ?? engine.config.sandbox.claude ?? false;
}

/** An agent session (Claude or Codex) runs without the personal setup when the server says so, on a user's run, and always when the run's lock holds skills. */
export function claudeIsolated(isolateAgents: boolean, userRun: boolean, skills?: Pick<SkillPayload, "loaded" | "omitted">, reviewer = false): boolean {
  return isolateAgents || userRun || reviewer || Boolean(skills && (skills.loaded.length || skills.omitted.length));
}

/** The skills that count for isolation: a skill left out for its tools still isolates the session. */
export function isolationSkills(s: SkillPayload | undefined, check?: Pick<ToolCheck, "leftOut">): Pick<SkillPayload, "loaded" | "omitted"> | undefined {
  return s && { loaded: s.loaded, omitted: [...s.omitted, ...(check?.leftOut.map((l) => l.key) ?? [])] };
}

/** Does a Codex session run in its own clean folder, without the personal setup? (Runs the server starts always do.) */
export function codexIsolated(o: { source?: string; isolateAgents: boolean; isolated: boolean; skills?: Pick<SkillPayload, "loaded" | "omitted"> }): boolean {
  return codexMustIsolate({ source: o.source, isolate: claudeIsolated(o.isolateAgents, o.isolated, o.skills) });
}

/** The tool settings one agent step runs with, from the step, the flow defaults and the server settings. */
export function stepToolSettings(step: ClaudeStep, scope: Pick<Scope, "flow">, engine: Pick<Engine, "config">, o: { boxed: boolean; isolated: boolean }): LegacyToolSettings {
  const d = scope.flow.defaults;
  const ops = stepRepoOps(step);
  return {
    permissionMode: step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE,
    allowedTools: step.allowed_tools ?? d.allowed_tools ?? [],
    sandbox: o.boxed ? false : agentSandboxed(step, scope, engine),
    boxed: o.boxed,
    noTools: false,
    mcpServers: !claudeIsolated(engine.config.isolate_agents, o.isolated, undefined, step.skill_role === "reviewer"),
    credential: o.isolated ? "none" : "machine",
    ...(ops ? { repoOps: [...ops] } : {}),
  };
}

export type StepProfiledFields = Omit<Extract<EvidenceEventBody, { type: "step.profiled" }>, "type" | "step">;

export interface StepProfile {
  session: ToolSession;
  /** The sandboxes the step runs with today. */
  today: SessionMapping;
  /** The sandboxes it runs with under the profile (only ever narrower). */
  mapping: SessionMapping;
}

type Refusal = { refused: string; event: StepProfiledFields };

/** Counts in text and logs stop at 99. */
export const countText = (n: number): string => (n <= 99 ? String(n) : "many");

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex" } as const;
const shaOf = (s: ToolSession): string => s.ref.sha256.slice(0, 12);
const gapText = (g: FitGap): string => `${g.kind} ${g.restriction}`;

function listed(items: string[]): string {
  const more = items.length - 10;
  return items.slice(0, 10).join(", ") + (more > 0 ? `, and ${countText(more)} more` : "");
}

/** The refusal for a profile that could not be read or checked. */
export function profileUnusable(e: unknown): Refusal {
  const known = e instanceof ToolProfileSchemaError;
  const code = known ? e.code : "error";
  const refused = known ? `tools: the declared tool profile cannot be used (${code}, ${countText(e.issues.length)} fields)` : "tools: the declared tool profile could not be checked";
  return { refused, event: { source: "declared", unreadable: code, outcome: "refused", gaps: [], excess: [], unmappedRules: 0, personalSetup: false } };
}

function fields(s: ToolSession, fit: AdapterFit): StepProfiledFields {
  return {
    ...(fit.agent ? { agent: fit.agent } : {}),
    source: s.source,
    profile: s.ref,
    outcome: fit.outcome,
    gaps: [...fit.unsupported.map((g) => ({ kind: g.kind, restriction: g.restriction })), ...fit.held.map((g) => ({ kind: g.kind, restriction: g.restriction, heldBy: g.by }))].slice(0, 100),
    excess: fit.excess.slice(0, 200),
    unmappedRules: fit.unmappedRules,
    personalSetup: fit.personalSetup,
  };
}

function refusalText(s: ToolSession, fit: AdapterFit): string {
  const parts: string[] = [];
  if (fit.excess.length) parts.push(`the step's settings allow more (${listed(fit.excess.map((e) => `${e.kind} ${e.operation} ${e.field}`))})`);
  if (fit.unmappedRules) parts.push(`${countText(fit.unmappedRules)} tool rules have no meaning in a profile`);
  if (fit.dataClassGaps.length) parts.push(`data classes below restricted cannot be held (${listed(fit.dataClassGaps.map((g) => g.kind))})`);
  const gaps = fit.unsupported.filter((g) => g.restriction !== "data-class");
  if (fit.agent && gaps.length) parts.push(`${AGENT_NAMES[fit.agent]} cannot hold ${listed(gaps.map(gapText))}`);
  if (fit.personalSetup) parts.push("the session would load the personal setup");
  return `tools: the declared tool profile ${shaOf(s)} cannot be held${fit.agent ? ` on ${AGENT_NAMES[fit.agent]}` : ""}: ${parts.join("; ")}`;
}

/**
 * The profile of a step, worked out once before any agent is picked. A declared profile (from the run) that cannot be
 * read, or that the step's settings exceed, is refused here. Never throws.
 */
export function resolveStepProfile(
  step: ClaudeStep,
  scope: Pick<Scope, "flow">,
  engine: Pick<Engine, "config" | "toolProfile">,
  o: { boxed: boolean; isolated: boolean },
): StepProfile | Refusal {
  try {
    const settings = stepToolSettings(step, scope, engine, o);
    const declared = engine.toolProfile === undefined ? undefined : declaredToolProfile(engine.toolProfile);
    let session: ToolSession;
    try {
      session = toolSession(settings, declared);
    } catch (e) {
      // A generated profile is only recorded: a flow that is valid today (e.g. more than 100 Bash rules) must still run.
      // It is recorded without its rules. A declared profile stays fail-closed.
      if (declared) throw e;
      session = toolSession({ ...settings, allowedTools: [] });
    }
    const today: SessionMapping = { claudeSandbox: settings.sandbox, codexSandbox: codexSandbox(step, scope, settings.sandbox) };
    const mapping = mapSessionSettings(session, today);
    const fit = adapterFit(session);
    const more = mappedExcess(session, mapping).filter((x) => !fit.excess.some((y) => y.kind === x.kind && y.operation === x.operation && y.field === x.field));
    if (fit.outcome === "refused" || more.length) {
      const refused: AdapterFit = { ...fit, outcome: "refused", excess: [...fit.excess, ...more] };
      return { refused: refusalText(session, refused), event: fields(session, refused) };
    }
    return { session, today, mapping };
  } catch (e) {
    return profileUnusable(e);
  }
}

export interface GateOptions {
  step: ClaudeStep;
  engine: Pick<Engine, "config" | "summary">;
  boxed: boolean;
  isolated: boolean;
  skills?: SkillPayload;
  check?: ToolCheck;
  /** The skill block is for a draft plan under review: it does not isolate a Codex session. */
  draft: boolean;
  /** The repository the run works on, as "owner/name". */
  repo?: string;
}

/** How well the agent of one try holds the profile of the step; the evidence fields, the log line and, when refused, the refusal. */
export function gateTarget(t: Pick<Target, "agent">, p: StepProfile, o: GateOptions): { event: StepProfiledFields; line: string; refused?: string; mapping: SessionMapping } {
  const { session, mapping } = p;
  const name = AGENT_NAMES[t.agent];
  let fit: AdapterFit;
  if (t.agent === "claude") {
    const personalSetup = !claudeIsolated(o.engine.config.isolate_agents, o.isolated, isolationSkills(o.skills, o.check), o.step.skill_role === "reviewer");
    fit = adapterFit(session, { agent: "claude", personalSetup, mapping });
  } else {
    const clean = codexIsolated({ source: o.engine.summary.source, isolateAgents: o.engine.config.isolate_agents, isolated: o.isolated, skills: o.draft ? undefined : o.skills });
    fit = adapterFit(session, {
      agent: "codex",
      personalSetup: !(o.boxed || clean),
      mapping,
      codex: {
        sandbox: o.boxed ? "danger-full-access" : mapping.codexSandbox,
        shellFilesystem: codexShellFilesystem(mapping.codexSandbox, o.boxed),
        noNetwork: (o.boxed || clean) && !codexPushAllowed(session.profile, o.repo),
      },
    });
  }
  const event = fields(session, fit);
  if (fit.outcome === "refused") return { event, line: refusalText(session, fit), refused: refusalText(session, fit), mapping };
  const gaps = fit.unsupported.map(gapText);
  const line = `tools: ${session.source} profile ${shaOf(session)} on ${name}: ${fit.outcome}${fit.outcome === "partial" ? ` — ${name} cannot hold ${listed(gaps)} (recorded only)` : ""}`;
  return { event, line, mapping };
}
