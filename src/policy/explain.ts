import type { StepIdentity } from "../evidence/identity.js";
import { BASELINE_POLICY_ID } from "./baseline.js";
import { REASON_CODES, reasonText, type ReasonCode } from "./reasons.js";
import type { Boundary, Mode, Outcome, PolicyDecision } from "./schema.js";

/**
 * Plain explanations of policy decisions. Pure. The text is worked out when a decision is shown, from the decision as
 * it was recorded, so the evidence format and old runs stay as they are. Every sentence comes from a closed list
 * (reasons.ts and `NEXT_ACTIONS`), so a filter can check a line against the lists.
 */

export const NEXT_ACTIONS = {
  none: "Nothing to do.",
  "observe-warn": "Nothing to do: this policy only observes. In block mode the step would go on with this warning.",
  "observe-approval": "Nothing was stopped: this policy only observes. In block mode a person would have to approve this first.",
  "observe-deny": "Nothing was stopped: this policy only observes. In block mode the step would be stopped.",
  "observe-incomplete": "Nothing was stopped: this policy only observes. The Foundry did not know a fact this rule needs; in block mode the step would be stopped.",
  "fix-pack": "Nothing was stopped. An administrator can fix this policy's file in the policies folder of the data folder.",
  "fix-mandatory": "The step was stopped. An administrator must fix this mandatory policy's file, or put back its last-known-good copy with scf policy restore. Then start the run again.",
  "fix-baseline": "The step was stopped. The Foundry's built-in policy could not be used. An administrator must check the protected branch and secret scan settings, or update the Foundry. Then start the run again.",
  "observe-baseline": "Nothing was stopped: this policy only observes. The Foundry's built-in policy could not be used. In block mode the step would be stopped; an administrator must check the protected branch and secret scan settings, or update the Foundry.",
  "break-glass": "The step went on under an administrator's break-glass. The mandatory policy must be fixed before the break-glass ends; after that, this step is stopped again.",
  "enforced-deny": "The step was stopped. Change what the policy refuses, or ask an administrator; then start the run again.",
  "enforced-deny-push": "Recorded only: at a push the Foundry's pre-push hook decides. Change what the policy refuses, or ask an administrator.",
  "enforced-deny-recorded": "The denial is recorded; enforcement is not yet applied at this boundary. Change what the policy refuses, or ask an administrator.",
  "fix-mandatory-recorded": "The denial is recorded; enforcement is not yet applied at this boundary. An administrator must fix this mandatory policy's file, or put back its last-known-good copy with scf policy restore.",
  "fix-baseline-recorded": "The denial is recorded; enforcement is not yet applied at this boundary. An administrator must check the protected branch and secret scan settings, or update the Foundry.",
  "enforced-warn": "The step went on. Check the warning; nothing else to do.",
  "enforced-approval": "Nothing was stopped: approval by a policy is not acted on yet.",
} as const;
export type NextActionCode = keyof typeof NEXT_ACTIONS;

type Explainable = Pick<PolicyDecision, "outcome" | "mode" | "reasonCode"> & { policy: Pick<PolicyDecision["policy"], "id">; boundary?: Boundary };

export function nextActionCode(d: Explainable): NextActionCode {
  if (d.reasonCode === "policy.break-glass") return "break-glass";
  if (d.outcome === "allow") return "none";
  if (d.reasonCode === "policy.unavailable" || d.reasonCode === "policy.invalid") {
    if (d.policy.id === BASELINE_POLICY_ID) return d.mode === "enforce" ? (unapplied(d) ? "fix-baseline-recorded" : "fix-baseline") : "observe-baseline";
    return d.mode === "enforce" ? (unapplied(d) ? "fix-mandatory-recorded" : "fix-mandatory") : "fix-pack";
  }
  if (d.mode === "observe") {
    if (d.outcome === "warn") return "observe-warn";
    if (d.outcome === "require_approval") return "observe-approval";
    return d.reasonCode === "policy.input-incomplete" ? "observe-incomplete" : "observe-deny";
  }
  if (d.outcome === "deny") return d.boundary === "push" ? "enforced-deny-push" : unapplied(d) ? "enforced-deny-recorded" : "enforced-deny";
  if (d.outcome === "warn") return "enforced-warn";
  return "enforced-approval";
}

export const nextActionText = (d: Explainable): string => NEXT_ACTIONS[nextActionCode(d)];

/**
 * The boundaries whose callers stop the step on a denial (they read `denied`). At every other boundary an enforced denial
 * is only recorded: the callers ignore it, so the explanation must not say the step was stopped.
 */
export const STOPPING_BOUNDARIES: readonly Boundary[] = ["repository.access", "agent.write", "approval.consume"];

/** A boundary is known and its callers do not stop the step on a denial (push is handled by the pre-push hook). */
const unapplied = (d: Pick<Explainable, "boundary">): boolean => d.boundary !== undefined && !STOPPING_BOUNDARIES.includes(d.boundary);

const WHY = "  Why: ";
const TODO = " What to do: ";

/** "  Why: <reason> What to do: <next>" for every outcome, allow included. */
export const explanationLine = (d: Explainable): string => `${WHY}${reasonText(d.reasonCode as ReasonCode)}${TODO}${nextActionText(d)}`;

const REASON_TEXTS: readonly string[] = REASON_CODES.map((c) => reasonText(c));
const NEXT_TEXTS: readonly string[] = Object.values(NEXT_ACTIONS);

/** True when `line` is exactly "  Why: <a reason text> What to do: <a NEXT_ACTIONS text>". */
export function isExplanationLine(line: string): boolean {
  if (!line.startsWith(WHY)) return false;
  const rest = line.slice(WHY.length);
  return REASON_TEXTS.some((r) => rest.startsWith(r + TODO) && NEXT_TEXTS.includes(rest.slice(r.length + TODO.length)));
}

/** The note at the end of a decision line. */
export function logNote(d: Pick<PolicyDecision, "mode" | "outcome" | "reasonCode"> & { boundary?: Boundary }): string {
  if (d.reasonCode === "policy.break-glass") return "break-glass: the step goes on";
  if (d.mode === "enforce") {
    if (d.outcome !== "deny") return "enforced: the step goes on";
    if (d.boundary === "push") return NOTE_PUSH;
    if (unapplied(d)) return NOTE_RECORDED;
    return "enforced: the step is stopped";
  }
  return "observe only, nothing was stopped";
}
const NOTE_PUSH = "enforced: recorded only, the pre-push hook decides";
const NOTE_RECORDED = "enforced: denial recorded, not yet applied at this boundary";
export const LOG_NOTES: readonly string[] = ["break-glass: the step goes on", "enforced: the step is stopped", "enforced: the step goes on", "observe only, nothing was stopped", NOTE_PUSH, NOTE_RECORDED];

export interface PolicyDecisionGroup {
  policy: PolicyDecision["policy"];
  boundary: Boundary;
  outcome: Outcome;
  mode: Mode;
  reasonCode: ReasonCode;
  reason: string;
  nextCode: NextActionCode;
  next: string;
  count: number;
  firstAt: string;
  lastAt: string;
  steps: string[];
  moreSteps: number;
  /** Admin only. */
  rule?: string;
  /** Admin only. */
  packSha256?: string;
}
export interface PolicyDecisionList {
  groups: PolicyDecisionGroup[];
  total: number;
  omittedGroups: number;
  complete: boolean;
}
export const MAX_POLICY_GROUPS = 100;
export const MAX_GROUP_STEPS = 10;

const stepName = (s: StepIdentity) => (s.parent ? `${s.parent}/${s.id}` : s.id);

/** Folds decisions into groups in order of first appearance. The step is not part of the key; the names are listed. */
export function groupPolicyDecisions(items: readonly { decision: PolicyDecision; step?: StepIdentity }[], o: { admin: boolean }): Omit<PolicyDecisionList, "complete"> {
  const groups = new Map<string, { g: PolicyDecisionGroup; names: Set<string> }>();
  const omitted = new Set<string>();
  for (const { decision: d, step } of items) {
    const key = JSON.stringify([d.policy.id, d.policy.version, d.boundary, d.outcome, d.reasonCode, d.mode, ...(o.admin ? [d.rule ?? null, d.packSha256 ?? null] : [])]);
    let e = groups.get(key);
    if (!e) {
      if (groups.size >= MAX_POLICY_GROUPS) {
        omitted.add(key);
        continue;
      }
      e = {
        names: new Set(),
        g: {
          policy: { id: d.policy.id, version: d.policy.version },
          boundary: d.boundary,
          outcome: d.outcome,
          mode: d.mode,
          reasonCode: d.reasonCode as ReasonCode,
          reason: reasonText(d.reasonCode as ReasonCode),
          nextCode: nextActionCode(d),
          next: nextActionText(d),
          count: 0,
          firstAt: d.evaluatedAt,
          lastAt: d.evaluatedAt,
          steps: [],
          moreSteps: 0,
          ...(o.admin && d.rule ? { rule: d.rule } : {}),
          ...(o.admin && d.packSha256 ? { packSha256: d.packSha256 } : {}),
        },
      };
      groups.set(key, e);
    }
    const { g, names } = e;
    g.count++;
    if (d.evaluatedAt < g.firstAt) g.firstAt = d.evaluatedAt;
    if (d.evaluatedAt > g.lastAt) g.lastAt = d.evaluatedAt;
    const n = step ? stepName(step) : undefined;
    if (n !== undefined && !names.has(n)) {
      names.add(n);
      if (g.steps.length < MAX_GROUP_STEPS) g.steps.push(n);
      else g.moreSteps++;
    }
  }
  return { groups: [...groups.values()].map((e) => e.g), total: items.length, omittedGroups: omitted.size };
}
