import { describe, expect, it } from "vitest";
import {
  evaluationGate, evaluationKey, evaluationOutcome, evaluationRecordDigest, evaluationRecordText, parseEvaluationRecord,
  type EvaluationGateResult, type EvaluationPolicy, type EvaluationRecord, type EvaluationSubject,
} from "../src/skills/evaluation.js";
import { EVALUATION_DIGEST_HEADER, EVALUATION_DIMENSIONS, EVALUATION_REASON_CODES, type EvaluationDimension } from "../src/skills/evaluation-rules.js";
import type { DecidedReport } from "../src/skills/scan-exceptions.js";
import type { ScanSeverity } from "../src/skills/scan.js";

const DIGEST = "sha256:" + "a".repeat(64);
const OTHER = "sha256:" + "c".repeat(64);
const SUITE = "sha256:" + "b".repeat(64);
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const OFFLINE: EvaluationDimension[] = ["selection", "conflicts", "context", "tools"];
const seen = new Set<string>();

const rec = (o: Record<string, unknown> = {}, dims: Record<string, number[] | undefined> = {}): EvaluationRecord => {
  const base = {
    schema: 1,
    candidate: { id: "alpha", version: "1.0.0", digest: DIGEST, fingerprint: "fp-alpha", source: "github", repositoryKey: "github.com/acme/skills", commit: "1".repeat(40) },
    suite: { digest: SUITE, scenarios: [{ id: "s-two", inputs: { prompt: "write a test" } }, { id: "s-one", inputs: { prompt: "fix a bug", mode: "x" } }] },
    runtime: { foundry: "0.1.0" },
    evaluatedAt: "2026-10-13T10:00:00Z",
    dimensions: { selection: [1], conflicts: [1], context: [1], tools: [1], ...dims },
    findings: [{ code: "note-a", dimension: "selection", scenario: "s-one", detail: "fine" }],
    evidence: [{ name: "log", digest: DIGEST }],
    ...o,
  };
  for (const k of Object.keys(base.dimensions)) if ((base.dimensions as Record<string, unknown>)[k] === undefined) delete (base.dimensions as Record<string, unknown>)[k];
  return base as unknown as EvaluationRecord;
};
/** A record with a model, as `instructions` needs. */
const withModel = (dims: Record<string, number[] | undefined>, o: Record<string, unknown> = {}) =>
  rec({ runtime: { foundry: "0.1.0", agent: "claude", model: "m-1" }, ...o }, dims);

const finding = (id: string, severity: ScanSeverity) => ({ id, rule: "r", category: "unsafe-network", severity, path: "SKILL.md", evidence: "e" });
const decided = (skill = "alpha", digest = DIGEST, ...fs: ReturnType<typeof finding>[]): DecidedReport =>
  ({ schema: 1, skill, digest, report: SUITE, findings: fs.map((f) => ({ finding: f as never, disposition: "open" as const })) });
const subject = (o: Partial<EvaluationSubject> = {}, r: unknown = rec()): EvaluationSubject => ({ record: r, digest: DIGEST, safety: decided(), licence: "allowed", ...o });
const pol = (o: Partial<EvaluationPolicy> = {}): EvaluationPolicy => ({ suite: SUITE, ...o });
const gate = (s: EvaluationSubject, p = pol()) => track(evaluationGate({ mode: "new", policy: p, candidate: s }));
const track = (r: EvaluationGateResult): EvaluationGateResult => {
  for (const v of r.verdicts) for (const x of v.reasons) seen.add(x.code);
  return r;
};
const codes = (r: EvaluationGateResult, i = 0) => r.verdicts[i]!.reasons.map((x) => x.code);
const upgrade = (cand: unknown, base: unknown | undefined, p = pol(), baseDigest = OTHER) =>
  track(evaluationGate({ mode: "upgrade", policy: p, candidate: subject({}, cand), ...(base === undefined ? {} : { baseline: { record: base, digest: baseDigest } }) }));
const baseRec = (dims: Record<string, number[] | undefined> = {}, o: Record<string, unknown> = {}) =>
  rec({ candidate: { ...rec().candidate, version: "0.9.0", digest: OTHER }, ...o }, dims);
const dup = (a: EvaluationSubject, b: EvaluationSubject, p = pol()) => track(evaluationGate({ mode: "duplicate", policy: p, candidates: [a, b] }));
const beta = (dims: Record<string, number[] | undefined> = {}, o: Record<string, unknown> = {}) => {
  const r = rec({ candidate: { ...rec().candidate, id: "beta", fingerprint: "fp-beta" }, ...o }, dims);
  return subject({ safety: decided("beta") }, r);
};

describe("evaluation record", () => {
  it("parses a valid record into a fresh copy", () => {
    const raw = rec();
    const r = parseEvaluationRecord(raw);
    expect("record" in r).toBe(true);
    if ("record" in r) {
      expect(r.record).not.toBe(raw);
      expect(r.record.suite.scenarios.map((s) => s.id)).toEqual(["s-one", "s-two"]);
      expect(r.digest).toBe(evaluationRecordDigest(r.record));
    }
  });
  const refuse: [string, (r: any) => void][] = [
    ["wrong schema", (r) => (r.schema = 2)],
    ["unknown key", (r) => (r.extra = 1)],
    ["bad id", (r) => (r.candidate.id = "Bad Id")],
    ["bad version", (r) => (r.candidate.version = "x")],
    ["bad digest", (r) => (r.candidate.digest = "sha256:zz")],
    ["bad commit", (r) => (r.candidate.commit = "abc")],
    ["score -0.1", (r) => (r.dimensions.selection = [-0.1])],
    ["score 1.1", (r) => (r.dimensions.selection = [1.1])],
    ["score NaN", (r) => (r.dimensions.selection = [NaN])],
    ["empty samples", (r) => (r.dimensions.selection = [])],
    ["unknown dimension", (r) => (r.dimensions.speed = [1])],
    ["duplicate scenario", (r) => r.suite.scenarios.push({ id: "s-one", inputs: {} })],
    ["finding for unknown scenario", (r) => (r.findings[0].scenario = "nope")],
    ["agent without model", (r) => (r.runtime.agent = "claude")],
    ["instructions without model", (r) => (r.dimensions.instructions = [1, 1, 1])],
    ["impossible date", (r) => (r.evaluatedAt = "2026-02-30T00:00:00Z")],
    ["too many scenarios", (r) => (r.suite.scenarios = Array.from({ length: 201 }, (_, i) => ({ id: `s-${i}`, inputs: {} })))],
    ["too deep", (r) => (r.deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } })],
  ];
  it.each(refuse)("refuses %s", (_n, mutate) => {
    const r = structuredClone(rec());
    mutate(r);
    const read = parseEvaluationRecord(r);
    expect("code" in read && read.code).toBe("record-invalid");
  });
  it("checks the repository key", () => {
    const key = (k: string) => parseEvaluationRecord(rec({ candidate: { ...rec().candidate, repositoryKey: k } }));
    expect("record" in key("git.example.com/~ann/skills")).toBe(true);
    expect("record" in key("h.example/" + "a".repeat(290))).toBe(true);
    expect("record" in key("h.example/" + "a".repeat(491))).toBe(false);
    expect("record" in key("a b")).toBe(false);
    expect("record" in key("a/b?x=1")).toBe(false);
  });
  it("has the same digest for another key and list order", () => {
    const a = rec();
    const b = rec();
    const shuffled = {
      evidence: [{ digest: DIGEST, name: "log" }],
      findings: [...b.findings].reverse(),
      dimensions: { tools: [1], context: [1], conflicts: [1], selection: [1] },
      suite: { scenarios: [...b.suite.scenarios].reverse(), digest: SUITE },
      ...b,
    };
    const da = evaluationRecordDigest(a);
    expect(da).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evaluationRecordDigest({ ...b, ...shuffled, schema: 1 } as EvaluationRecord)).toBe(da);
    const two = rec({ evidence: [{ name: "b", digest: DIGEST }, { name: "a", digest: OTHER }], findings: [{ code: "z-one" }, { code: "a-one" }] });
    const one = rec({ evidence: [{ name: "a", digest: OTHER }, { name: "b", digest: DIGEST }], findings: [{ code: "a-one" }, { code: "z-one" }] });
    expect(evaluationRecordDigest(two)).toBe(evaluationRecordDigest(one));
  });
  it("changes the digest with a sample, an input or the time", () => {
    const d = evaluationRecordDigest(rec());
    expect(evaluationRecordDigest(rec({}, { selection: [0.95] }))).not.toBe(d);
    expect(evaluationRecordDigest(rec({ evaluatedAt: "2026-10-13T10:00:01Z" }))).not.toBe(d);
    const r = rec();
    r.suite.scenarios[0]!.inputs.prompt = "other";
    expect(evaluationRecordDigest(r)).not.toBe(d);
  });
  it("starts the text with the header and keeps a newline in a value from forging a line", () => {
    expect(evaluationRecordText(rec()).startsWith(EVALUATION_DIGEST_HEADER)).toBe(true);
    const a = rec();
    a.suite.scenarios = [{ id: "s-one", inputs: { a: "x\ns-two" } }];
    const b = rec();
    b.suite.scenarios = [{ id: "s-one", inputs: { a: "x" } }, { id: "s-two", inputs: {} }];
    expect(evaluationRecordText(a)).not.toBe(evaluationRecordText(b));
  });
  it("refuses credential-like text without repeating it", () => {
    const inInput = rec();
    inInput.suite.scenarios[0]!.inputs.prompt = `use ${TOKEN}`;
    const inFinding = rec({ findings: [{ code: "note-a", detail: TOKEN }] });
    const extra = { ...rec(), note: TOKEN };
    for (const raw of [inInput, inFinding, extra]) {
      const r = parseEvaluationRecord(raw);
      expect("code" in r && r.code).toBe("record-credential");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    seen.add("record-credential");
  });
  it("scans a key together with its value", () => {
    const secret = "wJalrXUtnFEMI" + "/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const aws = rec();
    aws.suite.scenarios[0]!.inputs = { aws_secret_access_key: secret };
    const r = parseEvaluationRecord(aws);
    expect("code" in r && r.code).toBe("record-credential");
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("gate: mode new", () => {
  it("passes when everything is met", () => {
    const r = gate(subject());
    expect(r.verdicts[0]).toMatchObject({ outcome: "passed", reasons: [] });
    expect(evaluationOutcome(r)).toBe("passed");
  });
  it("checks the selection threshold at its boundary", () => {
    expect(gate(subject({}, rec({}, { selection: [0.9] }))).verdicts[0]!.outcome).toBe("passed");
    expect(gate(subject({}, rec({}, { selection: [0.9, 0.9, 0.9] }))).verdicts[0]!.outcome).toBe("passed");
    const f = gate(subject({}, rec({}, { selection: [0.89] })));
    expect(f.verdicts[0]!.reasons).toEqual([{ code: "below-threshold", dimension: "selection" }]);
    expect(evaluationOutcome(f)).toBe("failed");
  });
  it.each(["conflicts", "context", "tools"])("needs every %s sample to be exactly 1", (d) => {
    const run = (s: number[]) => gate(subject({}, rec({}, { [d]: s }))).verdicts[0]!.outcome;
    expect(run([1])).toBe("passed");
    expect(run([0.99])).toBe("failed");
    expect(run([0.9999999995])).toBe("failed");
    expect(run([...Array(999).fill(1), 0])).toBe("failed");
    expect(run([...Array(999).fill(1), 0.9999999995])).toBe("failed");
  });
  it("treats a threshold of 1 from the policy as exact", () => {
    const p = pol({ thresholds: { selection: 1 } });
    expect(gate(subject({}, rec({}, { selection: [1, 0.9999999995] })), p).verdicts[0]!.outcome).toBe("failed");
    expect(gate(subject({}, rec({}, { selection: [1, 1] })), p).verdicts[0]!.outcome).toBe("passed");
  });
  it("keeps instructions optional unless the policy says so", () => {
    expect(gate(subject()).verdicts[0]!.outcome).toBe("passed");
    const low = gate(subject({}, withModel({ instructions: [0.1, 0.1, 0.1] })));
    expect(low.verdicts[0]!.outcome).toBe("passed");
    expect(low.verdicts[0]!.dimensions.find((d) => d.dimension === "instructions")!.passed).toBe(false);
  });
  it("can make instructions mandatory", () => {
    const p = pol({ mandatory: ["instructions"] });
    expect(codes(gate(subject(), p))).toEqual(["dimension-missing"]);
    expect(codes(gate(subject({}, withModel({ instructions: [0.79, 0.79, 0.79] })), p))).toEqual(["below-threshold"]);
    expect(codes(gate(subject({}, withModel({ instructions: [1, 1] })), p))).toEqual(["too-few-samples"]);
    expect(gate(subject({}, withModel({ instructions: [0.8, 0.8, 0.8] })), p).verdicts[0]!.outcome).toBe("passed");
  });
  it("is tighten-only", () => {
    expect(codes(gate(subject({}, rec({}, { selection: [0.92] })), pol({ thresholds: { selection: 0.95 } })))).toEqual(["below-threshold"]);
    expect(codes(gate(subject({}, rec({}, { selection: [0.85] })), pol({ thresholds: { selection: 0.5 } })))).toEqual(["below-threshold"]);
    expect(codes(gate(subject({}, rec({}, { tools: undefined })), pol({ mandatory: [] })))).toEqual(["dimension-missing"]);
    expect(codes(gate(subject({}, withModel({ instructions: [1, 1, 1] })), pol({ mandatory: ["instructions"], minSamples: { instructions: 1 } })))).toEqual([]);
  });
  it.each([
    ["threshold of 2", pol({ thresholds: { selection: 2 } })],
    ["minSamples of 0", pol({ minSamples: { selection: 0 } })],
    ["unknown dimension", pol({ thresholds: { speed: 0.5 } as never })],
    ["bad suite", { suite: "x" }],
  ])("fails closed on a policy with %s", (_n, p) => {
    expect(codes(gate(subject(), p as EvaluationPolicy))).toEqual(["policy-invalid"]);
  });
  it.each(OFFLINE)("fails when %s is missing", (d) => {
    const r = gate(subject({}, rec({}, { [d]: undefined })));
    expect(r.verdicts[0]!.reasons).toEqual([{ code: "dimension-missing", dimension: d }]);
  });
  it("fails closed for another digest, another suite and a bad record", () => {
    expect(codes(gate(subject({ digest: OTHER })))).toContain("digest-mismatch");
    expect(codes(gate(subject({ digest: "nope" })))).toContain("digest-mismatch");
    expect(codes(gate(subject(), pol({ suite: OTHER })))).toEqual(["suite-mismatch"]);
    expect(codes(gate(subject({}, { nonsense: true })))).toEqual(["record-invalid"]);
    expect(codes(gate(subject({}, { ...rec(), note: TOKEN })))).toEqual(["record-credential"]);
  });
  it("reads the safety decision", () => {
    const id = "0123456789abcdef";
    const open = gate(subject({ safety: decided("alpha", DIGEST, finding(id, "high")) }));
    expect(open.verdicts[0]!.reasons).toEqual([{ code: "safety-blocked", finding: id }]);
    const accepted: DecidedReport = { ...decided("alpha", DIGEST, finding(id, "high")) };
    accepted.findings[0]!.disposition = "accepted";
    expect(gate(subject({ safety: accepted })).verdicts[0]!.outcome).toBe("passed");
    expect(gate(subject({ safety: decided("alpha", DIGEST, finding(id, "medium")) })).verdicts[0]!.outcome).toBe("passed");
    expect(codes(gate(subject({ safety: decided("alpha", OTHER) })))).toEqual(["safety-mismatch"]);
    expect(codes(gate(subject({ safety: decided("other") })))).toEqual(["safety-mismatch"]);
    expect(codes(gate(subject({ safety: undefined as never })))).toEqual(["safety-mismatch"]);
  });
  it.each(["review", "rejected", "missing", "ambiguous"] as const)("refuses licence %s", (licence) => {
    expect(gate(subject({ licence })).verdicts[0]!.reasons).toEqual([{ code: "licence-not-allowed", licence }]);
  });
  it("lists several reasons in code order", () => {
    const r = gate(subject({ licence: "review", safety: decided("alpha", DIGEST, finding("0123456789abcdef", "high")) }, rec({}, { selection: [0.1], tools: undefined })), pol({ suite: OTHER }));
    expect(codes(r)).toEqual(["suite-mismatch", "safety-blocked", "licence-not-allowed", "dimension-missing", "below-threshold"]);
  });
  it("throws on an unknown mode", () => {
    expect(() => evaluationGate({ mode: "x", policy: pol(), candidate: subject() } as never)).toThrow(TypeError);
  });
});

describe("gate: mode upgrade", () => {
  it("fails without a baseline", () => expect(codes(upgrade(rec(), undefined))).toEqual(["baseline-missing"]));
  it("fails on a garbage baseline", () => expect(codes(upgrade(rec(), { x: 1 }))).toEqual(["baseline-invalid"]));
  it("fails on another id, digest or suite", () => {
    expect(codes(upgrade(rec(), baseRec({}, { candidate: { ...rec().candidate, id: "zeta", digest: OTHER } })))).toEqual(["baseline-mismatch"]);
    expect(codes(upgrade(rec(), baseRec(), pol(), DIGEST))).toEqual(["baseline-mismatch"]);
    expect(codes(upgrade(rec(), baseRec({}, { suite: { ...rec().suite, digest: OTHER } })))).toEqual(["baseline-mismatch"]);
  });
  describe("a baseline of another id (upgrade by capability)", () => {
    const by = (cand: unknown, base: unknown, id?: unknown) =>
      track(evaluationGate({ mode: "upgrade", policy: pol(), candidate: subject({}, cand), baseline: { record: base, digest: OTHER, ...(id !== undefined ? { id: id as string } : {}) } }));
    const zeta = (dims: Record<string, number[] | undefined> = {}, id = "zeta") => baseRec(dims, { candidate: { ...rec().candidate, id, digest: OTHER } });
    it("passes when baseline.id names the record's skill and the scores are not worse", () => {
      expect(by(rec(), zeta(), "zeta").verdicts[0]!.reasons).toEqual([]);
    });
    it("still finds a regression, the digest and the suite", () => {
      expect(by(rec({}, { selection: [0.89] }), zeta({ selection: [1] }), "zeta").verdicts[0]!.reasons.map((r) => r.code)).toContain("regression");
      expect(codes(by(rec(), baseRec({}, { candidate: { ...rec().candidate, id: "zeta", digest: DIGEST } }), "zeta"))).toEqual(["baseline-mismatch"]);
      expect(codes(by(rec(), zeta({}), "zeta"), 0)).toEqual([]);
    });
    it("a record of a third id is a mismatch", () => expect(codes(by(rec(), zeta({}, "third"), "zeta"))).toEqual(["baseline-mismatch"]));
    it("without baseline.id another id is still a mismatch", () => expect(codes(by(rec(), zeta()))).toEqual(["baseline-mismatch"]));
    it("a baseline.id that is not a string is invalid", () => expect(codes(by(rec(), zeta(), 7))).toEqual(["baseline-invalid"]));
  });
  it("fails an empty baseline although the candidate is good", () => {
    const r = upgrade(rec(), baseRec({ selection: undefined, conflicts: undefined, context: undefined, tools: undefined }));
    expect(r.verdicts[0]!.reasons.map((x) => x.code)).toEqual(["baseline-invalid", "baseline-invalid", "baseline-invalid", "baseline-invalid"]);
  });
  it.each(OFFLINE)("fails a baseline without %s", (d) => {
    expect(upgrade(rec(), baseRec({ [d]: undefined })).verdicts[0]!.reasons).toEqual([{ code: "baseline-invalid", dimension: d }]);
  });
  it("needs instructions in the baseline when mandatory", () => {
    const p = pol({ mandatory: ["instructions"] });
    const r = upgrade(withModel({ instructions: [1, 1, 1] }), baseRec(), p);
    expect(r.verdicts[0]!.reasons).toEqual([{ code: "baseline-invalid", dimension: "instructions" }]);
  });
  it("passes equal and better scores", () => {
    expect(upgrade(rec(), baseRec()).verdicts[0]!.outcome).toBe("passed");
    expect(upgrade(rec({}, { selection: [1] }), baseRec({ selection: [0.92] })).verdicts[0]!.outcome).toBe("passed");
  });
  it("does not call noise a regression", () => {
    const r = upgrade(withModel({ instructions: [0.8, 0.85, 0.9] }), withModel({ instructions: [0.9, 0.8, 1.0] }, { candidate: { ...rec().candidate, digest: OTHER } }));
    expect(r.verdicts[0]!.outcome).toBe("passed");
  });
  it("calls a real drop a regression", () => {
    const r = upgrade(withModel({ instructions: [0.8, 0.8, 0.85] }), withModel({ instructions: [1, 1, 1] }, { candidate: { ...rec().candidate, digest: OTHER } }));
    expect(r.verdicts[0]!.reasons).toEqual([{ code: "regression", dimension: "instructions" }]);
    expect(r.verdicts[0]!.dimensions.find((d) => d.dimension === "instructions")).toMatchObject({ baseline: 1, allowed: 0.1 });
  });
  it("allows a drop of exactly the margin and more with a wide spread", () => {
    expect(upgrade(rec({}, { selection: [0.9] }), baseRec({ selection: [1] })).verdicts[0]!.outcome).toBe("passed");
    expect(codes(upgrade(rec({}, { selection: [0.89] }), baseRec({ selection: [1] })))).toEqual(["below-threshold", "regression"]);
    const wide = upgrade(withModel({ instructions: [0.8, 0.8, 0.8] }), withModel({ instructions: [1, 0.7, 1] }, { candidate: { ...rec().candidate, digest: OTHER } }));
    expect(wide.verdicts[0]!.outcome).toBe("passed");
  });
  it("fails when the candidate lacks a dimension the baseline holds", () => {
    const base = withModel({ instructions: [1, 1, 1] }, { candidate: { ...rec().candidate, digest: OTHER } });
    expect(upgrade(rec(), base).verdicts[0]!.reasons).toEqual([{ code: "dimension-missing", dimension: "instructions" }]);
  });
  it("fails on too few samples in the baseline", () => {
    const base = withModel({ instructions: [1, 1] }, { candidate: { ...rec().candidate, digest: OTHER } });
    expect(upgrade(withModel({ instructions: [1, 1, 1] }), base).verdicts[0]!.reasons).toEqual([{ code: "too-few-samples", dimension: "instructions" }]);
  });
});

describe("gate: mode duplicate", () => {
  const A = (dims: Record<string, number[] | undefined> = {}) => subject({}, rec({}, dims));
  const keyA = evaluationKey({ id: "alpha", version: "1.0.0", digest: DIGEST });
  const keyB = evaluationKey({ id: "beta", version: "1.0.0", digest: DIGEST });
  it("names a clear winner and fails the loser", () => {
    const model = { runtime: { foundry: "0.1.0", agent: "claude", model: "m-1" } };
    const r = dup(subject({}, withModel({ instructions: [1, 1, 1] })), beta({ instructions: [0.8, 0.8, 0.8] }, model));
    expect(r.comparison).toMatchObject({ better: keyA, basis: "scores" });
    expect(r.comparison!.dimensions).toEqual([{ dimension: "instructions", favours: keyA, difference: expect.closeTo(0.2), allowed: 0.1 }]);
    expect(r.verdicts.find((v) => v.candidate.id === "beta")!.reasons).toEqual([{ code: "worse-duplicate" }]);
    expect(evaluationOutcome(r, { id: "alpha", version: "1.0.0", digest: DIGEST })).toBe("passed");
    expect(evaluationOutcome(r, { id: "beta", version: "1.0.0", digest: DIGEST })).toBe("failed");
    expect(evaluationOutcome(r, { id: "zeta", version: "1.0.0", digest: DIGEST })).toBe("failed");
    expect(evaluationOutcome(r)).toBe("failed");
  });
  it("says no clear difference for a small gap", () => {
    const r = dup(A({ selection: [0.95] }), beta({ selection: [0.92] }));
    expect(r.comparison).toMatchObject({ better: "none", basis: "none" });
    expect(r.verdicts.map((v) => v.outcome)).toEqual(["passed", "passed"]);
  });
  it("says none when the gap is inside the spread", () => {
    const model = { runtime: { foundry: "0.1.0", agent: "claude", model: "m-1" } };
    const r = dup(subject({}, withModel({ instructions: [1, 0.7, 1] })), beta({ instructions: [0.8, 0.8, 0.8] }, model));
    expect(r.comparison!.better).toBe("none");
    expect(r.verdicts.map((v) => v.outcome)).toEqual(["passed", "passed"]);
  });
  it("names the one that passes its thresholds", () => {
    const r = dup(A({ selection: [0.5] }), beta());
    expect(r.comparison).toMatchObject({ better: keyB, basis: "thresholds" });
    expect(r.verdicts.flatMap((v) => v.reasons.map((x) => x.code))).toEqual(["below-threshold"]);
  });
  it("says none when both fail", () => {
    const r = dup(A({ selection: [0.5] }), beta({ selection: [0.4] }));
    expect(r.comparison!.better).toBe("none");
    expect(r.verdicts.map((v) => v.outcome)).toEqual(["failed", "failed"]);
  });
  it("names the passing candidate when the other record is unreadable, in both orders", () => {
    const good = A();
    const bad = subject({}, { nonsense: true });
    for (const r of [dup(good, bad), dup(bad, good)]) {
      expect(r.comparison).toMatchObject({ better: keyA, basis: "thresholds" });
      expect(r.verdicts.map((v) => v.outcome).sort()).toEqual(["failed", "passed"]);
    }
    expect(dup(good, bad)).toEqual(dup(bad, good));
  });
  it("fails the same candidate twice, in any order", () => {
    const a = A();
    const b = subject({ licence: "review" }, rec({}, { selection: [0.1] }));
    const r = dup(a, b);
    expect(r.verdicts.every((v) => v.reasons.some((x) => x.code === "same-candidate"))).toBe(true);
    expect(dup(b, a)).toEqual(r);
    expect(dup(a, A())).toEqual(dup(A(), a));
  });
  it("is order independent for two invalid records", () => {
    const a = subject({}, { x: 1 });
    const b = subject({}, { ...rec(), note: TOKEN });
    expect(dup(a, b)).toEqual(dup(b, a));
  });
  it("fails a side with too few instructions samples", () => {
    const a = subject({}, withModel({ instructions: [1, 1, 1] }));
    const b = beta({ instructions: [1, 1] }, { runtime: { foundry: "0.1.0", agent: "claude", model: "m-1" } });
    const r = dup(a, b);
    expect(r.verdicts.find((v) => v.candidate.id === "beta")!.reasons).toEqual([{ code: "too-few-samples", dimension: "instructions" }]);
    expect(r.verdicts.find((v) => v.candidate.id === "alpha")!.outcome).toBe("passed");
  });
  it("gives the same result when swapped", () => {
    const a = A({ selection: [1] });
    const b = beta({ selection: [0.9] });
    expect(dup(a, b)).toEqual(dup(b, a));
  });
  it("needs two candidates", () => {
    expect(() => evaluationGate({ mode: "duplicate", policy: pol(), candidates: [subject()] } as never)).toThrow(TypeError);
  });
});

describe("order and immutability", () => {
  const deepFreeze = <T>(v: T): T => {
    if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
    return Object.freeze(v);
  };
  it("gives the same result for shuffled lists", () => {
    const id = (n: string) => finding(n.repeat(16), "high");
    const base = rec({ findings: [{ code: "a-one" }, { code: "b-one" }] }, { selection: [0.9, 1, 0.95] });
    const flipped = rec({ findings: [{ code: "b-one" }, { code: "a-one" }], suite: { digest: SUITE, scenarios: [...base.suite.scenarios].reverse() } }, { selection: [0.95, 0.9, 1] });
    const s1 = subject({ safety: decided("alpha", DIGEST, id("a"), id("b")) }, base);
    const s2 = subject({ safety: decided("alpha", DIGEST, id("b"), id("a")) }, flipped);
    expect(gate(s1, pol({ mandatory: ["instructions", "selection"] }))).toEqual(gate(s2, pol({ mandatory: ["selection", "instructions"] })));
  });
  it("does not change its inputs", () => {
    const s = subject({}, withModel({ instructions: [1, 1, 1] }));
    const input = { mode: "upgrade" as const, policy: pol({ mandatory: ["instructions"] }), candidate: s, baseline: { record: baseRec({ instructions: [1, 1, 1] }, { runtime: { foundry: "0.1.0", agent: "c", model: "m" } }), digest: OTHER } };
    const copy = structuredClone(input);
    const r1 = evaluationGate(deepFreeze(input));
    expect(input).toEqual(copy);
    expect(evaluationGate(input)).toEqual(r1);
  });
});

describe("coverage of reason codes", () => {
  it("has produced every reason code", () => {
    expect([...EVALUATION_REASON_CODES].filter((c) => !seen.has(c))).toEqual([]);
    expect(EVALUATION_DIMENSIONS.length).toBe(5);
  });
});
