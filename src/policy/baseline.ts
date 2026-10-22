import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicyPack } from "./parse.js";
import { FactsSchema, MAX_PATTERNS, PatternSchema, type PolicyPack } from "./schema.js";
import { POLICY_PACK_VERSION } from "./version.js";

/**
 * The baseline pack: built in, owned by the Foundry, asked at every boundary of every run in observe mode.
 * Admins cannot replace it; they can only add stricter packs (see compose.ts).
 * The one file in src/policy/ that reads a file: package.json, once, for the version.
 */

export const BASELINE_POLICY_ID = "foundry.baseline";

/** The flow and step of the hotfix exception; a test pins them to HOTFIX_FLOW / HOTFIX_PUSH_STEP in engine/guards.ts (this folder has no engine imports). */
export const BASELINE_HOTFIX = { flow: "issue-gitflow", step: "push_main" } as const;

/** What the baseline of one run is built from. Later policy issues add optional fields. */
export interface BaselineControls {
  protectedBranches: readonly string[];
  secretScan: boolean;
  /** The run is the shipped hotfix flow: only then the pack has the hotfix exception (the `flow` fact is always known there). */
  shippedHotfixFlow: boolean;
  repository?: string;
}

export const NO_BASELINE_CONTROLS: BaselineControls = { protectedBranches: [], secretScan: true, shippedHotfixFlow: false };

/**
 * Reads the settings the way the pre-push hook does: entries are word-split on space, tab and new line only. Patterns the
 * evaluator cannot express exactly (`? [ ] \`) or the pack schema refuses (other spaces, control characters, over 255 characters)
 * go to `leftOut`; empty entries and duplicates are dropped. No count limit is applied here.
 */
export function baselineControls(
  config: { protected_branches?: readonly string[]; secret_scan?: boolean },
  run: { repository?: string; shippedHotfixFlow: boolean },
): { controls: BaselineControls; leftOut: string[] } {
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
  const repository = run.repository !== undefined && FactsSchema.shape.repository.safeParse(run.repository).success ? run.repository : undefined;
  return {
    controls: { protectedBranches, secretScan: config.secret_scan !== false, shippedHotfixFlow: run.shippedHotfixFlow, ...(repository ? { repository } : {}) },
    leftOut,
  };
}

const SECRET_RULE = { id: "secret-detected", boundaries: ["push"], when: { secretsFound: { over: 0 } }, outcome: "deny", reasonCode: "secret.detected", mode: "observe" };
const IDENTITY_RULE = { id: "identity-missing", boundaries: ["push"], when: { commitIdentity: false }, outcome: "deny", reasonCode: "identity.missing", mode: "observe" };
const SANDBOX_RULE = { id: "sandbox-required", boundaries: ["agent.write"], when: { owner: { in: ["user"] }, sandboxed: false }, outcome: "deny", reasonCode: "sandbox.required", mode: "observe" };
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

/** The baseline pack of one run (pure): protected branches first, as the hook checks the branch before it scans. */
export function baselinePack(version: string, controls: BaselineControls): PolicyPack {
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
  rules.push(SANDBOX_RULE, ADMIN_RULE);
  rules.push({ id: "credential-scope-exceeded", boundaries: ["repository.access"], when: { owner: { in: ["user"] }, credential: { in: ["machine"] } }, outcome: "deny", reasonCode: "credential.scope-exceeded", mode: "observe" });
  return { version: POLICY_PACK_VERSION, policy: { id: BASELINE_POLICY_ID, version }, mode: "observe", defaultOutcome: "allow", rules } as PolicyPack;
}

export interface RunBaseline {
  pack: PolicyPack;
  /** For a push whose repository is not known: the same pack without the repository rule. Only when the pack has one. */
  pushWithoutRepository?: PolicyPack;
}

/** Builds and parses the baseline of a run. Throws PolicySchemaError when it cannot be built. */
export function runBaseline(version: string, controls: BaselineControls): RunBaseline {
  const pack = parsePolicyPack(baselinePack(version, controls));
  if (!controls.repository) return { pack };
  return { pack, pushWithoutRepository: parsePolicyPack(baselinePack(version, { ...controls, repository: undefined })) };
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
