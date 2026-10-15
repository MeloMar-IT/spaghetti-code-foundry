// Thresholds, limits and reason codes of the evaluation gate. Data only; evaluation.ts uses it.

export const EVALUATION_DIGEST_HEADER = "scf-skill-evaluation-v1\n";
export const EVALUATION_DIMENSIONS = ["selection", "instructions", "conflicts", "context", "tools"] as const;
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];
/** Always mandatory. A suite can add `instructions`, never drop one. */
export const EVALUATION_MANDATORY: readonly EvaluationDimension[] = ["selection", "conflicts", "context", "tools"];
/** Lowest mean score that passes. A suite can only raise these. A threshold of 1 means every sample is exactly 1. */
export const EVALUATION_THRESHOLDS: Record<EvaluationDimension, number> = { selection: 0.9, instructions: 0.8, conflicts: 1, context: 1, tools: 1 };
/** Model-scored dimensions need repeats; the offline ones give one sample. */
export const EVALUATION_MIN_SAMPLES: Record<EvaluationDimension, number> = { selection: 1, instructions: 3, conflicts: 1, context: 1, tools: 1 };
/** A lower score is a regression only when the drop is larger than the spread of the samples and than this. */
export const EVALUATION_MIN_MARGIN = 0.1;
/** Tolerance for thresholds below 1 and for the regression margin; never used for a threshold of 1. */
export const EVALUATION_EPSILON = 1e-9;
export const EVALUATION_MODES = ["new", "upgrade", "duplicate"] as const;
export type EvaluationMode = (typeof EVALUATION_MODES)[number];
/** In the order reasons are listed. */
export const EVALUATION_REASON_CODES = [
  "policy-invalid", "record-invalid", "record-credential", "digest-mismatch", "suite-mismatch", "same-candidate",
  "safety-mismatch", "safety-blocked", "licence-not-allowed",
  "dimension-missing", "too-few-samples", "below-threshold",
  "baseline-missing", "baseline-invalid", "baseline-mismatch", "regression", "worse-duplicate",
] as const;
export type EvaluationReasonCode = (typeof EVALUATION_REASON_CODES)[number];
export const EVALUATION_LIMITS = {
  scenarios: 200, inputs: 20, inputChars: 2000, samples: 1000, findings: 500, evidence: 500, detailChars: 200, reasons: 50,
  repositoryKeyChars: 500, walkDepth: 8, walkNodes: 20000,
} as const;

// The suite file (evaluation-suite.ts) and the offline scorers (evaluation-score.ts).
export const EVALUATION_SUITE_DIGEST_HEADER = "scf-skill-evaluation-suite-v1\n";
export const EVALUATION_SUITE_FILE = "suite.yaml";
/** `compared: 30` keeps the joined `with` input at most 30 × 64 + 29 = 1949 characters, below `EVALUATION_LIMITS.inputChars`. */
export const EVALUATION_SUITE_LIMITS = {
  fileBytes: 262144, perDimension: 50, scenarios: 100, taskChars: 2000, modules: 20, pathChars: 200, compared: 30,
  maxTokens: 20000, maxChars: 1024,
  fixtureFiles: 200, fixtureEntries: 400, fixtureFileBytes: 65536, fixtureTotalBytes: 1048576, fixtureDepth: 8,
} as const;
/** The dimensions the offline scorers fill. */
export const EVALUATION_OFFLINE: readonly EvaluationDimension[] = ["selection", "conflicts", "context", "tools"];
export const EVALUATION_FINDING_CODES = [
  "not-offered", "offered-unexpectedly",
  "version-reuse", "id-conflict", "fork", "capability-overlap", "upgrade-of", "baseline-not-replaceable", "compared-skill-missing",
  "instructions-over-limit", "instructions-over-budget", "description-over-limit", "description-over-budget", "description-cut", "budget-invalid",
  "tool-not-approved", "connector-unavailable", "scan-high-open", "safety-mismatch", "findings-truncated",
  "check-failed", "agent-failed", "skill-not-loaded", "network-not-host-limited",
] as const;

// The `instructions` section of the suite (evaluation-instructions.ts): sandboxed agent scenarios, run with repeats.
export const EVALUATION_INSTRUCTIONS_LIMITS = {
  repeatMin: 3, repeatMax: 20, repeatDefault: 3, scenarios: 20, total: 200,
  timeoutMin: 60, timeoutMax: 3600, timeoutDefault: 900, checkChars: 2000, runs: 1000, baselines: 4, outbound: 10, runIdChars: 128,
  /** The credential walk of a record with an `agent` block: the candidate and four baselines hold up to 1000 scores in each of 5 dimensions. */
  walkNodes: 60000,
} as const;
/** What holds the agent run: a container image, or the operating-system sandbox. */
export const EVALUATION_SANDBOXES = ["container", "os"] as const;
export type EvaluationSandbox = (typeof EVALUATION_SANDBOXES)[number];
export const EVALUATION_NETWORK = ["not-host-limited", "host-limited"] as const;
export type EvaluationNetwork = (typeof EVALUATION_NETWORK)[number];
export const EVALUATION_ARMS = ["candidate", "baseline"] as const;
export type EvaluationArm = (typeof EVALUATION_ARMS)[number];
/** An instruction fixture must not hold agent configuration: the agent would load it. Compared in lower case. */
export const EVALUATION_AGENT_CONFIG: readonly string[] = [".claude", ".mcp.json"];

// The evaluation store (evaluation-store.ts) and `scf skills score` / `scf skills gate`.
export const EVALUATION_SUITE_DEFAULT = "skill-evaluation.yaml";
export const EVALUATIONS_DIR = "skill-evaluations";
export const EVALUATION_STORE_LIMITS = { recordBytes: 2_097_152, files: 5000, linkTries: 20 } as const;
