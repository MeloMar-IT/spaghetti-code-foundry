import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { protectedBranchEnv } from "../src/engine/guards.js";
import { baseFacts, deniedReason, drainPushLog, loadPolicyPacks, MAX_PACK_BYTES, MAX_PUSHES_PER_STEP, policyFacts, privilegedBoundary, RunPolicy, runPolicy, type LoadedPack } from "../src/engine/policy-hooks.js";
import { ENGINE_REASONS } from "../src/policy/reasons.js";
import { DenialSchema } from "../src/evidence/schema.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../src/policy/baseline.js";
import { parseEvidenceEvent } from "../src/evidence/parse.js";
import type { RunRecorder } from "../src/evidence/record.js";
import { parsePolicyDecision } from "../src/policy/parse.js";
import { BOUNDARIES, type Boundary, type Facts, type PolicyPack } from "../src/policy/schema.js";
import { coverPack, writePack } from "./fixtures/policy-pack.js";

const H = "1".repeat(64);
const T = "2026-01-31T12:00:00.000Z";
const STEP = { id: "build", visit: 1, type: "shell", parent: "outer" } as const;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "policy-hooks-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pack = (over: Partial<PolicyPack> = {}): PolicyPack => ({
  version: 1,
  policy: { id: "p1", version: "1" },
  mode: "observe",
  defaultOutcome: "allow",
  rules: [{ id: "any-step", boundaries: ["step.before"], when: { step: { in: ["build"] } }, outcome: "warn", reasonCode: "output.limit-exceeded" }],
  ...over,
});
const loaded = (id: string): LoadedPack => loadPolicyPacks([id], home)[0]!;
const detail = (l: LoadedPack) => ("problem" in l ? [l.problem, l.detail] : "pack");

describe("loadPolicyPacks", () => {
  it("reads a valid observe pack", () => {
    writePack(home, "p1", pack());
    expect(loaded("p1")).toEqual({ id: "p1", pack: pack() });
  });

  it("reads a version 2 pack with an observe rule or no rule mode, and refuses a rule in enforce", () => {
    const v2 = (mode?: "observe" | "enforce"): PolicyPack => {
      const p = pack({ version: 2 });
      return mode ? { ...p, rules: [{ ...p.rules[0]!, mode }] } : p;
    };
    writePack(home, "p1", v2());
    expect(detail(loaded("p1"))).toBe("pack");
    writePack(home, "p1", v2("observe"));
    expect(detail(loaded("p1"))).toBe("pack");
    writePack(home, "p1", v2("enforce"));
    expect(detail(loaded("p1"))).toEqual(["policy.invalid", "rule any-step has mode enforce, which is not supported yet: set its mode to observe or leave it out"]);
  });

  it("says unavailable for a missing file, a link and a folder", () => {
    expect(detail(loaded("nope"))).toEqual(["policy.unavailable", "no file policies/nope.json"]);
    mkdirSync(join(home, "policies"), { recursive: true });
    writeFileSync(join(home, "target.json"), JSON.stringify(pack()));
    symlinkSync(join(home, "target.json"), join(home, "policies", "linked.json"));
    expect(detail(loaded("linked"))).toEqual(["policy.unavailable", "not a plain file"]);
    mkdirSync(join(home, "policies", "folder.json"));
    expect(detail(loaded("folder"))).toEqual(["policy.unavailable", "not a plain file"]);
  });

  it("says invalid for bad JSON, a bad pack, another id, enforce mode and a large file", () => {
    writePack(home, "bad-json", "{ nope");
    expect(detail(loaded("bad-json"))).toEqual(["policy.invalid", "not valid JSON"]);
    writePack(home, "bad-pack", { ...pack(), policy: { id: "bad-pack", version: "1" }, defaultOutcome: "maybe-secret-value" });
    const bad = loaded("bad-pack");
    expect(bad).toMatchObject({ problem: "policy.invalid" });
    expect(JSON.stringify(bad)).not.toContain("maybe-secret-value");
    writePack(home, "other", pack());
    expect(detail(loaded("other"))).toEqual(["policy.invalid", "the file is for policy p1"]);
    writePack(home, "p1", pack({ mode: "enforce" }));
    expect(detail(loaded("p1"))).toEqual(["policy.invalid", "mode enforce is not supported yet: set mode to observe"]);
    writePack(home, "big", " ".repeat(MAX_PACK_BYTES + 1));
    expect(detail(loaded("big"))).toEqual(["policy.invalid", "larger than 1 MiB"]);
  });

  it("never names the data folder", () => {
    writePack(home, "bad-json", "{ nope");
    for (const id of ["nope", "bad-json"]) expect(JSON.stringify(loaded(id))).not.toContain(home);
  });
});

describe("policyFacts and baseFacts", () => {
  it("drops values that fail their own schema and keeps the rest", () => {
    const facts = policyFacts({ repository: "Acme/Widgets", step: "has spaces", runCostUsd: -1, flow: "daily-pr", elapsedMs: 5, isolated: false, stepCostUsd: undefined });
    expect(facts).toEqual({ flow: "daily-pr", elapsedMs: 5, isolated: false });
  });

  it("gives the repository in lower case, but not the placeholder", () => {
    const run = { flow: "f", flowDef: { workspace: "inplace" }, owner: undefined } as never;
    expect(baseFacts({ ...(run as object), vars: { github_repo: "Acme/Widgets" } } as never)).toEqual({ repository: "acme/widgets", flow: "f", workspace: "inplace", owner: "none" });
    expect(baseFacts({ ...(run as object), vars: { github_repo: "owner/repo" } } as never)).not.toHaveProperty("repository");
    expect(baseFacts({ ...(run as object), vars: {} } as never)).not.toHaveProperty("repository");
  });

  it("fails closed to user for an owner it does not know", () => {
    expect(baseFacts({ vars: {}, flow: "f", flowDef: { workspace: "empty" }, owner: "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11" } as never).owner).toBe("user");
  });
});

describe("RunPolicy", () => {
  const make = (packs: LoadedPack[], extra: { evidence?: unknown } = {}) => {
    const lines: string[] = [];
    const policyDecided = vi.fn();
    const incomplete = vi.fn();
    const evidence = (extra.evidence ?? { policyDecided, incomplete }) as RunRecorder;
    const policy = new RunPolicy({ runId: "run-1", packs: packs.map((p) => ({ layer: "optional" as const, ...p })), base: { flow: "f" }, log: (l) => lines.push(l), evidence, now: () => T });
    return { policy, lines, policyDecided, incomplete };
  };

  it("returns one decision per pack in order, logs one line each and records them with the step", () => {
    const second = pack({ policy: { id: "p2", version: "7" } });
    const { policy, lines, policyDecided } = make([{ id: "p1", pack: pack() }, { id: "p2", pack: second }]);
    const answer = policy.at("step.before", { step: "build" }, STEP);
    const out = answer.decisions.map((d) => d.decision);
    expect(out.map((d) => [d.policy.id, d.outcome, d.rule])).toEqual([["p1", "warn", "any-step"], ["p2", "warn", "any-step"]]);
    expect(answer.combined).toBe(answer.decisions[0]);
    expect(lines).toEqual([
      "· policy p1 1 [optional] · step.before outer/build: warn (output.limit-exceeded, rule any-step) · wins — observe only, nothing was stopped",
      "· policy p2 7 [optional] · step.before outer/build: warn (output.limit-exceeded, rule any-step) — observe only, nothing was stopped",
    ]);
    expect(policyDecided).toHaveBeenCalledTimes(2);
    expect(policyDecided).toHaveBeenCalledWith(out[0], STEP);
    expect(policyDecided).toHaveBeenCalledWith(out[1], STEP);
  });

  it("names the layer, and marks no winner with a single pack", () => {
    const lines: string[] = [];
    const policy = new RunPolicy({ runId: "run-1", packs: [{ layer: "mandatory", id: "p1", pack: pack() }], base: { flow: "f" }, log: (l) => lines.push(l), now: () => T });
    const { decisions, combined } = policy.at("step.before", { step: "build" });
    expect(combined).toBe(decisions[0]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" [mandatory] · ");
    expect(lines[0]).not.toContain("wins");
  });

  it("records an unavailable pack as an observe-mode deny without a pack hash", () => {
    const { policy } = make([{ id: "gone", problem: "policy.unavailable", detail: "no file" }, { id: "wrong", problem: "policy.invalid", detail: "x" }]);
    const [a, b] = policy.at("run.start").decisions.map((d) => d.decision);
    expect(a).toMatchObject({ policy: { id: "gone", version: "unknown" }, mode: "observe", outcome: "deny", reasonCode: "policy.unavailable", boundary: "run.start" });
    expect(b).toMatchObject({ reasonCode: "policy.invalid" });
    expect(a).not.toHaveProperty("packSha256");
    expect(parsePolicyDecision(a)).toEqual(a);
    // and the evidence event holds
    expect(parseEvidenceEvent({ version: 2, id: "e1", seq: 0, runId: "run-1", time: T, type: "policy.decided", decision: a })).toMatchObject({ type: "policy.decided" });
  });

  it("records a policy.invalid decision when an evaluation throws, and never throws", () => {
    const broken = { id: "p1", pack: { ...pack(), version: 99 } } as unknown as LoadedPack;
    const { policy, lines, policyDecided, incomplete } = make([broken]);
    const out = policy.at("run.start").decisions.map((d) => d.decision);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reasonCode: "policy.invalid", outcome: "deny", mode: "observe" });
    expect(lines[0]).toBe("! policy p1: could not be evaluated at run.start — recorded as policy.invalid; the run goes on");
    expect(policyDecided).toHaveBeenCalledTimes(1);
    expect(incomplete).not.toHaveBeenCalled();
  });

  it("marks the evidence incomplete when even that cannot be recorded", () => {
    const broken = { id: "Bad Id", pack: { ...pack(), version: 99 } } as unknown as LoadedPack;
    const { policy, lines, incomplete, policyDecided } = make([broken]);
    expect(policy.at("run.start").decisions).toEqual([]);
    expect(incomplete).toHaveBeenCalledTimes(1);
    expect(policyDecided).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatch(/^! policy: a decision could not be made or recorded/);
  });

  it("asks repository.access for a step, and push once for each push it made, with the facts of its access", () => {
    const rule = { id: "feat", boundaries: ["push" as const], when: { branch: { in: ["feat"] }, credential: { in: ["none" as const] }, isolated: true, repository: { in: ["acme/*"] } }, outcome: "deny" as const, reasonCode: "branch.protected" as const };
    const { policy, policyDecided } = make([{ id: "p1", pack: pack({ rules: [rule] }) }]);
    policy.repository(STEP, { step: "build", credential: "none", isolated: true, repository: "acme/run-repo" });
    policy.pushes(STEP, [{ branch: "feat", repository: "acme/other" }, { branch: "other" }, { branch: "feat" }]);
    const calls = policyDecided.mock.calls.map((c) => c[0] as { boundary: string; outcome: string; reasonCode: string });
    expect(calls.map((d) => [d.boundary, d.outcome, d.reasonCode])).toEqual([
      ["repository.access", "allow", "policy.no-rule-matched"],
      ["push", "deny", "branch.protected"],
      // no repository for this push: the run's repository is not assumed, and the rule needs one
      ["push", "deny", "policy.input-incomplete"],
      ["push", "deny", "policy.input-incomplete"],
    ]);
    // a step that never pushed leaves nothing behind, and a step that was not asked has no access facts
    policy.pushes(STEP, []);
    expect(policyDecided).toHaveBeenCalledTimes(4);
  });

  it("reads the pushes a hook logged, and removes the file", () => {
    const file = join(home, "pushes", "a-1.log");
    mkdirSync(join(home, "pushes"));
    writeFileSync(file, "feat\thttps://github.com/Acme/Widgets.git\nrelease/1\t/tmp/local/remote.git\n\nmain\tgit@github.com:acme/app.git\n");
    expect(drainPushLog(file)).toEqual([{ branch: "feat", repository: "acme/widgets" }, { branch: "release/1" }, { branch: "main", repository: "acme/app" }]);
    expect(existsSync(file)).toBe(false);
    expect(drainPushLog(file)).toEqual([]);
    // a link or a folder is not read, and the number of lines is limited
    mkdirSync(join(home, "pushes", "dir"));
    expect(drainPushLog(join(home, "pushes", "dir"))).toEqual([]);
    writeFileSync(file, Array.from({ length: MAX_PUSHES_PER_STEP + 20 }, (_, i) => `b${i}\t`).join("\n"));
    expect(drainPushLog(file)).toHaveLength(MAX_PUSHES_PER_STEP);
  });

  it("lets a boundary override a fact of the run, also with nothing (no fall back to the run's value)", () => {
    const rule = { id: "r", boundaries: ["run.start" as const], when: { repository: { in: ["acme/*"] } }, outcome: "deny" as const, reasonCode: "repository.not-allowed" as const };
    const lines: string[] = [];
    const policy = new RunPolicy({ runId: "run-1", packs: [{ layer: "optional", id: "p1", pack: pack({ rules: [rule] }) }], base: { repository: "acme/widgets" }, log: (l) => lines.push(l), now: () => T });
    expect(policy.at("run.start").decisions[0]!.decision).toMatchObject({ outcome: "deny", reasonCode: "repository.not-allowed" });
    expect(policy.at("run.start", { repository: undefined }).decisions[0]!.decision).toMatchObject({ reasonCode: "policy.input-incomplete" });
  });

  it("works with a pack that holds a rule for every boundary", () => {
    const { policy } = make([{ id: "cover", pack: coverPack() }]);
    expect(policy.at("run.complete", { runCostUsd: 0 }).decisions[0]!.decision).toMatchObject({ rule: "run-complete-ok" });
    expect(policy.at("run.complete").decisions[0]!.decision).toMatchObject({ reasonCode: "policy.input-incomplete", rule: "run-complete-check" });
  });
});

describe("runPolicy and the config", () => {
  it("reads nothing for no packs and asks only the baseline", () => {
    const lines: string[] = [];
    const policy = runPolicy({ runId: "r", vars: {}, flow: "f", flowDef: { workspace: "worktree" } } as never, ConfigSchema.parse({}), (l) => lines.push(l), undefined, join(home, "never-read"));
    expect(policy).toBeInstanceOf(RunPolicy);
    expect(existsSync(join(home, "never-read"))).toBe(false);
    expect(lines).toEqual([]);
    const answer = policy.at("run.start");
    expect(answer.decisions).toHaveLength(1);
    expect(answer.decisions[0]).toMatchObject({ layer: "mandatory", decision: { policy: { id: BASELINE_POLICY_ID }, outcome: "allow" } });
    expect(answer.combined).toBe(answer.decisions[0]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^· policy foundry\.baseline \S+ \[mandatory\] · run\.start: allow /);
    expect(lines[0]).not.toContain("wins");
    expect(policy.observesPushes).toBe(false);
  });

  it("asks the baseline, the overlays, the repository packs and the optional packs in that order", () => {
    for (const id of ["o", "r", "p"]) writePack(home, id, pack({ policy: { id, version: "1" } }));
    const lines: string[] = [];
    const config = ConfigSchema.parse({ policy: { mandatory: ["o"], repositories: { "acme/a": ["r"], "acme/b": ["x"] }, packs: ["p"] } });
    const policy = runPolicy({ runId: "r", vars: { github_repo: "Acme/A" }, flow: "f" } as never, config, (l) => lines.push(l), undefined, home);
    expect(policy.observesPushes).toBe(true);
    const { decisions } = policy.at("run.start");
    expect(decisions.map((d) => [d.decision.policy.id, d.layer])).toEqual([[BASELINE_POLICY_ID, "mandatory"], ["o", "mandatory"], ["r", "repository"], ["p", "optional"]]);
    expect(lines.some((l) => l.startsWith("!"))).toBe(false);
  });

  it("pushes: the baseline reads the secret count and the identity", () => {
    const answers: string[] = [];
    const policy = new RunPolicy({ runId: "r", packs: [{ layer: "mandatory", id: BASELINE_POLICY_ID, pack: BASELINE_PACK }], base: {}, log: () => {}, now: () => T, evidence: { policyDecided: (d: { reasonCode: string }) => answers.push(d.reasonCode), incomplete: () => {} } as never });
    policy.pushes(STEP, [{ branch: "a", secretsFound: 2, commitIdentity: true }, { branch: "b", secretsFound: 0, commitIdentity: false }, { branch: "c", secretsFound: 0, commitIdentity: true }]);
    expect(answers).toEqual(["secret.detected", "identity.missing", "policy.no-rule-matched"]);
  });

  it("reads the secret count and the identity from the hook's lines", () => {
    const file = join(home, "p.log");
    const read = (text: string) => {
      writeFileSync(file, text);
      return drainPushLog(file);
    };
    expect(read("feat\turl\t2\t1\n")).toEqual([{ branch: "feat", secretsFound: 2, commitIdentity: true }]);
    expect(read("b\t\t0\t0\n")).toEqual([{ branch: "b", secretsFound: 0, commitIdentity: false }]);
    for (const bad of ["x", "-1", "1234567890"]) expect(read(`b\turl\t${bad}\t1\n`)).toEqual([{ branch: "b", commitIdentity: true }]);
    expect(read("b\turl\n")).toEqual([{ branch: "b" }]);
  });

  it("installs no hook for no guards and no packs", () => {
    expect(protectedBranchEnv([], false, false)).toEqual({});
  });

  it("logs one line for a pack that cannot be loaded", () => {
    const lines: string[] = [];
    const policy = runPolicy({ runId: "r", vars: {}, flow: "f" } as never, ConfigSchema.parse({ policy: { packs: ["missing"] } }), (l) => lines.push(l), undefined, home);
    expect(policy).toBeInstanceOf(RunPolicy);
    expect(lines).toEqual(["! policy missing: no file policies/missing.json — recorded as policy.unavailable; the run goes on"]);
  });

  it("defaults to no packs and refuses odd lists", () => {
    expect(ConfigSchema.parse({}).policy).toEqual({ packs: [], mandatory: [], repositories: {} });
    for (const packs of [["a", "a"], ["../x"], ["Upper"], Array.from({ length: 21 }, (_, i) => `p${i}`), [BASELINE_POLICY_ID]]) {
      expect(ConfigSchema.safeParse({ policy: { packs } }).success, JSON.stringify(packs)).toBe(false);
      expect(ConfigSchema.safeParse({ policy: { mandatory: packs } }).success, JSON.stringify(packs)).toBe(false);
      expect(ConfigSchema.safeParse({ policy: { repositories: { "acme/a": packs } } }).success, JSON.stringify(packs)).toBe(false);
    }
    for (const key of ["Acme/A", "acme", "acme/a/b"]) expect(ConfigSchema.safeParse({ policy: { repositories: { [key]: ["a"] } } }).success, key).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`acme/r${i}`, ["a"]]));
    expect(ConfigSchema.safeParse({ policy: { repositories: many } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ policy: { packs: ["a", "b.c"], mandatory: ["m"], repositories: { "acme/a": ["a", "b"] } } }).success).toBe(true);
  });
});

describe("fail closed", () => {
  type Layer = "mandatory" | "repository" | "optional";
  const make = (packs: Array<{ layer: Layer } & LoadedPack>) => {
    const lines: string[] = [];
    const policyDecided = vi.fn();
    const incomplete = vi.fn();
    const evidence = { policyDecided, incomplete } as unknown as RunRecorder;
    const policy = new RunPolicy({ runId: "run-1", packs, base: { flow: "f" }, log: (l) => lines.push(l), evidence, now: () => T });
    return { policy, lines, incomplete };
  };
  const problem = (code: "policy.unavailable" | "policy.invalid", layer: Layer = "mandatory") => ({ layer, id: "org", problem: code, detail: "x" }) as const;
  const WRITE: Facts = { step: "build", isolated: false, sandboxed: false };
  const ASKS: Array<[Boundary, Facts]> = [
    ["agent.write", WRITE],
    ["repository.access", { credential: "machine" }],
    ["repository.access", { credential: "repository" }],
    ["approval.consume", { step: "build" }],
  ];

  it("privilegedBoundary: only a sign-in, a writing agent and a used approval", () => {
    for (const b of BOUNDARIES) {
      for (const credential of ["machine", "repository", "none"] as const) {
        const expected = b === "agent.write" || b === "approval.consume" || (b === "repository.access" && credential !== "none");
        expect(privilegedBoundary(b, { credential }), `${b} ${credential}`).toBe(expected);
      }
    }
    expect(privilegedBoundary("repository.access", {})).toBe(false);
    expect(privilegedBoundary("repository.access", { credential: "other" } as unknown as Facts)).toBe(false);
  });

  it("mandatoryUnusable: only for a mandatory pack with a problem", () => {
    const base = { layer: "mandatory" as const, id: BASELINE_POLICY_ID, pack: BASELINE_PACK };
    expect(make([base, problem("policy.unavailable")]).policy.mandatoryUnusable).toBe(true);
    expect(make([base]).policy.mandatoryUnusable).toBe(false);
    expect(make([base, problem("policy.invalid", "repository")]).policy.mandatoryUnusable).toBe(false);
    expect(make([base, problem("policy.invalid", "optional")]).policy.mandatoryUnusable).toBe(false);
  });

  const cases = (["policy.unavailable", "policy.invalid"] as const).flatMap((code) => ASKS.map(([b, f]) => [code, b, f] as const));
  it.each(cases)("denies at a privileged boundary: %s %s %j", (code, boundary, facts) => {
    const { policy, lines, incomplete } = make([problem(code)]);
    const answer = policy.at(boundary, facts, STEP);
    expect(answer.denied?.reason).toBe(deniedReason("org", code, boundary));
    const d = answer.decisions[0]!.decision;
    expect(d).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: code, policy: { id: "org", version: "unknown" } });
    expect(d).not.toHaveProperty("packSha256");
    expect(parsePolicyDecision(d)).toEqual(d);
    expect(answer.denied?.decision).toBe(d);
    expect(answer.denied?.denial).toEqual({ kind: "policy", policy: { id: "org", version: "unknown" }, reasonCode: code });
    expect(() => DenialSchema.parse(answer.denied?.denial)).not.toThrow();
    expect(lines[0]).toMatch(/— enforced: the step is stopped$/);
    const event = { version: 2, id: "e1", seq: 0, runId: "run-1", time: T, type: "step.denied", step: STEP, denial: answer.denied?.denial };
    expect(() => parseEvidenceEvent(event)).not.toThrow();
    expect(incomplete).not.toHaveBeenCalled();
  });

  it("uses the exact reason text", () => {
    expect(deniedReason("org", "policy.unavailable", "agent.write")).toBe("mandatory policy org cannot be used (policy.unavailable): agent.write is denied");
  });

  it("stays observe at the other boundaries and for the workspace", () => {
    const asks: Array<[Boundary, Facts]> = [
      ["run.start", {}],
      ["step.before", { step: "build" }],
      ["step.after", { step: "build" }],
      ["push", { step: "build" }],
      ["run.complete", {}],
      ["repository.access", { credential: "none", step: "build" }],
      ["repository.access", { credential: "none" }],
      ["repository.access", {}],
    ];
    for (const [b, f] of asks) {
      const { policy, lines } = make([problem("policy.unavailable")]);
      const answer = policy.at(b, f);
      expect(answer.denied, b).toBeUndefined();
      expect(answer.decisions[0]!.decision.mode).toBe("observe");
      expect(lines[0]).toMatch(/— observe only, nothing was stopped$/);
    }
  });

  it("never denies for the repository and optional layers", () => {
    for (const layer of ["repository", "optional"] as const) {
      const answer = make([problem("policy.invalid", layer)]).policy.at("agent.write", WRITE);
      expect(answer.denied).toBeUndefined();
      expect(answer.decisions[0]!.decision.mode).toBe("observe");
    }
  });

  it("does not stop anything for a valid mandatory pack whose rule denies", () => {
    const deny = pack({ rules: [{ id: "no-write", boundaries: ["agent.write"], when: {}, outcome: "deny", reasonCode: "output.limit-exceeded" }] });
    const answer = make([{ layer: "mandatory", id: "p1", pack: deny }]).policy.at("agent.write", WRITE);
    expect(answer.decisions[0]!.decision).toMatchObject({ outcome: "deny", mode: "observe" });
    expect(answer.denied).toBeUndefined();
  });

  it("an evaluation that throws is policy.invalid, enforced only at a privileged boundary", () => {
    const bad = { layer: "mandatory" as const, id: "p1", pack: { ...pack(), version: 99 } as unknown as PolicyPack };
    const a = make([bad]);
    const answer = a.policy.at("agent.write", WRITE, STEP);
    expect(answer.decisions[0]!.decision).toMatchObject({ mode: "enforce", reasonCode: "policy.invalid" });
    expect(answer.denied?.reason).toBe(deniedReason("p1", "policy.invalid", "agent.write"));
    expect(answer.denied?.denial).toBeDefined();
    expect(a.lines[0]).toBe("! policy p1: could not be evaluated at agent.write — recorded as policy.invalid; the step is stopped");
    expect(a.incomplete).not.toHaveBeenCalled();
    const b = make([bad]);
    expect(b.policy.at("run.start").denied).toBeUndefined();
    expect(b.lines[0]).toBe("! policy p1: could not be evaluated at run.start — recorded as policy.invalid; the run goes on");
  });

  it("is denied without a decision when even the failure cannot be recorded", () => {
    const { policy, incomplete } = make([{ layer: "mandatory", id: "Bad Id", pack: { ...pack(), version: 99 } as unknown as PolicyPack }]);
    const answer = policy.at("agent.write", WRITE);
    expect(answer.decisions).toEqual([]);
    expect(answer.denied).toEqual({ reason: deniedReason("Bad Id", "policy.invalid", "agent.write") });
    expect(answer.denied).not.toHaveProperty("decision");
    expect(answer.denied).not.toHaveProperty("denial");
    expect(incomplete).toHaveBeenCalledTimes(1);
  });

  it("is denied when the input cannot be built", () => {
    const { policy } = make([{ layer: "mandatory", id: BASELINE_POLICY_ID, pack: BASELINE_PACK }]);
    const facts = { credential: "machine" } as Facts;
    Object.defineProperty(facts, "step", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const answer = policy.at("repository.access", facts);
    expect(answer.denied?.reason).toBe(deniedReason(BASELINE_POLICY_ID, "policy.invalid", "repository.access"));
  });

  it("repository() returns the answer", () => {
    const { policy } = make([problem("policy.unavailable")]);
    expect(policy.repository(STEP, { credential: "repository" }).denied).toBeDefined();
  });

  it("logs a load problem of a mandatory pack differently", () => {
    const lines: string[] = [];
    const summary = { runId: "r", vars: {}, flow: "f", flowDef: undefined, owner: undefined } as never;
    const mandatory = runPolicy(summary, ConfigSchema.parse({ policy: { mandatory: ["org"] } }), (l) => lines.push(l), undefined, home);
    expect(lines).toEqual(["! policy org: no file policies/org.json — recorded as policy.unavailable; this mandatory policy denies steps with a sign-in and writing agents"]);
    expect(mandatory.mandatoryUnusable).toBe(true);
    lines.length = 0;
    const optional = runPolicy(summary, ConfigSchema.parse({ policy: { packs: ["org"] } }), (l) => lines.push(l), undefined, home);
    expect(lines).toEqual(["! policy org: no file policies/org.json — recorded as policy.unavailable; the run goes on"]);
    expect(optional.mandatoryUnusable).toBe(false);
  });

  it("keeps the text of the engine reasons", () => {
    expect(ENGINE_REASONS["policy.unavailable"]).toBe("The pack could not be loaded, so the action is denied.");
    expect(ENGINE_REASONS["policy.invalid"]).toBe("The pack could not be read, so the action is denied.");
    expect(ENGINE_REASONS["policy.break-glass"]).toBe("A mandatory pack could not be used, but an admin's break-glass is active, so the action goes on with a warning.");
  });
});

describe("the policy.decided evidence event", () => {
  const decision = (boundary: string) => ({ version: 1, policy: { id: "p", version: "1" }, packSha256: H, mode: "observe", boundary, inputSha256: H, outcome: "allow", reasonCode: "policy.no-rule-matched", evaluatedAt: T });
  const event = (boundary: string, step?: unknown) => ({ version: 2, id: "e1", seq: 0, runId: "run-1", time: T, type: "policy.decided", decision: decision(boundary), ...(step ? { step } : {}) });
  const step = { id: "a", visit: 1, type: "shell" };

  it("has a step exactly for the boundaries about a step", () => {
    for (const b of ["step.before", "step.after", "agent.write", "push", "approval.consume"]) {
      expect(() => parseEvidenceEvent(event(b, step)), b).not.toThrow();
      expect(() => parseEvidenceEvent(event(b)), b).toThrow();
    }
    // access to the repository is also asked for the run's workspace, before any step
    expect(() => parseEvidenceEvent(event("repository.access", step))).not.toThrow();
    expect(() => parseEvidenceEvent(event("repository.access"))).not.toThrow();
    for (const b of ["run.start", "run.complete"]) {
      expect(() => parseEvidenceEvent(event(b)), b).not.toThrow();
      expect(() => parseEvidenceEvent(event(b, step)), b).toThrow();
    }
  });
});
