import { cpSync, mkdirSync, mkdtempSync, appendFileSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { CATALOGUE_DETAIL } from "../src/skills/catalogue-rules.js";
import { evaluateSkillRun, SkillExpectSchema, type SkillEvalRun } from "../src/skills/eval.js";
import { INTEGRATION_CAPABILITIES } from "../src/skills/integration-rules.js";
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
import { RESOLVE_DEFAULTS, UNRESOLVED_HIGH_RISK_DEFAULT } from "../src/skills/resolve-rules.js";
import { REVIEW_DEFAULTS } from "../src/skills/schema.js";
import { skillRisk } from "../src/skills/unresolved.js";

const ID = "integration-testing";
const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillit-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const skillsCfg = ConfigSchema.parse({}).skills;
const pkg = loadSkillPackage(join(BUILTIN_SKILLS, ID));
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
  return { entry: cat.entries.find((e) => e.id === ID), entries: cat.entries };
}
const pj = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

describe("integration-testing skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("quality");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.detectors).toEqual([]);
    expect(pkg.review).toBeDefined();
    // The package sorts capabilities, so compare with a sorted list.
    expect(pkg.capabilities).toEqual(
      ["rest-openapi", "kafka", "ibm-mq", "cassandra", "oracle", "integration-tests", "testcontainers"].sort(),
    );
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, ID);
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
    expect(s?.label).toBe("built-in");
    expect(existsSync(join(BUILTIN_SKILLS, ID, "SKILL.md"))).toBe(true);
  });

  it("declares every interface and database capability the candidate rules know", () => {
    for (const c of INTEGRATION_CAPABILITIES) expect(pkg.capabilities).toContain(c);
  });
});

describe("integration-testing skill: description", () => {
  it("says what it does and when it must and must not activate", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/integration tests/i);
    expect(d).toMatch(/use when a change crosses/i);
    expect(d).toMatch(/not for unit-only/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "package.json": pj({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";' }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("integration-testing skill: budgets", () => {
  it("planner: the description fits its character budget and the catalogue", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(budget("budget-planner-chars"));
    expect(budget("budget-planner-chars")).toBeLessThanOrEqual(CATALOGUE_DETAIL.full.descriptionChars);
  });

  it("coder: the context fits its budget, and the delivered block adds only the wrapper", () => {
    const b = budget("budget-coder-tokens");
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
    const wrapperAllowance = 300;
    const p = renderSkillPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
      { maxTokens: b + wrapperAllowance },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.estimatedTokens).toBeLessThanOrEqual(b + wrapperAllowance);
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
      "When this applies", "Pick the test level", "Follow the repository first", "Realistic dependencies", "Fixtures and lifecycle",
      "Cleanup", "Waiting and retries", "Failure paths", "Assertions", "Never", "CI",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

const MONO = {
  "api/package.json": pj({ kafkajs: "2" }),
  "lib/package.json": pj({ lodash: "4" }),
};
const POSITIVE: [string, Record<string, string>, { task?: string; modules?: string[] }, RegExp][] = [
  ["http", { "openapi.yaml": "openapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\npaths: {}\n", "package.json": pj({ express: "4" }) }, {}, /^rest-openapi: high confidence/],
  ["kafka", { "package.json": pj({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";' }, {}, /^kafka: high confidence/],
  ["database-oracle", { "package.json": pj({ oracledb: "6" }), "src/db.ts": 'import oracledb from "oracledb";' }, {}, /^oracle:/],
  ["database-cassandra", { "requirements.txt": "cassandra-driver==3.29.0\n" }, {}, /^cassandra:/],
  ["task-names-it", { "package.json": pj({ pg: "8" }) }, { task: "Add integration tests for the orders repository" }, /^named in the task: integration-tests/],
  ["task-names-testcontainers", { "package.json": pj({ pg: "8" }) }, { task: "Use Testcontainers for the Postgres test" }, /testcontainers/],
  ["monorepo-boundary-module", MONO, { modules: ["api"] }, /^kafka:/],
];
const NEGATIVE: [string, Record<string, string>, { task?: string; modules?: string[] }][] = [
  ["unit-only", { "package.json": pj({ lodash: "4" }), "src/sum.ts": "export const sum = (a: number, b: number) => a + b;" }, { task: "Fix the rounding in sum()" }],
  ["unit-only-java", { "pom.xml": "<project/>", "src/main/java/A.java": "class A {}" }, { task: "Rename a private method" }],
  ["monorepo-unit-module", MONO, { modules: ["lib"] }],
  ["docs", { "README.md": "# Docs" }, { task: "Update the docs" }],
  ["whole-word-task", { "package.json": pj({ lodash: "4" }) }, { task: "disintegration testing of unit helpers" }],
];

describe("integration-testing skill: selection fixtures", () => {
  it.each(POSITIVE)("positive: %s", (_n, files, opts, first) => {
    const e = entry(files, opts).entry;
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(first);
  });

  it.each(NEGATIVE)("negative: %s", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("ranks first in a Kafka repository", () => {
    const { entries } = entry({ "package.json": pj({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";' });
    expect(entries[0]?.id).toBe(ID);
  });
});

describe("integration-testing skill: integrity and resolve", () => {
  it("is pinned with the digest of the package; loading twice agrees", () => {
    pinBuiltinSkills(registry());
    expect(selectSkill(registry(), ID, pkg.version).digest).toBe(pkg.digest);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, ID)).digest).toBe(pkg.digest);
  });

  it("resolves when requested, and refuses other roles", () => {
    pinBuiltinSkills(registry());
    const r = resolveSkills(registry(), [ID]);
    expect(r.selected.map((s) => [s.id, s.reason])).toEqual([[ID, "requested"]]);
    const t = resolveSkills(registry(), [ID], { role: "tester" });
    expect(t.decisions.find((d) => d.id === ID)?.code).toBe("role");
  });

  it("a changed file is a mismatch", () => {
    const root = tmp();
    cpSync(BUILTIN_SKILLS, root, { recursive: true });
    pinBuiltinSkills(registry());
    appendFileSync(join(root, ID, "REVIEW.md"), "\n- extra\n");
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), builtinRoot: root });
    expect(findSkill(reg, ID)?.pin).toBe("mismatch");
    expect(() => selectSkill(reg, ID, "1.0.0")).toThrow(SkillIntegrityError);
    expect(resolveSkills(reg, [ID]).decisions.find((d) => d.id === ID)?.code).toBe("mismatch");
  });

  it("without a pin it is refused as unpinned", () => {
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), home: tmp() });
    try {
      selectSkill(reg, ID, "1.0.0");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SkillSelectError);
      expect((e as SkillSelectError).code).toBe("unpinned");
    }
  });

  it("counts as high risk through its kafka capability, and low with no high-risk list", () => {
    expect(skillRisk(ID, registry(), UNRESOLVED_HIGH_RISK_DEFAULT)).toBe("high");
    expect(skillRisk(ID, registry(), [])).toBe("low");
  });
});

describe("integration-testing skill: behaviour", () => {
  const coder = renderSkillPayload(
    [{ id: ID, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
    { maxTokens: RESOLVE_DEFAULTS.maxTokens },
  );
  const reviewer = renderReviewPayload(
    [{ id: ID, version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }],
    { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
  );

  it("the coder gets the instructions, the reviewer gets the checks only", () => {
    expect(coder.loaded).toEqual([`${ID}@1.0.0`]);
    expect(coder.omitted).toEqual([]);
    expect(coder.text).toContain("Pick the test level");
    expect(coder.text).not.toContain(pkg.review!.split("\n")[0]!);
    expect(reviewer.loaded).toEqual([`${ID}@1.0.0`]);
    expect(reviewer.text).toContain(`role="reviewer"`);
    expect(reviewer.text).toContain("Determinism:");
    expect(reviewer.text).not.toContain("## Waiting and retries");
  });

  // The skill is guidance only; these scenarios check that each concern is covered by an instruction and a review check.
  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["four levels", /\*\*Unit\*\*[^]*\*\*Component\*\*[^]*\*\*Contract\*\*[^]*\*\*Integration\*\*/, /unit, component, contract, integration/],
    ["arbitrary sleep", /Never sleep for a fixed time/, /fixed sleep/],
    ["shared state", /No shared mutable state between tests/, /share mutable state/],
    ["disabled test", /No disabled or skipped tests/, /disabled, skipped or commented out/],
    ["production credentials", /No production credentials/, /production credentials/],
    ["cleanup", /on every path, including failure/, /Cleanup:/],
    ["failure paths", /at least one failure for each boundary/, /Failure paths:/],
    ["assertions", /No assertion-free tests/, /Meaningful assertions:/],
    ["determinism", /Every wait has a timeout/, /Determinism:/],
    ["fixed port", /Bind to port 0/, /fixed port/],
    ["Testcontainers", /Testcontainers only when the build already has it or the task explicitly approves it/, /Testcontainers unless already present or approved/],
    ["new dependency", /Do not add a dependency/, /no new dependency/],
    ["unit-only", /Do not use it for unit-only changes/, /only where a boundary changed/],
    ["CI", /command CI already runs/, /pass in CI/],
    ["retries", /Do not retry a failing assertion/, /retry that hides/],
  ];
  it.each(SCENARIOS)("covers: %s", (_n, rule, check) => {
    expect(pkg.instructions).toMatch(rule);
    expect(pkg.review).toMatch(check);
  });

  it("a package without a rule fails the same check", () => {
    const trimmed = pkg.instructions.replace(/^- \*\*Never sleep for a fixed time\.\*\*.*$/m, "");
    expect(trimmed).not.toMatch(/Never sleep for a fixed time/);
  });

  const lock = { version: 1 as const, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: coder.estimatedTokens,
    skills: [{ id: ID, version: pkg.version, digest: pkg.digest, selection: "requested" as const }] };
  const runWith = (stepId: string, loaded: string[]): SkillEvalRun => ({
    status: "succeeded",
    skillLock: lock,
    history: [{ id: stepId, type: "claude", ok: true, output: "", skills: { loaded, bytes: coder.bytes, estimatedTokens: coder.estimatedTokens, state: "loaded" } }] as unknown as SkillEvalRun["history"],
  });
  const maxTokens = () => budget("budget-coder-tokens") + 300;

  it.each(["impl-http", "impl-kafka", "impl-db"])("a boundary task (%s) is selected, loaded and within the budget", (step) => {
    const r = evaluateSkillRun(runWith(step, coder.loaded), SkillExpectSchema.parse({ selected: [ID], max_tokens: maxTokens() }));
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("loaded");
  });

  it("a unit-only task: no lock, the skill is absent", () => {
    const r = evaluateSkillRun({ status: "succeeded", history: [] }, SkillExpectSchema.parse({ absent: [ID] }));
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("none");
  });

  it("failure: wrongly selected", () => {
    const r = evaluateSkillRun(runWith("impl-unit", coder.loaded), SkillExpectSchema.parse({ absent: [ID] }));
    expect(r.ok).toBe(false);
    expect(r.selection.unexpected).toEqual([ID]);
  });

  it("failure: in the lock but not loaded", () => {
    const r = evaluateSkillRun(runWith("impl-http", []), SkillExpectSchema.parse({ selected: [ID] }));
    expect(r.activation.status).toBe("not-loaded");
  });

  it("failure: over the token budget", () => {
    const r = evaluateSkillRun(runWith("impl-http", coder.loaded), SkillExpectSchema.parse({ selected: [ID], max_tokens: 10 }));
    expect(r.context.ok).toBe(false);
  });
});
