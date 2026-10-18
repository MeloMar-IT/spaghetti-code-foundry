import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { baseFacts, drainPushLog, loadPolicyPacks, MAX_PACK_BYTES, MAX_PUSHES_PER_STEP, policyFacts, RunPolicy, runPolicy, type LoadedPack } from "../src/engine/policy-hooks.js";
import { parseEvidenceEvent } from "../src/evidence/parse.js";
import type { RunRecorder } from "../src/evidence/record.js";
import { parsePolicyDecision } from "../src/policy/parse.js";
import type { PolicyPack } from "../src/policy/schema.js";
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
    const policy = new RunPolicy({ runId: "run-1", packs, base: { flow: "f" }, log: (l) => lines.push(l), evidence, now: () => T });
    return { policy, lines, policyDecided, incomplete };
  };

  it("returns one decision per pack in order, logs one line each and records them with the step", () => {
    const second = pack({ policy: { id: "p2", version: "7" } });
    const { policy, lines, policyDecided } = make([{ id: "p1", pack: pack() }, { id: "p2", pack: second }]);
    const out = policy.at("step.before", { step: "build" }, STEP);
    expect(out.map((d) => [d.policy.id, d.outcome, d.rule])).toEqual([["p1", "warn", "any-step"], ["p2", "warn", "any-step"]]);
    expect(lines).toEqual([
      "· policy p1 1 · step.before outer/build: warn (output.limit-exceeded, rule any-step) — observe only, nothing was stopped",
      "· policy p2 7 · step.before outer/build: warn (output.limit-exceeded, rule any-step) — observe only, nothing was stopped",
    ]);
    expect(policyDecided).toHaveBeenCalledTimes(2);
    expect(policyDecided).toHaveBeenCalledWith(out[0], STEP);
  });

  it("records an unavailable pack as an observe-mode deny without a pack hash", () => {
    const { policy } = make([{ id: "gone", problem: "policy.unavailable", detail: "no file" }, { id: "wrong", problem: "policy.invalid", detail: "x" }]);
    const [a, b] = policy.at("run.start");
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
    const out = policy.at("run.start");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reasonCode: "policy.invalid", outcome: "deny", mode: "observe" });
    expect(lines[0]).toBe("! policy p1: could not be evaluated at run.start — recorded as policy.invalid; the run goes on");
    expect(policyDecided).toHaveBeenCalledTimes(1);
    expect(incomplete).not.toHaveBeenCalled();
  });

  it("marks the evidence incomplete when even that cannot be recorded", () => {
    const broken = { id: "Bad Id", pack: { ...pack(), version: 99 } } as unknown as LoadedPack;
    const { policy, lines, incomplete, policyDecided } = make([broken]);
    expect(policy.at("run.start")).toEqual([]);
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
    const policy = new RunPolicy({ runId: "run-1", packs: [{ id: "p1", pack: pack({ rules: [rule] }) }], base: { repository: "acme/widgets" }, log: (l) => lines.push(l), now: () => T });
    expect(policy.at("run.start")[0]).toMatchObject({ outcome: "deny", reasonCode: "repository.not-allowed" });
    expect(policy.at("run.start", { repository: undefined })[0]).toMatchObject({ reasonCode: "policy.input-incomplete" });
  });

  it("works with a pack that holds a rule for every boundary", () => {
    const { policy } = make([{ id: "cover", pack: coverPack() }]);
    expect(policy.at("run.complete", { runCostUsd: 0 })[0]).toMatchObject({ rule: "run-complete-ok" });
    expect(policy.at("run.complete")[0]).toMatchObject({ reasonCode: "policy.input-incomplete", rule: "run-complete-check" });
  });
});

describe("runPolicy and the config", () => {
  it("reads nothing and gives nothing for no packs", () => {
    const lines: string[] = [];
    expect(runPolicy({ runId: "r", vars: {}, flow: "f" } as never, ConfigSchema.parse({}), (l) => lines.push(l), undefined, join(home, "never-read"))).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("logs one line for a pack that cannot be loaded", () => {
    const lines: string[] = [];
    const policy = runPolicy({ runId: "r", vars: {}, flow: "f" } as never, ConfigSchema.parse({ policy: { packs: ["missing"] } }), (l) => lines.push(l), undefined, home);
    expect(policy).toBeInstanceOf(RunPolicy);
    expect(lines).toEqual(["! policy missing: no file policies/missing.json — recorded as policy.unavailable; the run goes on"]);
  });

  it("defaults to no packs and refuses odd lists", () => {
    expect(ConfigSchema.parse({}).policy).toEqual({ packs: [] });
    for (const packs of [["a", "a"], ["../x"], ["Upper"], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
      expect(ConfigSchema.safeParse({ policy: { packs } }).success, JSON.stringify(packs)).toBe(false);
    }
    expect(ConfigSchema.safeParse({ policy: { packs: ["a", "b.c"] } }).success).toBe(true);
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
