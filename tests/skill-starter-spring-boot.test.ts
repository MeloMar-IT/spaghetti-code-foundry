import { cpSync, mkdirSync, mkdtempSync, appendFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
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
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillboot-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const ID = "spring-boot";
const skillsCfg = ConfigSchema.parse({}).skills;
const pkg = loadSkillPackage(join(BUILTIN_SKILLS, ID));
const java = loadSkillPackage(join(BUILTIN_SKILLS, "java"));
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
type Opts = { task?: string; modules?: string[] };
function entry(files: Record<string, string>, opts: Opts = {}) {
  const cat = buildSkillCatalogue(registry(), { profile: profileOf(files), ...opts });
  return { entry: cat.entries.find((e) => e.id === ID), java: cat.entries.find((e) => e.id === "java"), entries: cat.entries };
}
const pom = (...deps: string[]) =>
  `<project><dependencies>${deps.map((d) => `<dependency><groupId>${d.split(":")[0]}</groupId><artifactId>${d.split(":")[1]}</artifactId></dependency>`).join("")}</dependencies></project>`;

describe("spring-boot skill: schema", () => {
  it("loads with the declared manifest and the java dependency", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("platform");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.files.references).toEqual([]);
    expect(pkg.dependencies).toEqual([{ id: "java", min_version: "1.0.0" }]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
    expect(pkg.capabilities.every((c) => c.startsWith("spring-boot-"))).toBe(true);
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, ID);
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
    expect(s?.label).toBe("built-in");
  });
});

describe("spring-boot skill: description", () => {
  it("says when it applies and when it does not", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/use for modules with a spring boot dependency/i);
    expect(d).toMatch(/not plain java or plain spring/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "pom.xml": pom("org.springframework.boot:spring-boot-starter-web"), "src/A.java": "class A {}\n" }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("spring-boot skill: budgets", () => {
  it("planner: the description fits its character budget and the catalogue", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(budget("budget-planner-chars"));
    expect(budget("budget-planner-chars")).toBeLessThanOrEqual(CATALOGUE_DETAIL.full.descriptionChars);
  });

  it("coder: the context fits its budget, alone and together with the java skill", () => {
    const b = budget("budget-coder-tokens");
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
    expect(skillContextTokens(pkg) + skillContextTokens(java)).toBeLessThan(RESOLVE_DEFAULTS.maxTokens);
    const p = renderSkillPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
      { maxTokens: b + 300 },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
  });

  it("reviewer: the delivered section is loaded under the declared per-skill budget", () => {
    const b = budget("budget-reviewer-tokens");
    expect(b).toBeLessThan(REVIEW_DEFAULTS.maxSkillTokens);
    const p = renderReviewPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: b },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.omitted).toEqual([]);
  });

  it("covers every topic", () => {
    for (const h of [
      "When this applies", "Follow the application first", "Dependency injection", "Configuration properties and profiles",
      "Controllers and validation", "Services and transactions", "Exception handling", "Observability", "Tests and test slices",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

// One repository, three modules: an MVC module, a service-only module and a module without Spring Boot.
const CONTROLLER = "package shop.web;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\nclass OrderController {}\n";
const SERVICE = "package shop.billing;\nimport org.springframework.stereotype.Service;\nimport org.springframework.transaction.annotation.Transactional;\n@Service\nclass InvoiceService {}\n";
const MONO = {
  "web/pom.xml": pom("org.springframework.boot:spring-boot-starter-web", "org.springframework.boot:spring-boot-starter-validation"),
  "web/src/main/java/shop/web/OrderController.java": CONTROLLER,
  "billing/pom.xml": pom("org.springframework.boot:spring-boot-starter", "org.springframework.boot:spring-boot-starter-data-jpa"),
  "billing/src/main/java/shop/billing/InvoiceService.java": SERVICE,
  "tools/pom.xml": pom("com.google.guava:guava"),
  "tools/src/main/java/shop/tools/CsvExport.java": "package shop.tools;\nimport com.google.common.base.Joiner;\nclass CsvExport {}\n",
};
const POSITIVE: [string, Record<string, string>, Opts][] = [
  ["mvc: single module, Maven", { "pom.xml": MONO["web/pom.xml"], "src/main/java/shop/web/OrderController.java": CONTROLLER }, { task: "Add an endpoint that cancels an order" }],
  ["mvc: module of a mono-repository", MONO, { modules: ["web"], task: "Validate the request body of the order endpoint" }],
  ["service-only: no web starter, no controller", { "pom.xml": MONO["billing/pom.xml"], "src/main/java/shop/billing/InvoiceService.java": SERVICE }, { task: "Make invoice numbering transactional" }],
  ["service-only: module of a mono-repository", MONO, { modules: ["billing"] }],
  ["gradle plugin and starter", { "build.gradle": "dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'\n}\n", "src/main/java/App.java": "import org.springframework.boot.SpringApplication;\nclass App {}\n" }, {}],
];
const NEGATIVE: [string, Record<string, string>, Opts][] = [
  ["unrelated module of the same repository", MONO, { modules: ["tools"], task: "Fix the separator of the CSV export" }],
  ["plain Java, Maven", { "pom.xml": pom("com.google.guava:guava"), "src/main/java/app/App.java": "package app;\nimport com.google.common.base.Joiner;\nclass App {}\n" }, { task: "Fix the Java service that builds the report" }],
  ["plain Java, sources only", { "src/Hello.java": "class Hello {}\n" }, {}],
  ["plain Spring without Boot", { "pom.xml": pom("org.springframework:spring-context"), "src/A.java": "import org.springframework.context.ApplicationContext;\nclass A {}\n" }, {}],
  ["Node.js service", { "package.json": JSON.stringify({ dependencies: { express: "4" } }), "src/index.js": "module.exports = {};\n" }, { task: "Boot the server faster in spring" }],
];

describe("spring-boot skill: selection fixtures", () => {
  it.each(POSITIVE)("positive: %s", (_n, files, opts) => {
    const { entry: e, java: j, entries } = entry(files, opts);
    expect(e?.evidence[0]).toMatch(/^spring-boot: high confidence/);
    // The language skill it depends on is a candidate for the same work.
    expect(j?.evidence[0]).toMatch(/^java: /);
    const ids = entries.map((x) => x.id);
    expect(ids.indexOf(ID)).toBeLessThan(ids.indexOf("small-changes"));
  });

  it.each(NEGATIVE)("negative: %s", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("plain Java still activates the java skill, and only that", () => {
    const { entry: e, java: j } = entry(NEGATIVE[1]![1], NEGATIVE[1]![2]);
    expect(e?.evidence).toEqual([]);
    expect(j?.evidence.length).toBeGreaterThan(0);
  });

  it("the unrelated module keeps java evidence from its own files", () => {
    const { entry: e, java: j } = entry(MONO, { modules: ["tools"] });
    expect(e?.evidence).toEqual([]);
    expect(j?.evidence[0]).toContain("tools/");
  });

  it("the evidence of a module names a file of that module", () => {
    expect(entry(MONO, { modules: ["web"] }).entry?.evidence[0]).toContain("web/");
    expect(entry(MONO, { modules: ["billing"] }).entry?.evidence[0]).toContain("billing/");
  });

  it("a task that names Spring Boot names the skill; Java or Spring alone do not", () => {
    const files = NEGATIVE[1]![1];
    expect(entry(files, { task: "Move this tool to Spring Boot" }).entry?.evidence).toEqual(["named in the task: spring-boot"]);
    expect(entry(files, { task: "Clean up the Java code before spring" }).entry?.evidence).toEqual([]);
  });
});

describe("spring-boot skill: integrity and resolve", () => {
  it("the pin matches the package digest", () => {
    pinBuiltinSkills(registry());
    expect(selectSkill(registry(), ID, "1.0.0").digest).toBe(pkg.digest);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, ID)).digest).toBe(pkg.digest);
  });

  it("brings the java skill with it, java first, and is refused for another role", () => {
    pinBuiltinSkills(registry());
    const r = resolveSkills(registry(), [ID]);
    expect(r.selected.map((s) => [s.id, s.reason, s.requiredBy])).toEqual([["java", "dependency", [ID]], [ID, "requested", []]]);
    const both = resolveSkills(registry(), ["java", ID]);
    expect(both.selected.map((s) => [s.id, s.reason])).toEqual([["java", "requested"], [ID, "requested"]]);
    const t = resolveSkills(registry(), [ID], { role: "tester" });
    expect(t.decisions.find((d) => d.id === ID)?.code).toBe("role");
  });

  it("is not selected without a usable java skill", () => {
    const builtinRoot = tmp();
    cpSync(join(BUILTIN_SKILLS, ID), join(builtinRoot, ID), { recursive: true });
    const reg = () => discoverSkills(skillsCfg, { env: {}, userHome: tmp(), builtinRoot });
    pinBuiltinSkills(reg());
    const r = resolveSkills(reg(), [ID]);
    expect(r.selected).toEqual([]);
    expect(r.decisions.find((d) => d.id === ID)?.code).toBe("dependency-unavailable");
  });

  it("a changed file is a mismatch", () => {
    const builtinRoot = tmp();
    const opts = { env: {}, userHome: tmp() };
    pinBuiltinSkills(discoverSkills(skillsCfg, { ...opts, builtinRoot: BUILTIN_SKILLS }));
    cpSync(join(BUILTIN_SKILLS, ID), join(builtinRoot, ID), { recursive: true });
    appendFileSync(join(builtinRoot, ID, "SKILL.md"), "\n- Extra line.\n");
    const reg = discoverSkills(skillsCfg, { ...opts, builtinRoot });
    expect(findSkill(reg, ID)?.pin).toBe("mismatch");
    expect(() => selectSkill(reg, ID, "1.0.0")).toThrow(SkillIntegrityError);
    expect(resolveSkills(reg, [ID]).decisions.find((d) => d.id === ID)?.code).toBe("mismatch");
  });

  it("an unpinned built-in cannot be selected", () => {
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), home: tmp() });
    try {
      selectSkill(reg, ID, "1.0.0");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SkillSelectError);
      expect((e as SkillSelectError).code).toBe("unpinned");
    }
  });
});

const row = (p: typeof pkg, selection: "requested" | "dependency", requiredBy: string[] = []) =>
  ({ id: p.id, version: p.version, digest: p.digest, selection, requiredBy, description: p.description, instructions: p.instructions });

describe("spring-boot skill: behaviour", () => {
  const coder = renderSkillPayload([row(java, "dependency", [ID]), row(pkg, "requested")], { maxTokens: RESOLVE_DEFAULTS.maxTokens });

  it("the coder block holds both skills' instructions and not the review checks", () => {
    expect(coder.loaded).toEqual(["java@1.0.0", `${ID}@1.0.0`]);
    expect(coder.omitted).toEqual([]);
    expect(coder.text).toContain("## Services and transactions");
    expect(coder.text).toContain("## Null handling");
    expect(coder.text).not.toContain(pkg.review!.split("\n")[0]!);
  });

  it("the reviewer block holds the review checks and not the instructions", () => {
    const p = renderReviewPayload(
      [{ id: ID, version: "1.0.0", digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.text).toContain('role="reviewer"');
    expect(p.text).toContain("Transaction boundaries:");
    expect(p.text).not.toContain("## Observability");
  });

  it("the reviewer checks name transaction boundaries, configuration safety, validation and test coverage", () => {
    for (const topic of [/^- Transaction boundaries:/m, /^- Configuration safety:/m, /^- Validation:/m, /^- Test coverage:/m]) expect(pkg.review).toMatch(topic);
  });

  // The skill is guidance only; each scenario checks that a concern has an instruction and a review check.
  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["field injection", /Use constructor injection with `final` fields\. No field injection/, /constructor injection only\? Is there a new field injection/],
    ["hidden cycle", /do not hide it with `@Lazy`/, /cycle hidden with `@Lazy`/],
    ["unrequested starter", /Do not add or remove a starter, change the Boot version/, /add no starter, dependency, Boot version or framework change the task did not ask for/],
    ["mixed stacks", /`javax\.\*` or `jakarta\.\*`, MVC or WebFlux[^]*Do not mix them/, /existing patterns/],
    ["new setting", /Bind new settings with `@ConfigurationProperties`[^]*validated with `@Validated`/, /new settings bound and validated/],
    ["committed secret", /Never commit a secret, password, token or real host/, /secret or real host committed/],
    ["unsafe shared configuration", /no `ddl-auto: create`, exposed actuator endpoints, disabled security or debug logging/, /schema creation, open actuator endpoints, disabled security, debug logging/],
    ["profile for logic", /Profiles choose environment settings, not business logic/, /profile used for business logic/],
    ["fat controller", /no business rules, no repository access, no transaction/, /controller hold business rules, repository access or a transaction/],
    ["missing validation", /`@Valid` \(or `@Validated`\) on every request body[^]*Nested objects need `@Valid`/, /every new request body have `@Valid` and constraints, also on nested objects/],
    ["transaction boundary", /on the public service method that is the unit of work, not on controllers or repositories/, /on the public service method that is the unit of work/],
    ["self-invocation", /do nothing on a `private` method or on a call from the same class/, /lost by a call from the same class or a `private` method/],
    ["checked exception rollback", /rollback happens for unchecked exceptions only[^]*`rollbackFor`/, /checked or caught exception skip the rollback/],
    ["remote call in a transaction", /No remote call, message send or long wait inside a transaction/, /remote call or message sent inside the transaction/],
    ["error path", /one error path \(`@RestControllerAdvice`, `ProblemDetail`/, /400 through the application's error path, without stack traces/],
    ["log content", /no secrets or personal data in logs/, /logs free of secrets and personal data/],
    ["metric tags", /tags of low cardinality: never an id/, /low-cardinality tags/],
    ["test level", /`@WebMvcTest`[^]*`@DataJpaTest`[^]*`@SpringBootTest` only for wiring/, /the right slice, `@SpringBootTest` only for wiring/],
    ["rollback test", /a test that proves the rollback or the commit/, /for a transaction, the rollback/],
    ["blocking in WebFlux", /never block[^]*event-loop thread/, /blocking call in WebFlux code/],
    ["other skills", /HTTP contracts, messaging and database specifics live in their own skills/, /language checks to the `java` skill, and protocol and database checks to their own skills/],
  ];
  it.each(SCENARIOS)("covers: %s", (_n, rule, check) => {
    expect(pkg.instructions).toMatch(rule);
    expect(pkg.review).toMatch(check);
  });

  it("a removed rule is noticed", () => {
    const cut = pkg.instructions.split("\n").filter((l) => !l.includes("No field injection")).join("\n");
    expect(cut).not.toMatch(SCENARIOS[0]![1]);
  });

  it("does not tell the agent to use field injection anywhere", () => {
    const lines = `${pkg.instructions}\n${pkg.review}`.split("\n").filter((l) => /field injection|@Autowired/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/No field injection|needs no `@Autowired`|new field injection/);
  });

  const lock = (ids: string[]) => ({
    version: 1 as const, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: coder.estimatedTokens,
    skills: ids.map((id) => ({ id, version: "1.0.0", digest: pkg.digest, selection: (id === "java" && ids.includes(ID) ? "dependency" : "requested") as "dependency" | "requested" })),
  });
  const runOf = (ids: string[]): SkillEvalRun => ({
    status: "succeeded",
    skillLock: ids.length ? lock(ids) : undefined,
    history: (ids.length
      ? [{ id: "impl", type: "claude", ok: true, output: "", skills: { loaded: ids.map((i) => `${i}@1.0.0`), bytes: coder.bytes, estimatedTokens: coder.estimatedTokens, state: "loaded" } }]
      : []) as unknown as SkillEvalRun["history"],
  });
  const ev = (r: SkillEvalRun, e: object) => evaluateSkillRun(r, SkillExpectSchema.parse(e));
  const withBlock = () => budget("budget-coder-tokens") + Number(java.metadata?.["budget-coder-tokens"]) + 300;

  it("evaluation, MVC or service-only task: spring-boot and java are selected, loaded and within the budget", () => {
    const r = ev(runOf(["java", ID]), { selected: [ID, "java"], absent: ["typescript"], max_tokens: withBlock() });
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("loaded");
  });

  it("evaluation, unrelated-module task: a plain Java run must not have spring-boot", () => {
    const plain = runOf(["java"]);
    expect(ev(plain, { selected: ["java"], absent: [ID] }).ok).toBe(true);
    expect(ev(runOf(["java", ID]), { selected: ["java"], absent: [ID] }).ok).toBe(false);
    expect(ev(plain, { selected: [ID] }).ok).toBe(false);
  });

  it("evaluation, no skills at all: absent is fine", () => {
    const none = ev(runOf([]), { absent: [ID] });
    expect(none.ok).toBe(true);
    expect(none.activation.status).toBe("none");
  });
});
