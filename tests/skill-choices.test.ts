import { describe, expect, it } from "vitest";
import { CANONICAL_STOP_PREFIX } from "../src/skills/canonical-rules.js";
import { selectCanonicalSkills, type CanonicalCandidate, type CanonicalPolicy } from "../src/skills/canonical.js";
import {
  checkSkillChoices, choiceDigest, choiceStop, parseProjectPins, parseSkillOverrides, planSkillChoices, type SkillChoice, type SkillOverride,
} from "../src/skills/choices.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { buildRunSkillLock, verifyRunSkillLock } from "../src/skills/run-lock.js";
import { resolveSkills } from "../src/skills/resolve.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const choice = (o: Partial<SkillChoice> = {}): SkillChoice => ({
  capability: "cap", target: "a@1.0.0", by: "@octocat", reason: "Reviewed by the owners", from: "2026-01-01T00:00:00Z", expires: "2027-01-01T00:00:00Z", ...o,
});
const override = (o: Partial<SkillOverride> = {}): SkillOverride => ({ ...choice(), scope: "all", ...o });
const cc = (id: string, o: Partial<CanonicalCandidate> = {}): CanonicalCandidate => ({
  id, version: "1.0.0", fingerprint: `fp-${id}`, capabilities: ["cap"], category: "general", risk: "low", tier: "scf-curated",
  status: "approved", failed: [], compatibility: "generic", ...o,
});
const policy: CanonicalPolicy = { exclusive: ["cap"], highRisk: [] };
const run = (cands: CanonicalCandidate[], i: { pins?: SkillChoice[]; overrides?: SkillOverride[]; repository?: string }) => {
  const plan = planSkillChoices({ ...i, now: NOW, exclusive: ["cap"] });
  const result = selectCanonicalSkills(cands, { ...policy, pins: plan.pins, overrides: plan.overrides });
  return { plan, result, ...checkSkillChoices(plan, result) };
};

describe("choice schemas", () => {
  it("parses a valid pins document and a valid overrides document", () => {
    expect(parseProjectPins({ schema: 1, pins: [choice()] }).ok).toBe(true);
    expect(parseSkillOverrides({ schema: 1, overrides: [override(), override({ capability: "other", scope: { repositories: ["Acme/Repo"] }, expires: undefined, review_by: "2027-01-01T00:00:00Z" })] }).ok).toBe(true);
  });
  const refused: [string, unknown][] = [
    ["unknown field", { schema: 1, pins: [{ ...choice(), extra: 1 }] }],
    ["schema 2", { schema: 2, pins: [choice()] }],
    ["target without version", { schema: 1, pins: [choice({ target: "a" })] }],
    ["bad by", { schema: 1, pins: [choice({ by: "octocat" })] }],
    ["empty reason", { schema: 1, pins: [choice({ reason: "" })] }],
    ["long reason", { schema: 1, pins: [choice({ reason: "x".repeat(301) })] }],
    ["control character", { schema: 1, pins: [choice({ reason: "a\u0007b" })] }],
    ["secret", { schema: 1, pins: [choice({ reason: "token ghp_" + "a1B2c3D4e5".repeat(4) })] }],
    ["no expiry", { schema: 1, pins: [choice({ expires: undefined })] }],
    ["expires before from", { schema: 1, pins: [choice({ expires: "2025-01-01T00:00:00Z" })] }],
    ["30 February", { schema: 1, pins: [choice({ expires: "2027-02-30T00:00:00Z" })] }],
    ["duplicate capability", { schema: 1, pins: [choice(), choice({ target: "b@1.0.0" })] }],
    ["too many", { schema: 1, pins: Array.from({ length: 201 }, (_, i) => choice({ capability: `cap-${i}` })) }],
  ];
  for (const [name, doc] of refused)
    it(`refuses ${name}`, () => {
      const r = parseProjectPins(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.problems)).not.toContain("ghp_");
    });
  it("refuses two `all` overrides and a repeated repository", () => {
    expect(parseSkillOverrides({ schema: 1, overrides: [override(), override({ target: "b@1.0.0" })] }).ok).toBe(false);
    expect(parseSkillOverrides({ schema: 1, overrides: [override({ scope: { repositories: ["a/b", "A/B"] } })] }).ok).toBe(false);
    expect(parseSkillOverrides({ schema: 1, overrides: [override({ scope: { repositories: ["a/b"] } }), override({ target: "b@1.0.0", scope: { repositories: ["A/b"] } })] }).ok).toBe(false);
  });
});

describe("choiceDigest", () => {
  it("ignores key order and changes with the content", () => {
    const a = choice();
    const shuffled = Object.fromEntries(Object.entries(a).reverse()) as unknown as SkillChoice;
    expect(choiceDigest(shuffled)).toBe(choiceDigest(a));
    expect(choiceDigest(choice({ reason: "Another reason" }))).not.toBe(choiceDigest(a));
    expect(choiceDigest(choice({ expires: "2027-02-01T00:00:00Z" }))).not.toBe(choiceDigest(a));
    expect(choiceDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("planSkillChoices", () => {
  const plan = (i: Partial<Parameters<typeof planSkillChoices>[0]>) => planSkillChoices({ now: NOW, exclusive: ["cap"], ...i });
  it("applies an `all` override without a repository, and a repository one only for that repository, which wins", () => {
    const all = override();
    const repo = override({ target: "b@1.0.0", scope: { repositories: ["Acme/Repo"] } });
    expect(plan({ overrides: [all, repo] }).overrides).toEqual({ cap: "a@1.0.0" });
    const p = plan({ overrides: [all, repo], repository: "acme/REPO" });
    expect(p.overrides).toEqual({ cap: "b@1.0.0" });
    expect(p.planned.map((x) => [x.scope, x.given])).toEqual([["repository", true], ["all", false]]);
    expect(plan({ overrides: [repo], repository: "other/repo" }).planned).toEqual([]);
  });
  it("handles dates", () => {
    expect(plan({ pins: [choice({ from: "2026-07-01T00:00:00Z" })] })).toMatchObject({ pending: 1, planned: [], problems: [] });
    const expired = plan({ pins: [choice({ expires: "2026-05-01T00:00:00Z" })] });
    expect(expired.problems).toEqual([{ code: "expired", level: "project-pin", capability: "cap", target: "a@1.0.0" }]);
    expect(expired.pins).toEqual({});
    const hidden = plan({ overrides: [override({ expires: "2026-05-01T00:00:00Z" }), override({ target: "b@1.0.0", scope: { repositories: ["a/b"] } })], repository: "a/b" });
    expect(hidden.problems.map((p) => p.code)).toEqual(["expired"]);
    const due = plan({ pins: [choice({ expires: undefined, review_by: "2026-05-01T00:00:00Z" })] });
    expect(due.planned[0]).toMatchObject({ reviewDue: true, reviewBy: "2026-05-01T00:00:00Z" });
    expect(due.pins).toEqual({ cap: "a@1.0.0" });
  });
  it("flags a capability that is not exclusive", () => {
    expect(plan({ pins: [choice({ capability: "free" })] }).problems.map((p) => p.code)).toEqual(["not-exclusive"]);
  });
  it("is the same for shuffled entries", () => {
    const o = [override({ capability: "x" }), override({ capability: "y", scope: { repositories: ["a/b"] } }), override({ capability: "x", scope: { repositories: ["a/b"] } })];
    const a = plan({ overrides: o, repository: "a/b", exclusive: ["x", "y"] });
    const b = plan({ overrides: [...o].reverse(), repository: "a/b", exclusive: ["x", "y"] });
    expect(b).toEqual(a);
  });
});

describe("with the selector", () => {
  const cands = [cc("a", { tier: "official-vendor" }), cc("b")];
  it("an override lifts a lower-tier candidate", () => {
    const r = run(cands, { overrides: [override({ target: "a@1.0.0" })] });
    expect(r.result.resolutions[0]).toMatchObject({ winner: { id: "a" }, decidedBy: "owner-override" });
    const o = run(cands, { overrides: [override({ target: "a@1.0.0" })] });
    expect(o.applied[0]).toMatchObject({ effect: "selected" });
    const b = run([cc("a", { tier: "official-vendor" }), cc("b", { tier: "local" })], { overrides: [override({ target: "a@1.0.0" })] });
    expect(b.result.resolutions[0]).toMatchObject({ winner: { id: "a" }, decidedBy: "owner-override" });
  });
  it("a pin beats an override", () => {
    const r = run([cc("a"), cc("b"), cc("c", { tier: "local" })], { pins: [choice({ target: "a@1.0.0" })], overrides: [override({ target: "b@1.0.0" })] });
    expect(r.result.resolutions[0]).toMatchObject({ winner: { id: "a" }, decidedBy: "project-pin" });
    expect(r.applied.map((a) => [a.level, a.effect])).toEqual([["project-pin", "selected"], ["owner-override", "superseded"]]);
    expect(r.problems).toEqual([]);
  });
  const cases: [string, CanonicalCandidate, string][] = [
    ["revoked", cc("b", { status: "revoked" }), "revoked"],
    ["quarantined", cc("b", { status: "quarantined" }), "quarantined"],
    ["licence", cc("b", { failed: ["licence"] }), "licence"],
    ["incompatible", cc("b", { compatibility: "incompatible" }), "incompatible"],
    ["discovery-only", cc("b", { tier: "discovery-only" }), "unapproved"],
  ];
  for (const [name, target, code] of cases)
    it(`stops on a ${name} target and it does not win`, () => {
      const r = run([cc("a"), target], { overrides: [override({ target: "b@1.0.0" })] });
      expect(r.problems).toEqual([{ code, level: "owner-override", capability: "cap", target: "b@1.0.0" }]);
      expect(r.result.resolutions[0]?.winner?.id).toBe("a");
      expect(choiceStop(r.problems)).toMatch(new RegExp(`^${CANONICAL_STOP_PREFIX}The owner override for "cap" names b@1\\.0\\.0, which `));
    });
  it("gives missing, or the answer of targetState", () => {
    const plan = planSkillChoices({ now: NOW, exclusive: ["cap"], overrides: [override({ target: "z@1.0.0" })] });
    const result = selectCanonicalSkills([cc("a")], { ...policy, overrides: plan.overrides });
    expect(checkSkillChoices(plan, result).problems[0]?.code).toBe("missing");
    for (const s of ["not-active", "unapproved", "not-usable"] as const) expect(checkSkillChoices(plan, result, () => s).problems[0]?.code).toBe(s);
  });
  it("builds a stop line without the reason, with a count, file problems first", () => {
    const r = run([cc("a"), cc("b", { status: "revoked" })], { overrides: [override({ target: "b@1.0.0", reason: "SECRET-WORDS" })] });
    const two = [...r.problems, { code: "invalid" as const, level: "project-pin" as const }];
    const line = choiceStop(two)!;
    expect(line.startsWith(`${CANONICAL_STOP_PREFIX}The project pins file`)).toBe(true);
    expect(line.endsWith("(and 1 more)")).toBe(true);
    expect(line).not.toContain("SECRET-WORDS");
    expect(choiceStop([])).toBeUndefined();
  });
  it("removing every choice gives the default result", () => {
    const base = selectCanonicalSkills(cands, policy);
    const r = run(cands, {});
    expect(r.result).toEqual(base);
    expect(r.problems).toEqual([]);
  });
});

describe("locks", () => {
  it("a lock still verifies when a choice selects another skill", () => {
    const sk = (id: string) =>
      ({
        key: `${id}@1.0.0`, id, version: "1.0.0", source: "admin", label: "x", dir: "/d", active: true, trust: "approved", pin: "pinned", digest: `sha256:${"a".repeat(64)}`,
        pkg: { id, version: "1.0.0", description: "d", instructions: "i", roles: [], dependencies: [], conflicts: [] },
      }) as unknown as RegisteredSkill;
    const skills = [sk("a"), sk("b")];
    const reg = { skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] };
    const req = { version: 1 as const, skills: [{ id: "a", reason: "Needed", evidence: ["catalogue:a"] }] };
    const lock = buildRunSkillLock({
      runId: "r", resolution: resolveSkills(reg, ["a"]), request: req, sourceOf: () => "admin", planHash: `sha256:${"c".repeat(64)}`, now: new Date("2026-01-01T00:00:00Z"),
    });
    const r = run([cc("a"), cc("b")], { overrides: [override({ target: "b@1.0.0" })] });
    expect(r.result.resolutions[0]?.winner?.id).toBe("b");
    expect(verifyRunSkillLock(lock, reg)).toEqual([]);
  });
});
