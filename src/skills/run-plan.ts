import type { Config } from "../config.js";
import type { RunSummary } from "../engine/state.js";
import { discoverSkills } from "./registry.js";
import { FlowSkillsSchema } from "../flow/schema.js";
import { planHashOf } from "./run-lock.js";
import { PLAN_CHECK_STEP, PLAN_PHASE_STEPS, planGateRecord, planSkillRequest, SKILL_REQUEST_GATES, SkillRequestError, type SkillRequest } from "./request.js";
import { resolveOptionsFrom, resolveSkills } from "./resolve.js";
import { assessSkills, type SkillPlan } from "./unresolved.js";

// The engine's use of the skill resolver: check the skills a run asks for and decide whether the run may go on.
// Three modes (flow `skills.mode`): planned (after the plan gate, from its request), explicit (at run start, from the
// ids the flow names) and off (no check). All logic lives here; the runner only calls these functions.

/** The gate name of an explicit flow: not a step id (ids start with a letter). */
export const EXPLICIT_SKILL_GATE = "(flow)";
export const EXPLICIT_SKILL_REASON = "named by the flow";

export type FlowSkillSource =
  | { mode: "planned" }
  | { mode: "off" }
  | { mode: "explicit"; request: SkillRequest; planHash: string };

/** How the run's flow gets its skills, from the stored flow. Anything missing or broken is `planned`. Never throws. */
export function flowSkillSource(flowDef: unknown): FlowSkillSource {
  try {
    const parsed = FlowSkillsSchema.safeParse((flowDef as { skills?: unknown } | undefined)?.skills);
    if (!parsed.success) return { mode: "planned" };
    const { mode, ids } = parsed.data;
    if (mode === "off") return { mode: "off" };
    if (mode !== "explicit" || !ids) return { mode: "planned" };
    return {
      mode: "explicit",
      request: { version: 1, skills: ids.map((id) => ({ id, reason: EXPLICIT_SKILL_REASON, evidence: [] })) } as SkillRequest,
      planHash: planHashOf("flow-skills:" + JSON.stringify(ids)),
    };
  } catch {
    return { mode: "planned" };
  }
}

export interface RunSkillPlan extends SkillPlan {
  /** The plan gate whose request was checked. */
  gate: string;
  at: string;
  /** Hash of the output of that gate, so a page can tell whether this plan belongs to the latest gate. Absent on older runs. */
  planHash?: string;
  /** How many times the request was checked (a resume checks again). */
  checks: number;
}

interface Deps {
  discover?: typeof discoverSkills;
}

const CHECK_FAILED = "skills not resolved: the skills could not be checked";
const REQUEST_LOST = "skills not resolved: the skill request of the plan could not be read again";

function failClosed(reason: string): SkillPlan {
  return { version: 1, role: "coder", action: "stop", selected: [], unresolved: [], warnings: [], reason };
}

function check(run: RunSummary, config: Config, stepId: string, log: (m: string) => void, deps: Deps, recheck: boolean): string | undefined {
  const src = flowSkillSource(run.flowDef);
  if (src.mode === "off") return undefined;
  const carryStep = src.mode === "planned" && stepId === PLAN_CHECK_STEP;
  if (src.mode === "explicit" ? stepId !== EXPLICIT_SKILL_GATE : !carryStep && !(SKILL_REQUEST_GATES as readonly string[]).includes(stepId)) return undefined;
  if (carryStep && planGateRecord(run)) return undefined; // a plan gate wins over a carry
  const previous = run.skillPlan;
  let ids: string[] | undefined;
  if (src.mode === "explicit") ids = src.request.skills.map((s) => s.id);
  else {
    try {
      ids = carryStep ? run.skillCarry?.request.skills.map((s) => s.id) : planSkillRequest(run)?.skills.map((s) => s.id);
    } catch (e) {
      if (!(e instanceof SkillRequestError)) throw e;
    }
  }
  let plan: SkillPlan;
  if (!ids) {
    // No validated request. An older run or a flow without the check goes on; a run that stopped for skills must not.
    if (!recheck) {
      delete run.skillPlan;
      return undefined;
    }
    plan = failClosed(REQUEST_LOST);
  } else if (ids.length === 0 && config.skills.selection.include.length === 0) {
    delete run.skillPlan;
    return undefined;
  } else {
    try {
      const registry = (deps.discover ?? discoverSkills)(config.skills, { repo: run.workdir ?? run.repo });
      const resolution = resolveSkills(registry, ids, { role: "coder", ...resolveOptionsFrom(config.skills) });
      plan = assessSkills(resolution, registry, config.skills.unresolved);
    } catch {
      plan = failClosed(CHECK_FAILED);
    }
  }
  const gate = planGateRecord(run);
  run.skillPlan = {
    ...plan, gate: stepId, at: new Date().toISOString(), ...(src.mode === "explicit" ? { planHash: src.planHash } : gate && gate.id === stepId ? { planHash: planHashOf(gate.output) } : {}), checks: (previous?.checks ?? 0) + 1,
  };
  for (const w of plan.warnings) log(`⚠ ${w}`);
  if (plan.action !== "stop") return undefined;
  log(`■ ${plan.reason}`);
  return plan.reason;
}

/** Stops the run for skills with a fixed reason (fail closed). Returns the reason. */
export function stopRunSkills(run: RunSummary, gate: string, reason: string, log: (m: string) => void): string {
  run.skillPlan = { ...failClosed(reason), gate, at: new Date().toISOString(), checks: run.skillPlan?.checks ?? 1 };
  log(`■ ${reason}`);
  return reason;
}

/** After a plan gate: resolves the skills of its request and sets or clears run.skillPlan. Returns the stop reason, or undefined to go on. */
export function planRunSkills(run: RunSummary, config: Config, stepId: string, log: (m: string) => void, deps: Deps = {}): string | undefined {
  return check(run, config, stepId, log, deps, false);
}

/** At the start of a run: checks the skills an explicit flow names. Other modes: undefined. */
export function startRunSkills(run: RunSummary, config: Config, log: (m: string) => void, deps: Deps = {}): string | undefined {
  if (flowSkillSource(run.flowDef).mode !== "explicit") return undefined;
  return check(run, config, EXPLICIT_SKILL_GATE, log, deps, false);
}

/** On resume: resolves again when the run stopped for skills and restarts after the gate (after an install or an approval). */
export function recheckRunSkills(run: RunSummary, config: Config, startAt: string, log: (m: string) => void, deps: Deps = {}): string | undefined {
  const mode = flowSkillSource(run.flowDef).mode;
  if (mode === "off") return undefined;
  const prev = run.skillPlan;
  if (prev?.action !== "stop") return undefined;
  if (mode === "explicit") return check(run, config, EXPLICIT_SKILL_GATE, log, deps, true);
  const ids = (run.flowDef?.steps ?? []).map((s) => s.id);
  const g = ids.indexOf(prev.gate);
  const a = ids.indexOf(startAt);
  // Planning or the gate itself runs again and decides.
  if (PLAN_PHASE_STEPS.has(startAt) || g < 0 || a <= g) return undefined;
  return check(run, config, prev.gate, log, deps, true);
}
