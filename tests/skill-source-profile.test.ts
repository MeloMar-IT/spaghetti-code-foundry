import { describe, expect, it } from "vitest";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import { applySourceProfile, profileSkill, SourceProfileError, vendorCapability } from "../src/skills/source-profile.js";
import type { SkillLibrarySource, SourceProfile } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT };

function skill(name = "kafka-tools"): NormalizedSkill {
  const md = `---\nname: ${name}\ndescription: About ${name}.\n---\n\nDo the work.\n`;
  const r = normalizeSkill(ORIGIN, { root: `skills/${name}`, files: [{ path: "SKILL.md", content: new Uint8Array(Buffer.from(md)) }] });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
const withCaps = (s: NormalizedSkill, capabilities: string[], provider?: NormalizedSkill["package"]["provider"]): NormalizedSkill => {
  const pkg = { ...s.package, capabilities };
  if (provider) pkg.provider = provider;
  else delete pkg.provider;
  return { ...s, package: pkg };
};
const PRODUCTS = [{ name: "confluent-platform", version: ">=7.0" }];
const profile = (over: Partial<SourceProfile> = {}): SourceProfile => ({ provider: "confluent", portable: [], products: PRODUCTS, ...over });
const source = (p?: SourceProfile): SkillLibrarySource => ({
  id: "lib", repository: ORIGIN.repository, repositoryKey: ORIGIN.repositoryKey, status: "enabled", ref: { approved: COMMIT }, paths: ["skills"],
  adapter: "agent-skills", trust: "community", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "@example", ...(p ? { profile: p } : {}),
});
const STREAMS = { upstream: "streams", capability: "kafka-streams" };

describe("vendorCapability", () => {
  it.each([
    ["producer", "confluent-producer"],
    ["confluent-cli", "confluent-cli"],
    ["confluent", "confluent"],
    ["confluentx", "confluent-confluentx"],
  ])("%s becomes %s", (c, out) => expect(vendorCapability("confluent", c)).toBe(out));
});

describe("applySourceProfile", () => {
  it("prefixes every capability and adds the provider block", () => {
    const r = applySourceProfile(withCaps(skill(), ["producer", "confluent-cli"]), source(profile()));
    expect(r.package.capabilities).toEqual(["confluent-cli", "confluent-producer"]);
    expect(r.package.provider).toEqual({ name: "confluent", products: PRODUCTS, tools: [] });
  });

  it("maps portable capabilities and adds no provider block when all are portable", () => {
    const r = applySourceProfile(withCaps(skill(), ["streams"]), source(profile({ portable: [STREAMS] })));
    expect(r.package.capabilities).toEqual(["kafka-streams"]);
    expect(r.package).not.toHaveProperty("provider");
  });

  it("keeps an upstream provider block when all are portable", () => {
    const upstream = { name: "other", products: [], tools: ["x"] };
    const r = applySourceProfile(withCaps(skill(), ["streams"], upstream), source(profile({ portable: [STREAMS] })));
    expect(r.package.provider).toEqual(upstream);
  });

  it("handles a mixed skill", () => {
    const r = applySourceProfile(withCaps(skill(), ["streams", "schema-registry"]), source(profile({ portable: [STREAMS] })));
    expect(r.package.capabilities).toEqual(["confluent-schema-registry", "kafka-streams"]);
    expect(r.package.provider).toEqual({ name: "confluent", products: PRODUCTS, tools: [] });
  });

  it("keeps the products of a provider block with the same name, and fills empty ones", () => {
    const own = { name: "confluent", products: [{ name: "ksql", version: "1" }], tools: ["cli"] };
    expect(applySourceProfile(withCaps(skill(), ["a"], own), source(profile())).package.provider).toEqual(own);
    const empty = { name: "confluent", products: [], tools: ["cli"] };
    expect(applySourceProfile(withCaps(skill(), ["a"], empty), source(profile())).package.provider).toEqual({ name: "confluent", products: PRODUCTS, tools: ["cli"] });
  });

  it("reports a provider block of another name", () => {
    const r = profileSkill(withCaps(skill(), ["a"], { name: "azure", products: [], tools: [] }), source(profile()));
    expect(r.skill).toBeUndefined();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ skill: "kafka-tools", capability: "a" });
    expect(r.problems[0]!.message).toContain('"azure"');
  });

  it("reports two upstream names landing on one slug", () => {
    const r = profileSkill(withCaps(skill(), ["x", "confluent-x"]), source(profile()));
    expect(r.skill).toBeUndefined();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.skill).toBe("kafka-tools");
    expect(r.problems[0]!.capability).toBe("x");
    expect(r.problems[0]!.message).toContain("confluent-x");
  });

  it("reports a portable target that another capability reaches", () => {
    const p = profile({ portable: [{ upstream: "a", capability: "confluent-b" }] });
    const r = profileSkill(withCaps(skill(), ["a", "b"]), source(p));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.message).toContain("confluent-b");
  });

  it("allows two upstream names for one target when they are in different skills", () => {
    const p = profile({ portable: [{ upstream: "producer", capability: "kafka-producer" }, { upstream: "publishing", capability: "kafka-producer" }] });
    expect(applySourceProfile(withCaps(skill(), ["producer"]), source(p)).package.capabilities).toEqual(["kafka-producer"]);
    expect(applySourceProfile(withCaps(skill(), ["publishing"]), source(p)).package.capabilities).toEqual(["kafka-producer"]);
    const both = profileSkill(withCaps(skill(), ["producer", "publishing"]), source(p));
    expect(both.skill).toBeUndefined();
    expect(both.problems).toHaveLength(1);
    expect(both.problems[0]).toMatchObject({ skill: "kafka-tools", capability: "publishing" });
    expect(both.problems[0]!.message).toContain('"producer"');
  });

  it("reports a slug over 64 characters", () => {
    const long = "a".repeat(60);
    const r = profileSkill(withCaps(skill(), [long]), source(profile()));
    expect(r.skill).toBeUndefined();
    expect(r.problems[0]).toMatchObject({ skill: "kafka-tools", capability: long });
    expect(r.problems[0]!.message).toContain("64");
  });

  it("throws SourceProfileError with every problem", () => {
    const s = withCaps(skill(), ["a".repeat(60), "b".repeat(60)]);
    expect(profileSkill(s, source(profile())).problems).toHaveLength(2);
    try {
      applySourceProfile(s, source(profile()));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SourceProfileError);
      expect((e as SourceProfileError).problems).toHaveLength(2);
    }
  });

  it("returns the skill as it is without a profile", () => {
    const s = withCaps(skill(), ["producer"]);
    expect(applySourceProfile(s, source())).toBe(s);
  });

  it("treats an empty portable list like an omitted one", () => {
    const s = withCaps(skill(), ["producer"]);
    expect(applySourceProfile(s, source(profile({ portable: [] })))).toEqual(applySourceProfile(s, source({ provider: "confluent", portable: [], products: PRODUCTS })));
  });

  it("does not touch the input, digest, fingerprint or provenance", () => {
    const s = withCaps(skill(), ["streams", "schema-registry"]);
    const before = JSON.stringify(s);
    const r = applySourceProfile(s, source(profile({ portable: [STREAMS] })));
    expect(JSON.stringify(s)).toBe(before);
    expect(r.package.digest).toBe(s.package.digest);
    expect(r.identity.fingerprint).toBe(s.identity.fingerprint);
    expect(r.provenance).toEqual(s.provenance);
  });

  it("gives the same result for any input order", () => {
    const p1 = profile({ portable: [STREAMS, { upstream: "zzz", capability: "kafka-zzz" }] });
    const p2 = profile({ portable: [...p1.portable].reverse() });
    const a = applySourceProfile(withCaps(skill(), ["streams", "schema-registry", "zzz"]), source(p1));
    const b = applySourceProfile(withCaps(skill(), ["zzz", "schema-registry", "streams"]), source(p2));
    expect(a).toEqual(b);
  });

  it("does not confuse a capability named like an object property", () => {
    const r = applySourceProfile(withCaps(skill(), ["constructor"]), source(profile()));
    expect(r.package.capabilities).toEqual(["confluent-constructor"]);
  });
});
