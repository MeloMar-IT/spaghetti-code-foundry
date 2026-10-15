import { describe, expect, it } from "vitest";
import { COLLISION_LIMITS } from "../src/skills/collision-rules.js";
import { classifySkillCollisions, collisionCandidate } from "../src/skills/collisions.js";
import { COMMUNITY_CAPABILITY_RULES } from "../src/skills/community-rules.js";
import { loadBuiltins } from "../src/skills/compare-cli.js";
import { builtinCollisionCandidate, compareFailed, compareLines, compareWithBuiltins, mappedCapabilities } from "../src/skills/compare.js";
import { skillFingerprint } from "../src/skills/identity.js";
import { SkillImportError } from "../src/skills/import-plan.js";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import { BUILTIN_SKILLS } from "../src/skills/registry.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

type F = { path: string; content: Uint8Array };
const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT };
const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const md = (name: string, front = "") => f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n${front}---\n\nDo the work.\n`);

function skill(name: string, o: { front?: string; yaml?: string; root?: string; files?: F[] } = {}): NormalizedSkill {
  const files = o.files ?? [md(name, o.front), ...(o.yaml ? [f("skill.yaml", o.yaml)] : [])];
  const r = normalizeSkill(ORIGIN, { root: o.root ?? `skills/${name}`, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
  id: "lib", repository: ORIGIN.repository, repositoryKey: ORIGIN.repositoryKey, status: "enabled", ref: { approved: COMMIT }, paths: ["skills"],
  adapter: "agent-skills", trust: "community", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "@example",
  review: { by: "@example", on: "2026-01-01", commit: COMMIT, licence: "MIT" }, ...over,
});

const BUILTINS = loadBuiltins(BUILTIN_SKILLS);
const shippedFiles = (id: string): F[] => BUILTINS.find((b) => b.id === id)!.files.map((x) => ({ path: x.path, content: x.content }));

const run = (skills: NormalizedSkill[], over: Partial<Parameters<typeof compareWithBuiltins>[0]> = {}) =>
  compareWithBuiltins({ source: source(), skills, builtins: BUILTINS, ...over });
const lines = (skills: NormalizedSkill[], over: Partial<Parameters<typeof compareWithBuiltins>[0]> = {}) => compareLines(run(skills, over));
const tx = (name = "tx") => skill(name, { front: "tags: [spring-boot, transactions]\n" });

describe("mappedCapabilities", () => {
  it("maps spring-boot + transactions and java", () => {
    expect(mappedCapabilities(tx())).toEqual(["spring-boot-transactions"]);
    expect(mappedCapabilities(skill("j", { front: "tags: [java]\n" }))).toEqual(["java-language"]);
  });
  it("applies aliases and slugs to keywords", () => {
    expect(mappedCapabilities(skill("w", { front: "keywords: [SpringBoot, Web]\n" }))).toEqual(["spring-boot-web"]);
  });
  it("reads leftover list tags next to explicit capabilities", () => {
    const s = skill("o", { front: "capabilities: [x]\nmetadata:\n  tags: [spring-boot, actuator]\n" });
    expect(mappedCapabilities(s)).toEqual(["spring-boot-observability"]);
  });
  it("reads comma-separated metadata text next to explicit capabilities", () => {
    const s = skill("o", { front: "capabilities: [x]\nmetadata:\n  tags: \"spring-boot, actuator\"\n" });
    expect(mappedCapabilities(s)).toEqual(["spring-boot-observability"]);
    const k = skill("p", { front: "capabilities: [x]\nmetadata:\n  keywords: \"Spring Boot, REST\"\n" });
    expect(mappedCapabilities(k)).toEqual(["spring-boot-web"]);
  });
  it("maps nothing for unknown tags or a half match", () => {
    expect(mappedCapabilities(skill("k", { front: "tags: [kafka]\n" }))).toEqual([]);
    expect(mappedCapabilities(skill("t", { front: "tags: [transactions]\n" }))).toEqual([]);
  });
  it("does not change the skill or its digest", () => {
    const s = tx();
    const before = JSON.stringify(s);
    const digest = s.package.digest;
    run([s]);
    expect(JSON.stringify(s)).toBe(before);
    expect(s.package.digest).toBe(digest);
  });
});

describe("the capability table", () => {
  it("maps only to capabilities of the compared built-ins", () => {
    const caps = new Set(BUILTINS.flatMap((b) => b.pkg.capabilities ?? []));
    for (const r of COMMUNITY_CAPABILITY_RULES) expect(caps.has(r.capability), r.capability).toBe(true);
  });
  it("reaches every built-in capability from its own name", () => {
    for (const cap of BUILTINS.flatMap((b) => b.pkg.capabilities ?? [])) {
      expect(COMMUNITY_CAPABILITY_RULES.some((r) => r.capability === cap && r.terms.length === 1 && r.terms[0] === cap), cap).toBe(true);
    }
  });
});

describe("the built-in adapter", () => {
  it("is a first-party, approved builtin member with the fingerprint of the given files", () => {
    const java = BUILTINS[0]!;
    const c = builtinCollisionCandidate(java);
    expect(c.skill.identity.source).toBe("builtin");
    expect(c.approved).toBe(true);
    expect(c.trust).toBe("first-party");
    expect(c.skill.identity.fingerprint).toBe(skillFingerprint(java.files));
  });
  it("refuses a built-in without its original files instead of rebuilding them", () => {
    const { files: _files, ...bare } = BUILTINS[0]!;
    expect(() => builtinCollisionCandidate(bare)).toThrow(TypeError);
  });
  it("leaves classifySkillCollisions as it was for imported skills", () => {
    const a = tx("a");
    const b = tx("b");
    const before = JSON.stringify(classifySkillCollisions([collisionCandidate(a, source()), collisionCandidate(b, source())]));
    run([a, b]);
    expect(JSON.stringify(classifySkillCollisions([collisionCandidate(a, source()), collisionCandidate(b, source())]))).toBe(before);
  });
});

describe("collisions", () => {
  it("a skill named java is a fork that does not block", () => {
    const r = run([skill("java", { front: "tags: [kafka]\n" })]);
    const c = r.collisions.find((x) => x.reason === "fork.same-name")!;
    expect(c.class).toBe("fork");
    expect(c.blocking).toBe(false);
    expect(compareLines(r).some((l) => /^COLLISION col-\S+ fork fork\.same-name .*java@1\.0\.0/.test(l))).toBe(true);
    expect(compareFailed(r)).toBe(false);
  });
  it("two imported skills for one capability overlap with the built-in", () => {
    const r = run([tx("a"), tx("b")]);
    const c = r.collisions.find((x) => x.reason === "capability.shared" && x.members.some((m) => m.id === "spring-boot"))!;
    expect(c.class).toBe("capability-overlap");
    expect(c.shared).toContain("spring-boot-transactions");
  });
  it("a verbatim copy of a shipped skill is an exact mirror, and blocks when its settings differ", () => {
    // the complete, unchanged package, skill.yaml included
    const same = skill("java", { files: shippedFiles("java") });
    const ok = run([same]);
    const mirror = ok.collisions.find((c) => c.class === "exact-mirror")!;
    expect(mirror).toBeDefined();
    expect(mirror.reason).toBe("mirror.same-content");
    expect(mirror.blocking).toBe(false);

    const shipped = shippedFiles("java").filter((x) => x.path !== "skill.yaml");
    const yaml = Buffer.from(shippedFiles("java").find((x) => x.path === "skill.yaml")!.content).toString("utf8");
    const changed = skill("java", { files: [...shipped, f("skill.yaml", yaml.replace("category: language", "category: security"))] });
    const bad = run([changed]);
    const m = bad.collisions.find((c) => c.class === "exact-mirror")!;
    expect(m.reason).toBe("mirror.settings-differ");
    expect(m.blocking).toBe(true);
    expect(compareFailed(bad)).toBe(true);
    expect(compareLines(bad).some((l) => l.startsWith("COLLISION ") && l.endsWith(" blocking"))).toBe(true);
  });
});

describe("recommendation and tier", () => {
  it("the built-in wins over a vetted community skill, one line per shared capability", () => {
    const l = lines([tx()]);
    expect(l).toContain("RECOMMEND spring-boot-transactions spring-boot@1.0.0 (trust-tier)");
    expect(l.filter((x) => /^(RECOMMEND|CONFLICT) /.test(x))).toHaveLength(1);
    expect(l.some((x) => /^SKILL \S+@\S+ vetted-community capabilities=spring-boot-transactions$/.test(x))).toBe(true);
    expect(compareFailed(run([tx()]))).toBe(false);
  });
  it("prints NO-OVERLAP for an unmapped skill and recommends nothing", () => {
    const l = lines([skill("k", { front: "tags: [kafka]\n" })]);
    expect(l.some((x) => /^NO-OVERLAP \S+$/.test(x))).toBe(true);
    expect(l.some((x) => x.startsWith("RECOMMEND"))).toBe(false);
  });
  it("an override for a skill that covers one capability picks it", () => {
    const s = tx();
    const l = lines([s], { overrides: { "spring-boot-transactions": s.identity.id } });
    expect(l).toContain(`RECOMMEND spring-boot-transactions ${s.identity.id}@${s.identity.version} (owner-override)`);
  });
  it("an override for a skill that covers two capabilities conflicts", () => {
    const s = skill("both", { front: "tags: [spring-boot, transactions, web]\n" });
    const r = run([s], { overrides: { "spring-boot-transactions": s.identity.id } });
    const l = compareLines(r);
    expect(l).toContain("CONFLICT spring-boot-transactions winners-overlap");
    expect(l).toContain("CONFLICT spring-boot-web winners-overlap");
    expect(l.some((x) => x.startsWith("NOTE skills not resolved: "))).toBe(true);
    expect(compareFailed(r)).toBe(true);
  });
  it("a disabled source or a review of another commit is discovery-only and its override is ignored", () => {
    for (const src of [source({ status: "disabled" }), source({ review: { by: "@example", on: "2026-01-01", commit: "b".repeat(40), licence: "MIT" } })]) {
      const s = tx();
      const l = compareLines(compareWithBuiltins({ source: src, skills: [s], builtins: BUILTINS, overrides: { "spring-boot-transactions": s.identity.id } }));
      expect(l.some((x) => /^SKILL \S+ discovery-only /.test(x))).toBe(true);
      expect(l).toContain("RECOMMEND spring-boot-transactions spring-boot@1.0.0 (only-candidate)");
    }
  });
});

describe("excluded skills", () => {
  it("a stale skill is excluded and the built-in is still recommended", () => {
    const s = skill("old", { front: "tags: [spring-boot, transactions]\n", yaml: "technologies: {spring-boot: '^2'}\n" });
    const l = lines([s]);
    expect(l).toContain(`EXCLUDED ${s.identity.id} stale`);
    expect(l).toContain("RECOMMEND spring-boot-transactions spring-boot@1.0.0 (only-candidate)");
    expect(l.some((x) => x.startsWith("RECOMMEND") && x.includes(s.identity.id))).toBe(false);
  });
  it("a range that cannot be read is compatibility-unchecked", () => {
    const s = skill("odd", { front: "tags: [spring-boot, transactions]\n", yaml: "technologies: {spring-boot: 'banana'}\n" });
    expect(lines([s])).toContain(`EXCLUDED ${s.identity.id} compatibility-unchecked`);
  });
  it("a skill that does not fit the project evidence is incompatible", () => {
    const s = skill("new", { front: "tags: [spring-boot, transactions]\n", yaml: "technologies: {spring-boot: '>=4.1'}\n" });
    const l = lines([s], { evidence: [{ name: "spring-boot", version: "4.0" }] });
    expect(l).toContain(`EXCLUDED ${s.identity.id} incompatible`);
  });
});

describe("order and limits", () => {
  it("gives the same lines for any order", () => {
    const skills = [tx("a"), tx("b"), skill("j", { front: "tags: [java]\n" }), skill("k", { front: "tags: [kafka]\n" })];
    const want = lines(skills);
    expect(lines([...skills].reverse(), { builtins: [...BUILTINS].reverse() })).toEqual(want);
    expect(lines([skills[2]!, skills[0]!, skills[3]!, skills[1]!])).toEqual(want);
  });
  it("refuses more skills than the collision limit", () => {
    const s = tx();
    const many = Array.from({ length: COLLISION_LIMITS.candidates + 1 }, () => s);
    expect(() => run(many)).toThrow(SkillImportError);
  });
});
