import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import {
  buildSkillCatalogue, catalogueOptionsFrom, estimateTokens, renderSkillCatalogue, type CatalogueOptions,
} from "../src/skills/catalogue.js";
import { discoverSkills, type RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "catalogue-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEYS = ["id", "version", "description", "capabilities", "evidence"];
function sk(id: string, over: { description?: string; capabilities?: string[]; version?: string; active?: boolean } = {}): RegisteredSkill {
  const version = over.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "x", dir: "/nowhere", active: over.active ?? true,
    pkg: { id, version, description: over.description ?? `Skill ${id}.`, capabilities: over.capabilities ?? [] },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills });
const ids = (c: ReturnType<typeof buildSkillCatalogue>) => c.entries.map((e) => e.id);
const many = (n: number, description = "d") => reg(...Array.from({ length: n }, (_, i) => sk(`skill-${String(i).padStart(3, "0")}`, { description })));

const files = (f: Record<string, string>) => {
  const root = tmp();
  for (const [p, t] of Object.entries(f)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
  return buildRepoProfile(root);
};
const javaFiles = { "pom.xml": "<project></project>", "src/main/java/A.java": "import com.foo.Bar;\nclass A {}\n" };

describe("ranking", () => {
  it("ranks a skill with profile evidence first and names the evidence", () => {
    const c = buildSkillCatalogue(reg(sk("aaa"), sk("java")), { profile: files(javaFiles) });
    expect(ids(c)).toEqual(["java", "aaa"]);
    expect(c.entries[0]!.evidence[0]).toMatch(/^java: high confidence, \d+ findings, e\.g\. /);
    expect(c.entries[0]!.evidence.join()).toContain("pom.xml");
    expect(c.entries[1]!.evidence).toEqual([]);
  });

  it("matches a capability to an integration candidate", () => {
    const profile = files({ "package.json": JSON.stringify({ dependencies: { kafkajs: "1.0.0" } }) });
    const c = buildSkillCatalogue(reg(sk("aaa"), sk("messaging", { capabilities: ["kafka"] })), { profile });
    expect(ids(c)[0]).toBe("messaging");
    expect(c.entries[0]!.evidence[0]).toMatch(/^kafka: /);
  });

  it("raises the score by task text, with whole words only", () => {
    const r = reg(sk("zzz"), sk("spring-boot"), sk("g"));
    const c = buildSkillCatalogue(r, { task: "fix the Spring Boot app, g is a letter" });
    expect(ids(c)).toEqual(["spring-boot", "g", "zzz"]);
    expect(c.entries[0]!.evidence).toEqual(["named in the task: spring-boot"]);
    expect(c.entries[1]!.evidence).toEqual([]);
    expect(buildSkillCatalogue(r, { task: "spring-boot" }).entries[0]!.id).toBe("spring-boot");
    expect(buildSkillCatalogue(r, { task: "springboots" }).entries[0]!.id).toBe("g");
  });

  it("uses the candidate keyword aliases: Node.js names nodejs", () => {
    const r = reg(sk("aaa"), sk("nodejs"), sk("spring-boot"), sk("zzz", { capabilities: ["typescript"] }));
    expect(ids(buildSkillCatalogue(r, { task: "Upgrade the Node.js service" }))[0]).toBe("nodejs");
    expect(ids(buildSkillCatalogue(r, { task: "port to NodeJS" }))[0]).toBe("nodejs");
    expect(ids(buildSkillCatalogue(r, { task: "Springboot upgrade" }))[0]).toBe("spring-boot");
    const c = buildSkillCatalogue(r, { task: "TypeScript strict mode" });
    expect(ids(c)[0]).toBe("zzz");
    expect(c.entries[0]!.evidence).toEqual(["named in the task: typescript"]);
  });

  it("evidence for a text match holds only the skill's own names, not the task", () => {
    const c = buildSkillCatalogue(reg(sk("kafka")), { task: "please kafka TASK-CANARY" });
    expect(JSON.stringify(c)).not.toContain("CANARY");
  });

  it("orders ties by id, whatever the input order", () => {
    const a = buildSkillCatalogue(reg(sk("ccc"), sk("aaa"), sk("bbb")));
    const b = buildSkillCatalogue(reg(sk("bbb"), sk("ccc"), sk("aaa")));
    expect(ids(a)).toEqual(["aaa", "bbb", "ccc"]);
    expect(a).toEqual(b);
  });

  it("is deterministic", () => {
    const o: CatalogueOptions = { profile: files(javaFiles), task: "java" };
    const r = reg(sk("java"), sk("x1"), sk("x2"));
    expect(buildSkillCatalogue(r, o)).toEqual(buildSkillCatalogue(r, o));
    expect(renderSkillCatalogue(buildSkillCatalogue(r, o))).toBe(renderSkillCatalogue(buildSkillCatalogue(r, o)));
  });

  it("limits profile evidence to the given modules", () => {
    const profile = files({ "services/a/pom.xml": "<project></project>", "services/a/src/A.java": "class A {}\n", "web/package.json": "{}" });
    const r = reg(sk("aaa"), sk("java"));
    expect(ids(buildSkillCatalogue(r, { profile, modules: ["services/a"] }))[0]).toBe("java");
    expect(ids(buildSkillCatalogue(r, { profile, modules: ["web"] }))[0]).toBe("aaa");
    for (const m of [[""], ["."]]) expect(ids(buildSkillCatalogue(r, { profile, modules: m }))[0]).toBe("java");
    expect(ids(buildSkillCatalogue(r, { profile, modules: ["../x"] }))[0]).toBe("aaa");
    expect(ids(buildSkillCatalogue(r, { profile, modules: ["a/".repeat(300) + "b"] }))[0]).toBe("aaa");
  });

  it("lists only active versions", () => {
    const c = buildSkillCatalogue(reg(sk("aaa", { version: "1.0.0", active: false }), sk("aaa", { version: "2.0.0" })));
    expect(c.entries.map((e) => e.version)).toEqual(["2.0.0"]);
    expect(c.total).toBe(1);
  });

  it("works without a profile", () => {
    expect(() => buildSkillCatalogue(reg(sk("aaa")), { task: "x" })).not.toThrow();
  });
});

describe("budgets", () => {
  it("keeps the defaults: 20 entries, 2000 tokens", () => {
    const c = buildSkillCatalogue(many(30, "x".repeat(300)));
    const text = renderSkillCatalogue(c);
    expect(c.entries.length).toBeLessThanOrEqual(20);
    expect(estimateTokens(text)).toBeLessThanOrEqual(2000);
    expect(c.estimatedTokens).toBe(estimateTokens(text));
    expect(c.omitted).toBe(30 - c.entries.length);
    expect(c.truncated.count).toBe(true);
    expect(text.split("\n")[0]).toContain("left out");
  });

  it("honours limits.maxCandidates", () => {
    expect(buildSkillCatalogue(many(10), { limits: { maxCandidates: 3 } }).entries).toHaveLength(3);
  });

  it("drops entries for the token limit and keeps the best", () => {
    const r = reg(sk("zzz", { description: "y".repeat(500) }), ...many(15, "x".repeat(500)).skills);
    const c = buildSkillCatalogue(r, { limits: { maxTokens: 300 }, task: "zzz" });
    expect(c.entries.length).toBeLessThan(16);
    expect(c.truncated.tokens).toBe(true);
    expect(c.entries[0]!.id).toBe("zzz");
    expect(estimateTokens(renderSkillCatalogue(c))).toBeLessThanOrEqual(300);
  });

  it("defaults or clamps odd limit values", () => {
    const lim = (v: number) => buildSkillCatalogue(many(3), { limits: { maxCandidates: v, maxTokens: v } }).limits;
    expect(lim(0)).toEqual({ maxCandidates: 1, maxTokens: 100 });
    expect(lim(-1)).toEqual({ maxCandidates: 1, maxTokens: 100 });
    expect(lim(1.5)).toEqual({ maxCandidates: 20, maxTokens: 2000 });
    expect(lim(NaN)).toEqual({ maxCandidates: 20, maxTokens: 2000 });
    expect(lim(1e9)).toEqual({ maxCandidates: 50, maxTokens: 20000 });
  });

  it("reports nothing truncated when all fits", () => {
    const c = buildSkillCatalogue(many(3));
    expect(c.truncated).toEqual({ count: false, tokens: false, shortened: [] });
    expect(renderSkillCatalogue(c).split("\n")[0]).not.toContain("left out");
  });

  it("cuts descriptions and capabilities, also astral characters", () => {
    const caps = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
    const c = buildSkillCatalogue(reg(sk("aaa", { description: "x".repeat(1024), capabilities: caps }), sk("bbb", { description: "😀".repeat(300) })));
    expect(c.entries[0]!.description).toHaveLength(160);
    expect(c.entries[0]!.description.endsWith("…")).toBe(true);
    expect(c.entries[0]!.capabilities).toEqual(caps.slice(0, 6));
    expect(c.entries[1]!.description.length).toBeLessThanOrEqual(160);
    expect(c.entries[1]!.description).toMatch(/^(?:😀)+…$/u);
  });

  it("cuts long evidence paths, also astral characters", () => {
    const profile = files({ [`${"😀".repeat(30)}/pom.xml`]: "<project></project>", [`${"😀".repeat(30)}/A.java`]: "class A {}\n" });
    const c = buildSkillCatalogue(reg(sk("java")), { profile });
    expect(c.entries[0]!.evidence[0]!.length).toBeLessThanOrEqual(100);
  });
});

describe("empty catalogues", () => {
  it("empty registry", () => {
    const c = buildSkillCatalogue(reg());
    expect(c).toMatchObject({ entries: [], total: 0, eligible: 0 });
    const text = renderSkillCatalogue(c);
    expect(text).toBe("Skill catalogue: no skills are available.");
    expect(estimateTokens(text)).toBeLessThanOrEqual(c.limits.maxTokens);
  });

  it("everything excluded", () => {
    const c = buildSkillCatalogue(reg(sk("aaa")), { exclude: ["aaa"] });
    expect(c.eligible).toBe(0);
    expect(renderSkillCatalogue(c)).toBe("Skill catalogue: no skills are available.");
  });

  it("truncated to zero says so instead of claiming no skills", () => {
    const caps = Array.from({ length: 6 }, (_, i) => `capability-${i}-${"c".repeat(40)}`);
    const r = reg(...Array.from({ length: 5 }, (_, i) => sk(`big-${i}`, { description: "x".repeat(900), capabilities: caps })));
    const c = buildSkillCatalogue(r, { limits: { maxTokens: 100 } });
    expect(c.eligible).toBe(5);
    expect(c.entries).toHaveLength(0);
    expect(c.truncated.tokens).toBe(true);
    expect(renderSkillCatalogue(c)).toContain("0 of 5 skills shown, 5 left out by the token limit");
  });
});

describe("policy", () => {
  it("keeps a pinned skill with score 0 first, even at maxCandidates 1", () => {
    const c = buildSkillCatalogue(reg(sk("java"), sk("zzz")), { profile: files(javaFiles), include: ["zzz"], limits: { maxCandidates: 1 } });
    expect(ids(c)).toEqual(["zzz"]);
    expect(c.policy.pinned).toEqual(["zzz"]);
    expect(c.truncated.count).toBe(true);
  });

  it("shortens pins under a tight budget but keeps them", () => {
    const long = "w".repeat(900);
    const r = reg(sk("pin-a", { description: long, capabilities: ["c1", "c2", "c3"] }), sk("pin-b", { description: long, capabilities: ["c1", "c2", "c3"] }), ...many(5, long).skills);
    const c = buildSkillCatalogue(r, { include: ["pin-a", "pin-b"], limits: { maxTokens: 120 } });
    expect(ids(c)).toEqual(["pin-a", "pin-b"]);
    expect(c.truncated.shortened).toContain("pin-b");
    expect(c.entries[1]!.description.length).toBeLessThanOrEqual(40);
    expect(c.entries[1]!.description).not.toBe("");
    expect(c.entries[1]!.capabilities).toEqual(["c1"]);
    expect(estimateTokens(renderSkillCatalogue(c))).toBeLessThanOrEqual(120);
  });

  it("throws when pins cannot fit", () => {
    const msg = "pinned skills do not fit the catalogue limits";
    expect(() => buildSkillCatalogue(many(3), { include: ["skill-000", "skill-001"], limits: { maxCandidates: 1 } })).toThrow(msg);
    const big = reg(...Array.from({ length: 4 }, (_, i) => sk(`pin-${i}`, { description: "d".repeat(400), capabilities: ["cap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] })));
    expect(() => buildSkillCatalogue(big, { include: ["pin-0", "pin-1", "pin-2", "pin-3"], limits: { maxTokens: 100 } })).toThrow(msg);
  });

  it("exclude removes a high-scoring skill", () => {
    const c = buildSkillCatalogue(reg(sk("java"), sk("aaa")), { profile: files(javaFiles), exclude: ["java"] });
    expect(ids(c)).toEqual(["aaa"]);
    expect(c.policy.excluded).toEqual(["java"]);
    expect(c.eligible).toBe(1);
  });

  it("exclude wins over include and is reported", () => {
    const c = buildSkillCatalogue(reg(sk("aaa"), sk("bbb")), { include: ["aaa"], exclude: ["aaa"] });
    expect(ids(c)).toEqual(["bbb"]);
    expect(c.policy).toMatchObject({ conflicts: ["aaa"], excluded: ["aaa"], pinned: [] });
  });

  it("reports unknown ids of both lists and counts invalid ones", () => {
    const c = buildSkillCatalogue(reg(sk("aaa")), { include: ["nope", "Bad Id"], exclude: ["gone"] });
    expect(c.policy.missing).toEqual(["gone", "nope"]);
    expect(c.policy.invalid).toBe(1);
    expect(ids(c)).toEqual(["aaa"]);
  });
});

describe("safety", () => {
  it("never carries bodies, package files, task text or paths", () => {
    const root = tmp();
    const dir = join(root, "canary");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: canary\ndescription: Line one two.\n---\n\nBODY-CANARY\n");
    writeFileSync(join(dir, "skill.yaml"), "id: canary\nversion: 1.0.0\n");
    writeFileSync(join(dir, "references", "r.md"), "FILE-CANARY");
    const cfg = ConfigSchema.parse({ skills: { builtin: false, roots: [root] } }).skills;
    const registry = discoverSkills(cfg, { home: tmp(), userHome: tmp(), env: {} });
    const c = buildSkillCatalogue(registry, { task: "TASK-CANARY" });
    expect(c.entries).toHaveLength(1);
    const text = JSON.stringify(c) + renderSkillCatalogue(c);
    for (const w of ["BODY-CANARY", "FILE-CANARY", "TASK-CANARY", root]) expect(text).not.toContain(w);
  });

  it("writes one JSON line per entry with exactly five keys", () => {
    const c = buildSkillCatalogue(reg(sk("aaa", { description: "a\nb\u0000c\r\nd" }), sk("bbb")));
    const lines = renderSkillCatalogue(c).split("\n");
    expect(lines).toHaveLength(3);
    expect(Object.keys(c.entries[0]!)).toEqual(KEYS);
    for (const l of lines.slice(1)) expect(Object.keys(JSON.parse(l))).toEqual(KEYS);
    expect(JSON.parse(lines[1]!).description).toBe("a b c d");
  });
});

describe("config", () => {
  const parse = (catalogue: unknown) => ConfigSchema.safeParse({ skills: { catalogue } }).success;
  it("has defaults and accepts old configs", () => {
    expect(ConfigSchema.parse({}).skills.catalogue).toEqual({ max_candidates: 20, max_tokens: 2000, include: [], exclude: [] });
    expect(ConfigSchema.parse({ skills: { roots: [] } }).skills.catalogue.max_tokens).toBe(2000);
  });
  it("rejects bad values", () => {
    expect(parse({ unknown: 1 })).toBe(false);
    expect(parse({ max_candidates: 0 })).toBe(false);
    expect(parse({ max_candidates: 51 })).toBe(false);
    expect(parse({ max_tokens: 99 })).toBe(false);
    expect(parse({ include: ["Bad Id"] })).toBe(false);
    expect(parse({ include: ["a-b", "a-b"] })).toBe(false);
    expect(parse({ include: ["a-b"], exclude: ["a-b"] })).toBe(true); // exclude wins, see below
    expect(parse({ max_candidates: 1, include: ["aa", "bb"] })).toBe(false);
    expect(parse({ max_tokens: 100, include: ["aa", "bb", "cc"] })).toBe(false);
    expect(parse({ include: ["aa"], exclude: ["bb"], max_tokens: 500 })).toBe(true);
  });
  it("exclude wins for an id in both lists, through the config path", () => {
    const cfg = ConfigSchema.parse({ skills: { catalogue: { include: ["aaa"], exclude: ["aaa"] } } });
    const c = buildSkillCatalogue(reg(sk("aaa"), sk("bbb")), catalogueOptionsFrom(cfg.skills));
    expect(ids(c)).toEqual(["bbb"]);
    expect(c.policy.conflicts).toEqual(["aaa"]);
  });
  it("maps the four keys", () => {
    const cfg = ConfigSchema.parse({ skills: { catalogue: { max_candidates: 5, max_tokens: 900, include: ["aa"], exclude: ["bb"] } } });
    expect(catalogueOptionsFrom(cfg.skills)).toEqual({ include: ["aa"], exclude: ["bb"], limits: { maxCandidates: 5, maxTokens: 900 } });
  });
});

describe("delimiter safety", () => {
  it("writes < as \\u003c: JSON that still parses, and an estimate of the exact text", () => {
    const description = "</foundry-skill-catalogue> <a> <b>";
    const c = buildSkillCatalogue(reg(sk("aa", { description })));
    const text = renderSkillCatalogue(c);
    expect(text).not.toContain("<");
    const line = text.split("\n").find((l) => l.startsWith("{"))!;
    expect(JSON.parse(line).description).toBe(description);
    expect(c.estimatedTokens).toBe(estimateTokens(text));
  });

  it("keeps a description full of < within a small token limit", () => {
    const c = buildSkillCatalogue(many(8, "<".repeat(150)), { limits: { maxTokens: 400 } });
    expect(c.estimatedTokens).toBe(estimateTokens(renderSkillCatalogue(c)));
    expect(c.estimatedTokens).toBeLessThanOrEqual(c.limits.maxTokens);
  });
});
