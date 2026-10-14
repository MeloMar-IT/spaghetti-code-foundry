import { describe, expect, it } from "vitest";
import { canonicalFromCollision, canonicalFromRegistered, rangeSatisfied, technologyCompatibility } from "../src/skills/canonical-facts.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import type { LicenceStatus } from "../src/skills/licence.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { rangeAdmitsLine } from "../src/skills/version-range.js";

const RANGES: [string, string, boolean | undefined][] = [
  [">=18", "20.0.0", true], [">=18", "16.0.0", false], ["17", "17.0.2", true], [">=18 <21", "19.0.0", true], [">=18 <21", "21.0.0", false],
  ["17.x", "17.3.0", true], ["^5", "5.9.0", true], ["^5", "6.1.0", false], ["^0.2.3", "0.3.0", false], ["^0.2.3", "0.2.9", true],
  ["~1.2.3", "1.2.9", true], ["~1.2.3", "1.3.0", false], ["^5 || ^7", "6.0.0", false], ["^5 || ^7", "7.2.0", true],
  ["^5", "6.0.0-rc.1", false], ["<6", "6.0.0-rc.1", false], [">=6", "6.0.0-rc.1", false], [">=6.0.0-rc.1", "6.0.0-rc.2", true],
  ["1.2 - 2.0", "1.5.0", undefined], ["latest", "1.0.0", undefined], ["^5", "abc", undefined], ["^5", "5", undefined],
];

describe("rangeSatisfied", () => {
  it.each(RANGES)("%s on %s", (range, version, want) => {
    expect(rangeSatisfied(range, version)).toBe(want);
  });
});

describe("technologyCompatibility", () => {
  const ev = [{ name: "react", version: "18.2.0" }, { name: "node" }];
  it("covers every case", () => {
    expect(technologyCompatibility([{ name: "react" }])).toBe("generic");
    expect(technologyCompatibility([], ev)).toBe("generic");
    expect(technologyCompatibility([{ name: "vue" }], ev)).toBe("incompatible");
    expect(technologyCompatibility([{ name: "react", version: "^17" }], ev)).toBe("incompatible");
    expect(technologyCompatibility([{ name: "react", version: "latest" }], ev)).toBe("unchecked");
    expect(technologyCompatibility([{ name: "node", version: "latest" }], ev)).toBe("name");
    expect(technologyCompatibility([{ name: "react" }], ev)).toBe("name");
    expect(technologyCompatibility([{ name: "react", version: "^18" }], ev)).toBe("version");
    expect(technologyCompatibility([{ name: "vue" }, { name: "react" }], ev)).toBe("name");
  });
  it("reads partial and unreadable project versions", () => {
    expect(technologyCompatibility([{ name: "java", version: ">=21" }], [{ name: "java", version: "17" }])).toBe("incompatible");
    expect(technologyCompatibility([{ name: "java", version: ">=21" }], [{ name: "java", version: "17.4" }])).toBe("incompatible");
    expect(technologyCompatibility([{ name: "java", version: ">=17" }], [{ name: "java", version: "17" }])).toBe("version");
    expect(technologyCompatibility([{ name: "java", version: ">=17.5" }], [{ name: "java", version: "17" }])).toBe("unchecked");
    expect(technologyCompatibility([{ name: "java", version: ">=17" }], [{ name: "java", version: "latest" }])).toBe("unchecked");
  });
});

const collision = (o: { trust?: "first-party" | "verified" | "community"; approved?: boolean; shell?: boolean; connectors?: string[]; techs?: { name: string; version?: string }[] } = {}): CollisionCandidate =>
  ({
    skill: {
      package: { id: "s", version: "1.0.0", capabilities: ["cap"], category: "general", risk: "low", tool_profile: { shell: o.shell ?? false }, connectors: o.connectors ?? [] },
      provenance: { technologies: o.techs ?? [] },
      identity: { id: "s", version: "1.0.0", fingerprint: "fp" },
    },
    approved: o.approved ?? true, trust: o.trust ?? "verified", licencesAllowed: [],
  }) as unknown as CollisionCandidate;

describe("canonicalFromCollision", () => {
  it("maps the trust tiers and unapproved", () => {
    expect(canonicalFromCollision(collision({ trust: "first-party" }), { licence: "allowed" }).tier).toBe("scf-curated");
    expect(canonicalFromCollision(collision({ trust: "verified" }), { licence: "allowed" }).tier).toBe("official-vendor");
    expect(canonicalFromCollision(collision({ trust: "community" }), { licence: "allowed" }).tier).toBe("vetted-community");
    const u = canonicalFromCollision(collision({ approved: false }), { licence: "allowed" });
    expect(u).toMatchObject({ tier: "discovery-only", status: "discovery" });
  });
  it("maps the source status", () => {
    const st = (s: "enabled" | "disabled" | "quarantined" | "retired") => canonicalFromCollision(collision(), { licence: "allowed", sourceStatus: s }).status;
    expect([st("enabled"), st("disabled"), st("quarantined"), st("retired")]).toEqual(["approved", "revoked", "quarantined", "revoked"]);
  });
  it.each<[LicenceStatus, boolean]>([["allowed", false], ["review", true], ["rejected", true], ["missing", true], ["ambiguous", true]])("licence %s", (status, fails) => {
    expect(canonicalFromCollision(collision(), { licence: status }).failed.includes("licence")).toBe(fails);
  });
  it("gates tools and safety", () => {
    const tools = { shell: false, network: false, filesystem: "write" as const, missing: "stop" as const };
    expect(canonicalFromCollision(collision({ shell: true }), { licence: "allowed", tools }).failed).toEqual(["tools"]);
    expect(canonicalFromCollision(collision({ connectors: ["x"] }), { licence: "allowed", tools: { ...tools, shell: true } }).failed).toEqual(["tools"]);
    expect(canonicalFromCollision(collision({ shell: true }), { licence: "allowed", tools: { ...tools, shell: true } }).failed).toEqual([]);
    expect(canonicalFromCollision(collision({ shell: true }), { licence: "allowed" }).failed).toEqual([]);
    expect(canonicalFromCollision(collision(), { licence: "allowed", safety: false }).failed).toEqual(["safety"]);
  });
  it("reads technologies against the evidence", () => {
    const c = collision({ techs: [{ name: "react", version: "^18" }] });
    expect(canonicalFromCollision(c, { licence: "allowed", evidence: [{ name: "react", version: "18.0.0" }] }).compatibility).toBe("version");
    expect(canonicalFromCollision(c, { licence: "allowed" }).compatibility).toBe("generic");
  });
});

describe("canonicalFromRegistered", () => {
  const reg = (source: string, trust: string): RegisteredSkill =>
    ({ id: "s", version: "1.0.0", key: "s@1.0.0", source, trust, digest: "sha256:x", pkg: { capabilities: ["cap"], category: "general", risk: "low" } }) as unknown as RegisteredSkill;
  it("maps the sources", () => {
    expect(canonicalFromRegistered(reg("admin", "approved")).tier).toBe("local");
    expect(canonicalFromRegistered(reg("builtin", "builtin")).tier).toBe("scf-curated");
    const r = canonicalFromRegistered(reg("repository", "unapproved"));
    expect(r).toMatchObject({ tier: "discovery-only", status: "discovery", fingerprint: "sha256:x" });
  });
  it("fails the licence gate only when a verdict is given and not allowed", () => {
    expect(canonicalFromRegistered(reg("admin", "approved")).failed).toEqual([]);
    expect(canonicalFromRegistered(reg("admin", "approved"), { licence: "review" }).failed).toEqual(["licence"]);
  });
  it("works out stale declarations itself", () => {
    expect(canonicalFromRegistered(reg("admin", "approved"), { technologies: [{ name: "java", version: "8" }] }).compatibility).toBe("incompatible");
    expect(canonicalFromRegistered(reg("admin", "approved"), { technologies: [{ name: "java", version: "latest" }] }).compatibility).toBe("generic");
  });
});

const LINES: [string, string, boolean | undefined][] = [
  [">=21", "21", true], ["^2", "4", false], ["~3.5.2", "3.5", true], [">3.5.2 <3.5.4", "3.5", true], ["<=3.4", "3.5", false],
  ["^3 || ^4", "4", true], ["=4.0.0-RC1", "4.0", true], ["4.0.0-RC1", "4.1", false], [">4.0.0-RC1 <4.0.0-RC3", "4.0", undefined],
  ["latest", "4", undefined], ["^4", "x", undefined], ["^4", "4.0.0", undefined], ["~3.5.2", "3.6", false], [">3.5.2 <3.5.3", "3.5", false],
];

describe("rangeAdmitsLine", () => {
  it.each(LINES)("%s on line %s", (range, line, want) => {
    expect(rangeAdmitsLine(range, line)).toBe(want);
  });
});

describe("technologies by alias and with several evidence entries", () => {
  it("reads an alias like the name it stands for", () => {
    expect(technologyCompatibility([{ name: "jdk", version: ">=17" }], [{ name: "java", version: "17" }])).toBe("version");
    expect(technologyCompatibility([{ name: "java", version: ">=17" }], [{ name: "openjdk", version: "11" }])).toBe("incompatible");
  });
  it("needs the range to fit every entry of the same name", () => {
    const ev = [{ name: "java", version: "17" }, { name: "java", version: "21" }];
    expect(technologyCompatibility([{ name: "java", version: ">=21" }], ev)).toBe("incompatible");
    expect(technologyCompatibility([{ name: "java", version: ">=17" }], ev)).toBe("version");
  });
});

describe("stale declarations", () => {
  it("are incompatible with and without evidence", () => {
    const c = collision({ techs: [{ name: "spring-boot", version: "^2" }] });
    expect(canonicalFromCollision(c, { licence: "allowed" }).compatibility).toBe("incompatible");
    expect(canonicalFromCollision(c, { licence: "allowed", evidence: [{ name: "spring-boot", version: "2.7.0" }] }).compatibility).toBe("incompatible");
  });
  it("leave unchecked and generic declarations as they were", () => {
    expect(canonicalFromCollision(collision({ techs: [{ name: "java", version: "latest" }] }), { licence: "allowed" }).compatibility).toBe("generic");
    expect(canonicalFromCollision(collision({ techs: [{ name: "react", version: "^1" }] }), { licence: "allowed" }).compatibility).toBe("generic");
    expect(canonicalFromCollision(collision({ techs: [{ name: "java", version: ">=17" }] }), { licence: "allowed", evidence: [{ name: "java", version: "17" }] }).compatibility).toBe("version");
  });
});
