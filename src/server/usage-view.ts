import { LIMIT_FIELDS, type LimitField, type Limits } from "../auth/limits.js";
import type { Stats, Today } from "../stats.js";

export interface UserUsage {
  owner: string;
  name: string;
  runs: number;
  costUsd: number;
  today: Today;
  active: number;
  limits: Limits;
  atLimit: LimitField[];
}

export interface UsageInput {
  /** Existing accounts: id → name. */
  names: Map<string, string>;
  /** Runs active now per owner id ("" = no owner). */
  active: Map<string, number>;
  /** New runs started today per owner id, as the per-day limit counts them. */
  runsToday: Map<string, number>;
  /** The exact (unrounded) cost of today's runs per owner id. */
  costToday: Map<string, number>;
  /** Effective limits of an existing account. Must not throw. */
  limitsOf: (id: string) => Limits;
  /** Name for an owner id that is not in `names`. */
  deletedName: string;
}

/** The "By user" lines with names, runs active now, limits and which limits are reached; adds accounts that have limits or active runs but no line. */
export function userUsage(byUser: Stats["byUser"], input: UsageInput): UserUsage[] {
  const line = (owner: string, runs: number, costUsd: number, todayCost: number): UserUsage => {
    const limits = input.names.has(owner) ? input.limitsOf(owner) : {};
    const active = input.active.get(owner) ?? 0;
    const runsToday = input.runsToday.get(owner) ?? 0;
    const exactCost = input.costToday.get(owner) ?? 0;
    const reached: Record<LimitField, boolean> = {
      maxConcurrent: limits.maxConcurrent !== undefined && active >= limits.maxConcurrent,
      maxRunsPerDay: limits.maxRunsPerDay !== undefined && runsToday >= limits.maxRunsPerDay,
      dailyBudgetUsd: limits.dailyBudgetUsd !== undefined && exactCost >= limits.dailyBudgetUsd,
    };
    return {
      owner,
      name: owner === "" ? "no owner" : input.names.get(owner) ?? input.deletedName,
      runs,
      costUsd,
      today: { runs: runsToday, costUsd: todayCost },
      active,
      limits,
      atLimit: LIMIT_FIELDS.filter((f) => reached[f]),
    };
  };
  const out = byUser.map((u) => line(u.owner, u.runs, u.costUsd, u.today.costUsd));
  const seen = new Set(byUser.map((u) => u.owner));
  const extra = [...new Set([...input.names.keys(), ...input.active.keys()])]
    .filter((id) => !seen.has(id))
    .map((id) => line(id, 0, 0, 0))
    .filter((u) => Object.keys(u.limits).length > 0 || u.active > 0);
  extra.sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
  return [...out, ...extra];
}
