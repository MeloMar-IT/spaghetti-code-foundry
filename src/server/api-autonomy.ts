import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { writeAudit } from "../auth/audit.js";
import { StoreError } from "../auth/store.js";
import { listUsers, type User } from "../auth/users.js";
import { githubNameOf } from "../auth/repo-url.js";
import { isRefinementRun, ownerNames } from "../auth/run-owner.js";
import { listAllRepos } from "../auth/repos.js";
import type { RunBrief, RunSummary } from "../engine/state.js";
import { listFlows, parseFlow } from "../flow/load.js";
import { isRefinementFlow } from "../flow/usage.js";
import { AUTONOMY_LEVELS, AutonomyLevelSchema, autonomyOfRun, nextLevel, type AutonomyLevel } from "../governance/autonomy.js";
import {
  AutonomyRefused,
  accountableOwner,
  activeAdmins,
  approversOf,
  approvePromotion,
  checkPromotable,
  checkReason,
  demoteLevel,
  liveRequest,
  mayApprove,
  requestPromotion,
  type AutonomyOwner,
  type ComponentRef,
} from "../governance/autonomy-change.js";
import { AutonomyError, emptyAutonomyStore, levelsOf, readAutonomy, requestOf, type AutonomyKind, type AutonomyRequest, type AutonomyStore } from "../governance/autonomy-store.js";
import { evalCoverage, promotionGate, readGateFindings, type EvalCoverage, type GateDeps, type GateFindings, type GateRuns, type PromotionGate } from "../governance/gate.js";
import type { OutcomeWindow } from "../outcomes.js";
import { factsCacheOf, loadWithFacts, narrowBriefs } from "./api-outcomes.js";
import { checkedRunAsync } from "./api-runs.js";
import { autonomyHistory } from "./api-audit.js";
import { guardedRepos } from "./api-repos.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

// GET /api/autonomy: the autonomy level of every repository and flow, and whether it has earned the next one (the promotion
// gate), its waiting promotion request and the accountable owner. Admin only. POST autonomy/promote|approve|demote (#646)
// change a level; nothing enforces a level yet.

const DAY_MS = 86_400_000;
const PROBLEM = "The autonomy file could not be read, so every level shows as observe (as a run start treats it).";
const OBSERVE: AutonomyLevel = "observe";
const turn = () => new Promise<void>((r) => setImmediate(r));

export interface AutonomyComponent {
  kind: AutonomyKind;
  id: string;
  name: string;
  level: AutonomyLevel;
  next: AutonomyLevel | null;
  gate: PromotionGate;
  /** The promotion request of this component, with its token; a request that no longer fits shows as `expired`. */
  request?: AutonomyRequest;
  /** The level the newest run of this component had. Absent when it has no run, or when the runs could not be listed (see `runsProblem`). */
  newestRun?: AutonomyNewestRun;
  /** Who asked, who may approve, and whether the viewer may. Only for a live request when the owner is known. */
  approval?: AutonomyApproval;
}
export interface AutonomyNewestRun { runId: string; level: AutonomyLevel; startedAt: string }
export interface AutonomyPerson { id: string; name: string }
export interface AutonomyApproval { requester: AutonomyPerson; approvers: (AutonomyPerson & { selfApproved: boolean })[]; mayApprove: boolean }
export interface AutonomyStatus {
  levels: readonly AutonomyLevel[];
  window: { from: string; to: string; days: number };
  settings: GateDeps["settings"];
  problem?: string;
  /** Who approves promotions; absent when no admin can sign in. */
  owner?: AutonomyOwner;
  /** The name of the accountable owner. */
  ownerName?: string;
  /** Set when the runs could not be listed: the newest runs are unknown, which is not the same as "no runs". */
  runsProblem?: string;
  components: AutonomyComponent[];
}

const GONE = "deleted user";

/** The newest run of a repository (by GitHub name, any case) or of a flow, with its level. Refinement and local-test runs do not count, as in the gate. */
export function newestRunOf(briefs: readonly RunBrief[], scope: { repo?: string; flow?: string }): AutonomyNewestRun | undefined {
  if (scope.repo === undefined && scope.flow === undefined) return undefined;
  const repo = scope.repo?.toLowerCase();
  let best: RunBrief | undefined;
  for (const b of briefs) {
    if (isRefinementRun(b.source) || b.localTest) continue;
    if (repo !== undefined && b.githubRepo?.toLowerCase() !== repo) continue;
    if (scope.flow !== undefined && b.flow !== scope.flow) continue;
    if (!best || Date.parse(b.startedAt) > Date.parse(best.startedAt)) best = b;
  }
  return best ? { runId: best.runId, level: autonomyOfRun(best), startedAt: best.startedAt } : undefined;
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
export function gateDepsFor(ctx: ApiContext, now: Date, known?: Promise<RunBrief[]>): GateDeps {
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
          briefs ??= known ?? ctx.scheduler.briefsAsync();
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

/** The accountable owner now. Logs one fixed line when the configured owner is not used. Undefined when the users cannot be read. */
function ownerNow(ctx: ApiContext): AutonomyOwner | undefined {
  try {
    const owner = accountableOwner(ctx.config().governance.owner, listUsers());
    if (owner?.problem) ctx.diagLog?.("autonomy: the configured owner is not an active admin; the first admin is the owner");
    return owner;
  } catch {
    return undefined;
  }
}

/** The approval check says what is waiting; its value stays `pending` and it never counts in `passed`. */
function withApprovalDetail(gate: PromotionGate, request: AutonomyRequest | undefined): PromotionGate {
  if (!request) return gate;
  const detail = request.state === "pending" ? "A promotion request waits for the owner to approve it." : "The last promotion request has expired; ask again.";
  return { ...gate, checks: gate.checks.map((c) => (c.id === "approval" ? { ...c, detail } : c)) };
}

/** The levels and gates of every repository and flow. Never reads a path into the answer. */
export async function autonomyStatus(ctx: ApiContext, now: Date, viewer?: string): Promise<AutonomyStatus> {
  let store: AutonomyStore;
  let problem: string | undefined;
  try {
    store = readAutonomy();
  } catch {
    store = emptyAutonomyStore();
    problem = PROBLEM;
  }
  const unreadable = problem !== undefined;
  // The runs are listed once and shared with the gates. A gate sees a failure itself; the newest-run lookup reports it.
  const known = ctx.scheduler.briefsAsync();
  let all: RunBrief[] | undefined;
  let runsProblem: string | undefined;
  try {
    all = await known;
  } catch {
    runsProblem = "The runs could not be listed, so the newest run of each component is not known.";
    ctx.diagLog?.("autonomy: the run list could not be read");
  }
  const deps = gateDepsFor(ctx, now, known);
  const from = new Date(now.getTime() - deps.settings.within_days * DAY_MS);
  const targets: { kind: AutonomyKind; id: string; name: string; level: AutonomyLevel }[] = [
    ...guardedRepos(ctx, listAllRepos).map((r) => ({ kind: "repos" as const, id: r.id, name: githubNameOf(r.url) ?? r.id, level: unreadable ? OBSERVE : levelsOf(store, [r.id], "").repository ?? "delivery-handoff" })),
    ...flowNames(ctx, store).map((n) => ({ kind: "flows" as const, id: n, name: n, level: unreadable ? OBSERVE : levelsOf(store, [], n).flow })),
  ];
  const owner = ownerNow(ctx);
  const names = ownerNames();
  const person = (id: string): AutonomyPerson => ({ id, name: names.get(id) ?? GONE });
  let admins: string[] = [];
  try {
    admins = activeAdmins(listUsers()).map((u) => u.id);
  } catch {
    // no list of admins: nobody is shown as an approver
  }
  const githubOf = new Map(listAllRepos().map((r) => [r.id, githubNameOf(r.url)]));
  const components: AutonomyComponent[] = [];
  for (const [i, t] of targets.entries()) {
    if (i > 0) await turn();
    const next = nextLevel(t.level);
    const stored = unreadable ? undefined : requestOf(store, t.kind, t.id);
    const request = stored && (liveRequest(store, t) ? stored : { ...stored, state: "expired" as const });
    const gate = withApprovalDetail(await promotionGate(t.kind, t.id, next ?? t.level, now, deps), request);
    const github = t.kind === "repos" ? githubOf.get(t.id) : undefined;
    const newest = all && (t.kind === "flows" || github !== undefined) ? newestRunOf(all, t.kind === "flows" ? { flow: t.id } : { repo: github }) : undefined;
    let approval: AutonomyApproval | undefined;
    if (request?.state === "pending" && owner) {
      const approvers = approversOf({ requester: request.by, owner: owner.id, to: request.to, admins }).map((a) => ({ ...person(a.id), selfApproved: a.selfApproved }));
      approval = { requester: person(request.by), approvers, mayApprove: viewer !== undefined && approvers.some((a) => a.id === viewer) };
    }
    components.push({ ...t, next, gate, ...(request ? { request } : {}), ...(newest ? { newestRun: newest } : {}), ...(approval ? { approval } : {}) });
  }
  return {
    levels: AUTONOMY_LEVELS,
    window: { from: from.toISOString(), to: now.toISOString(), days: deps.settings.within_days },
    settings: deps.settings,
    ...(problem ? { problem } : {}),
    ...(owner ? { owner, ownerName: names.get(owner.id) ?? GONE } : {}),
    ...(runsProblem ? { runsProblem } : {}),
    components,
  };
}

// ---- promote, approve, demote ----------------------------------------------------------------------

export type GateOf = (kind: AutonomyKind, id: string, to: AutonomyLevel, now: Date) => Promise<PromotionGate>;
const liveGate =
  (ctx: ApiContext): GateOf =>
  (kind, id, to, now) =>
    promotionGate(kind, id, to, now, gateDepsFor(ctx, now));

/** Maps the errors of a change to answers. No answer holds a path or quotes the input. */
async function guarded<T>(ctx: ApiContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof AutonomyError) throw new HttpError(400, e.message);
    if (e instanceof AutonomyRefused) throw new HttpError(e.status, e.message, undefined, e.extra);
    if (e instanceof StoreError) {
      if (e.kind === "locked") throw new HttpError(503, "the data folder is busy; try again");
      ctx.diagLog?.(`autonomy: ${basename(e.file)} ${e.kind}`);
    } else {
      ctx.diagLog?.("autonomy: the change failed");
    }
    throw new HttpError(500, "the level could not be changed; nothing was changed");
  }
}

/** The component and level a body names. 400 for a bad field, 404 for a repository or flow that is not known. */
function targetOf(ctx: ApiContext, body: Record<string, unknown>): { ref: ComponentRef; to: AutonomyLevel } {
  const kind = body.kind;
  if (kind !== "repos" && kind !== "flows") throw new HttpError(400, "the kind must be repos or flows");
  if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "the id must be a text");
  const to = AutonomyLevelSchema.safeParse(body.to);
  if (!to.success) throw new HttpError(400, "the level is not valid");
  const id = body.id;
  const known = kind === "repos" ? listAllRepos().some((r) => r.id === id) : flowNames(ctx, readAutonomy()).includes(id);
  if (!known) throw new HttpError(404, kind === "repos" ? "no such repository" : "no such flow");
  return { ref: { kind, id }, to: to.data };
}

/** The ids of the failed evidence checks, for the audit line. */
const failedIds = (g: PromotionGate): string => g.checks.filter((c) => !c.passed && c.id !== "approval").map((c) => c.id).join(",") || "gate";

/** POST /api/autonomy/promote: stores a request when `to` is one level up and the gate passes. */
export const promoteAutonomy = (ctx: ApiContext, user: User, body: Record<string, unknown>, gate: GateOf = liveGate(ctx)) =>
  guarded(ctx, async () => {
    const { ref, to } = targetOf(ctx, body);
    const reason = checkReason(body.reason);
    const from = checkPromotable(readAutonomy(), ref, to);
    const g = await gate(ref.kind, ref.id, to, new Date());
    if (!g.passed) {
      try {
        writeAudit(user.id, { action: "autonomy-promote-request", result: "failed", target: `${ref.kind}:${ref.id}`, detail: `${from}→${to} refused: ${failedIds(g)}` }, 0);
      } catch {
        ctx.diagLog?.("audit: audit.jsonl not-written (autonomy-promote-request)");
      }
      throw new AutonomyRefused(409, "the gate does not pass", { gate: g });
    }
    const request = requestPromotion({ ref, to, reason, by: user.id });
    return { request, owner: ownerNow(ctx), gate: g };
  });

/** POST /api/autonomy/approve: carries out the waiting request with this token. */
export const approveAutonomy = (ctx: ApiContext, user: User, body: Record<string, unknown>, gate: GateOf = liveGate(ctx)) =>
  guarded(ctx, async () => {
    const { ref, to } = targetOf(ctx, body);
    if (typeof body.token !== "string" || !body.token) throw new HttpError(400, "the token must be a text");
    const token = body.token;
    const configuredOwner = () => ctx.config().governance.owner;
    // the gate runs only for a request that is ready and a person who may approve it; the lock checks it all again
    const store = readAutonomy();
    const req = liveRequest(store, ref);
    const g = req && req.token === token && req.to === to && mayApprove(store, ref, to, user.id, configuredOwner()) ? await gate(ref.kind, ref.id, to, new Date()) : undefined;
    const r = approvePromotion({ ref, to, token, by: user.id, configuredOwner, ...(g ? { gate: g } : {}) });
    if (r.owner.problem) ctx.diagLog?.("autonomy: the configured owner is not an active admin; the first admin is the owner");
    return { kind: ref.kind, id: ref.id, from: r.from, to: r.to, level: r.to, requester: r.requester, approver: r.approver, selfApproved: r.selfApproved, entry: r.entry };
  });

/** POST /api/autonomy/demote: lowers a level at once. No gate. */
export const demoteAutonomy = (ctx: ApiContext, user: User, body: Record<string, unknown>) =>
  guarded(ctx, async () => {
    const { ref, to } = targetOf(ctx, body);
    const r = demoteLevel({ ref, to, reason: checkReason(body.reason), by: user.id });
    return { kind: ref.kind, id: ref.id, from: r.from, to: r.to, level: r.to, entry: r.entry };
  });

/** GET /api/autonomy and POST /api/autonomy/promote|approve|demote. */
export const autonomyRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "autonomy") return false;
  if (seg.length === 1 && method === "GET") {
    if (user.role !== "admin") throw new HttpError(403, "only an admin can see the autonomy levels");
    send(res, 200, await autonomyStatus(ctx, new Date(), user.id));
    return true;
  }
  if (seg.length === 2 && seg[1] === "history" && method === "GET") {
    if (user.role !== "admin") throw new HttpError(403, "only an admin can see the autonomy history");
    send(res, 200, await autonomyHistory(ctx, req));
    return true;
  }
  const act = seg.length === 2 && method === "POST" ? seg[1] : undefined;
  if (act !== "promote" && act !== "approve" && act !== "demote") return false;
  if (user.role !== "admin") throw new HttpError(403, "only an admin can change an autonomy level");
  const body = await readJson(req);
  if (act === "promote") send(res, 201, await promoteAutonomy(ctx, user, body));
  else send(res, 200, await (act === "approve" ? approveAutonomy : demoteAutonomy)(ctx, user, body));
  return true;
};
