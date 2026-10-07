import { isRefinementRun } from "../auth/run-owner.js";
import type { RunBrief } from "../engine/state.js";

/** The ids of the new runs of an account that started today (local day, as spentToday counts). Architect runs are left out. */
export function runIdsStartedToday(briefs: RunBrief[], owner: string, now = new Date()): Set<string> {
  const day = now.toDateString();
  const ids = new Set<string>();
  for (const b of briefs) {
    if (b.owner !== owner || isRefinementRun(b.source)) continue;
    const t = new Date(b.startedAt);
    if (Number.isNaN(t.getTime()) || t.toDateString() !== day) continue;
    ids.add(b.runId);
  }
  return ids;
}

/** New runs of an account that started today (local day, as spentToday counts). Architect runs are left out. */
export function runsStartedToday(briefs: RunBrief[], owner: string, now = new Date()): number {
  return runIdsStartedToday(briefs, owner, now).size;
}
