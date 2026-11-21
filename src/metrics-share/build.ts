import { isRefinementRun } from "../auth/run-owner.js";
import type { RunBrief, RunSummary } from "../engine/state.js";
import { TERMINAL_RUN_STATUSES } from "../evidence/schema.js";
import type { RunMeasures } from "../monitor/measures.js";
import type { OutcomeFacts } from "../outcome-facts.js";
import { computeOutcomes, issueToPrTimes, type OutcomeId } from "../outcomes.js";
import {
  DURATION_EDGES_MS, NO_INSTALL, PARTS_EDGES, SHARE_REPORT_VERSION, ShareReportSchema, addTo, emptyHistogram, flowKeyOf, modelKeyOf, stepKeyOf,
  type Histogram, type ShareReport, type SourceKey,
} from "./report.js";

// The pure builder of the shared report: plain data in, the report out. It reads no files.
// Only runs whose owner is one of the given accounts count; runs without an owner never do.
// A measure whose source is missing is left out; a zero means the source was there and recorded none.

const DAY_MS = 86_400_000;
export const DAY_TEXT = "day must be YYYY-MM-DD";

/** What one run gives the report, reduced when it was read: a slim run.json (no task, no output) and a few facts of its evidence. */
export interface ShareRun {
  run: RunSummary;
  /** The facts the outcome measures use (src/outcome-facts.ts); `evidence.read` false when the evidence could not be read. */
  facts: OutcomeFacts;
  /** `measureRun` of the run (src/monitor/measures.ts), the source of `run.measured`. */
  measures: RunMeasures;
  /** Facts of the evidence that only this report uses; absent when the evidence could not be read. */
  evidence?: {
    /** `step.routed` events with `fallbackFrom`: a model took over after a limit. */
    fallbacks: number;
    /** Times of the `run.stopped` events at a step that asks a person questions. */
    questionStops: string[];
    /** The run made a release: a top-level `handoff` (pull request develop → main) or `final_merge` (local release) completed. */
    released: boolean;
  };
  /** The wait (ms) of each decided approval of the run, one per decision (from `approvalWaitsMs`). */
  approvalWaitsMs: number[];
  /** The question rounds the Foundry decided itself (decided.json): when, with what outcome and how many questions. Absent when the file is unreadable or invalid. */
  decided?: { at: string; outcome: string; questions: number }[];
}

export interface ShareSplit { id: string; runId: string; time: string; parts: number }

export interface ShareInput {
  day: string;
  accountIds: readonly string[];
  /** The random install id of metrics-share.json (#889); NO_INSTALL while there is none (the preview). */
  install?: string;
  foundryVersion: string;
  /** All run briefs of the install (the owner rule is applied here). */
  briefs: readonly RunBrief[];
  /** The loaded runs: the runs the outcome measures need and the runs active on the day. */
  runs: readonly ShareRun[];
  /** The `issue.split` usage events of the day's month; undefined when the usage file cannot be read. */
  splits?: readonly ShareSplit[];
  /** Watcher id → source. A run of a watcher that is not here is `unknown`. */
  watcherSources: ReadonlyMap<string, SourceKey>;
}

/** [from, to) of a UTC day. Throws DAY_TEXT for anything that is not a real YYYY-MM-DD date. */
export function dayWindow(day: string): { from: Date; to: Date } {
  const from = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00.000Z`) : new Date(NaN);
  if (!Number.isFinite(from.getTime()) || from.toISOString().slice(0, 10) !== day) throw new Error(DAY_TEXT);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

const stamp = (t: unknown): number => (typeof t === "string" ? Date.parse(t) : NaN);
const whole = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const usd = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const QUESTION_ROUNDS_ANSWERED = "went_on";

/** The source of a run: the watcher's source, `manual` when no watcher started it, `unknown` for a watcher that is gone. */
export function sourceKeyOf(source: unknown, watchers: ReadonlyMap<string, SourceKey>): SourceKey {
  const id = /^watcher ([\w-]{1,128})(?: |$)/.exec(typeof source === "string" ? source : "")?.[1];
  if (!id) return "manual";
  return watchers.get(id) ?? "unknown";
}

/** Sum of the defined values; undefined when none is defined (no source). */
function sumOf(values: Iterable<number | undefined>): number | undefined {
  let n: number | undefined;
  for (const v of values) if (v !== undefined) n = (n ?? 0) + v;
  return n;
}

const bump = <K extends string>(o: Partial<Record<K, number>>, k: K, by = 1): void => {
  o[k] = (o[k] ?? 0) + by;
};

/** The report of one day. Throws DAY_TEXT for a bad day; the result is checked against ShareReportSchema. */
export function shareReportFrom(input: ShareInput): ShareReport {
  const { from, to } = dayWindow(input.day);
  const f = from.getTime();
  const t = to.getTime();
  const accounts = new Set(input.accountIds.filter((a) => typeof a === "string" && a));
  const eligible = (o: { owner?: unknown; source?: unknown; localTest?: unknown }): boolean =>
    typeof o.owner === "string" && accounts.has(o.owner) && !isRefinementRun(typeof o.source === "string" ? o.source : undefined) && o.localTest !== true;
  const inDay = (ms: number) => ms >= f && ms < t;

  // activity by start
  const started = input.briefs.filter((b) => eligible(b) && inDay(stamp(b.startedAt)));
  const runs = input.runs.filter((r) => r?.run && eligible(r.run));
  const ended = runs.filter((r) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(r.run.status) && inDay(stamp(r.run.finishedAt)));
  const withEvidence = ended.filter((r) => r.facts.evidence.stream && r.facts.evidence.read);
  const evidenceKnown = withEvidence.length > 0;
  const ev = <T>(v: T): T | undefined => (evidenceKnown ? v : undefined);

  // the outcome measures over the day
  const facts = new Map(runs.map((r) => [r.run.runId, r.facts]));
  const window = { from, to, previousFrom: new Date(f - DAY_MS) };
  const outcomes = new Map(computeOutcomes(runs.map((r) => r.run), facts, window).measures.map((m) => [m.id, m]));
  const out = (id: OutcomeId) => outcomes.get(id)!;

  // changes
  const runsEnded = { succeeded: 0, failed: 0, cancelled: 0 };
  for (const r of ended) runsEnded[r.run.status as keyof typeof runsEnded]++;
  const changes: ShareReport["changes"] = { runsStarted: started.length, runsEnded };
  const put = <T extends object>(o: T, k: keyof T, v: unknown) => {
    if (v !== undefined) (o as Record<string, unknown>)[k as string] = v;
  };
  put(changes, "workItemsDelivered", ev(out("rework").counted));
  put(changes, "pullRequestsDelivered", ev(withEvidence.filter((r) => r.measures.pullRequest?.delivered).length));
  put(changes, "dailyReleases", ev(withEvidence.filter((r) => r.run.flow === "release-daily" && r.run.status === "succeeded" && r.evidence?.released).length));

  // speed
  const runDuration = emptyHistogram(DURATION_EDGES_MS);
  const queueTime = emptyHistogram(DURATION_EDGES_MS);
  const approvalLatency = emptyHistogram(DURATION_EDGES_MS);
  const issueToPullRequest = emptyHistogram(DURATION_EDGES_MS);
  const stepTime: Partial<Record<string, Histogram>> = {};
  for (const r of ended) {
    addTo(runDuration, r.measures.durationMs, DURATION_EDGES_MS);
    addTo(queueTime, r.measures.queueMs, DURATION_EDGES_MS);
    // one observation per decision: a run with a 1-minute and a 1-hour wait gives two values, not their mean
    for (const w of r.approvalWaitsMs) addTo(approvalLatency, w, DURATION_EDGES_MS);
  }
  for (const ms of issueToPrTimes(runs.map((r) => r.run), facts, window)) addTo(issueToPullRequest, ms, DURATION_EDGES_MS);

  // cost, step time, retries and repeated steps: from the step records of the runs that ended
  const byModel: Partial<Record<string, { tokensIn: number; tokensOut: number; costUsd?: number }>> = {};
  const byStep: Partial<Record<string, { tokensIn: number; tokensOut: number; costUsd?: number }>> = {};
  const repeatedSteps: Partial<Record<string, number>> = {};
  const retries: (number | undefined)[] = [];
  // `withEarlier`: the paid earlier tries of a step (retries and fallbacks) count for the step, not for the final model:
  // the record does not say which model they ran on.
  const addTokens = (o: typeof byStep, k: string, rec: RunSummary["history"][number], withEarlier: boolean) => {
    const tin = whole(rec.tokens?.input);
    const tout = whole(rec.tokens?.output);
    const earlier = withEarlier ? usd(rec.earlierCostUsd) ?? 0 : 0;
    const cost = usd(rec.costUsd) === undefined && earlier === 0 ? undefined : (usd(rec.costUsd) ?? 0) + earlier;
    if (tin === undefined && tout === undefined && cost === undefined) return;
    const e = (o[k] ??= { tokensIn: 0, tokensOut: 0 });
    e.tokensIn += tin ?? 0;
    e.tokensOut += tout ?? 0;
    if (cost !== undefined) e.costUsd = round6((e.costUsd ?? 0) + cost);
  };
  for (const r of ended) {
    for (const rec of Array.isArray(r.run.history) ? r.run.history : []) {
      if (!rec || typeof rec.id !== "string") continue;
      const key = stepKeyOf(rec.id, r.run.flow);
      const h = (stepTime[key] ??= emptyHistogram(DURATION_EDGES_MS));
      addTo(h, whole(rec.durationMs), DURATION_EDGES_MS);
      if ((whole(rec.visit) ?? 1) > 1 && !rec.parent) bump(repeatedSteps, key);
      if (rec.retried && typeof rec.retried === "object") retries.push((whole(rec.retried.blips) ?? 0) + (whole(rec.retried.models) ?? 0));
      addTokens(byStep, key, rec, true);
      const model = modelKeyOf(rec.agent);
      if (model) addTokens(byModel, model, rec, false);
    }
  }
  for (const [k, h] of Object.entries(stepTime)) if (h && !h.counts.some((n) => n > 0)) delete stepTime[k];

  // splits (timestamped activity: by the time of the usage event)
  const runOwner = new Map(input.briefs.map((b) => [b.runId, b]));
  const splits: ShareReport["splits"] = {};
  if (input.splits) {
    const seen = new Set<string>();
    const parts = emptyHistogram(PARTS_EDGES);
    let n = 0;
    for (const s of input.splits) {
      const b = runOwner.get(s.runId);
      if (!b || !eligible(b) || !inDay(stamp(s.time)) || seen.has(s.id)) continue;
      seen.add(s.id);
      n++;
      addTo(parts, s.parts, PARTS_EDGES);
    }
    splits.issuesSplit = n;
    splits.partsPerSplit = parts;
  }

  // questions: a stop at a question step on the day counts, also when the run was resumed later. The counts exist only
  // when every owned run that was active on the day could be read: otherwise an unreadable source would look like 0.
  const activeBriefs = input.briefs.filter((b) => eligible(b) && stamp(b.startedAt) < t && !(stamp(b.finishedAt) < f));
  const loaded = new Map(runs.map((r) => [r.run.runId, r]));
  const allKnown = (known: (r: ShareRun) => boolean) => activeBriefs.every((b) => {
    const r = loaded.get(b.runId);
    return !!r && known(r);
  });
  const questions: Pick<ShareReport["quality"], "stoppedWithQuestions" | "questionsAnsweredAutomatically"> = {};
  if (allKnown((r) => r.evidence !== undefined)) questions.stoppedWithQuestions = runs.filter((r) => r.evidence?.questionStops.some((at) => inDay(stamp(at)))).length;
  if (allKnown((r) => r.decided !== undefined)) {
    questions.questionsAnsweredAutomatically = runs.reduce(
      (a, r) => a + (r.decided ?? []).filter((d) => d.outcome === QUESTION_ROUNDS_ANSWERED && inDay(stamp(d.at))).reduce((x, d) => x + d.questions, 0),
      0,
    );
  }

  const rework: ShareReport["rework"] = { repeatedSteps };
  put(rework, "reworkedAfterDelivery", ev(out("rework").value ?? 0));
  put(rework, "resumes", sumOf(ended.map((r) => whole(r.measures.resumes))));
  put(rework, "stepRetries", sumOf(retries));

  const quality: ShareReport["quality"] = { ...questions };
  const fp = out("first_pass_test_success");
  put(quality, "firstPassTests", ev({ passed: fp.detail.passed ?? 0, counted: fp.counted }));
  const mr = out("merge_rate");
  put(quality, "mergeRate", ev({ delivered: mr.detail.delivered ?? 0, counted: mr.counted }));
  const ec = out("evidence_completeness");
  if (ended.length) quality.evidence = { complete: ec.detail.complete ?? 0, counted: ec.counted };
  put(quality, "policyBlocks", ev(out("policy_blocks").value ?? 0));
  put(quality, "denials", sumOf(ended.flatMap((r) => r.measures.steps.map((s) => s.denials))));

  const cost: ShareReport["cost"] = { byModel, byStep };
  const total = sumOf(ended.map((r) => usd(r.measures.costUsd)));
  put(cost, "costUsd", total === undefined ? undefined : round6(total));
  put(cost, "modelFallbacks", ev(sumOf(withEvidence.map((r) => r.evidence?.fallbacks)) ?? 0));

  // use: the runs started on the day
  const bySource: Partial<Record<SourceKey, number>> = {};
  const byFlow: Partial<Record<string, number>> = {};
  const repos = new Set<string>();
  for (const b of started) {
    bump(bySource, sourceKeyOf(b.source, input.watcherSources));
    bump(byFlow, flowKeyOf(b.flow));
    if (typeof b.githubRepo === "string" && b.githubRepo) repos.add(b.githubRepo.toLowerCase());
  }

  return ShareReportSchema.parse({
    version: SHARE_REPORT_VERSION,
    install: input.install ?? NO_INSTALL,
    day: input.day,
    foundryVersion: /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(input.foundryVersion) ? input.foundryVersion : "unknown",
    accountsSharing: accounts.size,
    changes,
    speed: { runDuration, queueTime, issueToPullRequest, approvalLatency, stepTime },
    splits,
    rework,
    quality,
    cost,
    use: { bySource, byFlow, repositories: repos.size },
  });
}
