import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { breakGlassFile, type BreakGlass } from "../src/engine/policy-break-glass.js";
import { deniedReason, RunPolicy, runPolicy, type LoadedPack } from "../src/engine/policy-hooks.js";
import { EvidenceStream } from "../src/evidence/stream.js";
import { RunRecorder } from "../src/evidence/record.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../src/policy/baseline.js";
import { parsePolicyDecision } from "../src/policy/parse.js";
import type { Boundary, Facts, PolicyPack } from "../src/policy/schema.js";
import type { RunSummary } from "../src/engine/state.js";

const T = "2026-01-31T12:00:00.000Z";
const STEP = { id: "build", visit: 1, type: "shell" } as const;
const EXP = "2026-01-31T13:00:00.000Z";
const REC: BreakGlass = { version: 1, reason: "outage", startedAt: "2026-01-31T11:30:00.000Z", expiresAt: EXP, actor: { kind: "cli", osUser: "admin" } };
const WRITE: Facts = { step: "build", isolated: false, sandboxed: false };
const ASKS: Array<[Boundary, Facts]> = [
  ["agent.write", WRITE],
  ["repository.access", { credential: "machine" }],
  ["repository.access", { credential: "repository" }],
  ["approval.consume", { step: "build" }],
];
type Layer = "mandatory" | "repository" | "optional";
type Entry = { layer: Layer } & LoadedPack;
const problem = (code: "policy.unavailable" | "policy.invalid", layer: Layer = "mandatory"): Entry => ({ layer, id: "org", problem: code, detail: "x" });
const base: Entry = { layer: "mandatory", id: BASELINE_POLICY_ID, pack: BASELINE_PACK };

type Reader = (() => BreakGlass | undefined) | undefined;
const make = (packs: Entry[], breakGlass?: Reader, recorded: boolean | "throws" | "none" = true) => {
  const lines: string[] = [];
  const policyDecided = vi.fn(() => {
    if (recorded === "throws") throw new Error("disk");
    return recorded === true;
  });
  const incomplete = vi.fn();
  const evidence = recorded === "none" ? undefined : ({ policyDecided, incomplete } as unknown as RunRecorder);
  const policy = new RunPolicy({ runId: "run-1", packs, base: { flow: "f" }, log: (l) => lines.push(l), evidence, now: () => T, ...(breakGlass ? { breakGlass } : {}) });
  return { policy, lines, policyDecided, incomplete };
};
const active = () => REC;

describe("break-glass in RunPolicy", () => {
  const cases = (["policy.unavailable", "policy.invalid"] as const).flatMap((code) => ASKS.map(([b, f]) => [code, b, f] as const));

  it.each(cases)("lets the step go on, recorded: %s %s %j", (code, boundary, facts) => {
    const denyRun = make([problem(code)]).policy.at(boundary, facts, STEP);
    const { policy, lines, policyDecided, incomplete } = make([problem(code)], active);
    const answer = policy.at(boundary, facts, STEP);
    expect(answer.denied).toBeUndefined();
    const d = answer.decisions[0]!.decision;
    expect(d).toMatchObject({ mode: "enforce", outcome: "warn", reasonCode: "policy.break-glass", policy: { id: "org", version: "unknown" } });
    expect(d).not.toHaveProperty("packSha256");
    expect(d).not.toHaveProperty("rule");
    expect(parsePolicyDecision(d)).toEqual(d);
    expect(policyDecided).toHaveBeenCalledWith(d, STEP);
    expect(d.inputSha256).toBe(denyRun.decisions[0]!.decision.inputSha256);
    expect(lines).toContain(`! policy: break-glass active until ${EXP} (outage) — org ${code} allowed`);
    expect(lines.some((l) => l.endsWith("— break-glass: the step goes on"))).toBe(true);
    expect(incomplete).not.toHaveBeenCalled();
  });

  it("lets the step go on when an evaluation threw (catch path)", () => {
    const bad: Entry = { layer: "mandatory", id: "p1", pack: { version: 99 } as unknown as PolicyPack };
    const { policy, lines } = make([bad], active);
    const answer = policy.at("agent.write", WRITE, STEP);
    expect(answer.denied).toBeUndefined();
    expect(answer.decisions[0]!.decision).toMatchObject({ outcome: "warn", reasonCode: "policy.break-glass" });
    expect(lines).toContain("! policy p1: could not be evaluated at agent.write — recorded as policy.break-glass; break-glass: the step goes on");
  });

  const readers: Array<[string, Reader]> = [
    ["no reader", undefined],
    ["a reader with no record", () => undefined],
    [
      "a reader that throws",
      () => {
        throw new Error("x");
      },
    ],
  ];
  it.each(readers)("denies with %s", (_what, reader) => {
    const a = make([problem("policy.unavailable")], reader).policy.at("agent.write", WRITE, STEP);
    expect(a.denied?.reason).toBe(deniedReason("org", "policy.unavailable", "agent.write"));
    expect(a.decisions[0]!.decision).toMatchObject({ outcome: "deny", reasonCode: "policy.unavailable" });
    const bad: Entry = { layer: "mandatory", id: "p1", pack: { version: 99 } as unknown as PolicyPack };
    const b = make([bad], reader).policy.at("agent.write", WRITE, STEP);
    expect(b.denied?.reason).toBe(deniedReason("p1", "policy.invalid", "agent.write"));
    expect(b.decisions[0]!.decision).toMatchObject({ outcome: "deny", reasonCode: "policy.invalid" });
  });

  it.each([["false", false], ["throws", "throws"], ["no recorder", "none"]] as const)("denies when the decision is not recorded: %s", (_what, recorded) => {
    const reader = vi.fn(active);
    const { policy, lines } = make([problem("policy.unavailable")], reader, recorded);
    const a = policy.at("agent.write", WRITE, STEP);
    expect(a.denied?.reason).toBe(deniedReason("org", "policy.unavailable", "agent.write"));
    if (recorded === "none") {
      expect(reader).not.toHaveBeenCalled();
      expect(a.decisions[0]!.decision).toMatchObject({ outcome: "deny" });
      return;
    }
    expect(a.denied?.decision).toMatchObject({ outcome: "deny", reasonCode: "policy.unavailable" });
    expect(lines).toContain("! policy org: the break-glass decision could not be recorded — agent.write is denied");
    expect(lines.some((l) => l.includes("break-glass active"))).toBe(false);
  });

  it("denies with a real recorder whose stream has stopped, and allows with a working one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-rec-"));
    try {
      const decision = make([problem("policy.unavailable"), base], active).policy.at("agent.write", WRITE, STEP).decisions[0]!.decision;
      const rec = new RunRecorder(new EvidenceStream(dir, "run-1"), dir);
      expect(rec.policyDecided(decision, STEP)).toBe(true);
      rec.incomplete(new Error("stop"));
      expect(rec.policyDecided(decision, STEP)).toBe(false);
      const policy = new RunPolicy({ runId: "run-1", packs: [problem("policy.unavailable")], base: {}, log: () => {}, evidence: rec, now: () => T, breakGlass: active });
      expect(policy.at("agent.write", WRITE, STEP).denied?.reason).toBe(deniedReason("org", "policy.unavailable", "agent.write"));

      const dir2 = mkdtempSync(join(tmpdir(), "bg-rec-"));
      try {
        mkdirSync(join(dir2, "evidence.jsonl"));
        expect(new RunRecorder(new EvidenceStream(dir2, "run-2"), dir2).policyDecided(decision, STEP)).toBe(false);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never calls the reader for other layers, rule decisions or non-privileged boundaries", () => {
    const reader = vi.fn(active);
    const rulePack = (outcome: "allow" | "deny"): PolicyPack => ({
      version: 1,
      policy: { id: "org", version: "1" },
      mode: "observe",
      defaultOutcome: outcome,
      rules: [],
    });
    for (const layer of ["repository", "optional"] as const) {
      const a = make([problem("policy.invalid", layer)], reader).policy.at("agent.write", WRITE, STEP);
      expect(a.denied).toBeUndefined();
      expect(a.decisions[0]!.decision).toMatchObject({ mode: "observe", outcome: "deny", reasonCode: "policy.invalid" });
    }
    for (const outcome of ["allow", "deny"] as const) {
      const a = make([{ layer: "mandatory", id: "org", pack: rulePack(outcome) }], reader).policy.at("agent.write", WRITE, STEP);
      expect(a.denied).toBeUndefined();
      expect(a.decisions[0]!.decision).toMatchObject({ mode: "observe", outcome, reasonCode: "policy.no-rule-matched" });
    }
    for (const [b, f] of [["run.start", {}], ["push", { step: "build" }], ["repository.access", { credential: "none" }]] as Array<[Boundary, Facts]>) {
      const a = make([problem("policy.unavailable")], reader).policy.at(b, f, STEP);
      expect(a.denied).toBeUndefined();
      expect(a.decisions[0]!.decision).toMatchObject({ mode: "observe", reasonCode: "policy.unavailable" });
    }
    make([base], reader).policy.at("agent.write", WRITE, STEP);
    expect(reader).not.toHaveBeenCalled();
  });

  it("stays denied without a decision, and does not call the reader", () => {
    const reader = vi.fn(active);
    const odd = make([{ layer: "mandatory", id: "Bad Id", problem: "policy.invalid", detail: "x" }], reader).policy.at("agent.write", WRITE, STEP);
    expect(odd.denied).toBeDefined();
    expect(odd.decisions).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });

  it("records the decision when the input cannot be built: a warn under break-glass, a denial without the record", () => {
    const odd = { get step() { throw new Error("no"); } } as unknown as Facts;
    const reader = vi.fn(active);
    const glass = make([problem("policy.unavailable")], reader);
    const a = glass.policy.at("agent.write", odd, STEP);
    expect(a.denied).toBeUndefined();
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "warn", reasonCode: "policy.break-glass" });
    expect(reader).toHaveBeenCalled();
    expect(glass.policyDecided.mock.invocationCallOrder[0]!).toBeLessThan(glass.incomplete.mock.invocationCallOrder[0]!);
    const unrecorded = make([problem("policy.unavailable")], active, false).policy.at("agent.write", odd, STEP);
    expect(unrecorded.denied?.reason).toBe(deniedReason("org", "policy.invalid", "agent.write"));
    expect(unrecorded.decisions[0]!.decision).toMatchObject({ mode: "enforce", outcome: "warn", reasonCode: "policy.break-glass" });
  });
});

describe("runPolicy reads the break-glass file", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bg-run-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const summary = { runId: "run-1", flow: "f", vars: {} } as unknown as RunSummary;
  const recorder = { policyDecided: () => true, incomplete: () => {} } as unknown as RunRecorder;

  it("allows with a valid record and denies with an invalid file", () => {
    const now = Date.now();
    writeFileSync(breakGlassFile(home), JSON.stringify({ ...REC, startedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() }));
    const policy = runPolicy(summary, { policy: { mandatory: ["org"] } } as never, () => {}, recorder, home);
    expect(policy.at("agent.write", WRITE, STEP).denied).toBeUndefined();
    writeFileSync(breakGlassFile(home), "{ nope");
    const again = runPolicy(summary, { policy: { mandatory: ["org"] } } as never, () => {}, recorder, home);
    expect(again.at("agent.write", WRITE, STEP).denied?.reason).toBe(deniedReason("org", "policy.unavailable", "agent.write"));
  });
});
