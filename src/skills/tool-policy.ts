import type { ClaudeStep } from "../flow/schema.js";
import { UNRESOLVED_LIMITS } from "./resolve-rules.js";
import type { SkillPackage, ToolPolicy } from "./schema.js";

// Compares what a skill needs (shell, network, write access, connectors) with what a flow or one Claude step gives,
// under the administrator's skills.tools policy. Pure: no engine imports, nothing calls it yet. It decides which skills
// load; it never limits a session. Messages are built from validated ids and slugs only, and must not contain the
// phrases the watcher reads as a pause ("daily budget", "usage limit reached", "signed out").

/** The permission mode of a step with no mode set. A test keeps it equal to DEFAULT_PERMISSION_MODE. */
export const FLOW_DEFAULT_MODE = "acceptEdits";
export const SKILL_TOOLS_PREFIX = "skill tools: ";
const FLOW_REFUSED_PREFIX = "skills not resolved: ";

export type ToolNeed = "shell" | "network" | "write" | `connector:${string}`;
export type ToolCode = "tool-not-approved" | "tool-not-in-flow" | "tool-not-in-step" | "connector-unavailable";

export interface Capabilities {
  shell: boolean;
  network: boolean;
  filesystem: "read" | "write";
  /** Where each one comes from, e.g. "flow:step:impl", "flow:defaults", "flow:sandbox", "config:sandbox", "none". */
  sources: { shell: string; network: string; filesystem: string };
}
export interface SessionTools {
  stepId: string;
  mode: { value: string; source: string };
  approved: { rules: string[]; source: string };
  sandbox: boolean;
  capabilities: Capabilities;
}
export interface FlowTools { sessions: number; partial: boolean; capabilities: Capabilities }
export interface SkillToolNeed {
  key: string;
  id: string;
  selection: "requested" | "dependency" | "mandatory";
  requiredBy: string[];
  pkg: Pick<SkillPackage, "tool_profile" | "connectors" | "dependencies">;
}
/** `leftOut` is filled also when the action is "stop"; callers read `action` first. */
export interface ToolCheck {
  action: "continue" | "degrade" | "stop";
  met: { key: string; need: ToolNeed; sources: string[] }[];
  missing: { key: string; need: ToolNeed; code: ToolCode; message: string }[];
  leftOut: { key: string; code: ToolCode; via?: string }[];
  warnings: string[];
  reason?: string;
}
export type SkillToolPlan = ToolCheck;
export interface SessionToolGrant {
  mode: SessionTools["mode"];
  approved: SessionTools["approved"];
  sandbox: boolean;
  capabilities: Capabilities;
  connectors: string[];
  settingSources: string[];
  met: { key: string; need: ToolNeed }[];
  leftOut: { key: string; code: ToolCode; via?: string }[];
}

type Cap = "shell" | "network" | "filesystem";
const RULES: Record<Cap, RegExp> = {
  shell: /^Bash(\(.*\))?$/,
  network: /^(WebFetch|WebSearch)(\(.*\))?$/,
  filesystem: /^(Edit|Write|MultiEdit|NotebookEdit)(\(.*\))?$/,
};
const ruleGives = (rules: string[], cap: Cap) => rules.some((r) => RULES[cap].test(r.trim()));

export function sessionTools(o: {
  stepId: string;
  step: Pick<ClaudeStep, "permission_mode" | "allowed_tools">;
  defaults: { permission_mode?: string; allowed_tools?: string[] };
  sandbox: { step?: boolean; flow?: boolean; config?: boolean; boxed: boolean };
}): SessionTools {
  const stepSrc = `flow:step:${o.stepId}`;
  const mode = o.step.permission_mode !== undefined
    ? { value: o.step.permission_mode as string, source: stepSrc }
    : o.defaults.permission_mode !== undefined
      ? { value: o.defaults.permission_mode, source: "flow:defaults" }
      : { value: FLOW_DEFAULT_MODE, source: "default" };
  const list = o.step.allowed_tools ?? o.defaults.allowed_tools ?? [];
  const approved = { rules: [...list], source: list.length === 0 ? "none" : o.step.allowed_tools !== undefined ? stepSrc : "flow:defaults" };
  const level = o.sandbox.step !== undefined ? "step" : o.sandbox.flow !== undefined ? "flow" : o.sandbox.config !== undefined ? "config" : undefined;
  const sandbox = o.sandbox.boxed ? false : (o.sandbox.step ?? o.sandbox.flow ?? o.sandbox.config ?? false);
  const sandboxSource = level === "step" ? stepSrc : level === "flow" ? "flow:sandbox" : "config:sandbox";

  const caps: Capabilities = { shell: false, network: false, filesystem: "read", sources: { shell: "none", network: "none", filesystem: "none" } };
  const give = (cap: Cap, source: string) => {
    if (cap === "filesystem") { caps.filesystem = "write"; caps.sources.filesystem = source; } else { caps[cap] = true; caps.sources[cap] = source; }
  };
  const m = mode.value;
  if (m !== "plan") {
    const all = m === "bypassPermissions" || m === "auto";
    const writes = all || m === "acceptEdits" || m === "default";
    for (const cap of ["shell", "network", "filesystem"] as const) {
      if (all || (cap === "filesystem" && writes)) give(cap, mode.source);
      else if (ruleGives(approved.rules, cap)) give(cap, approved.source);
      else if (cap === "shell" && sandbox) give(cap, sandboxSource);
    }
  }
  return { stepId: o.stepId, mode, approved, sandbox, capabilities: caps };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lead = (spec: unknown): "claude" | "codex" | undefined => {
  if (typeof spec !== "string") return undefined;
  const first = spec.trim().split(":")[0]?.trim();
  return first === "claude" || first === "codex" ? first : undefined;
};

/** Which agent runs a step, without config or router rules (so a step routed to Codex at run time still counts as Claude here). */
function stepAgent(step: Record<string, unknown>, defaults: Record<string, unknown>): string {
  const model = step.model;
  const fromDefaultModel = model ? undefined : lead(defaults.model);
  return (typeof step.agent === "string" ? step.agent : undefined) ?? lead(model) ?? fromDefaultModel
    ?? (typeof defaults.agent === "string" ? defaults.agent : undefined) ?? "claude";
}

export function flowTools(flow: { steps?: unknown[]; defaults?: object; sandbox?: { claude?: boolean } }, configSandbox?: boolean): FlowTools {
  const defaults = (isObj(flow.defaults) ? flow.defaults : {}) as Record<string, unknown>;
  const caps: Capabilities = { shell: false, network: false, filesystem: "read", sources: { shell: "none", network: "none", filesystem: "none" } };
  let sessions = 0;
  let partial = false;
  for (const raw of Array.isArray(flow.steps) ? flow.steps : []) {
    if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.type !== "string") continue;
    if (raw.type === "flow") partial = true;
    if (raw.type !== "claude" || stepAgent(raw, defaults) !== "claude") continue;
    sessions++;
    const s = sessionTools({
      stepId: raw.id,
      step: raw as Pick<ClaudeStep, "permission_mode" | "allowed_tools">,
      defaults: defaults as { permission_mode?: string; allowed_tools?: string[] },
      sandbox: { step: raw.sandbox as boolean | undefined, flow: flow.sandbox?.claude, config: configSandbox, boxed: false },
    }).capabilities;
    for (const cap of ["shell", "network"] as const) {
      if (s[cap] && !caps[cap]) { caps[cap] = true; caps.sources[cap] = `flow:step:${raw.id}`; }
    }
    if (s.filesystem === "write" && caps.filesystem === "read") { caps.filesystem = "write"; caps.sources.filesystem = `flow:step:${raw.id}`; }
  }
  return { sessions, partial, capabilities: caps };
}

export function skillNeeds(pkg: SkillToolNeed["pkg"]): ToolNeed[] {
  const out: ToolNeed[] = [];
  const p: unknown = pkg.tool_profile;
  if (isObj(p)) {
    if (p.shell === true) out.push("shell");
    if (p.network === true) out.push("network");
    if (p.filesystem === "write") out.push("write");
  }
  for (const c of pkg.connectors ?? []) out.push(`connector:${c}`);
  return out;
}

const WHAT = { shell: "a shell", network: "network access", write: "write access" } as const;
const POLICY_NAME = { shell: "shell", network: "network", write: "filesystem" } as const;
const CAP_OF = { shell: "shell", network: "network", write: "filesystem" } as const;

function message(code: ToolCode, need: ToolNeed): string {
  if (need.startsWith("connector:")) return `It names the connector ${need.slice(10)}. Connectors are not available in this version.`;
  const n = need as "shell" | "network" | "write";
  if (code === "tool-not-approved") return `It needs ${WHAT[n]}, which skills.tools.${POLICY_NAME[n]} does not allow.`;
  if (code === "tool-not-in-flow") return `It needs ${WHAT[n]}, which no Claude step of this flow gives.`;
  return `It needs ${WHAT[n]}, which this step does not give.`;
}

function policyAllows(need: "shell" | "network" | "write", policy: ToolPolicy): boolean {
  return need === "write" ? policy.filesystem === "write" : policy[need];
}

export function checkSkillTools(needs: SkillToolNeed[], caps: Capabilities, policy: ToolPolicy, scope: "flow" | "session", partial = false): ToolCheck {
  const met: ToolCheck["met"] = [];
  const missing: ToolCheck["missing"] = [];
  for (const s of needs) {
    for (const need of skillNeeds(s.pkg)) {
      if (need.startsWith("connector:")) {
        missing.push({ key: s.key, need, code: "connector-unavailable", message: message("connector-unavailable", need) });
        continue;
      }
      const n = need as "shell" | "network" | "write";
      if (!policyAllows(n, policy)) {
        missing.push({ key: s.key, need, code: "tool-not-approved", message: message("tool-not-approved", need) });
        continue;
      }
      const has = n === "write" ? caps.filesystem === "write" : caps[n];
      if (!has) {
        if (scope === "session") missing.push({ key: s.key, need, code: "tool-not-in-step", message: message("tool-not-in-step", need) });
        else if (!partial) missing.push({ key: s.key, need, code: "tool-not-in-flow", message: message("tool-not-in-flow", need) });
        continue;
      }
      met.push({ key: s.key, need, sources: [`skill:${s.key}`, `policy:skills.tools.${POLICY_NAME[n]}`, caps.sources[CAP_OF[n]]] });
    }
  }

  const byId = new Map(needs.map((s) => [s.id, s]));
  const firstMissing = (key: string) => missing.find((m) => m.key === key);

  // leftOut: direct, then dependants and orphans until nothing changes.
  const left = new Map<string, { key: string; id: string; code: ToolCode; via?: string; line: string }>();
  for (const s of needs) {
    const m = firstMissing(s.key);
    if (m) left.set(s.id, { key: s.key, id: s.id, code: m.code, line: m.message });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const s of needs) {
      if (left.has(s.id)) continue;
      const dep = s.pkg.dependencies.map((d) => left.get(d.id)).find(Boolean);
      if (dep) {
        const via = dep.via ?? dep.id;
        left.set(s.id, { key: s.key, id: s.id, code: dep.code, via, line: `It depends on ${via}, which is left out.` });
        changed = true;
      } else if (s.selection === "dependency" && s.requiredBy.length > 0 && s.requiredBy.every((r) => left.has(r))) {
        const first = left.get(s.requiredBy[0] as string) as { id: string; code: ToolCode; via?: string };
        const via = first.via ?? first.id;
        left.set(s.id, { key: s.key, id: s.id, code: first.code, via, line: `Only skills that are left out need it (${via}).` });
        changed = true;
      }
    }
  }
  const leftEntries = needs.filter((s) => left.has(s.id)).map((s) => left.get(s.id) as NonNullable<ReturnType<typeof left.get>>);

  // Mandatory skills, and skills that a mandatory skill needs (up the requiredBy and dependencies edges).
  const mandatoryChain = (start: SkillToolNeed): boolean => {
    const seen = new Set<string>();
    const todo = [start];
    while (todo.length > 0) {
      const s = todo.pop() as SkillToolNeed;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      if (s.selection === "mandatory") return true;
      for (const r of s.requiredBy) { const p = byId.get(r); if (p) todo.push(p); }
      for (const p of needs) if (p.pkg.dependencies.some((d) => d.id === s.id)) todo.push(p);
    }
    return false;
  };
  const stoppers: { id: string; code: ToolCode; message: string }[] = [];
  for (const s of needs) {
    const own = missing.filter((m) => m.key === s.key && m.code !== "tool-not-in-step");
    if (own.length === 0) continue;
    if (policy.missing === "stop" || mandatoryChain(s)) {
      const m = own[0] as ToolCheck["missing"][number];
      stoppers.push({ id: s.id, code: m.code, message: m.message });
    }
  }

  const action: ToolCheck["action"] = stoppers.length > 0 ? "stop" : leftEntries.length > 0 ? "degrade" : "continue";
  const out: ToolCheck = {
    action,
    met,
    missing,
    leftOut: leftEntries.map((e) => ({ key: e.key, code: e.code, ...(e.via ? { via: e.via } : {}) })),
    warnings: leftEntries.map((e) => `skill ${e.id} [${e.code}]: ${e.line}`),
  };
  if (action === "stop") {
    const limit = UNRESOLVED_LIMITS.reasonItems;
    const items = stoppers.slice(0, limit).map((x) => `${x.id} [${x.code}]: ${x.message}`);
    const more = stoppers.length > limit ? ` (+${stoppers.length - limit} more)` : "";
    const prefix = scope === "session" ? SKILL_TOOLS_PREFIX : FLOW_REFUSED_PREFIX;
    out.reason = `${prefix}${stoppers.length} skill(s) cannot be used — ${items.join(" · ")}${more}`;
  }
  return out;
}

export function assessSkillTools(needs: SkillToolNeed[], flow: FlowTools, policy: ToolPolicy): SkillToolPlan {
  return checkSkillTools(needs, flow.capabilities, policy, "flow", flow.partial);
}

export function sessionToolGrant(tools: SessionTools, check: ToolCheck, isolated = false): SessionToolGrant {
  const out = new Set(check.leftOut.map((l) => l.key));
  return {
    mode: tools.mode,
    approved: tools.approved,
    sandbox: tools.sandbox,
    capabilities: tools.capabilities,
    connectors: [],
    settingSources: isolated ? ["project", "local"] : ["user", "project", "local"],
    met: check.met.filter((m) => !out.has(m.key)).map((m) => ({ key: m.key, need: m.need })),
    leftOut: check.leftOut,
  };
}
