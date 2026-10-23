import { describe, expect, it } from "vitest";
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
import { evaluatePolicy, policyPackSha256 } from "../src/policy/evaluate.js";
import type { Boundary, Facts } from "../src/policy/schema.js";

const T = "2026-01-31T12:00:00.000Z";
const FULL: BaselineControls = { protectedBranches: ["main", "release/*"], secretScan: true, shippedHotfixFlow: true, repository: "acme/widgets" };
const ask = (controls: BaselineControls, boundary: Boundary, facts: Facts, variant = false) => {
  const b = runBaseline("1", controls);
  const pack = variant && b.pushWithoutRepository ? b.pushWithoutRepository : b.pack;
  const d = evaluatePolicy(pack, { version: 1, boundary, runId: "r", facts }, T);
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
    expect(ids(FULL)).toEqual(["branch-hotfix-exception", "branch-protected", "secret-detected", "identity-missing", "repository-not-allowed", "sandbox-required", "workspace-admin-only", "credential-scope-exceeded"]);
    expect(baselinePack("1", FULL).rules.every((r) => r.mode === "observe")).toBe(true);
    expect(ids({ ...FULL, shippedHotfixFlow: false })[0]).toBe("branch-protected");
    expect(ids(NO_BASELINE_CONTROLS)).toEqual(["secret-detected", "identity-missing", "sandbox-required", "workspace-admin-only", "credential-scope-exceeded"]);
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
