import { z } from "zod";

// The shared metrics report (#893): one fixed, numbers-only report of one UTC day of an install's runs.
// Every object is strict and there is no free-text field. A name (flow, step, model, watcher source) can only be a
// key from the fixed lists below, or `custom`, so a repository, branch, issue title, account or e-mail cannot fit.
// This file imports only zod: the lists are literal, and tests/metrics-share-report.test.ts keeps them equal to flows/.

export const SHARE_REPORT_VERSION = 1;
/** The name for anything that is not a shipped flow or step, or a known model. */
export const CUSTOM = "custom";
/** The model of an agent step whose target names none (`claude:anthropic`): the agent picks its own. */
export const DEFAULT_MODEL = "default";
/** The install id until #889 makes a real one. */
export const NO_INSTALL = "0".repeat(32);

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
/** The bucket edges (ms) of every time histogram, the same for every install so totals add up. */
export const DURATION_EDGES_MS = [10 * S, M, 5 * M, 15 * M, 30 * M, H, 2 * H, 4 * H, 8 * H, D, 3 * D, 7 * D] as const;
/** The bucket edges of the number of parts per split. */
export const PARTS_EDGES = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** The flows the Foundry ships (the `name` of each flows/*.yaml). */
export const SHIPPED_FLOWS = [
  "daily-pr", "deps-weekly", "epic-questions", "issue-code-daily", "issue-gitflow", "issue-plan", "refine-brief", "refine-round", "release-build", "release-daily", "repo-review", "skill-write",
] as const;

/** The step ids of the shipped flows. */
export const SHIPPED_STEPS = [
  "address_review_1", "address_review_2", "after_review", "approve_plan", "approve_split", "approve_stories", "ask", "ask_for_info", "baseline_failed", "baseline_main", "baseline_tests",
  "audit", "brief", "build", "changes", "check", "check_brief", "check_round", "check_verify", "checks", "claim_areas", "clone", "close_parts", "commit", "commit_back_fix", "commit_develop_fix",
  "create_split", "daily_branch", "docs", "feature_branch", "fetch_main", "file_stories", "final_ask", "final_close", "final_files", "final_guard", "final_merge", "final_rejected",
  "final_report", "find_branch", "finish_back", "finish_merge", "fix_back", "fix_develop", "fix_fixed_tests", "fix_guard", "fix_tests", "fix_tests_1", "fix_tests_2", "fix_verify",
  "fixed_tests", "force_split", "guard", "handoff", "hotfix_branch", "hotfix_done", "implement", "list_issues", "lock", "make_final", "measure", "merge_back",
  "merge_develop", "merge_main", "pick", "plan", "plan_check", "plan_review", "plan_stories", "post", "post_plan", "pretest_merge", "pretest_tests", "publish", "pull_ticket", "push",
  "push_back", "push_develop", "push_feature", "push_main", "read_issue", "read_issues", "red_back", "red_develop", "red_main", "release_pr", "report", "resolve",
  "resolve_back", "resolve_conflicts", "review", "review_1", "review_2", "review_gate", "revise_gate", "revise_plan", "risk_gate", "round", "run_tests", "run_tests_1",
  "run_tests_2", "screen", "send_back", "size_gate", "split_gate", "test_back", "test_develop", "test_main", "upload", "verify", "wait_for_area", "wait_for_merge",
  "wait_for_story", "wait_local_tree", "write",
] as const;

/** The model names that are kept: the Claude aliases and ids, and every model of the built-in price table (src/usage/events.ts). */
export const KNOWN_MODELS = [
  "haiku", "sonnet", "opus", "fable",
  "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
  "claude-opus-4-5", "claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5",
  "gpt-5", "gpt-5-codex", "gpt-5.1", "gpt-5.1-codex", "gpt-5-mini", "gpt-5.1-codex-mini",
] as const;

/** Where runs come from: the watcher sources, `manual` (not started by a watcher) and `unknown` (a watcher that is gone). */
export const SHARE_SOURCES = ["issues", "pr-feedback", "ci-failures", "schedule", "monitor", "manual", "unknown"] as const;

export type FlowKey = (typeof SHIPPED_FLOWS)[number] | typeof CUSTOM;
export type StepKey = (typeof SHIPPED_STEPS)[number] | typeof CUSTOM;
export type ModelKey = (typeof KNOWN_MODELS)[number] | typeof CUSTOM | typeof DEFAULT_MODEL;
export type SourceKey = (typeof SHARE_SOURCES)[number];

const COUNT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const USD = z.number().nonnegative().finite();
const FLOW_KEY = z.enum([...SHIPPED_FLOWS, CUSTOM]);
const STEP_KEY = z.enum([...SHIPPED_STEPS, CUSTOM]);
const MODEL_KEY = z.enum([...KNOWN_MODELS, CUSTOM, DEFAULT_MODEL]);

/** A histogram over fixed edges: `counts[i]` holds the values in [edges[i-1], edges[i]); the last one the values ≥ the last edge. */
function histogram(edges: readonly number[]) {
  return z.object({ counts: z.array(COUNT).length(edges.length + 1), sum: z.number().nonnegative().finite() }).strict();
}
const TIME = histogram(DURATION_EDGES_MS);
const PARTS = histogram(PARTS_EDGES);
const TOKENS = z.object({ tokensIn: COUNT, tokensOut: COUNT, costUsd: USD.optional() }).strict();

export const ShareReportSchema = z
  .object({
    version: z.literal(SHARE_REPORT_VERSION),
    install: z.string().regex(/^[0-9a-f]{32}$/),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    foundryVersion: z.string().regex(/^(?:\d{1,6}\.\d{1,6}\.\d{1,6}|unknown)$/),
    accountsSharing: COUNT,
    changes: z
      .object({
        runsStarted: COUNT,
        runsEnded: z.object({ succeeded: COUNT, failed: COUNT, cancelled: COUNT }).strict(),
        workItemsDelivered: COUNT.optional(),
        pullRequestsDelivered: COUNT.optional(),
        dailyReleases: COUNT.optional(),
      })
      .strict(),
    speed: z
      .object({ runDuration: TIME, queueTime: TIME, issueToPullRequest: TIME, approvalLatency: TIME, stepTime: z.partialRecord(STEP_KEY, TIME) })
      .strict(),
    splits: z.object({ issuesSplit: COUNT.optional(), partsPerSplit: PARTS.optional() }).strict(),
    rework: z
      .object({ reworkedAfterDelivery: COUNT.optional(), resumes: COUNT.optional(), stepRetries: COUNT.optional(), repeatedSteps: z.partialRecord(STEP_KEY, COUNT) })
      .strict(),
    quality: z
      .object({
        firstPassTests: z.object({ passed: COUNT, counted: COUNT }).strict().optional(),
        mergeRate: z.object({ delivered: COUNT, counted: COUNT }).strict().optional(),
        evidence: z.object({ complete: COUNT, counted: COUNT }).strict().optional(),
        policyBlocks: COUNT.optional(),
        denials: COUNT.optional(),
        stoppedWithQuestions: COUNT.optional(),
        questionsAnsweredAutomatically: COUNT.optional(),
      })
      .strict(),
    cost: z
      .object({ byModel: z.partialRecord(MODEL_KEY, TOKENS), byStep: z.partialRecord(STEP_KEY, TOKENS), costUsd: USD.optional(), modelFallbacks: COUNT.optional() })
      .strict(),
    use: z.object({ bySource: z.partialRecord(z.enum(SHARE_SOURCES), COUNT), byFlow: z.partialRecord(FLOW_KEY, COUNT), repositories: COUNT }).strict(),
  })
  .strict();

export type ShareReport = z.infer<typeof ShareReportSchema>;
export type Histogram = { counts: number[]; sum: number };

/** The bucket of a value over fixed edges. */
export function bucketOf(value: number, edges: readonly number[]): number {
  let i = 0;
  while (i < edges.length && value >= edges[i]!) i++;
  return i;
}

/** An empty histogram over the edges. */
export const emptyHistogram = (edges: readonly number[]): Histogram => ({ counts: new Array<number>(edges.length + 1).fill(0), sum: 0 });

/** Adds a value (≥ 0, finite) to a histogram; anything else is left out. */
export function addTo(h: Histogram, value: number | undefined, edges: readonly number[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  h.counts[bucketOf(value, edges)]!++;
  h.sum += value;
}

const FLOWS: ReadonlySet<string> = new Set(SHIPPED_FLOWS);
const STEPS: ReadonlySet<string> = new Set(SHIPPED_STEPS);
const MODELS: ReadonlySet<string> = new Set(KNOWN_MODELS);

/** A flow name as the report keeps it: a shipped flow, else `custom`. */
export const flowKeyOf = (flow: unknown): FlowKey => (typeof flow === "string" && FLOWS.has(flow) ? (flow as FlowKey) : CUSTOM);

/** A step name as the report keeps it: a step of a shipped flow, else `custom` (also any step of a custom flow). */
export const stepKeyOf = (step: unknown, flow: unknown): StepKey =>
  flowKeyOf(flow) !== CUSTOM && typeof step === "string" && STEPS.has(step) ? (step as StepKey) : CUSTOM;

/**
 * The model of an agent target (`agent:provider:model`) as the report keeps it: a known model, `default` when the target
 * names none (`claude:anthropic`), else `custom`. undefined for a step without an agent target.
 */
export function modelKeyOf(target: unknown): ModelKey | undefined {
  if (typeof target !== "string" || !target) return undefined;
  const first = target.indexOf(":");
  const second = first < 0 ? -1 : target.indexOf(":", first + 1);
  const model = second < 0 ? "" : target.slice(second + 1);
  if (!model) return DEFAULT_MODEL;
  return MODELS.has(model) ? (model as ModelKey) : CUSTOM;
}
