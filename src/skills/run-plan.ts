import type { Config } from "../config.js";
import type { RunSummary } from "../engine/state.js";
import { discoverSkills } from "./registry.js";
import { PLAN_PHASE_STEPS, planSkillRequest, SKILL_REQUEST_GATES, SkillRequestError } from "./request.js";
import { resolveOptionsFrom, resolveSkills } from "./resolve.js";
import { assessSkills, type SkillPlan } from "./unresolved.js";

// The engine's use of the skill resolver: after the plan gate, check the skills the plan asked for and decide
// whether the run may go on. All logic lives here; the runner only calls these two functions.

export interface RunSkillPlan extends SkillPlan {
  /** The plan gate whose request was checked. */
  gate: string;
  at: string;
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
  if (!(SKILL_REQUEST_GATES as readonly string[]).includes(stepId)) return undefined;
  const previous = run.skillPlan;
  let ids: string[] | undefined;
  try {
    ids = planSkillRequest(run)?.skills.map((s) => s.id);
  } catch (e) {
    if (!(e instanceof SkillRequestError)) throw e;
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
  run.skillPlan = { ...plan, gate: stepId, at: new Date().toISOString(), checks: (previous?.checks ?? 0) + 1 };
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

/** On resume: resolves again when the run stopped for skills and restarts after the gate (after an install or an approval). */
export function recheckRunSkills(run: RunSummary, config: Config, startAt: string, log: (m: string) => void, deps: Deps = {}): string | undefined {
  const prev = run.skillPlan;
  if (prev?.action !== "stop") return undefined;
  const ids = (run.flowDef?.steps ?? []).map((s) => s.id);
  const g = ids.indexOf(prev.gate);
  const a = ids.indexOf(startAt);
  // Planning or the gate itself runs again and decides.
  if (PLAN_PHASE_STEPS.has(startAt) || g < 0 || a <= g) return undefined;
  return check(run, config, prev.gate, log, deps, true);
}
