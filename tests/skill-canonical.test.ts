import { describe, expect, it } from "vitest";
import { canonicalKey, canonicalStop, selectCanonicalSkills, type CanonicalCandidate, type CanonicalPolicy, type CanonicalResolution } from "../src/skills/canonical.js";
import { CANONICAL_STOP_PREFIX } from "../src/skills/canonical-rules.js";

const cand = (id: string, o: Partial<CanonicalCandidate> = {}): CanonicalCandidate => ({
  id, version: "1.0.0", fingerprint: `fp-${id}`, capabilities: ["cap"], category: "general", risk: "low", tier: "scf-curated",
  status: "approved", failed: [], compatibility: "generic", ...o,
});
const pol = (o: Partial<CanonicalPolicy> = {}): CanonicalPolicy => ({ exclusive: ["cap"], highRisk: [], ...o });
const one = (cs: CanonicalCandidate[], p: CanonicalPolicy = pol(), cap = "cap"): CanonicalResolution =>
  selectCanonicalSkills(cs, p).resolutions.find((r) => r.capability === cap)!;
const codeOf = (r: CanonicalResolution, id: string) => r.rejected.find((x) => x.id === id);

describe("precedence levels", () => {
  it("project-pin, by id and by id@version", () => {
    const cs = [cand("a"), cand("b", { tier: "vetted-community" })];
    for (const pin of ["b", "b@1.0.0"]) {
      const r = one(cs, pol({ pins: { cap: pin } }));
      expect(r.winner?.id).toBe("b");
      expect(r.decidedBy).toBe("project-pin");
      expect(codeOf(r, "a")).toMatchObject({ code: "outranked", level: "project-pin" });
    }
  });
  it("owner-override", () => {
    const r = one([cand("a"), cand("b", { tier: "vetted-community" })], pol({ overrides: { cap: "b" } }));
    expect(r.winner?.id).toBe("b");
    expect(r.decidedBy).toBe("owner-override");
    expect(codeOf(r, "a")?.level).toBe("owner-override");
  });
  it("trust-tier, in order", () => {
    const tiers = ["local", "scf-curated", "official-vendor", "vetted-community"] as const;
    for (let i = 0; i < tiers.length - 1; i++) {
      const r = one([cand("b", { tier: tiers[i + 1]! }), cand("z", { tier: tiers[i]! })]);
      expect(r.winner?.id).toBe("z");
      expect(r.decidedBy).toBe("trust-tier");
    }
  });
  it("compatibility: version > name > generic", () => {
    const r = one([cand("a"), cand("b", { compatibility: "name" }), cand("c", { compatibility: "version" })]);
    expect(r.winner?.id).toBe("c");
    expect(r.decidedBy).toBe("compatibility");
    expect(one([cand("a"), cand("b", { compatibility: "name" })]).winner?.id).toBe("b");
  });
  it("evaluation: passed > not run > failed", () => {
    const r = one([cand("a", { evaluation: "failed" }), cand("b"), cand("c", { evaluation: "passed" })]);
    expect(r.winner?.id).toBe("c");
    expect(r.decidedBy).toBe("evaluation");
    expect(one([cand("a", { evaluation: "failed" }), cand("b")]).winner?.id).toBe("b");
  });
  it("specificity: fewer capabilities wins", () => {
    const r = one([cand("a", { capabilities: ["cap", "other"] }), cand("b")], pol({ exclusive: ["cap"] }));
    expect(r.winner?.id).toBe("b");
    expect(r.decidedBy).toBe("specificity");
  });
  it("freshness: newer approval wins, missing is oldest", () => {
    const r = one([cand("a", { approvedAt: "2026-01-01T00:00:00Z" }), cand("b", { approvedAt: "2026-02-01T00:00:00Z" }), cand("c")]);
    expect(r.winner?.id).toBe("b");
    expect(r.decidedBy).toBe("freshness");
    expect(one([cand("a"), cand("b", { approvedAt: "2026-02-01T00:00:00Z" })]).winner?.id).toBe("b");
  });
  it("lexical: id, then version, then fingerprint", () => {
    let r = one([cand("b"), cand("a")]);
    expect(r.winner?.id).toBe("a");
    expect(r.decidedBy).toBe("lexical");
    r = one([cand("a", { version: "1.0.1" }), cand("a", { version: "1.0.0" })]);
    expect(r.winner?.version).toBe("1.0.0");
    r = one([cand("a", { fingerprint: "y" }), cand("a", { fingerprint: "x" })]);
    expect(r.winner?.fingerprint).toBe("x");
    expect(codeOf(r, "a")).toMatchObject({ code: "outranked", level: "lexical" });
  });
  it("applies the levels in order", () => {
    const old = "2026-01-01T00:00:00Z";
    const fresh = "2026-02-01T00:00:00Z";
    // pin beats override
    expect(one([cand("a"), cand("b")], pol({ pins: { cap: "a" }, overrides: { cap: "b" } })).winner?.id).toBe("a");
    // override beats tier
    expect(one([cand("a", { tier: "vetted-community" }), cand("b")], pol({ overrides: { cap: "a" } })).winner?.id).toBe("a");
    // tier beats compatibility
    expect(one([cand("a", { compatibility: "version", tier: "vetted-community" }), cand("b")]).winner?.id).toBe("b");
    // compatibility beats evaluation
    expect(one([cand("a", { evaluation: "passed" }), cand("b", { compatibility: "name" })]).winner?.id).toBe("b");
    // evaluation beats specificity
    expect(one([cand("a", { capabilities: ["cap", "x"], evaluation: "passed" }), cand("b")]).winner?.id).toBe("a");
    // specificity beats freshness
    expect(one([cand("a", { capabilities: ["cap", "x"], approvedAt: fresh }), cand("b", { approvedAt: old })]).winner?.id).toBe("b");
    // freshness beats lexical
    expect(one([cand("a", { approvedAt: old }), cand("b", { approvedAt: fresh })]).winner?.id).toBe("b");
  });
});

describe("exclusion", () => {
  const worse = cand("w", { tier: "vetted-community", compatibility: "generic" });
  const cases: [string, Partial<CanonicalCandidate>][] = [
    ["revoked", { status: "revoked" }],
    ["quarantined", { status: "quarantined" }],
    ["discovery-only", { status: "discovery" }],
    ["discovery-only", { tier: "discovery-only" }],
    ["safety", { failed: ["safety"] }],
    ["licence", { failed: ["licence"] }],
    ["tools", { failed: ["tools"] }],
    ["incompatible", { compatibility: "incompatible" }],
    ["compatibility-unchecked", { compatibility: "unchecked" }],
  ];
  it.each(cases)("%s never wins, even with a pin", (code, o) => {
    const r = one([cand("x", { tier: "local", ...o }), worse], pol({ pins: { cap: "x" } }));
    expect(r.winner?.id).toBe("w");
    expect(codeOf(r, "x")?.code).toBe(code);
    expect(r.ignored).toEqual([{ level: "project-pin", value: "x", reason: "not-eligible" }]);
  });
  it("first code wins, and all excluded gives none", () => {
    const r = one([cand("x", { status: "revoked", failed: ["safety"], compatibility: "incompatible" })]);
    expect(r.outcome).toBe("none");
    expect(r.rejected[0]?.code).toBe("revoked");
  });
  it("a pin to an absent skill is recorded and the next level decides", () => {
    const r = one([cand("a"), cand("b")], pol({ pins: { cap: "ghost" }, overrides: { cap: "b" } }));
    expect(r.winner?.id).toBe("b");
    expect(r.ignored).toEqual([{ level: "project-pin", value: "ghost", reason: "not-a-candidate" }]);
  });
});

describe("same key, other facts", () => {
  it("equal records collapse", () => {
    const r = one([cand("a"), cand("a")]);
    expect(r.outcome).toBe("selected");
    expect(r.rejected).toEqual([]);
  });
  it.each([
    ["status", { status: "revoked" as const }],
    ["failed", { failed: ["licence" as const] }],
    ["capabilities", { capabilities: ["cap", "more"] }],
  ])("a difference in %s is refused", (field, o) => {
    const res = selectCanonicalSkills([cand("a"), cand("a", o), cand("b", { tier: "vetted-community" })], pol());
    const r = res.resolutions[0]!;
    expect(r.winner?.id).toBe("b");
    expect(codeOf(r, "a")).toMatchObject({ code: "ambiguous-record" });
    expect(codeOf(r, "a")?.differs).toContain(field);
    expect(res.left).toContain(canonicalKey(cand("a")));
  });
});

describe("high-risk ties", () => {
  const hp = pol({ exclusive: ["kafka-consumer"], highRisk: ["kafka"] });
  const get = (cs: CanonicalCandidate[], p = hp) => one(cs, p, "kafka-consumer");
  const k = (id: string, o: Partial<CanonicalCandidate> = {}) => cand(id, { capabilities: ["kafka-consumer"], ...o });
  it("stops when only freshness or the name decides", () => {
    for (const cs of [[k("a", { approvedAt: "2026-01-01T00:00:00Z" }), k("b", { approvedAt: "2026-02-01T00:00:00Z" })], [k("a"), k("b")]]) {
      const res = selectCanonicalSkills(cs, hp);
      const r = res.resolutions[0]!;
      expect(r.outcome).toBe("conflict");
      expect(r.conflict).toBe("tie");
      expect(r.winner).toBeUndefined();
      expect(r.message).toContain('"kafka-consumer"');
      expect(r.message).toContain("a@1.0.0");
      expect(r.message).toContain("b@1.0.0");
      expect(r.message).toContain("Pin one");
      expect(r.message).not.toMatch(/daily budget|usage limit reached|signed out/);
      expect(res.ok).toBe(false);
      expect(res.left).toHaveLength(2);
      expect(res.selected).toEqual([]);
    }
  });
  it("risk: high on a tied skill stops, too", () => {
    expect(one([cand("a", { risk: "high" }), cand("b")]).outcome).toBe("conflict");
  });
  it("the same tie on a low-risk capability is selected", () => {
    const r = get([k("a"), k("b")], pol({ exclusive: ["kafka-consumer"] }));
    expect(r.outcome).toBe("selected");
    expect(r.decidedBy).toBe("lexical");
  });
  it("a high-risk capability decided by trust tier is selected", () => {
    const r = get([k("a", { tier: "vetted-community" }), k("b")]);
    expect(r).toMatchObject({ outcome: "selected", decidedBy: "trust-tier", highRisk: true });
  });
  it("a pin resolves it", () => {
    expect(get([k("a"), k("b")], { ...hp, pins: { "kafka-consumer": "b" } }).winner?.id).toBe("b");
  });
});

describe("several capabilities", () => {
  const A = cand("a", { capabilities: ["alpha", "beta"] });
  const B = cand("b", { capabilities: ["beta"] });
  const p = (o: Partial<CanonicalPolicy> = {}) => pol({ exclusive: ["alpha", "beta"], ...o });
  it("a skill that wins one and loses another is a winners-overlap conflict", () => {
    const res = selectCanonicalSkills([A, B], p({ pins: { beta: "b" } }));
    const [alpha, beta] = res.resolutions;
    expect(beta).toMatchObject({ outcome: "selected", decidedBy: "project-pin", winner: { id: "b" } });
    expect(alpha).toMatchObject({ outcome: "conflict", conflict: "winners-overlap" });
    expect(codeOf(alpha!, "a")).toMatchObject({ code: "overlap", via: "beta" });
    expect(res.selected).toEqual([canonicalKey(B)]);
    expect(res.left).toEqual([canonicalKey(A)]);
  });
  it("both pinned to the same skill", () => {
    const res = selectCanonicalSkills([A, B], p({ pins: { alpha: "a", beta: "a" } }));
    expect(res.ok).toBe(true);
    expect(res.selected).toEqual([canonicalKey(A)]);
    expect(codeOf(res.resolutions[1]!, "b")).toMatchObject({ code: "outranked", level: "project-pin" });
  });
  it("a skill that loses both capabilities is no conflict", () => {
    const res = selectCanonicalSkills([A, cand("c", { capabilities: ["alpha"], tier: "local" }), cand("d", { capabilities: ["beta"], tier: "local" })], p());
    expect(res.ok).toBe(true);
    expect(res.selected).toEqual([canonicalKey(cand("c", { capabilities: ["alpha"] })), canonicalKey(cand("d", { capabilities: ["beta"] }))].sort());
  });
  it("a tie in one capability makes the other a conflict", () => {
    const res = selectCanonicalSkills([A, cand("c", { capabilities: ["beta"] }), cand("z", { capabilities: ["beta"] })], p({ highRisk: ["beta"] }));
    expect(res.resolutions[0]).toMatchObject({ capability: "alpha", conflict: "winners-overlap" });
    expect(res.resolutions[1]).toMatchObject({ capability: "beta", conflict: "tie" });
  });
  it("a capability that is not exclusive is never resolved", () => {
    const res = selectCanonicalSkills([A, B], p({ exclusive: ["alpha"] }));
    expect(res.resolutions.map((r) => r.capability)).toEqual(["alpha"]);
    expect(res.left).toEqual([]);
    expect(res.selected).toEqual([canonicalKey(A)]);
  });
});

describe("mandatory skills", () => {
  it("one that is outranked is a conflict", () => {
    const r = one([cand("m", { tier: "vetted-community" }), cand("b")], pol({ mandatory: ["m"] }));
    expect(r).toMatchObject({ outcome: "conflict", conflict: "mandatory" });
    expect(codeOf(r, "b")?.code).toBe("held");
    expect(r.message).toContain('"m"');
  });
  it("one that fails a gate carries its code", () => {
    const r = one([cand("m", { failed: ["licence"] }), cand("b")], pol({ mandatory: ["m"] }));
    expect(r.conflict).toBe("mandatory");
    expect(r.message).toContain("(licence)");
  });
  it("one that wins is no conflict", () => {
    expect(one([cand("m"), cand("b", { tier: "vetted-community" })], pol({ mandatory: ["m"] })).outcome).toBe("selected");
  });
  it("two for one capability are a conflict", () => {
    expect(one([cand("m"), cand("n")], pol({ mandatory: ["m", "n"] })).conflict).toBe("mandatory");
  });
});

describe("determinism and checks", () => {
  const set = [
    cand("a", { approvedAt: "2026-01-01T00:00:00Z" }),
    cand("b", { tier: "official-vendor", capabilities: ["cap", "second"] }),
    cand("c", { status: "revoked" }),
    cand("d", { capabilities: ["second"], compatibility: "name" }),
  ];
  const perms = (xs: CanonicalCandidate[]): CanonicalCandidate[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  it("gives the same result for every order", () => {
    const p = pol({ exclusive: ["cap", "second"] });
    const first = selectCanonicalSkills(set, p);
    const before = structuredClone(set);
    for (const order of perms(set)) expect(selectCanonicalSkills(order, { ...p, exclusive: [...p.exclusive].reverse() })).toEqual(first);
    expect(set).toEqual(before);
    expect(selectCanonicalSkills(set, p)).toEqual(first);
    const providers = set.filter((c) => c.capabilities.some((x) => p.exclusive.includes(x))).map(canonicalKey).sort();
    expect([...first.selected, ...first.left].sort()).toEqual(providers);
    expect(first.selected.filter((x) => first.left.includes(x))).toEqual([]);
  });
  it("only-candidate", () => {
    expect(one([cand("a")]).decidedBy).toBe("only-candidate");
  });
  it("limits and bad input", () => {
    expect(() => selectCanonicalSkills(Array.from({ length: 1001 }, (_, i) => cand(`s${i}`)), pol())).toThrow(RangeError);
    expect(() => selectCanonicalSkills([], pol({ exclusive: Array.from({ length: 201 }, (_, i) => `c${i}`) }))).toThrow(RangeError);
    expect(() => selectCanonicalSkills([cand("Bad Id")], pol())).toThrow(TypeError);
    expect(() => selectCanonicalSkills([cand("a")], pol({ pins: { cap: "bad id" } }))).toThrow(TypeError);
    expect(() => selectCanonicalSkills([cand("a", { approvedAt: "yesterday" })], pol())).toThrow(TypeError);
  });
});

describe("canonicalStop", () => {
  it("is undefined for an ok result", () => {
    expect(canonicalStop(selectCanonicalSkills([cand("a")], pol()))).toBeUndefined();
  });
  it("gives the prefix, the first message and the count", () => {
    const res = selectCanonicalSkills([cand("a", { capabilities: ["x", "y"] }), cand("b", { capabilities: ["x", "y"] })], pol({ exclusive: ["x", "y"], highRisk: ["x", "y"] }));
    const stop = canonicalStop(res)!;
    expect(stop.startsWith(CANONICAL_STOP_PREFIX)).toBe(true);
    expect(stop).toContain('"x"');
    expect(stop.endsWith("(and 1 more)")).toBe(true);
  });
  it("names a winner that needs a left-out skill", () => {
    const stop = canonicalStop(selectCanonicalSkills([cand("a")], pol()), [{ id: "w", needs: "l" }])!;
    expect(stop).toBe(`${CANONICAL_STOP_PREFIX}"w" is a canonical skill but needs "l", which is not. Pin the skills so that they agree, then run again.`);
  });
});

describe("companions: complementary providers of an exclusive capability", () => {
  const both = (id: string, o: Partial<CanonicalCandidate> = {}) => cand(id, { composable: ["cap"], ...o });
  const win = (id: string, o: Partial<CanonicalCandidate> = {}) => both(id, { tier: "local", ...o });
  const ids = (r: CanonicalResolution) => r.companions.map((c) => c.id);
  const perms = (xs: CanonicalCandidate[]): CanonicalCandidate[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  it("loads a provider next to the winner when both declare the capability", () => {
    const b = both("b");
    const res = selectCanonicalSkills([win("a"), b], pol());
    const r = res.resolutions[0]!;
    expect(r.winner?.id).toBe("a");
    expect(ids(r)).toEqual(["b"]);
    expect(codeOf(r, "b")).toBeUndefined();
    expect(res.companions).toEqual([canonicalKey(b)]);
    expect(res.left).toEqual([]);
    expect(res.ok).toBe(true);
  });
  it("is never a companion when only one side declares it, in either order", () => {
    for (const cs of [[win("a"), cand("b")], [cand("a", { tier: "local" }), both("b")]]) {
      const res = selectCanonicalSkills(cs, pol());
      expect(res.resolutions[0]!.companions).toEqual([]);
      expect(res.companions).toEqual([]);
      expect(codeOf(res.resolutions[0]!, "b")).toMatchObject({ code: "outranked" });
      expect(res.left).toEqual([canonicalKey(cs[1]!)]);
    }
  });
  it("lists several companions in rank order", () => {
    const r = one([both("c", { tier: "vetted-community" }), win("z"), both("a", { tier: "official-vendor" }), both("m", { tier: "scf-curated" })]);
    expect(r.winner?.id).toBe("z");
    expect(ids(r)).toEqual(["m", "a", "c"]);
  });
  it("never takes an ineligible provider", () => {
    const r = one([win("a"), both("b", { failed: ["safety"] })]);
    expect(r.companions).toEqual([]);
    expect(codeOf(r, "b")?.code).toBe("safety");
  });
  it("never takes a provider that loses another exclusive capability it provides", () => {
    const cs = [win("a"), both("b", { capabilities: ["cap", "other"], composable: ["cap"] }), cand("c", { capabilities: ["other"], tier: "local" })];
    const res = selectCanonicalSkills(cs, pol({ exclusive: ["cap", "other"] }));
    const r = res.resolutions.find((x) => x.capability === "cap")!;
    expect(r.companions).toEqual([]);
    expect(codeOf(r, "b")).toMatchObject({ code: "overlap", via: "other" });
    expect(res.left).toContain(canonicalKey(cs[1]!));
  });
  it("takes it when the other capability is composable for both", () => {
    const b = both("b", { capabilities: ["cap", "other"], composable: ["cap", "other"] });
    const cs = [win("a"), b, cand("c", { capabilities: ["other"], tier: "local", composable: ["other"] })];
    const res = selectCanonicalSkills(cs, pol({ exclusive: ["cap", "other"] }));
    expect(res.resolutions.map((r) => ids(r))).toEqual([["b"], ["b"]]);
    expect(res.companions).toEqual([canonicalKey(b)]);
  });
  it("removes a companion everywhere when it fails one capability", () => {
    // b would accompany "cap" and "other", but the winner of "other" does not declare it.
    const b = both("b", { capabilities: ["cap", "other"], composable: ["cap", "other"] });
    const cs = [win("a"), b, cand("c", { capabilities: ["other"], tier: "local" })];
    const res = selectCanonicalSkills(cs, pol({ exclusive: ["cap", "other"] }));
    expect(res.companions).toEqual([]);
    expect(res.resolutions.map((r) => ids(r))).toEqual([[], []]);
    expect(res.left).toEqual([canonicalKey(b)]);
  });
  it("lets a provider win one capability and accompany the winner of another", () => {
    // x wins "other" and is only a companion for "cap", where a wins; both declare cap composable.
    const x = cand("x", { capabilities: ["cap", "other"], composable: ["cap"], tier: "scf-curated" });
    const a = win("a");
    const res = selectCanonicalSkills([a, x, cand("y", { capabilities: ["other"], tier: "vetted-community" })], pol({ exclusive: ["cap", "other"] }));
    expect(res.ok).toBe(true);
    const cap = res.resolutions.find((r) => r.capability === "cap")!;
    const other = res.resolutions.find((r) => r.capability === "other")!;
    expect(cap.winner?.id).toBe("a");
    expect(ids(cap)).toEqual(["x"]);
    expect(other.winner?.id).toBe("x");
    expect(res.selected).toContain(canonicalKey(x));
    expect(res.companions).toEqual([]);
  });
  it("gives no companions in a conflict", () => {
    const res = selectCanonicalSkills([win("a", { risk: "high" }), win("b", { risk: "high" })], pol());
    expect(res.resolutions[0]!.outcome).toBe("conflict");
    expect(res.resolutions[0]!.companions).toEqual([]);
    expect(res.companions).toEqual([]);
  });
  it("does not depend on the input order, and selected, companions and left partition the providers", () => {
    const set = [win("a"), both("b", { tier: "scf-curated" }), both("c", { tier: "official-vendor" }), cand("d", { tier: "vetted-community" })];
    const first = selectCanonicalSkills(set, pol());
    expect(ids(first.resolutions[0]!)).toEqual(["b", "c"]);
    for (const order of perms(set)) expect(selectCanonicalSkills(order, pol())).toEqual(first);
    const all = [...first.selected, ...first.companions, ...first.left].sort();
    expect(all).toEqual(set.map(canonicalKey).sort());
  });
  it("refuses a composable entry that is not a capability", () => {
    expect(() => selectCanonicalSkills([cand("a", { composable: ["nope"] })], pol())).toThrow(TypeError);
  });
});
