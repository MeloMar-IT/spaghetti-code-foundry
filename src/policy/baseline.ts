import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StepIdSchema } from "../evidence/identity.js";
import { parsePolicyPack } from "./parse.js";
import { FactsSchema, MAX_PATTERNS, MAX_RULES, PatternSchema, type PolicyPack } from "./schema.js";
import { POLICY_PACK_VERSION, PolicySchemaError } from "./version.js";

/**
 * The baseline pack: built in, owned by the Foundry, asked at every boundary of every run in observe mode.
 * Admins cannot replace it; they can only add stricter packs (see compose.ts).
 * The one file in src/policy/ that reads a file: package.json, once, for the version.
 */

export const BASELINE_POLICY_ID = "foundry.baseline";

/** The flow and step of the hotfix exception; a test pins them to HOTFIX_FLOW / HOTFIX_PUSH_STEP in engine/guards.ts (this folder has no engine imports). */
export const BASELINE_HOTFIX = { flow: "issue-gitflow", step: "push_main" } as const;

/** Steps that share one limit. */
export interface LimitGroup {
  limit: number;
  steps: readonly string[];
}

/** The limits of the steps of one flow, grouped by value (the order of first appearance). */
export interface StepLimits {
  /** Bytes a step may print before the baseline warns. */
  output: readonly LimitGroup[];
  /** Milliseconds a step may run. */
  timeout: readonly LimitGroup[];
  /** US dollars a step may cost. */
  stepBudget: readonly LimitGroup[];
}

export interface BaselineLimits extends Partial<StepLimits> {
  /** US dollars a run may cost (every step is asked). */
  runBudget?: number;
  /** US dollars a day may cost (every step is asked). */
  dailyBudget?: number;
}

/** What the baseline of one run is built from. Later policy issues add optional fields. */
export interface BaselineControls {
  limits?: BaselineLimits;
  protectedBranches: readonly string[];
  secretScan: boolean;
  /** The run is the shipped hotfix flow: only then the pack has the hotfix exception (the `flow` fact is always known there). */
  shippedHotfixFlow: boolean;
  repository?: string;
  /** Patterns of the `forbidden_paths` run variable, as written (`*` is the only wildcard). Left out when empty. */
  forbiddenPaths?: readonly string[];
}

export const NO_BASELINE_CONTROLS: BaselineControls = { protectedBranches: [], secretScan: true, shippedHotfixFlow: false };

/**
 * Reads the settings the way the pre-push hook does: entries are word-split on space, tab and new line only. Patterns the
 * evaluator cannot express exactly (`? [ ] \`) or the pack schema refuses (other spaces, control characters, over 255 characters)
 * go to `leftOut`; empty entries and duplicates are dropped. No count limit is applied here.
 */
export function baselineControls(
  config: { protected_branches?: readonly string[]; secret_scan?: boolean },
  run: { repository?: string; shippedHotfixFlow: boolean; limits?: BaselineLimits; forbiddenPaths?: string },
): { controls: BaselineControls; leftOut: string[]; leftOutPaths: string[] } {
  const protectedBranches: string[] = [];
  const leftOut: string[] = [];
  const seen = new Set<string>();
  for (const entry of config.protected_branches ?? []) {
    for (const token of String(entry).split(/[ \t\n]+/)) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      if (/[?[\]\\]/.test(token) || !PatternSchema.safeParse(token).success) leftOut.push(token);
      else protectedBranches.push(token);
    }
  }
  const forbiddenPaths: string[] = [];
  const leftOutPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const token of typeof run.forbiddenPaths === "string" ? run.forbiddenPaths.split(/[ \t\n]+/) : []) {
    if (!token || seenPaths.has(token)) continue;
    seenPaths.add(token);
    if (PatternSchema.safeParse(token).success) forbiddenPaths.push(token);
    else leftOutPaths.push(token);
  }
  const repository = run.repository !== undefined && FactsSchema.shape.repository.safeParse(run.repository).success ? run.repository : undefined;
  return {
    controls: { protectedBranches, secretScan: config.secret_scan !== false, shippedHotfixFlow: run.shippedHotfixFlow, ...(repository ? { repository } : {}), ...(run.limits ? { limits: run.limits } : {}), ...(forbiddenPaths.length ? { forbiddenPaths } : {}) },
    leftOut,
    leftOutPaths,
  };
}

const SECRET_RULE = { id: "secret-detected", boundaries: ["push"], when: { secretsFound: { over: 0 } }, outcome: "deny", reasonCode: "secret.detected", mode: "observe" };
const IDENTITY_RULE = { id: "identity-missing", boundaries: ["push"], when: { commitIdentity: false }, outcome: "deny", reasonCode: "identity.missing", mode: "observe" };
const SANDBOX_RULE = { id: "sandbox-required", boundaries: ["agent.write"], when: { owner: { in: ["user"] }, sandboxed: false }, outcome: "deny", reasonCode: "sandbox.required", mode: "observe" };
const SANDBOX_STEP_RULE = { ...SANDBOX_RULE, boundaries: ["agent.write", "step.before"] };
const ADMIN_RULE = { id: "workspace-admin-only", boundaries: ["run.start"], when: { owner: { in: ["user"] }, workspace: { in: ["inplace"] } }, outcome: "deny", reasonCode: "workspace.admin-only", mode: "observe" };

/** The four rules of the baseline without run controls (unchanged). */
export function legacyBaselinePack(version: string): PolicyPack {
  return {
    version: POLICY_PACK_VERSION,
    policy: { id: BASELINE_POLICY_ID, version },
    mode: "observe",
    defaultOutcome: "allow",
    rules: [SECRET_RULE, IDENTITY_RULE, SANDBOX_RULE, ADMIN_RULE],
  } as PolicyPack;
}

const chunkId = (base: string, i: number) => (i === 0 ? base : `${base}-${i + 1}`);

const validLimit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The limit rules (observe only, at `step.after`). Bad step ids and bad numbers are dropped; a group with no steps gives no rule. */
function limitRules(limits: BaselineLimits | undefined): unknown[] {
  if (!limits) return [];
  const rules: unknown[] = [];
  const kinds = [
    { groups: limits.output, base: "output-limit-exceeded", fact: "outputBytes", outcome: "warn", reasonCode: "output.limit-exceeded" },
    { groups: limits.timeout, base: "timeout-exceeded", fact: "elapsedMs", outcome: "deny", reasonCode: "timeout.exceeded" },
    { groups: limits.stepBudget, base: "budget-step-exceeded", fact: "stepCostUsd", outcome: "deny", reasonCode: "budget.step-exceeded" },
  ];
  for (const k of kinds) {
    let n = 0;
    for (const g of k.groups ?? []) {
      if (!validLimit(g.limit)) continue;
      const ids = [...new Set(g.steps.filter((id) => typeof id === "string" && StepIdSchema.safeParse(id).success))];
      for (let i = 0; i < ids.length; i += MAX_PATTERNS) {
        rules.push({
          id: chunkId(k.base, n++),
          boundaries: ["step.after"],
          when: { step: { in: ids.slice(i, i + MAX_PATTERNS) }, [k.fact]: { over: g.limit } },
          outcome: k.outcome,
          reasonCode: k.reasonCode,
          mode: "observe",
        });
      }
    }
  }
  if (validLimit(limits.runBudget)) {
    rules.push({ id: "budget-run-exceeded", boundaries: ["step.after"], when: { runCostUsd: { over: limits.runBudget } }, outcome: "deny", reasonCode: "budget.run-exceeded", mode: "observe" });
  }
  if (validLimit(limits.dailyBudget)) {
    rules.push({ id: "budget-daily-exceeded", boundaries: ["step.after"], when: { dailyCostUsd: { over: limits.dailyBudget } }, outcome: "deny", reasonCode: "budget.daily-exceeded", mode: "observe" });
  }
  return rules;
}

/** The forbidden-path rules (observe only, at `step.after`): a whole path matches a pattern, `*` is a wildcard. */
function pathRules(patterns: readonly string[] | undefined): unknown[] {
  const rules: unknown[] = [];
  for (let i = 0; i < (patterns?.length ?? 0); i += MAX_PATTERNS) {
    rules.push({ id: chunkId("path-forbidden", i / MAX_PATTERNS), boundaries: ["step.after"], when: { paths: { anyIn: patterns!.slice(i, i + MAX_PATTERNS) } }, outcome: "deny", reasonCode: "path.forbidden", mode: "observe" });
  }
  return rules;
}

/** The baseline pack of one run (pure): protected branches first, as the hook checks the branch before it scans. */
export function baselinePack(version: string, controls: BaselineControls, o: { stepSandbox?: boolean } = {}): PolicyPack {
  const chunks: string[][] = [];
  for (let i = 0; i < controls.protectedBranches.length; i += MAX_PATTERNS) chunks.push(controls.protectedBranches.slice(i, i + MAX_PATTERNS));
  const rules: unknown[] = [];
  if (controls.shippedHotfixFlow) {
    chunks.forEach((c, i) =>
      rules.push({
        id: chunkId("branch-hotfix-exception", i),
        boundaries: ["push"],
        when: { branch: { in: c }, flow: { in: [BASELINE_HOTFIX.flow] }, step: { in: [BASELINE_HOTFIX.step] }, shippedFlow: true },
        outcome: "allow",
        reasonCode: "branch.hotfix-exception",
        mode: "observe",
      }),
    );
  }
  chunks.forEach((c, i) => rules.push({ id: chunkId("branch-protected", i), boundaries: ["push"], when: { branch: { in: c } }, outcome: "deny", reasonCode: "branch.protected", mode: "observe" }));
  if (controls.secretScan) rules.push(SECRET_RULE);
  rules.push(IDENTITY_RULE);
  if (controls.repository) {
    rules.push({ id: "repository-not-allowed", boundaries: ["push"], when: { repository: { notIn: [controls.repository] } }, outcome: "deny", reasonCode: "repository.not-allowed", mode: "observe" });
  }
  rules.push(o.stepSandbox === false ? SANDBOX_RULE : SANDBOX_STEP_RULE, ADMIN_RULE);
  rules.push({ id: "credential-scope-exceeded", boundaries: ["repository.access"], when: { owner: { in: ["user"] }, credential: { in: ["machine"] } }, outcome: "deny", reasonCode: "credential.scope-exceeded", mode: "observe" });
  rules.push(...limitRules(controls.limits));
  rules.push(...pathRules(controls.forbiddenPaths));
  return { version: POLICY_PACK_VERSION, policy: { id: BASELINE_POLICY_ID, version }, mode: "observe", defaultOutcome: "allow", rules } as PolicyPack;
}

export interface RunBaseline {
  pack: PolicyPack;
  /** For a push whose repository is not known: the same pack without the repository rule. Only when the pack has one. */
  pushWithoutRepository?: PolicyPack;
  /** For a step whose `sandboxed` fact is not known (not a shell step): the sandbox rule only at `agent.write`. */
  stepWithoutSandbox: PolicyPack;
}

/** Builds and parses the baseline of a run. Throws PolicySchemaError when it cannot be built. */
export function runBaseline(version: string, controls: BaselineControls): RunBaseline {
  const n = baselinePack(version, controls).rules.length;
  if (n > MAX_RULES) throw new PolicySchemaError("pack", "invalid", `policy pack: the baseline would have ${n} rules, more than ${MAX_RULES}`);
  const pack = parsePolicyPack(baselinePack(version, controls));
  const stepWithoutSandbox = parsePolicyPack(baselinePack(version, controls, { stepSandbox: false }));
  if (!controls.repository) return { pack, stepWithoutSandbox };
  return { pack, stepWithoutSandbox, pushWithoutRepository: parsePolicyPack(baselinePack(version, { ...controls, repository: undefined })) };
}

function readVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const v = (JSON.parse(readFileSync(join(dir, "../../package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(v) ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/** The version of this build: package.json "version", or "unknown". */
export const BASELINE_VERSION: string = readVersion();

/** The baseline of this build without run controls (the legacy four rules). */
export const BASELINE_PACK: PolicyPack = parsePolicyPack(legacyBaselinePack(BASELINE_VERSION));
