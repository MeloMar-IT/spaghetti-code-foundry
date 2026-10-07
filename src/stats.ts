import { isRefinementRun } from "./auth/run-owner.js";
import type { RunSummary } from "./engine/state.js";

export interface Today { runs: number; costUsd: number }

export interface Stats {
  totals: { runs: number; costUsd: number; succeeded: number; failed: number; stopped: number; waiting: number };
  byDay: { day: string; costUsd: number; runs: number }[];
  byFlow: { flow: string; runs: number; succeeded: number; costUsd: number; avgMinutes: number }[];
  byRepo: { repo: string; runs: number; costUsd: number; today: Today }[];
  /** `owner` is "" for runs without an owner. The costs add up to `totals.costUsd`; today's costs add up to today's total. `today.runs` leaves out architect runs, as the per-day limit does. */
  byUser: { owner: string; runs: number; costUsd: number; today: Today }[];
  failingSteps: { step: string; failures: number; runs: number }[];
  loops: { step: string; extraVisits: number }[];
}

/** What a run works on: a GitHub issue / PR / CI run / chore, or (without those) just itself. */
function workKey(r: RunSummary): string {
  const v = r.vars ?? {};
  const repo = v.github_repo;
  if (repo && v.issue) return `${repo}#issue:${v.issue}`;
  if (repo && v.pr) return `${repo}#pr:${v.pr}`;
  if (repo && v.ci_run) return `${repo}#ci:${v.ci_run}`;
  return r.runId;
}

/**
 * Runs that a newer run on the same issue/PR replaced (e.g. an old stopped plan run after the issue
 * was built by a later run). They no longer need a human, whatever their own status says.
 */
export function supersededRuns(runs: RunSummary[]): Set<string> {
  const newest = new Map<string, RunSummary>();
  for (const r of runs) {
    const k = workKey(r);
    const cur = newest.get(k);
    if (!cur || r.startedAt > cur.startedAt) newest.set(k, r);
  }
  return new Set(runs.filter((r) => newest.get(workKey(r)) !== r).map((r) => r.runId));
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whole ten-thousandths per line that add up to `total` units: rounded down, leftovers to the biggest remainders (ties: by key). */
function spread(lines: { key: string; exact: number }[], total: number): Map<string, number> {
  const parts = lines.map((l) => {
    const units = Math.max(0, Math.floor(l.exact + 1e-9));
    return { key: l.key, units, rest: l.exact - units };
  });
  let left = total - parts.reduce((a, l) => a + l.units, 0);
  for (const l of [...parts].sort((a, b) => b.rest - a.rest || a.key.localeCompare(b.key))) {
    if (left <= 0) break;
    l.units++;
    left--;
  }
  return new Map(parts.map((l) => [l.key, l.units]));
}

/** The exact (unrounded) cost of the runs that started today per owner ("" = no owner), for comparing with a budget. */
export function todayCostByOwner(runs: RunSummary[], now = new Date()): Map<string, number> {
  const day = now.toDateString();
  const out = new Map<string, number>();
  for (const r of runs) {
    if (new Date(r.startedAt).toDateString() !== day) continue;
    out.set(r.owner ?? "", (out.get(r.owner ?? "") ?? 0) + r.totalCostUsd);
  }
  return out;
}

/** Aggregate run history for the dashboard. */
export function computeStats(runs: RunSummary[], days = 30, now = new Date()): Stats {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000);
  since.setHours(0, 0, 0, 0);
  const inRange = runs.filter((r) => new Date(r.startedAt) >= since);

  const byDay = new Map<string, { costUsd: number; runs: number }>();
  for (let i = 0; i < days; i++) byDay.set(dayKey(new Date(since.getTime() + i * 86_400_000)), { costUsd: 0, runs: 0 });
  const byFlow = new Map<string, { runs: number; succeeded: number; costUsd: number; minutes: number; finished: number }>();
  const byRepo = new Map<string, { runs: number; costUsd: number; todayRuns: number; todayCost: number }>();
  const byUser = new Map<string, { runs: number; costUsd: number; todayRuns: number; todayCost: number }>();
  const day = now.toDateString();
  let todayCost = 0;
  const stepFail = new Map<string, { failures: number; runs: Set<string> }>();
  const loops = new Map<string, number>();
  const totals = { runs: 0, costUsd: 0, succeeded: 0, failed: 0, stopped: 0, waiting: 0 };
  const replaced = supersededRuns(runs);

  for (const r of inRange) {
    const isToday = new Date(r.startedAt).toDateString() === day;
    if (isToday) todayCost += r.totalCostUsd;
    totals.runs++;
    totals.costUsd += r.totalCostUsd;
    // Stopped/waiting runs that a newer run on the same issue replaced don't need a human any more.
    const stale = (r.status === "stopped" || r.status === "waiting") && replaced.has(r.runId);
    if (r.status in totals && !stale) (totals as Record<string, number>)[r.status]! += 1;
    const d = byDay.get(dayKey(new Date(r.startedAt)));
    if (d) {
      d.costUsd += r.totalCostUsd;
      d.runs++;
    }
    const f = byFlow.get(r.flow) ?? { runs: 0, succeeded: 0, costUsd: 0, minutes: 0, finished: 0 };
    f.runs++;
    f.costUsd += r.totalCostUsd;
    if (r.status === "succeeded") f.succeeded++;
    if (r.finishedAt) {
      f.finished++;
      f.minutes += (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 60_000;
    }
    byFlow.set(r.flow, f);
    const repoKey = r.vars?.github_repo && r.vars.github_repo !== "owner/repo" ? r.vars.github_repo : (r.repo ?? "(older runs)");
    const rp = byRepo.get(repoKey) ?? { runs: 0, costUsd: 0, todayRuns: 0, todayCost: 0 };
    rp.runs++;
    rp.costUsd += r.totalCostUsd;
    if (isToday) {
      rp.todayRuns++;
      rp.todayCost += r.totalCostUsd;
    }
    byRepo.set(repoKey, rp);
    const u = byUser.get(r.owner ?? "") ?? { runs: 0, costUsd: 0, todayRuns: 0, todayCost: 0 };
    u.runs++;
    u.costUsd += r.totalCostUsd;
    if (isToday) {
      if (!isRefinementRun(r.source)) u.todayRuns++;
      u.todayCost += r.totalCostUsd;
    }
    byUser.set(r.owner ?? "", u);
    for (const h of r.history) {
      const key = `${r.flow} · ${h.id}`;
      if (!h.ok) {
        const s = stepFail.get(key) ?? { failures: 0, runs: new Set<string>() };
        s.failures++;
        s.runs.add(r.runId);
        stepFail.set(key, s);
      }
      if (h.visit > 1) loops.set(key, (loops.get(key) ?? 0) + 1);
    }
  }

  const round = (n: number) => Math.round(n * 10000) / 10000;
  const entries = [...byUser];
  const cost30 = spread(entries.map(([key, v]) => ({ key, exact: v.costUsd * 10000 })), Math.round(totals.costUsd * 10000));
  const costToday = spread(entries.map(([key, v]) => ({ key, exact: v.todayCost * 10000 })), Math.round(todayCost * 10000));
  const users = entries
    .map(([owner, v]) => ({ owner, runs: v.runs, costUsd: cost30.get(owner)! / 10000, today: { runs: v.todayRuns, costUsd: costToday.get(owner)! / 10000 } }))
    .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs || a.owner.localeCompare(b.owner));
  return {
    totals: { ...totals, costUsd: round(totals.costUsd) },
    byDay: [...byDay].map(([day, v]) => ({ day, costUsd: round(v.costUsd), runs: v.runs })),
    byFlow: [...byFlow]
      .map(([flow, v]) => ({ flow, runs: v.runs, succeeded: v.succeeded, costUsd: round(v.costUsd), avgMinutes: v.finished ? Math.round((v.minutes / v.finished) * 10) / 10 : 0 }))
      .sort((a, b) => b.runs - a.runs),
    byRepo: [...byRepo].map(([repo, v]) => ({ repo, runs: v.runs, costUsd: round(v.costUsd), today: { runs: v.todayRuns, costUsd: round(v.todayCost) } })).sort((a, b) => b.costUsd - a.costUsd),
    byUser: users,
    failingSteps: [...stepFail].map(([step, v]) => ({ step, failures: v.failures, runs: v.runs.size })).sort((a, b) => b.failures - a.failures).slice(0, 10),
    loops: [...loops].map(([step, extraVisits]) => ({ step, extraVisits })).sort((a, b) => b.extraVisits - a.extraVisits).slice(0, 10),
  };
}
