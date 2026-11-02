import { githubNameOf } from "../auth/repo-url.js";
import { listRepos } from "../auth/repos.js";
import { isRefinementRun } from "../auth/run-owner.js";
import type { RunBrief, RunSummary } from "../engine/state.js";
import { PolicyIdentitySchema, modelIdentityOf } from "../evidence/identity.js";
import { OutcomeFactsCache, type OutcomeFacts } from "../outcome-facts.js";
import { OUTCOME_DEFINITIONS, computeOutcomes, type OutcomeDefinition, type OutcomeValue, type OutcomeWindow } from "../outcomes.js";
import { checkedRunAsync } from "./api-runs.js";
import { guardedRepos } from "./api-repos.js";
import { HttpError, send } from "./http.js";
import { runFilterValues } from "./run-filter.js";
import type { ApiContext, Route } from "./server.js";

// GET /api/outcomes: the outcome measures for one window, filtered, and only for what the caller may see.
// Briefs (in memory) narrow the runs; only the narrowed runs are loaded (async, in turns) and their evidence read.

export const OUTCOME_DAYS_MAX = 90;
export const OUTCOME_DAYS_DEFAULT = 30;
const DAY_MS = 86_400_000;
const NAME_MAX = 200;
const LOAD_YIELD = 25;

export interface OutcomeFilter { days: number; repo?: string; flow?: string; model?: string; policy?: string }

const DAYS_TEXT = `days must be a whole number from 1 to ${OUTCOME_DAYS_MAX}`;
const MODEL_TEXT = "model must be agent:provider:model, like claude:anthropic:opus";
const POLICY_TEXT = "policy must be id@version, like baseline@1";
const ADMIN_ONLY_TEXT = "only an admin can filter by model or policy";

/** Reads the query of GET /api/outcomes. Throws HttpError 400 for a wrong value. Unknown parameters are ignored. */
export function parseOutcomeFilter(params: URLSearchParams): OutcomeFilter {
  const f: OutcomeFilter = { days: OUTCOME_DAYS_DEFAULT };
  const days = params.get("days");
  if (days !== null) {
    const n = /^\d{1,3}$/.test(days) ? Number(days) : NaN;
    if (!(n >= 1 && n <= OUTCOME_DAYS_MAX)) throw new HttpError(400, DAYS_TEXT);
    f.days = n;
  }
  for (const key of ["repo", "flow"] as const) {
    const v = params.get(key);
    if (v === null) continue;
    if (v === "" || [...v].length > NAME_MAX) throw new HttpError(400, `invalid ${key}`);
    f[key] = v;
  }
  const model = params.get("model");
  if (model !== null) {
    const m = modelIdentityOf(model);
    if (!m || `${m.agent}:${m.provider}:${m.model}` !== model) throw new HttpError(400, MODEL_TEXT);
    f.model = model;
  }
  const policy = params.get("policy");
  if (policy !== null) {
    const parts = policy.split("@");
    if (parts.length !== 2 || !PolicyIdentitySchema.safeParse({ id: parts[0], version: parts[1] }).success) throw new HttpError(400, POLICY_TEXT);
    f.policy = policy;
  }
  return f;
}

/** The brief version of `workKey` (src/stats.ts): the same key for the runs of one issue, pull request or CI run. */
export function briefWorkKey(b: RunBrief): string {
  const repo = b.githubRepo;
  if (repo && b.issue) return `${repo}#issue:${b.issue}`;
  if (repo && b.pr) return `${repo}#pr:${b.pr}`;
  if (repo && b.ciRun) return `${repo}#ci:${b.ciRun}`;
  return b.runId;
}

export interface OutcomeScope { owner?: string; repos?: ReadonlySet<string>; repo?: string; flow?: string }

/** The briefs the caller may see. With `owner` (a user): own runs on repositories in `repos` (lower case). Without: all. */
export function visibleBriefs(briefs: readonly RunBrief[], scope: Pick<OutcomeScope, "owner" | "repos">): RunBrief[] {
  if (scope.owner === undefined) return [...briefs];
  const repos = scope.repos ?? new Set<string>();
  return briefs.filter((b) => b.owner === scope.owner && typeof b.githubRepo === "string" && repos.has(b.githubRepo.toLowerCase()));
}

const stampOf = (t: string | undefined): number => (typeof t === "string" ? Date.parse(t) : NaN);

/**
 * The visible briefs that matter for a window: filtered by repo and flow, ended in [previousFrom, to) (or open and
 * started in [from, to)), plus the earlier runs of the same work items, which delivery and rework need.
 */
export function narrowBriefs(visible: readonly RunBrief[], scope: OutcomeScope, window: OutcomeWindow): RunBrief[] {
  const repo = scope.repo?.toLowerCase();
  const scoped = visible.filter((b) => (repo === undefined || b.githubRepo?.toLowerCase() === repo) && (scope.flow === undefined || b.flow === scope.flow));
  const from = window.from.getTime();
  const to = window.to.getTime();
  const previousFrom = window.previousFrom.getTime();
  const inWindow = (b: RunBrief): boolean => {
    const end = stampOf(b.finishedAt);
    if (Number.isFinite(end)) return end >= previousFrom && end < to;
    const start = stampOf(b.startedAt);
    return start >= from && start < to;
  };
  const kept = new Set(scoped.filter(inWindow));
  const keys = new Set([...kept].map(briefWorkKey));
  for (const b of scoped) {
    if (kept.has(b)) continue;
    const key = briefWorkKey(b);
    if (key !== b.runId && keys.has(key) && stampOf(b.startedAt) < to) kept.add(b);
  }
  return scoped.filter((b) => kept.has(b));
}

/** The definitions a caller may see: a user gets no admin-only measure and no cost. */
export function outcomeDefinitionsFor(admin: boolean): OutcomeDefinition[] {
  return OUTCOME_DEFINITIONS.filter((d) => admin || !(d.adminOnly || d.unit === "usd")).map((d) => ({ ...d }));
}

export interface OutcomeDeps {
  load(b: RunBrief): Promise<RunSummary | undefined>;
  cache: OutcomeFactsCache;
  yieldEvery?: number;
}

export interface OutcomeResult {
  values: { models?: string[]; policies?: string[] };
  measures: OutcomeValue[];
  definitions: OutcomeDefinition[];
}

const turn = () => new Promise<void>((r) => setImmediate(r));
const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));

export interface LoadedRuns {
  runs: RunSummary[];
  facts: Map<string, OutcomeFacts>;
  /** The briefs whose run.json could not be loaded (unreadable or not the run the brief names). */
  failed: RunBrief[];
}

/** Loads the runs of the briefs one by one (yielding) and collects the facts of the settled ones. Never throws for one bad run. */
export async function loadWithFacts(briefs: readonly RunBrief[], window: OutcomeWindow, deps: OutcomeDeps): Promise<LoadedRuns> {
  const every = Math.max(1, deps.yieldEvery ?? LOAD_YIELD);
  const runs: RunSummary[] = [];
  const failed: RunBrief[] = [];
  const updatedAt = new Map<string, string>();
  for (const [i, b] of briefs.entries()) {
    if (i > 0 && i % every === 0) await turn();
    let run: RunSummary | undefined;
    try {
      run = await deps.load(b);
    } catch {
      run = undefined;
    }
    if (!run) {
      failed.push(b);
      continue;
    }
    runs.push(run);
    if (typeof run.runDir === "string") updatedAt.set(run.runDir, b.updatedAt);
  }
  const facts = await deps.cache.collect(runs.filter((r) => !isRefinementRun(r.source)), updatedAt, window.to);
  return { runs, facts, failed };
}

/** Loads the narrowed runs one by one (yielding), reads their evidence, filters by model and policy, and computes the measures. */
export async function outcomesFor(input: { briefs: readonly RunBrief[]; filter: OutcomeFilter; admin: boolean; window: OutcomeWindow }, deps: OutcomeDeps): Promise<OutcomeResult> {
  const { filter, admin, window } = input;
  const { runs, facts } = await loadWithFacts(input.briefs, window, deps);
  const from = window.from.getTime();
  const to = window.to.getTime();
  const values: OutcomeResult["values"] = {};
  if (admin) {
    const models = new Set<string>();
    const policies = new Set<string>();
    for (const r of runs) {
      const end = Date.parse(r.finishedAt ?? "");
      const f = facts.get(r.runId);
      if (!f || !(end >= from && end < to)) continue;
      f.models.forEach((m) => models.add(m));
      f.policies.forEach((p) => policies.add(p));
    }
    values.models = sorted(models);
    values.policies = sorted(policies);
  }
  const matches = (f: OutcomeFacts | undefined): boolean =>
    !!f && (filter.model === undefined || f.models.includes(filter.model)) && (filter.policy === undefined || f.policies.includes(filter.policy));
  const wanted = filter.model === undefined && filter.policy === undefined ? runs : runs.filter((r) => matches(facts.get(r.runId)));
  const definitions = outcomeDefinitionsFor(admin);
  const ids = new Set<string>(definitions.map((d) => d.id));
  const measures = computeOutcomes(wanted, facts, window).measures.filter((m) => ids.has(m.id));
  return { values, measures, definitions };
}

const caches = new WeakMap<ApiContext, OutcomeFactsCache>();
/** The facts cache of this server. */
export function factsCacheOf(ctx: ApiContext): OutcomeFactsCache {
  let c = caches.get(ctx);
  if (!c) {
    c = new OutcomeFactsCache();
    caches.set(ctx, c);
  }
  return c;
}

/** GET /api/outcomes. */
export const outcomeRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "outcomes" || seg.length !== 1 || method !== "GET") return false;
  const admin = user.role === "admin";
  const filter = parseOutcomeFilter(new URL(req.url ?? "/", "http://x").searchParams);
  if (!admin && (filter.model !== undefined || filter.policy !== undefined)) throw new HttpError(403, ADMIN_ONLY_TEXT);
  const repos = admin ? undefined : new Set(guardedRepos(ctx, () => listRepos(user.id)).flatMap((r) => githubNameOf(r.url)?.toLowerCase() ?? []));
  const visible = visibleBriefs(await ctx.scheduler.briefsAsync(), { owner: admin ? undefined : user.id, repos });
  const to = new Date();
  const from = new Date(to.getTime() - filter.days * DAY_MS);
  const window: OutcomeWindow = { from, to, previousFrom: new Date(from.getTime() - filter.days * DAY_MS) };
  const briefs = narrowBriefs(visible, { repo: filter.repo, flow: filter.flow }, window);
  const owner = admin ? undefined : user.id;
  const r = await outcomesFor({ briefs, filter, admin, window }, { load: (b) => checkedRunAsync(ctx.scheduler, b.dirName, owner), cache: factsCacheOf(ctx) });
  send(res, 200, {
    window: { from: from.toISOString(), to: to.toISOString(), days: filter.days },
    filters: filter,
    values: { ...runFilterValues(visible), ...r.values },
    measures: r.measures,
    definitions: r.definitions,
  });
  return true;
};
