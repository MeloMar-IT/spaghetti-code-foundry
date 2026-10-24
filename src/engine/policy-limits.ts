import type { Config } from "../config.js";
import type { Flow } from "../flow/schema.js";
import { BASELINE_POLICY_ID, type BaselineLimits, type LimitGroup, type StepLimits } from "../policy/baseline.js";
import { DEFAULT_MAX_OUTPUT } from "../steps/shell.js";
import { stepMaxOutput } from "./guards.js";
import type { LayeredPack } from "./policy-hooks.js";

/**
 * The limits the engine itself applies, as the baseline's limit rules see them (see policy/baseline.ts): grouped by value,
 * in the order of first appearance. Pure; reads flows defensively because tests pass partial ones.
 */

export const NO_STEP_LIMITS: StepLimits = { output: [], timeout: [], stepBudget: [] };

function add(groups: LimitGroup[], limit: number, id: string): void {
  const g = groups.find((x) => x.limit === limit);
  if (g) (g.steps as string[]).push(id);
  else groups.push({ limit, steps: [id] });
}

/** The output, time and cost limits of the steps of one flow (`depth` 0 is the root flow). */
export function stepLimits(flow: Flow | undefined, depth: number, config: Partial<Pick<Config, "cost_limits">>): StepLimits {
  const output: LimitGroup[] = [];
  const timeout: LimitGroup[] = [];
  const stepBudget: LimitGroup[] = [];
  for (const step of flow?.steps ?? []) {
    if (step.type === "shell") add(output, stepMaxOutput(step, depth, flow?.name ?? "") ?? DEFAULT_MAX_OUTPUT, step.id);
    if (step.type === "claude" || step.type === "shell") {
      const sec = step.timeout_sec ?? flow?.defaults?.timeout_sec;
      if (sec !== undefined) add(timeout, sec * 1000, step.id);
    }
    if (step.type === "claude" && config.cost_limits !== false) {
      const usd = step.max_budget_usd ?? flow?.defaults?.max_budget_usd;
      if (usd !== undefined) add(stepBudget, usd, step.id);
    }
  }
  return { output, timeout, stepBudget };
}

/** The limits of the root flow, plus the run and daily budgets (only when money limits are on). */
export function baselineLimits(flow: Flow | undefined, config: Partial<Pick<Config, "cost_limits" | "daily_budget_usd">>): BaselineLimits {
  const money = config.cost_limits !== false;
  const runBudget = money ? flow?.limits?.max_cost_usd : undefined;
  const dailyBudget = money ? config.daily_budget_usd : undefined;
  return { ...stepLimits(flow, 0, config), ...(runBudget !== undefined ? { runBudget } : {}), ...(dailyBudget !== undefined ? { dailyBudget } : {}) };
}

/** The packs to ask for a sub-flow step: the root baseline swapped for the scope's, unless the root baseline has a problem (that failure is kept). */
export function scopedPacks(packs: readonly LayeredPack[], entry: LayeredPack): readonly LayeredPack[] {
  const at = packs.findIndex((p) => p.layer === "mandatory" && p.id === BASELINE_POLICY_ID);
  if (at < 0 || "problem" in packs[at]!) return packs;
  return packs.map((p, i) => (i === at ? entry : p));
}
