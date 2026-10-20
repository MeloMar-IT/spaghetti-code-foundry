import { isRefinementRun } from "./auth/run-owner.js";
import type { RunSummary } from "./engine/state.js";
import { TERMINAL_RUN_STATUSES } from "./evidence/schema.js";
import type { MeasureOwner } from "./monitor/measures.js";
import type { OutcomeFacts } from "./outcome-facts.js";
import { workKey } from "./stats.js";

// The ten outcome measures: what is measured over a window of run history and evidence, who acts on it, which decision
// it informs, and which measures must be read with it. Pure: reads no files. `excluded` always counts runs.

export const OUTCOME_IDS = [
  "issue_to_pr_time", "first_pass_test_success", "merge_rate", "rework", "policy_blocks",
  "evidence_completeness", "resume_count", "approval_latency", "cost_per_successful_run", "returning_users",
] as const;
export type OutcomeId = (typeof OUTCOME_IDS)[number];
export type OutcomeCategory = "speed" | "quality" | "rework" | "policy" | "cost" | "user";

export interface OutcomeDefinition {
  id: OutcomeId;
  label: string;
  unit: "ms" | "share" | "count" | "usd";
  category: OutcomeCategory;
  owner: MeasureOwner;
  /** The decision the measure informs: a sentence, and the detector or the setting it belongs to. */
  decision: { text: string } & ({ detector: string } | { setting: string });
  /** Measures to read with this one, so that a gain in one is not paid for in another. */
  pairedWith: readonly OutcomeId[];
  countOf: "runs" | "work items" | "accounts";
  definition: string;
  exclusions: string;
  adminOnly: boolean;
}

const NO_EVIDENCE = "Runs without readable evidence (older runs, or a file that is missing, too large or a link).";

export const OUTCOME_DEFINITIONS: readonly OutcomeDefinition[] = [
  {
    id: "issue_to_pr_time", label: "Issue to pull request", unit: "ms", category: "speed", owner: "repository owner",
    decision: { text: "Whether work gets from an issue to a pull request fast enough, or needs more slots or fewer steps.", setting: "concurrency" },
    pairedWith: ["first_pass_test_success", "rework", "policy_blocks", "returning_users"], countOf: "work items",
    definition: "The median time from the first queueing or start of a GitHub issue's runs to the end of the first run that delivered it. A run delivers when it succeeded and a push policy decision did not deny it.",
    exclusions: `${NO_EVIDENCE} Runs without an issue. Issues delivered before the window. Refinement runs.`, adminOnly: false,
  },
  {
    id: "first_pass_test_success", label: "First-pass test success", unit: "share", category: "quality", owner: "repository owner",
    decision: { text: "Whether the tests pass on the first try, or the build steps need better instructions.", detector: "same-step-failing" },
    pairedWith: ["issue_to_pr_time", "cost_per_successful_run"], countOf: "runs",
    definition: "The share of runs whose first test run (not a baseline run before the work) passed.",
    exclusions: `${NO_EVIDENCE} Runs with no test result, such as plan-only flows. Refinement runs.`, adminOnly: false,
  },
  {
    id: "merge_rate", label: "Merge rate (pushed work)", unit: "share", category: "quality", owner: "repository owner",
    decision: { text: "Whether a flow delivers the work it starts. Merges done by hand on GitHub are not seen.", detector: "unexplained-failure" },
    pairedWith: ["issue_to_pr_time", "rework"], countOf: "work items",
    definition: "The share of work items, in flows that push, that a run delivered. A run delivers when it succeeded and a push policy decision did not deny it.",
    exclusions: `${NO_EVIDENCE} Flows that never push in the window. Runs that work on no issue, pull request or CI run. Refinement runs.`, adminOnly: false,
  },
  {
    id: "rework", label: "Rework after delivery", unit: "count", category: "rework", owner: "repository owner",
    decision: { text: "Whether delivered work comes back, so the review steps must be stricter.", setting: "review steps of the flow" },
    pairedWith: ["merge_rate", "issue_to_pr_time", "cost_per_successful_run"], countOf: "work items",
    definition: "The number of work items delivered in the window that a later run worked on again before the end of the window.",
    exclusions: `${NO_EVIDENCE} Later runs without readable evidence. Items delivered outside the window. Refinement runs.`, adminOnly: false,
  },
  {
    id: "policy_blocks", label: "Policy blocks", unit: "count", category: "policy", owner: "admin",
    decision: { text: "Whether an observed policy pack is ready to enforce, or would block too much.", setting: "policy.packs" },
    pairedWith: ["issue_to_pr_time", "approval_latency", "cost_per_successful_run"], countOf: "runs",
    definition: "The number of runs that a policy stopped at least once. The details also give the denials that observed packs would have made.",
    exclusions: `${NO_EVIDENCE} Refinement runs.`, adminOnly: false,
  },
  {
    id: "evidence_completeness", label: "Evidence completeness", unit: "share", category: "quality", owner: "admin",
    decision: { text: "Whether every run leaves complete evidence before more work is trusted to the Foundry.", detector: "evidence-finalization" },
    pairedWith: ["resume_count", "cost_per_successful_run"], countOf: "runs",
    definition: "The share of runs with an evidence file that also have the final manifest and are not marked incomplete.",
    exclusions: "Runs without an evidence file. Refinement runs.", adminOnly: false,
  },
  {
    id: "resume_count", label: "Resumes", unit: "count", category: "rework", owner: "admin",
    decision: { text: "Whether runs stop and restart too often.", detector: "restart-loop" },
    pairedWith: ["issue_to_pr_time", "cost_per_successful_run"], countOf: "runs",
    definition: "The number of times the runs of the window were resumed. The details give the share of runs resumed at least once.",
    exclusions: "Refinement runs.", adminOnly: false,
  },
  {
    id: "approval_latency", label: "Approval latency", unit: "ms", category: "speed", owner: "repository owner",
    decision: { text: "Whether people decide approvals fast enough, or a flow has approval steps it does not need.", setting: "approval steps of the flow" },
    pairedWith: ["first_pass_test_success", "rework", "policy_blocks", "returning_users"], countOf: "runs",
    definition: "The mean time from the moment a run waited for an approval to the decision.",
    exclusions: `${NO_EVIDENCE} Runs with no approval are not counted. Refinement runs.`, adminOnly: false,
  },
  {
    id: "cost_per_successful_run", label: "Cost per successful run", unit: "usd", category: "cost", owner: "admin",
    decision: { text: "Whether the money spent buys finished work, and the daily budget fits.", setting: "daily_budget_usd" },
    pairedWith: ["first_pass_test_success", "rework", "policy_blocks", "returning_users"], countOf: "runs",
    definition: "The cost of all runs of the window, failed ones included, divided by the number of runs that succeeded.",
    exclusions: "Refinement runs. No value when no run succeeded.", adminOnly: false,
  },
  {
    id: "returning_users", label: "Returning users", unit: "count", category: "user", owner: "admin",
    decision: { text: "Whether people keep using the Foundry before it is rolled out further.", setting: "user accounts" },
    pairedWith: ["issue_to_pr_time", "cost_per_successful_run"], countOf: "accounts",
    definition: "The number of accounts that started a run that ended in the window and one that ended in the window before it. Only counts are given, never an account.",
    exclusions: "Runs without an owner. Refinement runs.", adminOnly: true,
  },
];

export interface OutcomeWindow { from: Date; to: Date; previousFrom: Date }
export interface OutcomeValue { id: OutcomeId; value: number | null; detail: Record<string, number | null>; counted: number; excluded: number }
export interface Outcomes { from: string; to: string; previousFrom: string; open: number; measures: OutcomeValue[] }

export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
/** part ÷ whole to 4 decimals; null when there is no whole. */
export const share = (part: number, whole: number): number | null => (whole > 0 ? round4(part / whole) : null);
/** The median; an even count gives the rounded mean of the two middle values. null when empty. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const whole = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const iso = (d: unknown): string => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : "");

function empty(window: OutcomeWindow): Outcomes {
  return {
    from: iso(window?.from), to: iso(window?.to), previousFrom: iso(window?.previousFrom), open: 0,
    measures: OUTCOME_IDS.map((id) => ({ id, value: null, detail: {}, counted: 0, excluded: 0 })),
  };
}

type Facts = ReadonlyMap<string, OutcomeFacts>;

/**
 * The ten measures over the window [from, to). Never throws: on an error or a bad window every measure is null.
 * Runs count by when they ended; work items by the end of their first delivery.
 */
export function computeOutcomes(runs: readonly RunSummary[], facts: Facts, window: OutcomeWindow): Outcomes {
  try {
    return compute(runs, facts, window);
  } catch {
    return empty(window);
  }
}

function compute(runsIn: readonly RunSummary[], facts: Facts, window: OutcomeWindow): Outcomes {
  const f = window.from?.getTime();
  const t = window.to?.getTime();
  const p = window.previousFrom?.getTime();
  if (!Number.isFinite(f) || !Number.isFinite(t) || !Number.isFinite(p) || f >= t) return empty(window);
  const all = (Array.isArray(runsIn) ? runsIn : []).filter((r): r is RunSummary => !!r && typeof r === "object");
  const refinement = all.filter((r) => isRefinementRun(r.source));
  const runs = all.filter((r) => !isRefinementRun(r.source));
  const end = (r: RunSummary): number => ((TERMINAL_RUN_STATUSES as readonly string[]).includes(r.status) ? Date.parse(r.finishedAt ?? "") : NaN);
  const ended = (r: RunSummary) => Number.isFinite(end(r));
  const inWin = runs.filter((r) => end(r) >= f && end(r) < t);
  const refined = refinement.filter((r) => end(r) >= f && end(r) < t).length;
  const open = runs.filter((r) => !ended(r) && Date.parse(r.startedAt) >= f && Date.parse(r.startedAt) < t).length;
  const fx = (r: RunSummary): OutcomeFacts | undefined => facts?.get?.(r.runId);
  const hasEv = (r: RunSummary): boolean => !!fx(r)?.evidence.stream && !!fx(r)?.evidence.read;
  const noEv = inWin.filter((r) => !hasEv(r)).length;

  // the first delivering run of every work item, over all runs
  const byKey = new Map<string, RunSummary[]>();
  for (const r of runs) byKey.set(workKey(r), [...(byKey.get(workKey(r)) ?? []), r]);
  const firstDelivery = new Map<string, RunSummary>();
  for (const [key, list] of byKey) {
    let d: RunSummary | undefined;
    for (const r of list) if (ended(r) && hasEv(r) && fx(r)!.delivered && (!d || end(r) < end(d))) d = r;
    if (d) firstDelivery.set(key, d);
  }
  const deliveredInWin = [...firstDelivery].filter(([, d]) => end(d) >= f && end(d) < t);

  const m = new Map<OutcomeId, OutcomeValue>();
  const set = (id: OutcomeId, value: number | null, detail: Record<string, number | null>, counted: number, excluded: number) => {
    m.set(id, { id, value: value !== null && Number.isFinite(value) ? value : null, detail, counted, excluded: excluded + refined });
  };

  // issue_to_pr_time
  {
    const times: number[] = [];
    for (const [key, d] of deliveredInWin) {
      if (!key.includes("#issue:")) continue;
      let start = Infinity;
      for (const r of byKey.get(key) ?? []) {
        if (!(Date.parse(r.startedAt) <= end(d))) continue;
        const s = Date.parse(fx(r)?.queuedAt ?? r.startedAt);
        const own = Number.isFinite(s) ? s : Date.parse(r.startedAt);
        if (Number.isFinite(own)) start = Math.min(start, own);
      }
      if (Number.isFinite(start)) times.push(Math.max(0, end(d) - start));
    }
    set("issue_to_pr_time", median(times), { longestMs: times.length ? Math.max(...times) : null }, times.length,
      inWin.filter((r) => !hasEv(r) || !workKey(r).includes("#issue:")).length);
  }

  // first_pass_test_success
  {
    const counted = inWin.filter((r) => hasEv(r) && fx(r)!.firstTest !== undefined);
    const passed = counted.filter((r) => fx(r)!.firstTest === "passed").length;
    set("first_pass_test_success", share(passed, counted.length), { passed }, counted.length, inWin.length - counted.length);
  }

  // merge_rate
  {
    const pushing = new Set(inWin.filter((r) => hasEv(r) && fx(r)!.pushed).map((r) => r.flow));
    const eligible = inWin.filter((r) => hasEv(r) && pushing.has(r.flow) && workKey(r) !== r.runId);
    const keys = new Set(eligible.map(workKey));
    const delivered = new Set(eligible.filter((r) => fx(r)!.delivered).map(workKey));
    set("merge_rate", share(delivered.size, keys.size), { delivered: delivered.size }, keys.size, inWin.length - eligible.length);
  }

  // rework
  {
    let reworked = 0;
    for (const [key, d] of deliveredInWin) {
      const again = (byKey.get(key) ?? []).some((r) => r !== d && ended(r) && hasEv(r) && Date.parse(r.startedAt) > end(d) && end(r) < t);
      if (again) reworked++;
    }
    set("rework", reworked, { share: share(reworked, deliveredInWin.length) }, deliveredInWin.length, noEv);
  }

  // policy_blocks
  {
    const counted = inWin.filter(hasEv);
    set("policy_blocks", counted.filter((r) => fx(r)!.policyBlocks > 0).length, { wouldBlock: counted.reduce((a, r) => a + fx(r)!.observeDenies, 0) }, counted.length, noEv);
  }

  // evidence_completeness
  {
    const counted = inWin.filter((r) => fx(r)?.evidence.stream);
    const complete = counted.filter((r) => fx(r)!.evidence.manifest && !fx(r)!.evidence.incomplete).length;
    set("evidence_completeness", share(complete, counted.length), { complete }, counted.length, inWin.length - counted.length);
  }

  // resume_count
  {
    const per = inWin.map((r) => fx(r)?.resumes ?? whole(r.resumes) ?? 0);
    set("resume_count", per.reduce((a, b) => a + b, 0), { share: share(per.filter((n) => n > 0).length, inWin.length) }, inWin.length, 0);
  }

  // approval_latency
  {
    const counted = inWin.filter((r) => hasEv(r) && fx(r)!.approvals.decided > 0);
    const decisions = counted.reduce((a, r) => a + fx(r)!.approvals.decided, 0);
    const total = counted.reduce((a, r) => a + fx(r)!.approvals.totalMs, 0);
    set("approval_latency", decisions ? Math.round(total / decisions) : null,
      { longestMs: counted.length ? Math.max(...counted.map((r) => fx(r)!.approvals.maxMs)) : null, decisions }, counted.length, noEv);
  }

  // cost_per_successful_run
  {
    const costUsd = round4(inWin.reduce((a, r) => a + (typeof r.totalCostUsd === "number" && Number.isFinite(r.totalCostUsd) && r.totalCostUsd >= 0 ? r.totalCostUsd : 0), 0));
    const succeeded = inWin.filter((r) => r.status === "succeeded").length;
    set("cost_per_successful_run", succeeded ? round4(costUsd / succeeded) : null, { costUsd, succeeded }, inWin.length, 0);
  }

  // returning_users: counts only, never an account
  {
    const owner = (r: RunSummary) => (typeof r.owner === "string" && r.owner ? r.owner : undefined);
    const cur = new Set(inWin.flatMap((r) => owner(r) ?? []));
    const prev = new Set(runs.filter((r) => end(r) >= p && end(r) < f).flatMap((r) => owner(r) ?? []));
    set("returning_users", [...cur].filter((o) => prev.has(o)).length, { previous: prev.size }, cur.size, inWin.filter((r) => !owner(r)).length);
  }

  return { from: iso(window.from), to: iso(window.to), previousFrom: iso(window.previousFrom), open, measures: OUTCOME_IDS.map((id) => m.get(id)!) };
}

/** "—" for null; ms as minutes or hours, share as %, usd as $0.00, count as is. */
export function outcomeText(def: OutcomeDefinition, value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  switch (def.unit) {
    case "ms": return value < 3_600_000 ? `${Math.round(value / 60_000)} min` : `${Math.round(value / 360_000) / 10} h`;
    case "share": return `${Math.round(value * 1000) / 10}%`;
    case "usd": return `$${value.toFixed(2)}`;
    default: return String(value);
  }
}
