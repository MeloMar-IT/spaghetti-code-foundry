import { describe, expect, it } from "vitest";
import { BASELINE_POLICY_ID } from "../src/policy/baseline.js";
import { MAX_GROUP_STEPS, MAX_POLICY_GROUPS, NEXT_ACTIONS, explanationLine, groupPolicyDecisions, isExplanationLine, logNote, nextActionCode, nextActionText, type NextActionCode } from "../src/policy/explain.js";
import { REASON_CODES, reasonText, type ReasonCode } from "../src/policy/reasons.js";
import { OUTCOMES, type Mode, type Outcome, type PolicyDecision } from "../src/policy/schema.js";

const H = "a".repeat(64);
const T = (n: number) => `2026-01-31T12:00:${String(n).padStart(2, "0")}.000Z`;
const dec = (o: Partial<PolicyDecision> = {}): PolicyDecision =>
  ({ version: 1, policy: { id: "p", version: "1" }, packSha256: H, mode: "observe", boundary: "step.before", inputSha256: H, outcome: "warn", reasonCode: "output.limit-exceeded", rule: "r1", evaluatedAt: T(0), ...o }) as PolicyDecision;
const ex = (outcome: Outcome, mode: Mode, reasonCode: ReasonCode, id = "p") => ({ outcome, mode, reasonCode, policy: { id } });

describe("nextActionCode", () => {
  const rows: [Outcome, Mode, ReasonCode, NextActionCode][] = [
    ["allow", "observe", "policy.no-rule-matched", "none"],
    ["allow", "enforce", "policy.no-rule-matched", "none"],
    ["warn", "observe", "output.limit-exceeded", "observe-warn"],
    ["require_approval", "observe", "approval.required", "observe-approval"],
    ["deny", "observe", "secret.detected", "observe-deny"],
    ["deny", "observe", "policy.input-incomplete", "observe-incomplete"],
    ["deny", "observe", "policy.unavailable", "fix-pack"],
    ["deny", "enforce", "policy.unavailable", "fix-mandatory"],
    ["deny", "enforce", "policy.invalid", "fix-mandatory"],
    ["deny", "enforce", "secret.detected", "enforced-deny"],
    ["warn", "enforce", "output.limit-exceeded", "enforced-warn"],
    ["require_approval", "enforce", "approval.required", "enforced-approval"],
    ["warn", "enforce", "policy.break-glass", "break-glass"],
  ];
  it.each(rows)("%s / %s / %s -> %s", (o, m, c, want) => {
    expect(nextActionCode(ex(o, m, c))).toBe(want);
  });
  it("tells the baseline apart by mode: no file, no restore, and no 'stopped' when nothing was stopped", () => {
    for (const code of ["policy.invalid", "policy.unavailable"] as const) {
      expect(nextActionCode(ex("deny", "enforce", code, BASELINE_POLICY_ID))).toBe("fix-baseline");
      expect(nextActionCode(ex("deny", "observe", code, BASELINE_POLICY_ID))).toBe("observe-baseline");
      for (const mode of ["observe", "enforce"] as const) {
        const text = nextActionText(ex("deny", mode, code, BASELINE_POLICY_ID));
        expect(text).not.toMatch(/restore|file/);
      }
      expect(nextActionText(ex("deny", "observe", code, BASELINE_POLICY_ID))).toMatch(/^Nothing was stopped/);
      expect(nextActionText(ex("deny", "observe", code, BASELINE_POLICY_ID))).not.toMatch(/The step was stopped/);
    }
  });
  it("gives every code and every outcome a sentence from the list", () => {
    for (const code of REASON_CODES) {
      for (const outcome of OUTCOMES) for (const mode of ["observe", "enforce"] as const) expect(Object.values(NEXT_ACTIONS)).toContain(nextActionText(ex(outcome, mode, code)));
    }
  });
});

describe("explanation lines", () => {
  it("round-trips for every code, outcome and mode", () => {
    for (const code of REASON_CODES) {
      for (const outcome of OUTCOMES) for (const mode of ["observe", "enforce"] as const) {
        const line = explanationLine(ex(outcome, mode, code));
        expect(line.startsWith("  Why: ")).toBe(true);
        expect(isExplanationLine(line)).toBe(true);
      }
    }
  });
  it("refuses a changed sentence, extra text and an unknown sentence", () => {
    const line = explanationLine(ex("warn", "observe", "output.limit-exceeded"));
    expect(isExplanationLine(`${line} Extra.`)).toBe(false);
    expect(isExplanationLine(line.replace("printed", "wrote"))).toBe(false);
    expect(isExplanationLine(`  Why: Something else. What to do: ${NEXT_ACTIONS.none}`)).toBe(false);
    expect(isExplanationLine(`  Why: ${reasonText("secret.detected")} What to do: Do as you like.`)).toBe(false);
    expect(isExplanationLine(line.trim())).toBe(false);
  });
  it("words the log note", () => {
    expect(logNote({ mode: "observe", outcome: "deny", reasonCode: "secret.detected" })).toBe("observe only, nothing was stopped");
    expect(logNote({ mode: "enforce", outcome: "deny", reasonCode: "policy.invalid" })).toBe("enforced: the step is stopped");
    expect(logNote({ mode: "enforce", outcome: "warn", reasonCode: "policy.break-glass" })).toBe("break-glass: the step goes on");
  });
});

describe("groupPolicyDecisions", () => {
  const step = (id: string, parent?: string) => ({ id, visit: 1, type: "shell" as const, ...(parent ? { parent } : {}) });
  it("folds identical decisions at several steps into one group", () => {
    const r = groupPolicyDecisions([1, 2, 3].map((n) => ({ decision: dec({ evaluatedAt: T(n) }), step: step(`s${n}`, n === 3 ? "par" : undefined) })), { admin: true });
    expect(r).toMatchObject({ total: 3, omittedGroups: 0 });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ count: 3, firstAt: T(1), lastAt: T(3), steps: ["s1", "s2", "par/s3"], nextCode: "observe-warn", rule: "r1", packSha256: H });
  });
  it("keeps another version or outcome apart", () => {
    const r = groupPolicyDecisions([{ decision: dec() }, { decision: dec({ policy: { id: "p", version: "2" } }) }, { decision: dec({ outcome: "deny", reasonCode: "secret.detected" }) }], { admin: true });
    expect(r.groups).toHaveLength(3);
  });
  it("leaves rule and hash out for users, and merges groups that differ only by them", () => {
    const r = groupPolicyDecisions([{ decision: dec() }, { decision: dec({ rule: "r2", packSha256: "b".repeat(64) }) }], { admin: false });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.count).toBe(2);
    expect(r.groups[0]).not.toHaveProperty("rule");
    expect(r.groups[0]).not.toHaveProperty("packSha256");
    expect(groupPolicyDecisions([{ decision: dec() }, { decision: dec({ rule: "r2" }) }], { admin: true }).groups).toHaveLength(2);
  });
  it("caps the groups and the step names, and says what it left out", () => {
    const many = Array.from({ length: MAX_POLICY_GROUPS + 1 }, (_, i) => ({ decision: dec({ policy: { id: "p", version: String(i + 1) } }) }));
    const r = groupPolicyDecisions(many, { admin: true });
    expect(r.groups).toHaveLength(MAX_POLICY_GROUPS);
    expect(r.omittedGroups).toBe(1);
    expect(r.total).toBe(MAX_POLICY_GROUPS + 1);
    const steps = groupPolicyDecisions(Array.from({ length: 12 }, (_, i) => ({ decision: dec(), step: step(`s${i}`) })), { admin: true }).groups[0]!;
    expect(steps.steps).toHaveLength(MAX_GROUP_STEPS);
    expect(steps.moreSteps).toBe(2);
  });
  it("answers an empty input", () => {
    expect(groupPolicyDecisions([], { admin: true })).toEqual({ groups: [], total: 0, omittedGroups: 0 });
  });
});
