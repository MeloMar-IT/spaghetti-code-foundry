import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { baselineEntry, deniedReason, enforceProblem, outageScope, RunPolicy, ruleDeniedReason, type LayeredPack } from "../src/engine/policy-hooks.js";
import type { BreakGlass } from "../src/engine/policy-break-glass.js";
import type { RunRecorder } from "../src/evidence/record.js";
import {
  BASELINE_POLICY_ID, BASELINE_RULE_BOUNDARIES, BASELINE_RULE_IDS, baselineControls, baselinePack, baselineRuleBase, NO_BASELINE_CONTROLS, runBaseline,
  type BaselineControls, type BaselineRuleId,
} from "../src/policy/baseline.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import type { Boundary, Facts, PolicyPack } from "../src/policy/schema.js";
import { POLICY_INPUT_VERSION } from "../src/policy/version.js";

const V = "1.0.0";
const T = "2026-01-31T12:00:00.000Z";
const EXP = "2026-01-31T13:00:00.000Z";
const GLASS: BreakGlass = { version: 1, reason: "outage", startedAt: "2026-01-31T11:30:00.000Z", expiresAt: EXP, actor: { kind: "cli", osUser: "admin" } };
const STEP = { id: "s", visit: 1, type: "shell" } as const;
const SUB_STEP = { id: "x", parent: "sub", visit: 1, type: "shell" } as const;

const controls = (o: Partial<BaselineControls> = {}): BaselineControls => ({ ...NO_BASELINE_CONTROLS, ...o });
/** 600 timeout groups with distinct limits: more rules than a pack may hold, so the baseline is `policy.invalid`. */
const TOO_MANY = { timeout: Array.from({ length: 600 }, (_, i) => ({ limit: i, steps: [`t${i}`] })) };
const invalidEntry = (): LayeredPack => baselineEntry(V, controls({ limits: TOO_MANY }));

const ids = (pack: PolicyPack) => pack.rules.map((r) => r.id);

function make(o: { enforce?: readonly BaselineRuleId[]; entry?: LayeredPack; sub?: LayeredPack; glass?: boolean; recorded?: boolean | "throws"; base?: Facts; c?: Partial<BaselineControls> } = {}) {
  const lines: string[] = [];
  const policyDecided = vi.fn(() => {
    if (o.recorded === "throws") throw new Error("disk");
    return o.recorded !== false;
  });
  const incomplete = vi.fn();
  const evidence = { policyDecided, incomplete } as unknown as RunRecorder;
  const entry = o.entry ?? baselineEntry(V, controls({ ...(o.enforce ? { enforce: o.enforce } : {}), ...o.c }));
  const policy = new RunPolicy({
    runId: "run-1", packs: [entry], base: o.base ?? {}, log: (l) => lines.push(l), evidence, now: () => T, enforce: o.enforce,
    ...(o.glass ? { breakGlass: () => GLASS } : {}),
    ...(o.sub ? { scopedBaseline: () => o.sub! } : {}),
  });
  return { policy, lines, policyDecided, incomplete };
}

describe("the policy.enforce setting", () => {
  it("defaults to an empty list and takes every rule id", () => {
    expect(ConfigSchema.parse({}).policy.enforce).toEqual([]);
    expect(ConfigSchema.parse({ policy: { enforce: [...BASELINE_RULE_IDS] } }).policy.enforce).toEqual([...BASELINE_RULE_IDS]);
    expect(ConfigSchema.safeParse({ policy: { enforce: ["budget-daily-exceeded"] }, cost_limits: false }).success).toBe(true);
  });

  it("refuses an unknown id, a duplicate and a chunk id", () => {
    const bad = ConfigSchema.safeParse({ policy: { enforce: ["nope"] } });
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0]!.path).toEqual(["policy", "enforce", 0]);
    expect(ConfigSchema.safeParse({ policy: { enforce: ["path-forbidden", "path-forbidden"] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ policy: { enforce: ["branch-protected-2"] } }).success).toBe(false);
  });

  it("keeps only known ids, once, in the controls", () => {
    const run = { shippedHotfixFlow: false };
    expect(baselineControls({ policy: { enforce: ["path-forbidden", "x", "path-forbidden"] } }, run).controls.enforce).toEqual(["path-forbidden"]);
    expect(baselineControls({ policy: { enforce: [] } }, run).controls).not.toHaveProperty("enforce");
    expect(baselineControls({}, run).controls).not.toHaveProperty("enforce");
  });
});

describe("rule ids and boundaries", () => {
  const all = controls({
    shippedHotfixFlow: true,
    protectedBranches: Array.from({ length: 101 }, (_, i) => `b${i}`),
    repository: "acme/app",
    limits: {
      output: [{ limit: 1, steps: Array.from({ length: 101 }, (_, i) => `o${i}`) }],
      timeout: [{ limit: 1, steps: Array.from({ length: 101 }, (_, i) => `t${i}`) }],
      stepBudget: [{ limit: 1, steps: Array.from({ length: 101 }, (_, i) => `c${i}`) }],
      runBudget: 1,
      dailyBudget: 1,
    },
    forbiddenPaths: Array.from({ length: 101 }, (_, i) => `p${i}/*`),
  });

  it("maps every produced rule into the list, within its boundaries", () => {
    const seen = new Set<string>();
    for (const o of [{}, { stepSandbox: false }, { contextCitations: false }]) {
      for (const r of baselinePack(V, all, o).rules) {
        const base = baselineRuleBase(r.id) as BaselineRuleId;
        expect(BASELINE_RULE_IDS, r.id).toContain(base);
        seen.add(base);
        for (const b of r.boundaries) expect(BASELINE_RULE_BOUNDARIES[base], r.id).toContain(b);
      }
    }
    expect([...seen].sort()).toEqual([...BASELINE_RULE_IDS].sort());
    expect(baselineRuleBase("branch-protected-2")).toBe("branch-protected");
    expect(baselineRuleBase("path-forbidden")).toBe("path-forbidden");
  });

  it("marks every chunk of a listed rule and orders hotfix, enforced, rest", () => {
    const plain = baselinePack(V, all);
    const pack = baselinePack(V, { ...all, enforce: ["branch-protected", "path-forbidden"] });
    expect(pack.mode).toBe("observe");
    expect(ids(pack).slice().sort()).toEqual(ids(plain).slice().sort());
    const hotfix = pack.rules.filter((r) => baselineRuleBase(r.id) === "branch-hotfix-exception");
    expect(hotfix.length).toBe(2);
    expect(pack.rules.slice(0, 2)).toEqual(hotfix);
    const enforced = pack.rules.filter((r) => r.mode === "enforce");
    expect(enforced.map((r) => baselineRuleBase(r.id))).toEqual(["branch-protected", "branch-protected", "path-forbidden", "path-forbidden"]);
    expect(pack.rules.slice(2, 6)).toEqual(enforced);
    expect(pack.rules.slice(6).every((r) => r.mode === "observe")).toBe(true);
    // the shared rule constants are not changed
    expect(baselinePack(V, controls()).rules.every((r) => r.mode === "observe")).toBe(true);
    expect(baselinePack(V, all).rules.every((r) => r.mode === "observe")).toBe(true);
  });

  it("keeps the hotfix rules first, and marks them when listed", () => {
    const pack = baselinePack(V, { ...all, enforce: ["branch-hotfix-exception", "secret-detected"] });
    expect(pack.rules.slice(0, 2).map((r) => [baselineRuleBase(r.id), r.mode])).toEqual([["branch-hotfix-exception", "enforce"], ["branch-hotfix-exception", "enforce"]]);
    expect(pack.rules[2]).toMatchObject({ id: "secret-detected", mode: "enforce" });
  });

  it("marks all variants of the run baseline", () => {
    const rb = runBaseline(V, controls({ repository: "acme/app", protectedBranches: ["main"], enforce: ["sandbox-required", "context-uncited", "repository-not-allowed", "branch-protected"] }));
    for (const p of [rb.pack, rb.stepWithoutSandbox, rb.stepWithoutCitations, rb.pushWithoutRepository!]) {
      expect(p.mode).toBe("observe");
      expect(p.rules.filter((r) => r.mode === "enforce").length).toBeGreaterThan(0);
    }
    expect(rb.stepWithoutCitations.rules.some((r) => r.id === "context-uncited")).toBe(false);
    expect(rb.pushWithoutRepository!.rules.some((r) => r.id === "repository-not-allowed")).toBe(false);
  });

  it("is the same as today with an empty list", () => {
    const a = baselinePack(V, all);
    const b = baselinePack(V, { ...all, enforce: [] });
    expect(b).toEqual(a);
    const input = { version: POLICY_INPUT_VERSION, boundary: "step.after", runId: "r", facts: { step: "o1" } } as never;
    expect(evaluatePolicy(b, input, T).packSha256).toBe(evaluatePolicy(a, input, T).packSha256);
  });
});

describe("enforced rules in RunPolicy", () => {
  const AFTER: Facts = { step: "s", outputBytes: 1e9, elapsedMs: 1e9, paths: ["secret/x"] };
  const limits = { output: [{ limit: 10, steps: ["s"] }], timeout: [{ limit: 10, steps: ["s"] }] };
  const c = { limits, forbiddenPaths: ["secret/*"] };

  it("asks an enforced rule first and denies with its reason", () => {
    const { policy } = make({ enforce: ["path-forbidden"], c });
    const a = policy.at("step.after", AFTER, STEP);
    const d = a.decisions[0]!.decision;
    expect(d).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: "path.forbidden" });
    expect(a.denied?.reason).toBe(ruleDeniedReason(d));
    expect(a.denied?.reason).toContain("rule path-forbidden");
  });

  it("is observe and denies nothing with an empty list", () => {
    const a = make({ enforce: [], c }).policy.at("step.after", AFTER, STEP);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "observe", reasonCode: "output.limit-exceeded" });
    expect(a.denied).toBeUndefined();
  });

  it("denies a missing fact in enforce mode", () => {
    const { paths: _paths, ...rest } = AFTER;
    void _paths;
    const a = make({ enforce: ["path-forbidden"], c }).policy.at("step.after", rest, STEP);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: "policy.input-incomplete", rule: "path-forbidden" });
    expect(a.denied).toBeDefined();
  });

  it("records an enforced deny at a push, and leaves the stop to the pre-push hook", () => {
    const { policy, lines } = make({ enforce: ["branch-protected"], c: { protectedBranches: ["main"] } });
    const a = policy.at("push", { branch: "main", step: "s" }, STEP);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: "branch.protected" });
    expect(a.denied).toBeUndefined();
    expect(lines.some((l) => l.endsWith("— enforced: recorded only, the pre-push hook decides"))).toBe(true);
  });

  it("keeps a rule denial under break-glass, and turns only an outage into a warn", () => {
    const o = { enforce: ["credential-scope-exceeded"] as BaselineRuleId[], glass: true, base: { owner: "user" } as Facts };
    const rule = make(o).policy.at("repository.access", { credential: "machine" }, STEP);
    expect(rule.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: "credential.scope-exceeded" });
    expect(rule.denied?.reason).toBe(ruleDeniedReason(rule.decisions[0]!.decision));
    const outage = make({ ...o, entry: invalidEntry() }).policy.at("agent.write", { step: "s" }, STEP);
    expect(outage.decisions[0]!.decision).toMatchObject({ outcome: "warn", reasonCode: "policy.break-glass" });
    expect(outage.denied).toBeUndefined();
  });
});

describe("an unusable baseline with enforced rules", () => {
  const E = ["path-forbidden"] as BaselineRuleId[];

  it("starts from an invalid entry", () => {
    const e = invalidEntry();
    expect("problem" in e && e.problem).toBe("policy.invalid");
  });

  it.each(["step.before", "step.after"] as Boundary[])("denies %s in enforce mode", (b) => {
    const a = make({ enforce: E, entry: invalidEntry() }).policy.at(b, { step: "s" }, STEP);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: "policy.invalid" });
    expect(a.denied?.reason).toBe(deniedReason(BASELINE_POLICY_ID, "policy.invalid", b));
  });

  it("leaves push observe, and everything observe with an empty list", () => {
    const push = make({ enforce: E, entry: invalidEntry() }).policy.at("push", { step: "s" }, STEP);
    expect(push.decisions[0]!.decision.mode).toBe("observe");
    expect(push.denied).toBeUndefined();
    for (const b of ["step.before", "step.after"] as Boundary[]) {
      const a = make({ entry: invalidEntry() }).policy.at(b, { step: "s" }, STEP);
      expect(a.decisions[0]!.decision.mode).toBe("observe");
      expect(a.denied).toBeUndefined();
    }
  });

  it("turns the outage into a recorded warn under break-glass", () => {
    for (const b of ["step.before", "step.after"] as Boundary[]) {
      const { policy, policyDecided } = make({ enforce: E, entry: invalidEntry(), glass: true });
      const a = policy.at(b, { step: "s" }, STEP);
      expect(a.decisions[0]!.decision).toMatchObject({ outcome: "warn", reasonCode: "policy.break-glass" });
      expect(a.denied).toBeUndefined();
      expect(policyDecided).toHaveBeenCalled();
    }
  });

  it("does the same for the baseline of a sub-flow, and says so in the log", () => {
    const valid = baselineEntry(V, controls({ enforce: E }));
    const on = make({ enforce: E, entry: valid, sub: invalidEntry() });
    on.policy.subFlow("sub", {} as never, 1);
    expect(on.lines.some((l) => l.includes("sub-flow sub") && l.includes("path-forbidden") && l.includes("step.after"))).toBe(true);
    const a = on.policy.at("step.before", {}, SUB_STEP);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "enforce", reasonCode: "policy.invalid" });
    expect(a.denied).toBeDefined();
    const glass = make({ enforce: E, entry: valid, sub: invalidEntry(), glass: true });
    glass.policy.subFlow("sub", {} as never, 1);
    expect(glass.policy.at("step.after", {}, SUB_STEP).decisions[0]!.decision.reasonCode).toBe("policy.break-glass");
    const off = make({ entry: valid, sub: invalidEntry() });
    off.policy.subFlow("sub", {} as never, 1);
    expect(off.lines.some((l) => l.endsWith("— this mandatory policy denies steps with a sign-in and writing agents in this sub-flow"))).toBe(true);
    const b = off.policy.at("step.before", {}, SUB_STEP);
    expect(b.decisions[0]!.decision.mode).toBe("observe");
    expect(b.denied).toBeUndefined();
  });

  it("words the scope", () => {
    expect(outageScope([])).toBe("this mandatory policy denies steps with a sign-in and writing agents");
    expect(outageScope(["branch-protected"])).toBe("this mandatory policy denies steps with a sign-in and writing agents");
    expect(outageScope(["path-forbidden", "workspace-admin-only"])).toBe("this mandatory policy denies steps with a sign-in and writing agents; for the enforced rules path-forbidden, workspace-admin-only it also denies step.before, step.after, run.start");
    expect(outageScope(["credential-scope-exceeded", "branch-protected"])).toBe("this mandatory policy denies steps with a sign-in and writing agents");
  });
});

describe("the question cannot be built", () => {
  const odd = { get step(): string { throw new Error("no"); } } as unknown as Facts;
  const E = ["path-forbidden"] as BaselineRuleId[];

  it("records an enforce-mode policy.invalid at an enforced boundary, before the evidence is marked incomplete", () => {
    const { policy, policyDecided, incomplete } = make({ enforce: E, recorded: false });
    const a = policy.at("step.after", odd, STEP);
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: "policy.invalid" });
    expect(a.denied?.reason).toBe(deniedReason(BASELINE_POLICY_ID, "policy.invalid", "step.after"));
    expect(incomplete).toHaveBeenCalledTimes(1);
    expect(policyDecided.mock.invocationCallOrder[0]!).toBeLessThan(incomplete.mock.invocationCallOrder[0]!);
  });

  it("is a warn under break-glass when recorded, and stays denied when recording fails or throws", () => {
    const ok = make({ enforce: E, glass: true }).policy.at("step.after", odd, STEP);
    expect(ok.decisions[0]!.decision).toMatchObject({ outcome: "warn", reasonCode: "policy.break-glass" });
    expect(ok.denied).toBeUndefined();
    for (const recorded of [false, "throws"] as const) {
      const { policy, lines } = make({ enforce: E, glass: true, recorded });
      const a = policy.at("step.after", odd, STEP);
      expect(a.denied?.reason).toBe(deniedReason(BASELINE_POLICY_ID, "policy.invalid", "step.after"));
      if (recorded === false) expect(lines.some((l) => l.includes("break-glass decision could not be recorded"))).toBe(true);
    }
  });

  it("denies a privileged boundary, and does nothing else with an empty list", () => {
    expect(make({ enforce: [] }).policy.at("agent.write", odd, STEP).denied).toBeDefined();
    const a = make({ enforce: [] }).policy.at("step.after", odd, STEP);
    expect(a.decisions).toEqual([]);
    expect(a.denied).toBeUndefined();
  });
});

describe("overlays", () => {
  it("still refuse a pack with an enforce rule", () => {
    const pack = baselinePack(V, controls({ enforce: ["secret-detected"] }));
    expect(enforceProblem({ ...pack, mode: "observe" })).toContain("not supported yet");
  });
});
