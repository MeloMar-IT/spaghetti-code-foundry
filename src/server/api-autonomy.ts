import { readFileSync } from "node:fs";
import { githubNameOf } from "../auth/repo-url.js";
import { isRefinementRun } from "../auth/run-owner.js";
import { listAllRepos } from "../auth/repos.js";
import type { RunBrief, RunSummary } from "../engine/state.js";
import { listFlows, parseFlow } from "../flow/load.js";
import { isRefinementFlow } from "../flow/usage.js";
import { AUTONOMY_LEVELS, type AutonomyLevel } from "../governance/autonomy.js";
import { emptyAutonomyStore, levelsOf, readAutonomy, type AutonomyKind, type AutonomyStore } from "../governance/autonomy-store.js";
import { evalCoverage, promotionGate, readGateFindings, type EvalCoverage, type GateDeps, type GateFindings, type GateRuns, type PromotionGate } from "../governance/gate.js";
import type { OutcomeWindow } from "../outcomes.js";
import { factsCacheOf, loadWithFacts, narrowBriefs } from "./api-outcomes.js";
import { checkedRunAsync } from "./api-runs.js";
import { guardedRepos } from "./api-repos.js";
import { HttpError, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

// GET /api/autonomy: the autonomy level of every repository and flow, and whether it has earned the next one (the promotion
// gate). Read-only, admin only. Nothing here promotes or enforces anything.

const DAY_MS = 86_400_000;
const PROBLEM = "The autonomy file could not be read, so every level shows as observe (as a run start treats it).";
const OBSERVE: AutonomyLevel = "observe";
const turn = () => new Promise<void>((r) => setImmediate(r));

export interface AutonomyComponent { kind: AutonomyKind; id: string; name: string; level: AutonomyLevel; next: AutonomyLevel | null; gate: PromotionGate }
export interface AutonomyStatus {
  levels: readonly AutonomyLevel[];
  window: { from: string; to: string; days: number };
  settings: GateDeps["settings"];
  problem?: string;
  components: AutonomyComponent[];
}

/** The runs a gate reads: the narrowed ones, plus every run that is still open (it may hold decisions of the window). */
function gateBriefs(all: readonly RunBrief[], scope: { repo?: string; flow?: string }, window: OutcomeWindow): RunBrief[] {
  const narrow = narrowBriefs(all, scope, window);
  const repo = scope.repo?.toLowerCase();
  const have = new Set(narrow.map((b) => b.runId));
  const open = all.filter(
    (b) => !b.finishedAt && !have.has(b.runId) && (repo === undefined || b.githubRepo?.toLowerCase() === repo) && (scope.flow === undefined || b.flow === scope.flow),
  );
  return [...narrow, ...open].filter((b) => !isRefinementRun(b.source));
}

/**
 * What `promotionGate` needs from this server. Briefs, run loads, the findings and the eval scan are each read once per
 * call of this function, so a status of many components reads each run once. Facts come from the server's shared cache.
 */
export function gateDepsFor(ctx: ApiContext, now: Date): GateDeps {
  const settings = ctx.config().governance.promotion;
  let repos: Map<string, string | undefined> | undefined;
  let briefs: Promise<RunBrief[]> | undefined;
  let evals: Promise<EvalCoverage> | undefined;
  let found: GateFindings | undefined;
  const loads = new Map<string, Promise<RunSummary | undefined>>();
  const scopes = new Map<string, Promise<GateRuns>>();
  const load = (b: RunBrief): Promise<RunSummary | undefined> => {
    let p = loads.get(b.dirName);
    if (!p) loads.set(b.dirName, (p = checkedRunAsync(ctx.scheduler, b.dirName)));
    return p;
  };
  return {
    settings,
    repoName(id) {
      repos ??= new Map(listAllRepos().map((r) => [r.id, githubNameOf(r.url)]));
      return repos.get(id);
    },
    runs(scope, window) {
      const key = `${scope.repo?.toLowerCase() ?? ""}\0${scope.flow ?? ""}`;
      let p = scopes.get(key);
      if (!p) {
        p = (async () => {
          briefs ??= ctx.scheduler.briefsAsync();
          const chosen = gateBriefs(await briefs, scope, window);
          const r = await loadWithFacts(chosen, window, { load, cache: factsCacheOf(ctx) });
          const from = window.from.getTime();
          const to = window.to.getTime();
          // a failed load counts when the run ended in the window or has not ended
          const failedLoads = r.failed.filter((b) => {
            const end = Date.parse(b.finishedAt ?? "");
            return Number.isFinite(end) ? end >= from && end < to : true;
          }).length;
          return { runs: r.runs, facts: r.facts, failedLoads };
        })();
        scopes.set(key, p);
      }
      return p;
    },
    evals() {
      return (evals ??= evalCoverage());
    },
    findings() {
      if (!found) {
        const monitor = ctx.watchers.statuses().find((w) => w.source === "monitor")?.status;
        const ok = monitor?.lastOk ? new Date(monitor.lastOk) : undefined;
        found = readGateFindings(ok);
      }
      return found;
    },
  };
}

/** The flow names of the flow files (the declared `name`, which runs and levels use; the file name may differ) and of the store. */
function flowNames(ctx: ApiContext, store: AutonomyStore): string[] {
  const names = new Set(Object.keys(store.flows));
  try {
    for (const f of listFlows(ctx.opts.repo)) {
      if (f.error) continue;
      try {
        names.add(parseFlow(readFileSync(f.path, "utf8"), f.path).name);
      } catch {
        // a file that no longer parses is left out
      }
    }
  } catch {
    // no flow folder: only the stored names
  }
  return [...names].filter((n) => !isRefinementFlow(n)).sort();
}

/** The levels and gates of every repository and flow. Never reads a path into the answer. */
export async function autonomyStatus(ctx: ApiContext, now: Date): Promise<AutonomyStatus> {
  let store: AutonomyStore;
  let problem: string | undefined;
  try {
    store = readAutonomy();
  } catch {
    store = emptyAutonomyStore();
    problem = PROBLEM;
  }
  const unreadable = problem !== undefined;
  const deps = gateDepsFor(ctx, now);
  const from = new Date(now.getTime() - deps.settings.within_days * DAY_MS);
  const targets: { kind: AutonomyKind; id: string; name: string; level: AutonomyLevel }[] = [
    ...guardedRepos(ctx, listAllRepos).map((r) => ({ kind: "repos" as const, id: r.id, name: githubNameOf(r.url) ?? r.id, level: unreadable ? OBSERVE : levelsOf(store, [r.id], "").repository ?? "delivery-handoff" })),
    ...flowNames(ctx, store).map((n) => ({ kind: "flows" as const, id: n, name: n, level: unreadable ? OBSERVE : levelsOf(store, [], n).flow })),
  ];
  const components: AutonomyComponent[] = [];
  for (const [i, t] of targets.entries()) {
    if (i > 0) await turn();
    const next = AUTONOMY_LEVELS[AUTONOMY_LEVELS.indexOf(t.level) + 1] ?? null;
    components.push({ ...t, next, gate: await promotionGate(t.kind, t.id, next ?? t.level, now, deps) });
  }
  return {
    levels: AUTONOMY_LEVELS,
    window: { from: from.toISOString(), to: now.toISOString(), days: deps.settings.within_days },
    settings: deps.settings,
    ...(problem ? { problem } : {}),
    components,
  };
}

/** GET /api/autonomy. */
export const autonomyRoutes: Route = async (ctx, _req, res, seg, method, user) => {
  if (seg[0] !== "autonomy" || seg.length !== 1 || method !== "GET") return false;
  if (user.role !== "admin") throw new HttpError(403, "only an admin can see the autonomy levels");
  send(res, 200, await autonomyStatus(ctx, new Date()));
  return true;
};
