import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PolicyIdentitySchema, sha256Hex, ReasonCodeSchema as EvidenceReasonCodeSchema } from "../src/evidence/identity.js";
import { parseEvidenceEvent } from "../src/evidence/parse.js";
import { DenialSchema } from "../src/evidence/schema.js";
import { canonicalJson, evaluatePolicy, factsNeeded, matchesPattern, policyDenial, policyIdentityOf, policyInputSha256, policyPackSha256 } from "../src/policy/evaluate.js";
import { parsePolicyDecision, parsePolicyInput, parsePolicyPack } from "../src/policy/parse.js";
import { ENGINE_REASON_CODES, REASON_CODES, RULE_REASON_CODES, reasonText } from "../src/policy/reasons.js";
import { BOUNDARIES, ConditionsSchema, FactsSchema, OUTCOMES, type Facts, type PolicyDecision, type PolicyInput, type PolicyPack } from "../src/policy/schema.js";
import { POLICY_DECISION_VERSION, POLICY_INPUT_VERSION, POLICY_PACK_VERSION, PolicySchemaError } from "../src/policy/version.js";

const T = "2026-01-31T12:00:00.000Z";
const H = "1".repeat(64);

/** The safeguards the Foundry has today, written as one pack. */
const BASELINE: PolicyPack = {
  version: 1,
  policy: { id: "baseline", version: "2026.1" },
  mode: "enforce",
  defaultOutcome: "allow",
  rules: [
    { id: "no-secrets", boundaries: ["push"], when: { secretsFound: { over: 0 } }, outcome: "deny", reasonCode: "secret.detected" },
    { id: "hotfix-merge", boundaries: ["push"], when: { branch: { in: ["main"] }, flow: { in: ["issue-gitflow"] }, step: { in: ["push_main"] }, shippedFlow: true }, outcome: "allow", reasonCode: "branch.hotfix-exception" },
    { id: "protected-branches", boundaries: ["push"], when: { branch: { in: ["main", "master", "develop", "release/*"] } }, outcome: "deny", reasonCode: "branch.protected" },
    { id: "workflow-files", boundaries: ["push", "step.after"], when: { paths: { anyIn: [".github/workflows/*", "*.pem"] } }, outcome: "require_approval", reasonCode: "path.forbidden" },
    { id: "output-limit", boundaries: ["step.after"], when: { outputBytes: { over: 60000 } }, outcome: "warn", reasonCode: "output.limit-exceeded" },
    { id: "step-timeout", boundaries: ["step.after"], when: { elapsedMs: { over: 3600000 } }, outcome: "deny", reasonCode: "timeout.exceeded" },
    { id: "run-budget", boundaries: ["step.before", "step.after"], when: { runCostUsd: { over: 25 } }, outcome: "deny", reasonCode: "budget.run-exceeded" },
    { id: "daily-budget", boundaries: ["run.start"], when: { dailyCostUsd: { over: 100 } }, outcome: "deny", reasonCode: "budget.daily-exceeded" },
    { id: "user-sandbox", boundaries: ["step.before"], when: { owner: { in: ["user"] }, sandboxed: false }, outcome: "deny", reasonCode: "sandbox.required" },
    { id: "server-folder", boundaries: ["run.start"], when: { owner: { in: ["user"] }, workspace: { in: ["inplace", "worktree"] } }, outcome: "deny", reasonCode: "workspace.admin-only" },
    { id: "target-repositories", boundaries: ["repository.access"], when: { repository: { notIn: ["acme/*"] } }, outcome: "deny", reasonCode: "repository.not-allowed" },
    { id: "machine-login", boundaries: ["repository.access", "agent.write"], when: { owner: { notIn: ["admin"] }, credential: { in: ["machine"] } }, outcome: "deny", reasonCode: "credential.scope-exceeded" },
  ],
};

const input = (boundary: PolicyInput["boundary"], facts: Facts): PolicyInput => ({ version: 1, boundary, runId: "20260131-120000-abc", facts });
const decide = (boundary: PolicyInput["boundary"], facts: Facts, pack: PolicyPack = BASELINE): PolicyDecision => evaluatePolicy(pack, input(boundary, facts), T);
const short = (d: PolicyDecision) => [d.outcome, d.reasonCode, d.rule];
const failure = (run: () => unknown): PolicySchemaError => {
  try {
    run();
  } catch (e) {
    if (e instanceof PolicySchemaError) return e;
    throw e;
  }
  throw new Error("expected a PolicySchemaError");
};
const edit = <T>(value: T, change: (copy: any) => void): any => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};

describe("versions", () => {
  it("every contract has its own explicit version", () => {
    expect([POLICY_PACK_VERSION, POLICY_INPUT_VERSION, POLICY_DECISION_VERSION]).toEqual([2, 1, 1]);
    expect(parsePolicyPack(BASELINE).version).toBe(1);
    expect(decide("push", { branch: "feature/x", secretsFound: 0, paths: [] }).version).toBe(1);
  });

  it.each([
    ["pack", parsePolicyPack, 3, "versions 1 to 2"],
    ["input", parsePolicyInput, 2, "version 1"],
    ["decision", parsePolicyDecision, 2, "version 1"],
  ] as const)("a %s is refused without a version, with another version, or when it is not an object", (kind, parse, unsupported, reads) => {
    expect(failure(() => parse(null)).code).toBe("not-an-object");
    expect(failure(() => parse([])).code).toBe("not-an-object");
    expect(failure(() => parse({})).code).toBe("no-version");
    expect(failure(() => parse({ version: "1" })).code).toBe("no-version");
    expect(failure(() => parse({ version: 0 })).code).toBe("no-version");
    const newer = failure(() => parse({ version: unsupported }));
    expect([newer.kind, newer.code]).toEqual([kind, "unsupported-version"]);
    expect(newer.message).toContain(`version ${unsupported} is not supported; this Foundry reads ${reads}`);
  });
});

describe("pack format version 2", () => {
  // The hash of BASELINE as written in version 1, taken from the code before version 2 existed.
  const V1_SHA = "4b6b2f44d3a4143d9dd18567ff45f0afb1028e9bdcd620c84fe512e6743fb58e";
  const V2: PolicyPack = edit(BASELINE, (p) => {
    p.version = 2;
  });
  const withMode = (pack: PolicyPack, mode: PolicyPack["mode"], ruleModes: Record<string, "observe" | "enforce"> = {}): PolicyPack =>
    ({ ...pack, mode, rules: pack.rules.map((r) => (ruleModes[r.id] ? { ...r, mode: ruleModes[r.id] } : r)) }) as PolicyPack;

  it("reads a version 1 pack as written, with no rule mode added", () => {
    const parsed = parsePolicyPack(BASELINE);
    expect(parsed).toEqual(BASELINE);
    expect(parsed.version).toBe(1);
    for (const rule of parsed.rules) expect("mode" in rule).toBe(false);
  });

  it("refuses a rule mode in a version 1 pack", () => {
    const e = failure(() => parsePolicyPack(edit(BASELINE, (p) => (p.rules[0].mode = "observe"))));
    expect(e.code).toBe("invalid");
    expect(e.issues.map((i) => i.path)).toContain("rules.0");
  });

  it("keeps the hash of a version 1 pack: it is hashed as written", () => {
    expect(policyPackSha256(BASELINE)).toBe(V1_SHA);
    expect(policyPackSha256(BASELINE)).toBe(sha256Hex(canonicalJson(BASELINE)));
    expect(decide("run.complete", { runCostUsd: 1 }).packSha256).toBe(V1_SHA);
    expect(policyPackSha256(V2)).not.toBe(V1_SHA);
  });

  it("reads a version 2 pack without rule modes, and with enforce on a rule or on the pack", () => {
    expect(parsePolicyPack(V2)).toEqual(V2);
    expect(parsePolicyPack(withMode(V2, "observe", { "no-secrets": "enforce" })).rules[0]!.mode).toBe("enforce");
    expect(parsePolicyPack(withMode(V2, "enforce")).mode).toBe("enforce");
  });

  it("takes the mode of the decision from the rule, else from the pack", () => {
    const secret: Facts = { branch: "feature/x", secretsFound: 1, paths: [] };
    const d = decide("push", secret, withMode(V2, "observe", { "no-secrets": "enforce" }));
    expect(d).toMatchObject({ mode: "enforce", rule: "no-secrets", outcome: "deny" });
    expect(policyDenial(d)).toBeDefined();

    const o = decide("push", secret, withMode(V2, "enforce", { "no-secrets": "observe" }));
    expect(o).toMatchObject({ mode: "observe", rule: "no-secrets" });
    expect(policyDenial(o)).toBeUndefined();

    const inherited = decide("push", { branch: "main", secretsFound: 0, flow: "other", step: "push", shippedFlow: false }, withMode(V2, "enforce", { "no-secrets": "observe" }));
    expect(inherited).toMatchObject({ mode: "enforce", rule: "protected-branches", reasonCode: "branch.protected" });
  });

  it("takes the mode of the rule for policy.input-incomplete", () => {
    const d = decide("push", {}, withMode(V2, "observe", { "no-secrets": "enforce" }));
    expect(d).toMatchObject({ outcome: "deny", reasonCode: "policy.input-incomplete", rule: "no-secrets", mode: "enforce" });
  });

  it("takes the mode of the pack for policy.no-rule-matched", () => {
    const every = Object.fromEntries(V2.rules.map((r) => [r.id, "enforce" as const]));
    const d = decide("run.complete", { runCostUsd: 1 }, withMode(V2, "observe", every));
    expect(d).toMatchObject({ reasonCode: "policy.no-rule-matched", mode: "observe" });
  });

  it("refuses an unknown rule field and an unknown rule mode", () => {
    const field = failure(() => parsePolicyPack(edit(V2, (p) => (p.rules[0].weight = 1))));
    expect(field.issues.map((i) => i.path)).toContain("rules.0");
    const mode = failure(() => parsePolicyPack(edit(V2, (p) => (p.rules[0].mode = "block"))));
    expect(mode.issues.map((i) => i.path)).toContain("rules.0.mode");
  });

  it("refuses version 3 even when the rest is valid", () => {
    const e = failure(() => parsePolicyPack({ ...V2, version: 3 }));
    expect(e.code).toBe("unsupported-version");
    expect(e.message).toContain("versions 1 to 2");
    expect(e.message).toContain("newer Foundry");
  });
});

describe("PolicyPack", () => {
  it("accepts the baseline and gives it back unchanged", () => {
    expect(parsePolicyPack(BASELINE)).toEqual(BASELINE);
    expect(PolicyIdentitySchema.parse(BASELINE.policy)).toEqual({ id: "baseline", version: "2026.1" });
  });

  it.each([
    ["an unknown field", (p: any) => (p.owner = "me"), "(root)"],
    ["no mode", (p: any) => delete p.mode, "mode"],
    ["no default outcome", (p: any) => delete p.defaultOutcome, "defaultOutcome"],
    ["a default outcome that is not allow or deny", (p: any) => (p.defaultOutcome = "warn"), "defaultOutcome"],
    ["a policy id with capitals", (p: any) => (p.policy.id = "Baseline"), "policy.id"],
    ["a policy version with a space", (p: any) => (p.policy.version = "1 0"), "policy.version"],
    ["the same rule id twice", (p: any) => (p.rules[1].id = p.rules[0].id), "rules.1.id"],
    ["an unknown outcome", (p: any) => (p.rules[0].outcome = "block"), "rules.0.outcome"],
    ["a reason code that is not in the list", (p: any) => (p.rules[0].reasonCode = "branch.locked"), "rules.0.reasonCode"],
    ["a reason code only the evaluation may give", (p: any) => (p.rules[0].reasonCode = "policy.invalid"), "rules.0.reasonCode"],
    ["a rule without boundaries", (p: any) => (p.rules[0].boundaries = []), "rules.0.boundaries"],
    ["a boundary twice", (p: any) => (p.rules[0].boundaries = ["push", "push"]), "rules.0.boundaries"],
    ["an unknown boundary", (p: any) => (p.rules[0].boundaries = ["deploy"]), "rules.0.boundaries.0"],
    ["a rule without when", (p: any) => delete p.rules[0].when, "rules.0.when"],
    ["a condition on an unknown fact", (p: any) => (p.rules[0].when.weather = true), "rules.0.when"],
    ["in and notIn together", (p: any) => (p.rules[1].when.branch = { in: ["a"], notIn: ["b"] }), "rules.1.when.branch"],
    ["neither in nor notIn", (p: any) => (p.rules[1].when.branch = {}), "rules.1.when.branch"],
    ["an empty pattern list", (p: any) => (p.rules[1].when.branch = { in: [] }), "rules.1.when.branch.in"],
    ["a pattern twice", (p: any) => (p.rules[1].when.branch = { in: ["a", "a"] }), "rules.1.when.branch.in"],
    ["a pattern with a space", (p: any) => (p.rules[1].when.branch = { in: ["a b"] }), "rules.1.when.branch.in.0"],
    ["a repository pattern with capitals", (p: any) => (p.rules[10].when.repository = { notIn: ["Acme/*"] }), "rules.10.when.repository.notIn.0"],
    ["an owner that does not exist", (p: any) => (p.rules[8].when.owner = { in: ["root"] }), "rules.8.when.owner.in.0"],
    ["a negative limit", (p: any) => (p.rules[2].when.secretsFound = { over: -1 }), "rules.2.when.secretsFound.over"],
    ["a limit that is text", (p: any) => (p.rules[2].when.secretsFound = { over: "0" }), "rules.2.when.secretsFound.over"],
    ["a flag that is text", (p: any) => (p.rules[8].when.sandboxed = "no"), "rules.8.when.sandboxed"],
  ])("refuses %s", (_what, change, path) => {
    const e = failure(() => parsePolicyPack(edit(BASELINE, change)));
    expect(e.code).toBe("invalid");
    expect(e.issues.map((i) => i.path)).toContain(path);
    expect(e.message).toContain("policy pack: not valid");
  });

  it("refuses more rules than the limit", () => {
    const rules = Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, boundaries: ["push"], when: {}, outcome: "allow", reasonCode: "exception.granted" }));
    expect(failure(() => parsePolicyPack({ ...BASELINE, rules })).issues[0]!.path).toBe("rules");
  });

  it("has a condition for every fact, and none for anything else", () => {
    expect(Object.keys(ConditionsSchema.shape).sort()).toEqual(Object.keys(FactsSchema.shape).sort());
  });
});

describe("PolicyInput", () => {
  it("accepts every boundary, and facts are all optional", () => {
    for (const boundary of BOUNDARIES) expect(parsePolicyInput(input(boundary, {})).boundary).toBe(boundary);
  });

  it.each([
    ["an unknown field", (i: any) => (i.prompt = "x"), "(root)"],
    ["an unknown fact", (i: any) => (i.facts.command = "rm"), "facts"],
    ["an unknown boundary", (i: any) => (i.boundary = "deploy"), "boundary"],
    ["a run id with a slash", (i: any) => (i.runId = "../x"), "runId"],
    ["no facts", (i: any) => delete i.facts, "facts"],
    ["a repository with capitals", (i: any) => (i.facts.repository = "Acme/Shop"), "facts.repository"],
    ["a repository that is an address", (i: any) => (i.facts.repository = "https://example.test/acme/shop"), "facts.repository"],
    ["a branch with a line break", (i: any) => (i.facts.branch = "main\nx"), "facts.branch"],
    ["a path that leaves the repository", (i: any) => (i.facts.paths = ["../secret"]), "facts.paths.0"],
    ["a negative cost", (i: any) => (i.facts.runCostUsd = -1), "facts.runCostUsd"],
    ["a count that is not whole", (i: any) => (i.facts.secretsFound = 0.5), "facts.secretsFound"],
    ["a flag that is null", (i: any) => (i.facts.sandboxed = null), "facts.sandboxed"],
  ])("refuses %s", (_what, change, path) => {
    const e = failure(() => parsePolicyInput(edit(input("push", { branch: "main" }), change)));
    expect(e.code).toBe("invalid");
    expect(e.issues.map((i) => i.path)).toContain(path);
  });

  it("refuses a cost that is not finite", () => {
    expect(FactsSchema.safeParse({ runCostUsd: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(FactsSchema.safeParse({ runCostUsd: Number.NaN }).success).toBe(false);
  });
});

describe("reason codes", () => {
  it("are a closed list, each once, each with a sentence, and each fits the evidence format", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    expect(REASON_CODES).toHaveLength(RULE_REASON_CODES.length + ENGINE_REASON_CODES.length);
    for (const code of REASON_CODES) {
      expect(code).toMatch(/^[a-z]+\.[a-z]+(-[a-z]+)*$/);
      expect(EvidenceReasonCodeSchema.safeParse(code).success).toBe(true);
      expect(reasonText(code)).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("are stable: this list only grows", () => {
    expect([...REASON_CODES].sort()).toEqual([
      "approval.required", "branch.hotfix-exception", "branch.protected", "budget.daily-exceeded", "budget.run-exceeded", "budget.step-exceeded",
      "credential.scope-exceeded", "exception.granted", "flow.retired", "identity.missing", "issue.closed", "output.limit-exceeded", "path.forbidden",
      "policy.break-glass", "policy.input-incomplete", "policy.invalid", "policy.no-rule-matched", "policy.unavailable", "repository.not-allowed", "sandbox.required",
      "secret.detected", "timeout.exceeded", "tool.not-allowed", "workspace.admin-only",
    ]);
  });
});

describe("evaluatePolicy", () => {
  it("gives all four outcomes", () => {
    const push = { branch: "feature/x", flow: "issue-gitflow", step: "push", shippedFlow: true, secretsFound: 0, paths: ["src/a.ts"] };
    expect(short(decide("push", push))).toEqual(["allow", "policy.no-rule-matched", undefined]);
    expect(short(decide("push", { ...push, branch: "release/1.2" }))).toEqual(["deny", "branch.protected", "protected-branches"]);
    expect(short(decide("push", { ...push, paths: ["src/a.ts", ".github/workflows/ci.yml"] }))).toEqual(["require_approval", "path.forbidden", "workflow-files"]);
    expect(short(decide("step.after", { paths: [], outputBytes: 60001, elapsedMs: 10, runCostUsd: 1 }))).toEqual(["warn", "output.limit-exceeded", "output-limit"]);
    expect(new Set(BASELINE.rules.map((r) => r.outcome))).toEqual(new Set(OUTCOMES));
  });

  it("records policy id, version, pack hash, input hash, mode, boundary, outcome, reason, rule and time", () => {
    const question = input("push", { branch: "main", secretsFound: 0, paths: [] });
    expect(evaluatePolicy(BASELINE, question, T)).toEqual({
      version: 1,
      policy: { id: "baseline", version: "2026.1" },
      packSha256: policyPackSha256(BASELINE),
      mode: "enforce",
      boundary: "push",
      inputSha256: policyInputSha256(question),
      outcome: "deny",
      reasonCode: "policy.input-incomplete",
      rule: "hotfix-merge",
      evaluatedAt: T,
    });
  });

  it("is deterministic: the same pack, input and time give the same decision, whatever the order of the keys", () => {
    const facts = { branch: "main", flow: "issue-gitflow", step: "push_main", shippedFlow: true, secretsFound: 0, paths: [] };
    const first = decide("push", facts);
    const reordered: PolicyPack = { rules: BASELINE.rules.map((r) => ({ reasonCode: r.reasonCode, outcome: r.outcome, when: r.when, boundaries: r.boundaries, id: r.id })), defaultOutcome: "allow", mode: "enforce", policy: { version: "2026.1", id: "baseline" }, version: 1 };
    const again = evaluatePolicy(reordered, { facts: { paths: [], secretsFound: 0, shippedFlow: true, step: "push_main", flow: "issue-gitflow", branch: "main" }, runId: "20260131-120000-abc", boundary: "push", version: 1 }, T);
    expect(JSON.stringify(first)).toBe(JSON.stringify(again));
    expect(JSON.stringify(decide("push", facts))).toBe(JSON.stringify(first));
    expect(short(first)).toEqual(["allow", "branch.hotfix-exception", "hotfix-merge"]);
  });

  it("changes only evaluatedAt when the time changes, and the hashes when the input or the pack changes", () => {
    const question = input("run.start", { dailyCostUsd: 5, owner: "admin", workspace: "worktree" });
    const a = evaluatePolicy(BASELINE, question, T);
    const later = evaluatePolicy(BASELINE, question, "2026-02-01T00:00:00.000Z");
    expect({ ...later, evaluatedAt: T }).toEqual(a);
    expect(evaluatePolicy(BASELINE, { ...question, runId: "other-run" }, T).inputSha256).not.toBe(a.inputSha256);
    const next = edit(BASELINE, (p) => (p.policy.version = "2026.2"));
    const b = evaluatePolicy(next, question, T);
    expect(b.packSha256).not.toBe(a.packSha256);
    expect(b.inputSha256).toBe(a.inputSha256);
    expect(b.policy).toEqual({ id: "baseline", version: "2026.2" });
  });

  it("does not change its arguments", () => {
    const pack = structuredClone(BASELINE);
    const question = input("push", { branch: "main", flow: "x", step: "s", shippedFlow: false, secretsFound: 0, paths: [] });
    const copy = structuredClone(question);
    evaluatePolicy(pack, question, T);
    expect(pack).toEqual(BASELINE);
    expect(question).toEqual(copy);
  });

  it("lets the first rule that applies decide", () => {
    const facts = { branch: "main", flow: "issue-gitflow", step: "push_main", shippedFlow: true, secretsFound: 0, paths: [] };
    expect(short(decide("push", facts))).toEqual(["allow", "branch.hotfix-exception", "hotfix-merge"]);
    expect(short(decide("push", { ...facts, shippedFlow: false }))).toEqual(["deny", "branch.protected", "protected-branches"]);
    expect(short(decide("push", { ...facts, step: "push" }))).toEqual(["deny", "branch.protected", "protected-branches"]);
    expect(short(decide("push", { ...facts, secretsFound: 3 }))).toEqual(["deny", "secret.detected", "no-secrets"]);
  });

  it("passes over a rule at a boundary it does not name", () => {
    expect(short(decide("run.complete", { branch: "main" }))).toEqual(["allow", "policy.no-rule-matched", undefined]);
    expect(short(decide("step.before", { runCostUsd: 26 }))).toEqual(["deny", "budget.run-exceeded", "run-budget"]);
  });

  it("denies when a rule needs a fact the input does not have, also when another condition is false", () => {
    expect(short(decide("push", {}))).toEqual(["deny", "policy.input-incomplete", "no-secrets"]);
    expect(short(decide("push", { branch: "main", flow: "issue-gitflow", step: "push_main", shippedFlow: true }))).toEqual(["deny", "policy.input-incomplete", "no-secrets"]);
    expect(short(decide("push", { secretsFound: 0, branch: "feature/x", flow: "f", step: "s" }))).toEqual(["deny", "policy.input-incomplete", "hotfix-merge"]);
    expect(short(decide("push", { secretsFound: 0, branch: "feature/x", flow: "f", step: "s", shippedFlow: true }))).toEqual(["deny", "policy.input-incomplete", "workflow-files"]);
    expect(short(decide("step.before", { runCostUsd: 1, owner: "user" }))).toEqual(["deny", "policy.input-incomplete", "user-sandbox"]);
  });

  it("uses the default outcome when no rule applies", () => {
    const closed: PolicyPack = { ...BASELINE, defaultOutcome: "deny" };
    expect(short(decide("run.complete", {}, closed))).toEqual(["deny", "policy.no-rule-matched", undefined]);
    expect(short(decide("run.complete", {}, { ...closed, rules: [] }))).toEqual(["deny", "policy.no-rule-matched", undefined]);
  });

  it("a rule without conditions always applies at its boundaries", () => {
    const pack: PolicyPack = { ...BASELINE, rules: [{ id: "ask", boundaries: ["approval.consume"], when: {}, outcome: "require_approval", reasonCode: "approval.required" }] };
    expect(short(decide("approval.consume", {}, pack))).toEqual(["require_approval", "approval.required", "ask"]);
    expect(short(decide("push", {}, pack))).toEqual(["allow", "policy.no-rule-matched", undefined]);
  });

  it("compares limits with more than, never with equal", () => {
    const at = (runCostUsd: number) => decide("step.before", { runCostUsd, owner: "admin", sandboxed: false }).outcome;
    expect([at(24.99), at(25), at(25.01)]).toEqual(["allow", "allow", "deny"]);
  });

  it("reads in, notIn and flags as written", () => {
    const access = (repository: string, owner: Facts["owner"], credential: Facts["credential"]) => short(decide("repository.access", { repository, owner, credential }));
    expect(access("acme/shop", "admin", "machine")).toEqual(["allow", "policy.no-rule-matched", undefined]);
    expect(access("other/shop", "admin", "machine")).toEqual(["deny", "repository.not-allowed", "target-repositories"]);
    expect(access("acme/shop", "user", "machine")).toEqual(["deny", "credential.scope-exceeded", "machine-login"]);
    expect(access("acme/shop", "none", "machine")).toEqual(["deny", "credential.scope-exceeded", "machine-login"]);
    expect(access("acme/shop", "user", "repository")).toEqual(["allow", "policy.no-rule-matched", undefined]);
    const start = (owner: Facts["owner"], workspace: Facts["workspace"]) => decide("run.start", { dailyCostUsd: 0, owner, workspace }).reasonCode;
    expect([start("user", "inplace"), start("user", "worktree"), start("user", "empty"), start("admin", "inplace")]).toEqual(["workspace.admin-only", "workspace.admin-only", "policy.no-rule-matched", "policy.no-rule-matched"]);
    const step = (owner: Facts["owner"], sandboxed: boolean) => decide("step.before", { runCostUsd: 0, owner, sandboxed }).outcome;
    expect([step("user", false), step("user", true), step("admin", false)]).toEqual(["deny", "allow", "allow"]);
  });

  it("makes the same decision in observe mode and only marks it", () => {
    const facts = { branch: "main", flow: "f", step: "s", shippedFlow: false, secretsFound: 0 };
    const enforced = decide("push", facts);
    const observed = decide("push", facts, { ...BASELINE, mode: "observe" });
    expect(observed.mode).toBe("observe");
    expect(short(observed)).toEqual(short(enforced));
  });

  it("decides nothing on bad data", () => {
    const question = input("push", { branch: "main" });
    expect(failure(() => evaluatePolicy(edit(BASELINE, (p) => (p.rules[0].outcome = "maybe")), question, T)).kind).toBe("pack");
    expect(failure(() => evaluatePolicy({ ...BASELINE, version: 3 } as never, question, T)).code).toBe("unsupported-version");
    expect(failure(() => evaluatePolicy(BASELINE, edit(question, (i) => (i.facts.extra = 1)), T)).kind).toBe("input");
    for (const time of ["yesterday", "2026-01-31", "2026-01-31T12:00:00+01:00", ""]) {
      const e = failure(() => evaluatePolicy(BASELINE, question, time));
      expect([e.kind, e.code, e.issues[0]!.path]).toEqual(["decision", "invalid", "evaluatedAt"]);
    }
  });

  it("names the facts a rule needs", () => {
    expect(factsNeeded(BASELINE.rules[1]!)).toEqual(["branch", "flow", "shippedFlow", "step"]);
    expect(factsNeeded({ when: {} })).toEqual([]);
  });
});

describe("PolicyDecision", () => {
  const ok = decide("push", { branch: "main", flow: "f", step: "s", shippedFlow: false, secretsFound: 0 });

  it("reads back what the evaluation wrote, also after JSON", () => {
    expect(parsePolicyDecision(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  });

  it.each([
    ["an unknown field", (d: any) => (d.note = "x")],
    ["no input hash", (d: any) => delete d.inputSha256],
    ["a short hash", (d: any) => (d.inputSha256 = "abc")],
    ["no time", (d: any) => delete d.evaluatedAt],
    ["a local time", (d: any) => (d.evaluatedAt = "2026-01-31 12:00")],
    ["an unknown outcome", (d: any) => (d.outcome = "block")],
    ["an unknown reason code", (d: any) => (d.reasonCode = "because")],
    ["no mode", (d: any) => delete d.mode],
    ["a rule reason without a rule", (d: any) => delete d.rule],
    ["a rule with the no-rule reason", (d: any) => (d.reasonCode = "policy.no-rule-matched")],
    ["no pack hash for a pack that was read", (d: any) => delete d.packSha256],
    ["an incomplete input that does not deny", (d: any) => Object.assign(d, { reasonCode: "policy.input-incomplete", outcome: "allow" })],
    ["a warning when no rule matched", (d: any) => Object.assign(d, { reasonCode: "policy.no-rule-matched", outcome: "warn", rule: undefined })],
  ])("refuses %s", (_what, change) => {
    expect(failure(() => parsePolicyDecision(edit(ok, change))).code).toBe("invalid");
  });

  it("accepts a denial for a pack that could not be read: no rule, no pack hash, always deny", () => {
    const unread = { version: 1, policy: { id: "baseline", version: "2026.1" }, mode: "enforce", boundary: "push", inputSha256: H, outcome: "deny", reasonCode: "policy.unavailable", evaluatedAt: T };
    expect(parsePolicyDecision(unread).reasonCode).toBe("policy.unavailable");
    expect(parsePolicyDecision({ ...unread, reasonCode: "policy.invalid" }).outcome).toBe("deny");
    expect(failure(() => parsePolicyDecision({ ...unread, outcome: "allow" })).issues[0]!.path).toBe("outcome");
    expect(failure(() => parsePolicyDecision({ ...unread, packSha256: H })).issues[0]!.path).toBe("packSha256");
    expect(failure(() => parsePolicyDecision({ ...unread, rule: "r" })).issues[0]!.path).toBe("rule");
  });

  it("accepts a break-glass decision only as an enforced warning with no pack hash and no rule", () => {
    const glass = { version: 1, policy: { id: "org", version: "unknown" }, mode: "enforce", boundary: "agent.write", inputSha256: H, outcome: "warn", reasonCode: "policy.break-glass", evaluatedAt: T };
    expect(parsePolicyDecision(glass).reasonCode).toBe("policy.break-glass");
    expect(failure(() => parsePolicyDecision({ ...glass, outcome: "deny" })).issues[0]!.path).toBe("outcome");
    expect(failure(() => parsePolicyDecision({ ...glass, outcome: "allow" })).issues[0]!.path).toBe("outcome");
    expect(failure(() => parsePolicyDecision({ ...glass, mode: "observe" })).issues[0]!.path).toBe("mode");
    expect(failure(() => parsePolicyDecision({ ...glass, packSha256: H })).issues[0]!.path).toBe("packSha256");
    expect(failure(() => parsePolicyDecision({ ...glass, rule: "r" })).issues[0]!.path).toBe("rule");
  });

  it("is refused by an older build: its closed list of codes lacks policy.break-glass", () => {
    const old = z.enum(REASON_CODES.filter((c) => c !== "policy.break-glass") as [string, ...string[]]);
    expect(old.safeParse("policy.break-glass").success).toBe(false);
    const glass = { version: 1, policy: { id: "org", version: "unknown" }, mode: "enforce", boundary: "agent.write", inputSha256: H, outcome: "warn", reasonCode: "policy.future-code", evaluatedAt: T };
    expect(failure(() => parsePolicyDecision(glass)).code).toBe("invalid");
  });
});

describe("a decision as evidence", () => {
  const denied = decide("push", { branch: "main", flow: "f", step: "s", shippedFlow: false, secretsFound: 0 });

  it("gives the policy identity evidence carries", () => {
    expect(PolicyIdentitySchema.parse(policyIdentityOf(denied))).toEqual({ id: "baseline", version: "2026.1" });
  });

  it("gives the denial of a step.denied event, which the evidence format accepts", () => {
    const denial = policyDenial(denied, "Bash");
    expect(denial).toEqual({ kind: "policy", policy: { id: "baseline", version: "2026.1" }, reasonCode: "branch.protected", tool: { name: "Bash" } });
    expect(DenialSchema.parse(policyDenial(denied))).toEqual({ kind: "policy", policy: { id: "baseline", version: "2026.1" }, reasonCode: "branch.protected" });
    const event = { version: 1, id: "e0001", seq: 1, runId: "20260131-120000-abc", time: T, type: "step.denied", step: { id: "push", visit: 1, type: "shell" }, denial };
    expect(parseEvidenceEvent(event).type).toBe("step.denied");
  });

  it("gives no denial for a decision that refused nothing", () => {
    expect(policyDenial(decide("push", { branch: "main", flow: "f", step: "s", shippedFlow: false, secretsFound: 0 }, { ...BASELINE, mode: "observe" }))).toBeUndefined();
    expect(policyDenial(decide("run.complete", {}))).toBeUndefined();
    expect(policyDenial(decide("push", { branch: "x", flow: "f", step: "s", shippedFlow: false, secretsFound: 0, paths: ["a.pem"] }))).toBeUndefined();
  });
});

describe("helpers", () => {
  it("canonicalJson sorts keys, keeps array order and refuses what is not JSON", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: null, c: "x" }], e: undefined })).toBe('{"a":[3,{"c":"x","d":null}],"b":1}');
    expect(canonicalJson("a\"b")).toBe('"a\\"b"');
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, new Date(0), new Map(), 1n]) expect(() => canonicalJson(bad)).toThrow(TypeError);
    expect(() => canonicalJson({ a: [new Date(0)] })).toThrow(TypeError);
  });

  it("the hashes are SHA-256 of the canonical form", () => {
    expect(policyPackSha256(BASELINE)).toMatch(/^[0-9a-f]{64}$/);
    expect(policyPackSha256({ ...BASELINE, mode: "observe" })).not.toBe(policyPackSha256(BASELINE));
    expect(policyInputSha256(input("push", { branch: "a", step: "s" }))).toBe(policyInputSha256({ facts: { step: "s", branch: "a" }, runId: "20260131-120000-abc", boundary: "push", version: 1 }));
    expect(() => policyPackSha256({ ...BASELINE, extra: 1 } as never)).toThrow(PolicySchemaError);
  });

  it.each([
    ["main", "main", true],
    ["main", "main2", false],
    ["main", "Main", false],
    ["release/*", "release/1.0", true],
    ["release/*", "release/", true],
    ["release/*", "release", false],
    ["*", "", true],
    ["*", "a/b", true],
    ["*.pem", "keys/a.pem", true],
    ["*.pem", "a.pem.txt", false],
    ["a*a", "a", false],
    ["a*a", "aa", true],
    ["a*b*c", "a-b-b-c", true],
    ["a*b*c", "acb", false],
    ["a*bc*c", "abc", false],
    ["**", "x", true],
    ["a.c", "abc", false],
    ["a?c", "abc", false],
    ["[ab]", "a", false],
    ["(a+)+$", "aaaa", false],
  ])("pattern %s against %s: %s", (pattern, text, expected) => {
    expect(matchesPattern(pattern, text)).toBe(expected);
  });

  it("a long pattern with many stars is answered at once", () => {
    const started = performance.now();
    expect(matchesPattern(`${"a*".repeat(120)}b`, "a".repeat(1024))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
