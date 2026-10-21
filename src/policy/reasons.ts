import { z } from "zod";

/**
 * Reason codes: why a policy decided as it did. A closed list. A code is never renamed, reused for another meaning or
 * removed once a release has written it; a new meaning gets a new code here (and a line in docs/DESIGN.md).
 * Every code has the form of the evidence `ReasonCodeSchema` ("area.what", lower case), so a decision can be written
 * to the evidence of a run as it is.
 */

/** Codes a rule of a pack may give. The sentence says what was found, not what was decided: the outcome says that. */
export const RULE_REASONS = {
  "branch.protected": "The push goes to a protected branch.",
  "branch.hotfix-exception": "The push is the hotfix merge of the unchanged built-in flow, which may reach a protected branch.",
  "secret.detected": "The new commits contain something that looks like a secret.",
  "path.forbidden": "A changed file is in a place that may not be changed.",
  "output.limit-exceeded": "The step printed more than its output limit.",
  "timeout.exceeded": "The step ran longer than its time limit.",
  "budget.step-exceeded": "The step cost more than its budget.",
  "budget.run-exceeded": "The run cost more than its budget.",
  "budget.daily-exceeded": "Today's spend is above the daily budget.",
  "sandbox.required": "The step would run without the sandbox it must have.",
  "workspace.admin-only": "The flow works in the server's own folder, which only an admin may use.",
  "repository.not-allowed": "The repository is not one the run may work on.",
  "credential.scope-exceeded": "The step would get a credential it may not have.",
  "identity.missing": "There is no name and e-mail address to commit with.",
  "tool.not-allowed": "The agent may not use this tool.",
  "issue.closed": "The issue of the run is closed.",
  "flow.retired": "The flow of the run no longer exists.",
  "approval.required": "A person has to agree before this goes on.",
  "exception.granted": "A rule makes an exception to a rule after it.",
} as const;

/** Codes only the evaluation itself gives; a rule cannot use them. */
export const ENGINE_REASONS = {
  "policy.no-rule-matched": "No rule of the pack applied; the default outcome of the pack was used.",
  "policy.input-incomplete": "A rule needed a fact the input did not have, so the action is denied.",
  "policy.invalid": "The pack could not be read, so the action is denied.",
  "policy.unavailable": "The pack could not be loaded, so the action is denied.",
  "policy.break-glass": "A mandatory pack could not be used, but an admin's break-glass is active, so the action goes on with a warning.",
} as const;

export type RuleReasonCode = keyof typeof RULE_REASONS;
export type EngineReasonCode = keyof typeof ENGINE_REASONS;
export type ReasonCode = RuleReasonCode | EngineReasonCode;

export const RULE_REASON_CODES = Object.keys(RULE_REASONS) as [RuleReasonCode, ...RuleReasonCode[]];
export const ENGINE_REASON_CODES = Object.keys(ENGINE_REASONS) as [EngineReasonCode, ...EngineReasonCode[]];
export const REASON_CODES: readonly ReasonCode[] = [...RULE_REASON_CODES, ...ENGINE_REASON_CODES];

const known = (codes: readonly string[]) => ({ error: `must be a known reason code: ${codes.join(", ")}` });
/** A reason code a rule may give. */
export const RuleReasonCodeSchema = z.enum(RULE_REASON_CODES, known(RULE_REASON_CODES));
/** Any reason code a decision may carry. */
export const ReasonCodeSchema = z.enum([...RULE_REASON_CODES, ...ENGINE_REASON_CODES], known(REASON_CODES));

/** The one-sentence meaning of a code, for a log line or a page. */
export const reasonText = (code: ReasonCode): string => (code in RULE_REASONS ? RULE_REASONS[code as RuleReasonCode] : ENGINE_REASONS[code as EngineReasonCode]);
