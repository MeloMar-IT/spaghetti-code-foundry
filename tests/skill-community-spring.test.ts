import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { communityPromotionCheck, type CommunityPromotionInput, type FixtureResult } from "../src/skills/community-promotion.js";
import { loadBuiltins } from "../src/skills/compare-cli.js";
import { compareLines, compareWithBuiltins } from "../src/skills/compare.js";
import { evaluateSkillRun, SkillExpectSchema, type SkillEvalRun } from "../src/skills/eval.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { reviewImport } from "../src/skills/licence-review.js";
import { normalizeImport, type NormalizedSkill } from "../src/skills/normalize.js";
import { BUILTIN_SKILLS, type RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { scanSkill } from "../src/skills/scan.js";
import { parseSources, type SkillLibrarySource } from "../src/skills/sources.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/skill-sources/", import.meta.url));
const COLLECTION = join(FIXTURES, "community-spring");
const PROJECTS = join(FIXTURES, "community-spring-projects");
const COMMIT = "c".repeat(40);
const TODAY = "2026-10-15";

function readTree(root: string): SourceTree {
  const content = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else content.set(relative(root, full).split(sep).join("/"), readFileSync(full));
    }
  };
  walk(root);
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}

const ENTRY = {
  id: "spring-agent-skills",
  repository: "https://github.com/Jiangxianze/spring-agent-skills",
  status: "enabled",
  ref: { approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
  review: { by: "@example", on: "2026-10-01", commit: COMMIT, licence: "MIT" },
};
const parsed = parseSources({ schema: 1, sources: [ENTRY] }, TODAY);
const source = parsed.manifest?.sources[0] as SkillLibrarySource;

const tree = readTree(COLLECTION);
const prep = prepareImport(source, tree);
const normalized = normalizeImport(prep);
const skills = normalized.skills;
const evidence = collectLicenceEvidence({ repositoryKey: source.repositoryKey, commit: COMMIT }, skills.map((s) => s.provenance.root), tree);
const licenceReview = reviewImport({ allow: source.licence.allow, prep, evidence });
const scans = Object.fromEntries(skills.map((s) => {
  const root = s.provenance.root;
  const own = [...prep.files].filter(([p]) => p.startsWith(root + "/")).map(([p, content]) => ({ path: p.slice(root.length + 1), content }));
  return [s.package.id, scanSkill({ root, files: own })];
}));
const BUILTINS = loadBuiltins(BUILTIN_SKILLS);
const idOf = (name: string): string => skills.find((s) => s.provenance.name === name)!.package.id;
const byId = (id: string): NormalizedSkill => skills.find((s) => s.package.id === id)!;

const input = (fixtures: Readonly<Record<string, FixtureResult>>): CommunityPromotionInput => ({
  source, record: prep.record, skills, evidence: licenceReview.evidence, retrievedAt: "2026-10-12T10:00:00Z", licenceReview,
  scans, exceptions: [], today: TODAY, builtins: BUILTINS, fixtures,
});

// Offered per project, by upstream name. The stale skill is never offered. The skills declare ">=3.2" so that they reach the
// supported Spring Boot lines in SUPPORTED_LINES (4.0 and 4.1); a range that stops at 3.x would be stale on purpose.
const MAVEN = "maven-boot3-java17";
const GRADLE = "gradle-boot3-java21";
const PLAIN = "plain-java";
const NODE = "node";
const EXPECT: Record<string, string[]> = {
  "spring-diagnosis": [MAVEN, GRADLE],
  "spring-operations": [MAVEN, GRADLE],
  "spring-boot": [MAVEN, GRADLE],
  "java-code-review": [MAVEN, GRADLE, PLAIN],
  "spring-boot2-legacy": [],
};
const NAMES = Object.keys(EXPECT);

const asRegistered = (s: NormalizedSkill): RegisteredSkill => ({
  key: `${s.package.id}@${s.package.version}`, id: s.package.id, version: s.package.version, source: "admin", label: "candidate", dir: "",
  active: true, trust: "approved", pin: "pinned", digest: s.package.digest, pkg: s.package,
});
const runOf = (ids: string[]): SkillEvalRun => ({
  status: "succeeded",
  skillLock: ids.length
    ? ({ version: 1, lockDigest: COMMIT, planHash: COMMIT, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: 10,
        skills: ids.map((id) => ({ id, version: byId(id).package.version, digest: byId(id).package.digest, selection: "requested" })) } as unknown as SkillEvalRun["skillLock"])
    : undefined,
  history: (ids.length
    ? [{ id: "impl", type: "claude", ok: true, output: "", skills: { loaded: ids.map((i) => `${i}@${byId(i).package.version}`), bytes: 100, estimatedTokens: 10, state: "loaded" } }]
    : []) as unknown as SkillEvalRun["history"],
});

/** Per project: which candidates the catalogue matches, the fixture result of each, and the decisions. */
function inProject(project: string) {
  const profile = buildRepoProfile(join(PROJECTS, project));
  const catalogue = buildSkillCatalogue({ skills: skills.map(asRegistered) }, { profile });
  const matched = new Set(skills.filter((s) => (catalogue.entries.find((e) => e.id === s.package.id)?.evidence.length ?? 0) > 0).map((s) => s.package.id));
  const fixtures: Record<string, FixtureResult> = {};
  for (const name of NAMES) {
    const id = idOf(name);
    const want = EXPECT[name]!.includes(project) ? { selected: [id] } : { absent: [id] };
    const run = runOf(matched.has(id) ? [id] : []);
    fixtures[id] = evaluateSkillRun(run, SkillExpectSchema.parse(want)).ok ? "passed" : "failed";
  }
  const decisions = communityPromotionCheck(input(fixtures));
  const offered = decisions.filter((d) => d.decision === "promotable" && matched.has(d.skill)).map((d) => d.skill);
  return { matched, fixtures, decisions, offered };
}

describe("community Spring collection", () => {
  it("is a valid enabled community source entry", () => {
    expect(parsed.problems).toEqual([]);
    expect(source.trust).toBe("community");
    expect(source.status).toBe("enabled");
  });

  it("imports five skills under an MIT licence", () => {
    expect(skills).toHaveLength(5);
    expect(licenceReview.evidence.files.some((f) => f.path === "LICENSE")).toBe(true);
  });

  it.each([MAVEN, GRADLE, PLAIN, NODE])("offers the matching promotable skills in %s", (project) => {
    const r = inProject(project);
    const expected = NAMES.filter((n) => EXPECT[n]!.includes(project)).map((n) => idOf(n)).sort();
    expect([...r.offered].sort()).toEqual(expected);
  });

  it("matches no candidate in the Node project", () => {
    expect(inProject(NODE).matched.size).toBe(0);
  });

  it.each([MAVEN, GRADLE, PLAIN, NODE])("refuses the stale skill with version-stale in %s, even with its fixture forced to passed", (project) => {
    const stale = idOf("spring-boot2-legacy");
    const r = inProject(project);
    expect(r.decisions.find((d) => d.skill === stale)!.codes).toContain("version-stale");
    const forced = communityPromotionCheck(input({ ...r.fixtures, [stale]: "passed" })).find((d) => d.skill === stale)!;
    expect(forced.decision).toBe("refused");
    expect(forced.codes).toContain("version-stale");
    expect(r.offered).not.toContain(stale);
  });

  it("does not refuse the skill that collides with the built-in for the collision alone, and recommends the built-in", () => {
    const collider = idOf("spring-boot");
    expect(collider).not.toBe("spring-boot");
    const r = inProject(MAVEN);
    const d = r.decisions.find((x) => x.skill === collider)!;
    expect(d.codes).not.toContain("collision-blocking");
    expect(d.decision).toBe("promotable");
    const lines = compareLines(compareWithBuiltins({ source, skills, builtins: BUILTINS }));
    expect(lines).toContain("RECOMMEND spring-boot-web spring-boot@1.0.0 (trust-tier)");
    expect(lines.some((l) => l.startsWith("COLLISION ") && l.includes("fork.same-name") && !l.endsWith(" blocking"))).toBe(true);
  });

  it("refuses every candidate with fixtures-missing when there are no fixture results", () => {
    const r = communityPromotionCheck(input({}));
    expect(r).toHaveLength(5);
    for (const d of r) expect(d.codes).toContain("fixtures-missing");
  });
});
