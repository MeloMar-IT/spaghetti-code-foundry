import { describe, expect, it } from "vitest";
import { POLICY_INPUT_VERSION } from "../src/policy/version.js";
import { HOTFIX_FLOW, HOTFIX_PUSH_STEP } from "../src/engine/guards.js";
import {
  BASELINE_HOTFIX,
  BASELINE_PACK,
  NO_BASELINE_CONTROLS,
  baselineControls,
  baselinePack,
  legacyBaselinePack,
  runBaseline,
  type BaselineControls,
} from "../src/policy/baseline.js";
import { baselineEntry } from "../src/engine/policy-hooks.js";
import { evaluatePolicy, policyPackSha256 } from "../src/policy/evaluate.js";
import type { Boundary, Facts } from "../src/policy/schema.js";

const T = "2026-01-31T12:00:00.000Z";
const FULL: BaselineControls = { protectedBranches: ["main", "release/*"], secretScan: true, shippedHotfixFlow: true, repository: "acme/widgets" };
const ask = (controls: BaselineControls, boundary: Boundary, facts: Facts, variant = false) => {
  const b = runBaseline("1", controls);
  let pack = variant && b.pushWithoutRepository ? b.pushWithoutRepository : b.pack;
  if (boundary === "step.after" && facts.contextUncited === undefined) pack = b.stepWithoutCitations;
  const d = evaluatePolicy(pack, { version: POLICY_INPUT_VERSION, boundary, runId: "r", facts }, T);
  return { reason: d.reasonCode, outcome: d.outcome, rule: d.rule };
};
const push = (branch: string, over: Facts = {}): Facts => ({ branch, step: "x", secretsFound: 0, commitIdentity: true, repository: "acme/widgets", flow: "f", shippedFlow: false, ...over });
const ids = (c: BaselineControls) => baselinePack("1", c).rules.map((r) => r.id);

describe("baselinePack", () => {
  it("is pure, and each control changes the hash but not the id or version", () => {
    expect(baselinePack("1", FULL)).toEqual(baselinePack("1", { ...FULL }));
    const h = policyPackSha256(baselinePack("1", FULL));
    for (const c of [{ ...FULL, protectedBranches: ["main"] }, { ...FULL, secretScan: false }, { ...FULL, shippedHotfixFlow: false }, { ...FULL, repository: "acme/other" }]) {
      const p = baselinePack("1", c);
      expect(policyPackSha256(p)).not.toBe(h);
      expect(p.policy).toEqual({ id: "foundry.baseline", version: "1" });
    }
  });

  it("keeps the legacy pack with its four rules", () => {
    expect(BASELINE_PACK.rules.map((r) => r.id)).toEqual(["secret-detected", "identity-missing", "sandbox-required", "workspace-admin-only"]);
    expect(legacyBaselinePack("1").rules).toHaveLength(4);
  });

  it("orders the rules, all in observe", () => {
    expect(ids(FULL)).toEqual(["branch-hotfix-exception", "branch-protected", "secret-detected", "identity-missing", "repository-not-allowed", "sandbox-required", "workspace-admin-only", "credential-scope-exceeded", "context-uncited"]);
    expect(baselinePack("1", FULL).rules.every((r) => r.mode === "observe")).toBe(true);
    expect(ids({ ...FULL, shippedHotfixFlow: false })[0]).toBe("branch-protected");
    expect(ids(NO_BASELINE_CONTROLS)).toEqual(["secret-detected", "identity-missing", "sandbox-required", "workspace-admin-only", "credential-scope-exceeded", "context-uncited"]);
    expect(ids({ ...NO_BASELINE_CONTROLS, secretScan: false })).not.toContain("secret-detected");
  });

  it("splits more than 100 patterns into chunks and keeps all of them", () => {
    const protectedBranches = Array.from({ length: 250 }, (_, i) => `p${i + 1}`);
    const c = { ...NO_BASELINE_CONTROLS, protectedBranches, shippedHotfixFlow: true };
    expect(ids(c).slice(0, 6)).toEqual(["branch-hotfix-exception", "branch-hotfix-exception-2", "branch-hotfix-exception-3", "branch-protected", "branch-protected-2", "branch-protected-3"]);
    expect(ask(c, "push", { branch: "p250", step: "x", flow: "f", shippedFlow: false })).toMatchObject({ reason: "branch.protected", rule: "branch-protected-3" });
  });

  it("has no branch rules for an empty list, and no repository rule without a repository", () => {
    expect(ids(NO_BASELINE_CONTROLS).some((i) => i.startsWith("branch-"))).toBe(false);
    expect(runBaseline("1", NO_BASELINE_CONTROLS).pushWithoutRepository).toBeUndefined();
    expect(ids(NO_BASELINE_CONTROLS)).not.toContain("repository-not-allowed");
  });
});

describe("baselineControls", () => {
  it("splits like the hook, drops duplicates and lists what it leaves out", () => {
    const { controls, leftOut } = baselineControls(
      { protected_branches: ["main develop", " ", "main", "rel\tfix\nhot", "a\u0007b", "x y", "c\u0085d", "release/?", "v[0-9]", "x".repeat(300)] },
      { shippedHotfixFlow: false },
    );
    expect(controls.protectedBranches).toEqual(["main", "develop", "rel", "fix", "hot"]);
    expect(leftOut).toEqual(["a\u0007b", "x y", "c\u0085d", "release/?", "v[0-9]", "x".repeat(300)]);
    expect(() => runBaseline("1", controls)).not.toThrow();
  });

  it("reads secret_scan and the repository", () => {
    expect(baselineControls({}, { shippedHotfixFlow: false }).controls).toEqual({ protectedBranches: [], secretScan: true, shippedHotfixFlow: false });
    expect(baselineControls({ secret_scan: false }, { shippedHotfixFlow: false }).controls.secretScan).toBe(false);
    expect(baselineControls({}, { repository: "acme/widgets", shippedHotfixFlow: true }).controls).toMatchObject({ repository: "acme/widgets", shippedHotfixFlow: true });
    expect(baselineControls({}, { repository: "Acme/Widgets", shippedHotfixFlow: false }).controls).not.toHaveProperty("repository");
    expect(baselineControls({}, { repository: "bad", shippedHotfixFlow: false }).controls).not.toHaveProperty("repository");
  });
});

describe("decisions", () => {
  const hot = { step: "push_main", flow: "issue-gitflow", shippedFlow: true };
  it("allows the hotfix exception only for the shipped push_main", () => {
    expect(ask(FULL, "push", push("main", hot))).toMatchObject({ outcome: "allow", reason: "branch.hotfix-exception" });
    for (const over of [{ ...hot, step: "other" }, { ...hot, flow: "other" }, { ...hot, shippedFlow: false }]) {
      expect(ask(FULL, "push", push("main", over))).toMatchObject({ outcome: "deny", reason: "branch.protected" });
    }
  });

  it("denies patterns and falls through for other branches", () => {
    expect(ask(FULL, "push", push("release/1"))).toMatchObject({ reason: "branch.protected" });
    expect(ask(FULL, "push", push("feat"))).toMatchObject({ reason: "policy.no-rule-matched" });
    expect(ask(FULL, "push", push("feat", { repository: "acme/other" }))).toMatchObject({ reason: "repository.not-allowed" });
    expect(ask(FULL, "push", push("feat", { repository: undefined }), true)).toMatchObject({ reason: "policy.no-rule-matched" });
  });

  it("is never input-incomplete with the scan off or a flow name the fact cannot hold", () => {
    const c: BaselineControls = { protectedBranches: ["main"], secretScan: false, shippedHotfixFlow: false, repository: "acme/widgets" };
    const base: Facts = { step: "x", commitIdentity: true, shippedFlow: false };
    expect(ask(c, "push", { ...base, branch: "main", repository: "acme/widgets" })).toMatchObject({ reason: "branch.protected" });
    expect(ask(c, "push", { ...base, branch: "feat", repository: "acme/other" })).toMatchObject({ reason: "repository.not-allowed" });
    expect(ask(c, "push", { ...base, branch: "feat", repository: "acme/widgets" })).toMatchObject({ reason: "policy.no-rule-matched" });
    expect(ask(c, "push", { ...base, branch: "feat" }, true)).toMatchObject({ reason: "policy.no-rule-matched" });
  });

  it("denies a user with the machine credential, also without run controls", () => {
    for (const c of [FULL, NO_BASELINE_CONTROLS]) {
      expect(ask(c, "repository.access", { owner: "user", credential: "machine" })).toMatchObject({ outcome: "deny", reason: "credential.scope-exceeded" });
      for (const f of [{ owner: "admin", credential: "machine" }, { owner: "user", credential: "repository" }, { owner: "user", credential: "none" }, { owner: "none", credential: "machine" }] as Facts[]) {
        expect(ask(c, "repository.access", f).outcome).toBe("allow");
      }
    }
  });

  it("pins the hotfix names to guards.ts", () => {
    expect(BASELINE_HOTFIX).toEqual({ flow: HOTFIX_FLOW, step: HOTFIX_PUSH_STEP });
  });
});

describe("the limit rules of the baseline", () => {
  const LIMITS = {
    output: [{ limit: 1000, steps: ["a"] }],
    timeout: [
      { limit: 1000, steps: ["a"] },
      { limit: 5000, steps: ["c"] },
    ],
    stepBudget: [{ limit: 2, steps: ["a"] }],
    runBudget: 10,
    dailyBudget: 20,
  };
  const C: BaselineControls = { ...NO_BASELINE_CONTROLS, limits: LIMITS };
  const facts = (over: Facts = {}): Facts => ({ step: "a", outputBytes: 0, elapsedMs: 0, stepCostUsd: 0, runCostUsd: 0, dailyCostUsd: 0, ...over });
  const afterIds = (c: BaselineControls) => ids(c).filter((id) => id !== "context-uncited").slice(ids(NO_BASELINE_CONTROLS).length - 1);

  it("adds the rules after credential-scope-exceeded, in order, observe only and at step.after", () => {
    expect(afterIds(C)).toEqual(["output-limit-exceeded", "timeout-exceeded", "timeout-exceeded-2", "budget-step-exceeded", "budget-run-exceeded", "budget-daily-exceeded"]);
    const added = baselinePack("1", C).rules.slice(-7, -1);
    expect(added.every((r) => r.mode === "observe" && r.boundaries.join() === "step.after")).toBe(true);
    expect(added.map((r) => r.outcome)).toEqual(["warn", "deny", "deny", "deny", "deny", "deny"]);
  });

  it("fires just over each limit and not at it", () => {
    const cases: [Facts, string, string][] = [
      [{ outputBytes: 1001 }, "output.limit-exceeded", "output-limit-exceeded"],
      [{ elapsedMs: 1001 }, "timeout.exceeded", "timeout-exceeded"],
      [{ stepCostUsd: 2.01 }, "budget.step-exceeded", "budget-step-exceeded"],
      [{ runCostUsd: 10.01 }, "budget.run-exceeded", "budget-run-exceeded"],
      [{ dailyCostUsd: 20.01 }, "budget.daily-exceeded", "budget-daily-exceeded"],
    ];
    for (const [over, reason, rule] of cases) {
      expect(ask(C, "step.after", facts(over))).toMatchObject({ reason, rule });
    }
    expect(ask(C, "step.after", facts({ outputBytes: 1000, elapsedMs: 1000, stepCostUsd: 2, runCostUsd: 10, dailyCostUsd: 20 })).reason).toBe("policy.no-rule-matched");
  });

  it("applies the step rules to the listed steps only, and the run and daily rules to every step", () => {
    expect(ask(C, "step.after", facts({ step: "zzz", outputBytes: 9999, elapsedMs: 9999, stepCostUsd: 99 })).reason).toBe("policy.no-rule-matched");
    expect(ask(C, "step.after", facts({ step: "c", elapsedMs: 1001 })).reason).toBe("policy.no-rule-matched");
    expect(ask(C, "step.after", facts({ step: "zzz", runCostUsd: 11 })).reason).toBe("budget.run-exceeded");
    expect(ask(C, "step.after", facts({ step: "zzz", dailyCostUsd: 21 })).reason).toBe("budget.daily-exceeded");
  });

  it("splits more than 100 steps with one limit into chunks", () => {
    const steps = Array.from({ length: 250 }, (_, i) => `s${i + 1}`);
    const c = { ...NO_BASELINE_CONTROLS, limits: { timeout: [{ limit: 1000, steps }] } };
    expect(afterIds(c)).toEqual(["timeout-exceeded", "timeout-exceeded-2", "timeout-exceeded-3"]);
    expect(ask(c, "step.after", { step: "s250", elapsedMs: 2000 })).toMatchObject({ reason: "timeout.exceeded", rule: "timeout-exceeded-3" });
  });

  it("drops bad step ids and bad numbers", () => {
    const c = {
      ...NO_BASELINE_CONTROLS,
      limits: {
        timeout: [
          { limit: 1000, steps: ["a".repeat(129), "a b", "x*", "ok", "ok"] },
          { limit: Number.NaN, steps: ["n"] },
          { limit: -1, steps: ["m"] },
          { limit: Number.POSITIVE_INFINITY, steps: ["i"] },
          { limit: 7, steps: ["a b"] },
        ],
        runBudget: Number.NaN,
        dailyBudget: -1,
      },
    };
    expect(afterIds(c)).toEqual(["timeout-exceeded"]);
    expect((baselinePack("1", c).rules.at(-2)!.when as { step: { in: string[] } }).step.in).toEqual(["ok"]);
  });

  it("has the same rules as before without limits, and asks no more facts", () => {
    expect(ids({ ...NO_BASELINE_CONTROLS, limits: {} })).toEqual(ids(NO_BASELINE_CONTROLS));
    expect(ask(NO_BASELINE_CONTROLS, "step.after", { step: "a" }).reason).toBe("policy.no-rule-matched");
  });

  it("refuses a baseline of more than 500 rules, clearly", () => {
    const timeout = Array.from({ length: 600 }, (_, i) => ({ limit: 1000 + i, steps: [`s${i}`] }));
    expect(() => runBaseline("1", { ...NO_BASELINE_CONTROLS, limits: { timeout } })).toThrow(/would have \d+ rules, more than 500/);
    const entry = baselineEntry("1", { ...NO_BASELINE_CONTROLS, limits: { timeout } });
    expect(entry).toMatchObject({ layer: "mandatory", problem: "policy.invalid" });
    expect((entry as { detail: string }).detail).toMatch(/would have \d+ rules, more than 500/);
    const fine = { ...NO_BASELINE_CONTROLS, limits: { timeout: timeout.slice(0, 400) } };
    expect(() => runBaseline("1", fine)).not.toThrow();
  });
});

describe("the forbidden path rules and the step sandbox rule", () => {
  const PATHS = { ...NO_BASELINE_CONTROLS, forbiddenPaths: ["a.txt", "docs/*"] };
  const after = (controls: BaselineControls, facts: Facts) => ask(controls, "step.after", { step: "s", ...facts });

  it("reads the variable as written, and leaves out what the pack cannot hold", () => {
    const r = baselineControls({}, { shippedHotfixFlow: false, forbiddenPaths: "docs/*  a.txt\tdocs/* x* c\x05d " + "y".repeat(255) + " " + "z".repeat(256) });
    expect(r.controls.forbiddenPaths).toEqual(["docs/*", "a.txt", "x*", "y".repeat(255)]);
    expect(r.leftOutPaths).toEqual(["c\x05d", "z".repeat(256)]);
    expect(baselineControls({}, { shippedHotfixFlow: false, forbiddenPaths: "a?b [x]" }).controls.forbiddenPaths).toEqual(["a?b", "[x]"]);
    for (const v of [undefined, "", " \n\t "]) {
      const c = baselineControls({}, { shippedHotfixFlow: false, forbiddenPaths: v }).controls;
      expect("forbiddenPaths" in c).toBe(false);
      expect(ids(c)).not.toContain("path-forbidden");
    }
  });

  it("puts the path rules last, in chunks of 100", () => {
    expect(ids({ ...PATHS, limits: { runBudget: 5 } }).slice(-3, -1)).toEqual(["budget-run-exceeded", "path-forbidden"]);
    const many = Array.from({ length: 150 }, (_, i) => `p${i}`);
    expect(ids({ ...NO_BASELINE_CONTROLS, forbiddenPaths: many }).slice(-3, -1)).toEqual(["path-forbidden", "path-forbidden-2"]);
    expect(BASELINE_PACK.rules.map((r) => r.id)).toEqual(["secret-detected", "identity-missing", "sandbox-required", "workspace-admin-only"]);
  });

  it("denies a changed file that matches a whole path, and only observes", () => {
    expect(after(PATHS, { paths: ["a.txt"] })).toMatchObject({ outcome: "deny", reason: "path.forbidden" });
    expect(after(PATHS, { paths: ["a.txt.bak"] }).reason).toBe("policy.no-rule-matched");
    expect(after(PATHS, { paths: ["docs/a.md"] }).reason).toBe("path.forbidden");
    expect(after(PATHS, { paths: ["docs.md"] }).reason).toBe("policy.no-rule-matched");
    expect(after(PATHS, { paths: [] }).reason).toBe("policy.no-rule-matched");
    expect(runBaseline("1", PATHS).pack.rules.every((r) => r.mode === "observe")).toBe(true);
  });

  it("is incomplete without paths, unless there are no patterns or a limit rule applies first", () => {
    expect(after(PATHS, {})).toMatchObject({ reason: "policy.input-incomplete", rule: "path-forbidden" });
    expect(after(NO_BASELINE_CONTROLS, {}).reason).toBe("policy.no-rule-matched");
    const timed = { ...PATHS, limits: { timeout: [{ limit: 10, steps: ["s"] }] } };
    expect(after(timed, { elapsedMs: 99 }).reason).toBe("timeout.exceeded");
  });

  it("asks for the sandbox before a shell step of a user's run, not for a step without the fact", () => {
    const before = (facts: Facts) => ask(NO_BASELINE_CONTROLS, "step.before", { step: "s", ...facts });
    expect(before({ owner: "user", sandboxed: false })).toMatchObject({ outcome: "deny", reason: "sandbox.required" });
    expect(before({ owner: "user", sandboxed: true }).reason).toBe("policy.no-rule-matched");
    expect(before({ owner: "admin", sandboxed: false }).reason).toBe("policy.no-rule-matched");
    const v = runBaseline("1", NO_BASELINE_CONTROLS).stepWithoutSandbox;
    const run = (boundary: Boundary, facts: Facts) => evaluatePolicy(v, { version: POLICY_INPUT_VERSION, boundary, runId: "r", facts }, T).reasonCode;
    expect(run("step.before", { step: "s", owner: "user" })).toBe("policy.no-rule-matched");
    expect(run("agent.write", { step: "s", owner: "user", sandboxed: false, isolated: false })).toBe("sandbox.required");
  });
  it("warns at step.after for an uncited plan, last, and a limit deny wins over it", () => {
    const pack = baselinePack("1", NO_BASELINE_CONTROLS);
    expect(pack.rules.at(-1)).toMatchObject({ id: "context-uncited", boundaries: ["step.after"], outcome: "warn", reasonCode: "context.uncited", mode: "observe", when: { contextUncited: { over: 0 } } });
    expect(ask(NO_BASELINE_CONTROLS, "step.after", { step: "p", contextUncited: 1 })).toMatchObject({ outcome: "warn", reason: "context.uncited", rule: "context-uncited" });
    expect(ask(NO_BASELINE_CONTROLS, "step.after", { step: "p", contextUncited: 0 }).reason).toBe("policy.no-rule-matched");
    const c = { ...NO_BASELINE_CONTROLS, limits: { runBudget: 1 } } as BaselineControls;
    expect(ask(c, "step.after", { step: "p", runCostUsd: 2, contextUncited: 2 }).reason).toBe("budget.run-exceeded");
  });
  it("has a variant without the citation rule that is not input-incomplete without the fact", () => {
    const b = runBaseline("1", FULL);
    expect(b.stepWithoutCitations.rules.map((r) => r.id)).toEqual(b.pack.rules.map((r) => r.id).filter((id) => id !== "context-uncited"));
    expect(ask(FULL, "step.after", { step: "s" }).reason).toBe("policy.no-rule-matched");
    expect(BASELINE_PACK.rules.map((r) => r.id)).not.toContain("context-uncited");
  });
});
