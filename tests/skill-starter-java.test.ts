import { cpSync, mkdirSync, mkdtempSync, appendFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { buildSkillCatalogue, estimateTokens } from "../src/skills/catalogue.js";
import { CATALOGUE_DETAIL } from "../src/skills/catalogue-rules.js";
import { evaluateSkillRun, SkillExpectSchema, type SkillEvalRun } from "../src/skills/eval.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { renderReviewPayload, renderSkillPayload } from "../src/skills/payload.js";
import {
  BUILTIN_SKILLS,
  clearSkillRegistryCache,
  discoverSkills,
  findSkill,
  pinBuiltinSkills,
  selectSkill,
  SkillIntegrityError,
  SkillSelectError,
} from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { resolveSkills, skillContextTokens } from "../src/skills/resolve.js";
import { RESOLVE_DEFAULTS } from "../src/skills/resolve-rules.js";
import { REVIEW_DEFAULTS } from "../src/skills/schema.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skilljava-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const skillsCfg = ConfigSchema.parse({}).skills;
const pkg = loadSkillPackage(join(BUILTIN_SKILLS, "java"));
const registry = () => discoverSkills(skillsCfg, { env: {}, userHome: tmp() });
const budget = (key: string): number => {
  const v = Number(pkg.metadata?.[key]);
  expect(Number.isInteger(v) && v > 0).toBe(true);
  return v;
};

function profileOf(files: Record<string, string>) {
  const root = tmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return buildRepoProfile(root);
}
function entry(files: Record<string, string>, opts: { task?: string; modules?: string[] } = {}) {
  const cat = buildSkillCatalogue(registry(), { profile: profileOf(files), ...opts });
  return { entry: cat.entries.find((e) => e.id === "java"), entries: cat.entries };
}

describe("java skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe("java");
    expect(pkg.version).toMatch(/^1\.0\.0$/);
    expect(pkg.category).toBe("language");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, "java");
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
  });
});

describe("java skill: description", () => {
  it("says what it does and when it must and must not activate", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/java/i);
    expect(d).toMatch(/use for java sources or java builds/i);
    expect(d).toMatch(/not kotlin\/scala-only or non-java/i);
    expect(d.toLowerCase()).not.toContain("spring");
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "pom.xml": "<project/>", "src/A.java": "class A {}" }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("java skill: budgets", () => {
  it("planner: the description fits its character budget and the catalogue", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(budget("budget-planner-chars"));
    expect(budget("budget-planner-chars")).toBeLessThanOrEqual(CATALOGUE_DETAIL.full.descriptionChars);
  });

  it("coder: the context fits its budget, and the delivered block adds only the wrapper", () => {
    const b = budget("budget-coder-tokens");
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
    const wrapperAllowance = 300; // intro text, tags and digest
    const p = renderSkillPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
      { maxTokens: b + wrapperAllowance },
    );
    expect(p.loaded).toEqual(["java@1.0.0"]);
    expect(p.estimatedTokens).toBeLessThanOrEqual(b + wrapperAllowance);
  });

  it("reviewer: the delivered section is loaded under the declared per-skill budget", () => {
    const b = budget("budget-reviewer-tokens");
    expect(b).toBeLessThan(REVIEW_DEFAULTS.maxSkillTokens);
    const p = renderReviewPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: b },
    );
    expect(p.loaded).toEqual(["java@1.0.0"]);
    expect(p.omitted).toEqual([]);
  });

  it("keeps to the conventions and covers every topic", () => {
    expect(pkg.instructions).toMatch(/do not add a dependency/i);
    expect(pkg.instructions).toContain("wrapper");
    expect(pkg.instructions).toMatch(/own skills/i);
    expect(pkg.review).toMatch(/dependency/i);
    for (const h of [
      "When this applies", "Follow the repository first", "Source and runtime version", "API compatibility", "Null handling",
      "Exceptions", "Resources", "Concurrency", "Collections and streams", "Tests (JUnit)",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

const POM = "<project><dependencies/></project>";
const MONO = {
  "billing/pom.xml": POM, "billing/src/A.java": "class A {}",
  "mobile/build.gradle.kts": "plugins { kotlin(\"jvm\") }", "mobile/src/Main.kt": "fun main() {}",
};
const POSITIVE: [string, Record<string, string>, { task?: string; modules?: string[] }, "high" | "medium" | "low" | undefined][] = [
  ["plain-maven", { "pom.xml": POM, "src/main/java/app/App.java": "package app;\nimport com.foo.Bar;\nclass App {}" }, {}, "high"],
  ["plain-gradle", { "build.gradle": "plugins { id 'java' }", "src/App.java": "class App {}" }, {}, "high"],
  ["plain-sources-only", { "src/Hello.java": "class Hello {}" }, {}, "low"],
  ["mixed-same-module", { "build.gradle.kts": "plugins { kotlin(\"jvm\") }", "src/main/kotlin/Main.kt": "fun main() {}", "src/main/java/Legacy.java": "class Legacy {}" }, {}, undefined],
  ["mixed-monorepo-java-module", MONO, { modules: ["billing"] }, undefined],
];
const NEGATIVE: [string, Record<string, string>, { task?: string; modules?: string[] }][] = [
  ["mixed-monorepo-kotlin-module", MONO, { modules: ["mobile"] }],
  ["kotlin-only-maven", { "pom.xml": POM, "src/main/kotlin/Main.kt": "fun main() {}" }, {}],
  ["typescript-node", { "package.json": JSON.stringify({ dependencies: { typescript: "5", express: "4" } }), "src/index.ts": "export {};" }, { task: "Fix the JavaScript build" }],
  ["python-docs", { "README.md": "# Docs", "app.py": "print(1)" }, { task: "Update the docs" }],
];

describe("java skill: selection fixtures", () => {
  it.each(POSITIVE)("positive: %s", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(/^java: (high|medium|low) confidence/);
    if (conf) expect(e?.evidence[0]).toContain(`java: ${conf} confidence`);
    if (conf === "high") expect(entries[0]?.id).toBe("java");
  });

  it.each(NEGATIVE)("negative: %s", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("a Spring Boot repository still gives java evidence, and none for spring-boot", () => {
    const { entry: e } = entry({
      "pom.xml": "<project><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></project>",
      "src/main/java/App.java": "import org.springframework.boot.SpringApplication;\nclass App {}",
    });
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence.some((l) => l.startsWith("spring-boot"))).toBe(false);
  });
});

describe("java skill: integrity and resolve", () => {
  it("is pinned with the digest of the package; loading twice agrees", () => {
    pinBuiltinSkills(registry());
    expect(selectSkill(registry(), "java", pkg.version).digest).toBe(pkg.digest);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, "java")).digest).toBe(pkg.digest);
  });

  it("resolves when requested, and refuses other roles", () => {
    pinBuiltinSkills(registry());
    const r = resolveSkills(registry(), ["java"]);
    expect(r.selected.map((s) => [s.id, s.reason])).toEqual([["java", "requested"]]);
    const t = resolveSkills(registry(), ["java"], { role: "tester" });
    expect(t.decisions.find((d) => d.id === "java")?.code).toBe("role");
  });

  it("a changed file is a mismatch", () => {
    const root = tmp();
    cpSync(join(BUILTIN_SKILLS, "java"), join(root, "java"), { recursive: true });
    cpSync(join(BUILTIN_SKILLS, "small-changes"), join(root, "small-changes"), { recursive: true });
    pinBuiltinSkills(registry());
    appendFileSync(join(root, "java", "SKILL.md"), "\n- extra\n");
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), builtinRoot: root });
    expect(findSkill(reg, "java")?.pin).toBe("mismatch");
    expect(() => selectSkill(reg, "java", "1.0.0")).toThrow(SkillIntegrityError);
    expect(resolveSkills(reg, ["java"]).decisions.find((d) => d.id === "java")?.code).toBe("mismatch");
  });

  it("without a pin it is refused as unpinned", () => {
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), home: tmp() });
    try {
      selectSkill(reg, "java", "1.0.0");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SkillSelectError);
      expect((e as SkillSelectError).code).toBe("unpinned");
    }
  });
});

describe("java skill: behaviour", () => {
  const coder = renderSkillPayload(
    [{ id: "java", version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
    { maxTokens: RESOLVE_DEFAULTS.maxTokens },
  );
  const reviewer = renderReviewPayload(
    [{ id: "java", version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }],
    { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
  );

  it("the coder gets the instructions, the reviewer gets the checks only", () => {
    expect(coder.loaded).toEqual(["java@1.0.0"]);
    expect(coder.omitted).toEqual([]);
    expect(coder.text).toContain("Follow the repository first");
    expect(coder.text).not.toContain(pkg.review!.split("\n")[0]!);
    expect(reviewer.loaded).toEqual(["java@1.0.0"]);
    expect(reviewer.text).toContain(`role="reviewer"`);
    expect(reviewer.text).toContain("Does the change follow the repository's conventions");
    expect(reviewer.text).not.toContain("## Concurrency");
  });

  // The skill is guidance only; these scenarios check that each Java concern is covered by an instruction and a review check.
  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["public API change", /Do not remove, rename or change signatures/, /breaks callers/],
    ["null result", /not `null`/, /`null` reach a dereference/],
    ["swallowed exception", /Never swallow an exception/, /swallowed/],
    ["unclosed resource", /try-with-resources/, /AutoCloseable/],
    ["shared state", /one thread-safety strategy[^]*atomics[^]*same lock/, /consistent thread-safety strategy/],
    ["API baseline", /`source`\/`target` alone do not limit JDK APIs; `--release`/, /`release`, or the stated minimum runtime/],
    ["mixed module build settings", /build and test settings that affect Java; not to Kotlin/, /Java level change/],
    ["legacy JUnit", /only if the installed JUnit or assertion library has it \(JUnit 4\.13\+, 5\)[^]*repository's own way/, /project's JUnit version/],
    ["exposed collection", /Do not expose internal mutable collections/, /exposed/],
    ["sleeping test", /No `Thread.sleep`/, /sleeps/],
    ["new dependency", /Do not add a dependency/, /dependency/],
  ];
  it.each(SCENARIOS)("covers: %s", (_n, rule, check) => {
    expect(pkg.instructions).toMatch(rule);
    expect(pkg.review).toMatch(check);
  });

  it("a package without a rule fails the same check", () => {
    const trimmed = pkg.instructions.replace(/^- No `Thread.sleep`.*$/m, "");
    expect(trimmed).not.toMatch(/No `Thread.sleep`/);
  });

  const lock = { version: 1 as const, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: coder.estimatedTokens,
    skills: [{ id: "java", version: pkg.version, digest: pkg.digest, selection: "requested" as const }] };
  const javaRun: SkillEvalRun = {
    status: "succeeded",
    skillLock: lock,
    history: [{ id: "impl", type: "claude", ok: true, output: "", skills: { loaded: coder.loaded, bytes: coder.bytes, estimatedTokens: coder.estimatedTokens, state: "loaded" } }] as unknown as SkillEvalRun["history"],
  };

  it("a Java run is selected, loaded and within the budget", () => {
    const r = evaluateSkillRun(javaRun, SkillExpectSchema.parse({ selected: ["java"], absent: ["spring-boot"], max_tokens: budgetCoderWithBlock() }));
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("loaded");
  });

  it("failure: a Java run fails an expectation that java is absent", () => {
    expect(evaluateSkillRun(javaRun, SkillExpectSchema.parse({ absent: ["java"] })).ok).toBe(false);
  });

  it("non-Java work: no lock, java absent is fine", () => {
    const r = evaluateSkillRun({ status: "succeeded", history: [] }, SkillExpectSchema.parse({ absent: ["java"] }));
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("none");
  });

  function budgetCoderWithBlock(): number {
    return budget("budget-coder-tokens") + 300;
  }
});
