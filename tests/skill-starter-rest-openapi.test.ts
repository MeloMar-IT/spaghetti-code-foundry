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
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillrest-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const ID = "rest-openapi";
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
const npm = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps, devDependencies: dev });

describe("rest-openapi skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("interface");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.files.references).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
    expect(pkg.capabilities).toEqual(["http-api", "openapi", "rest-api", "rest-contract", "swagger"]);
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

describe("rest-openapi skill: description", () => {
  it("says when it applies and when it does not", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/use when routes, clients or openapi files change/i);
    expect(d).toMatch(/not for internal-only changes/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "package.json": npm({ express: "4" }), "openapi.yaml": "openapi: 3.0.0\n" }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("rest-openapi skill: budgets", () => {
  it("planner: the description fits its character budget and the catalogue", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(budget("budget-planner-chars"));
    expect(budget("budget-planner-chars")).toBeLessThanOrEqual(CATALOGUE_DETAIL.full.descriptionChars);
  });

  it("coder: the context fits its budget, and the delivered block adds only the wrapper", () => {
    const b = budget("budget-coder-tokens");
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
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
      "When this applies", "Keep contract and implementation in sync", "Resources, methods and status codes", "Validation", "Errors",
      "Pagination", "Idempotency", "Compatibility and versioning", "Security boundaries", "Tests", "Focused notes",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

const MONO = {
  "api/package.json": npm({ express: "4" }), "api/openapi.yaml": "openapi: 3.0.0\n", "api/src/app.ts": "export {};\n",
  "worker/package.json": npm({ lodash: "4" }), "worker/src/job.ts": "export {};\n",
};
const POSITIVE: [string, Record<string, string>, { task?: string; modules?: string[] }, string][] = [
  ["server-express-spec", { "package.json": npm({ express: "4" }), "openapi.yaml": "openapi: 3.0.0\n", "src/routes.ts": 'import express from "express";\n' }, {}, "high"],
  [
    "server-spring-annotations",
    {
      "pom.xml": "<project><dependencies><dependency><groupId>org.springdoc</groupId><artifactId>springdoc-openapi-starter-webmvc-ui</artifactId></dependency></dependencies></project>",
      "src/main/java/OrderController.java": "import io.swagger.v3.oas.annotations.Operation;\nclass OrderController {}\n",
    },
    {}, "high",
  ],
  ["client-generated", { "package.json": npm({}, { "openapi-typescript": "7" }), "spec/petstore.openapi.json": '{"openapi":"3.0.0"}', "src/client.ts": "export {};\n" }, {}, "high"],
  ["contract-only", { "api/orders.openapi.yaml": "openapi: 3.0.0\n" }, {}, "medium"],
  ["contract-only-swagger", { "swagger.json": '{"swagger":"2.0"}' }, {}, "medium"],
  ["monorepo-api-module", MONO, { modules: ["api"] }, "high"],
];

describe("rest-openapi skill: selection", () => {
  it.each(POSITIVE)("%s is a candidate", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(new RegExp(`^${ID}: ${conf} confidence`));
    const ids = entries.map((x) => x.id);
    if (ids.includes("small-changes")) expect(ids.indexOf(ID)).toBeLessThan(ids.indexOf("small-changes"));
  });

  it.each<[string, Record<string, string>, { task?: string; modules?: string[] }]>([
    [
      "unrelated-http-mention",
      { "package.json": npm({ lodash: "4" }), "src/download.ts": 'import https from "node:https"; // HTTP download\n', "README.md": "Fetches the logo over HTTP.\n" },
      { task: "Fix the log line when the HTTP download of the logo fails and retry the HTTP request once." },
    ],
    [
      "internal-service",
      { "pom.xml": "<project><dependencies/></project>", "src/main/java/pricing/PriceService.java": "class PriceService {}\n" },
      { task: "Refactor the pricing service to cache results; the rest of the code stays." },
    ],
    ["monorepo-worker-module", MONO, { modules: ["worker"] }],
    ["docs-text-only", { "README.md": "REST OpenAPI Swagger\n", "openapi.md": "# notes\n", "docs/swagger.md": "# notes\n" }, {}],
    ["other-integration", { "package.json": npm({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";\n' }, {}],
  ])("%s is not a candidate", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("a web framework alone, or a spec under docs/ only, is low confidence", () => {
    expect(entry({ "package.json": npm({ express: "4" }) }).entry?.evidence[0]).toMatch(/low confidence/);
    expect(entry({ "docs/openapi.yaml": "openapi: 3.0.0\n" }).entry?.evidence[0]).toMatch(/low confidence/);
  });

  it("server code alone (no spec) is at most medium evidence, with or without an internal-only task", () => {
    const files = { "package.json": npm({ express: "4" }), "src/routes.ts": 'import express from "express";\n' };
    expect(entry(files).entry?.evidence[0]).toMatch(/medium confidence/);
    expect(entry(files, { task: "Refactor the pricing cache" }).entry?.evidence[0]).toMatch(/medium confidence/);
  });

  it("an explicit plan to change a REST contract names the skill without repository evidence", () => {
    const files = { "pom.xml": "<project><dependencies/></project>", "src/main/java/pricing/PriceService.java": "class PriceService {}\n" };
    const named = (task: string) => entry(files, { task }).entry?.evidence;
    expect(named("Change the OpenAPI contract of the orders endpoint")).toEqual(["named in the task: openapi"]);
    expect(named("Add paging to the REST API")).toEqual(["named in the task: rest-api"]);
    expect(named("Make the REST contract of orders stricter")).toEqual(["named in the task: rest-contract"]);
  });
});

describe("rest-openapi skill: integrity and resolve", () => {
  it("the pin matches the package digest", () => {
    pinBuiltinSkills(registry());
    expect(selectSkill(registry(), ID, "1.0.0").digest).toBe(pkg.digest);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, ID)).digest).toBe(pkg.digest);
  });

  it("is selected when requested, and refused for another role", () => {
    pinBuiltinSkills(registry());
    const r = resolveSkills(registry(), [ID]);
    expect(r.selected.map((s) => s.id)).toEqual([ID]);
    expect(r.selected[0]!.reason).toBe("requested");
    const t = resolveSkills(registry(), [ID], { role: "tester" });
    expect(t.decisions.find((d) => d.id === ID)?.code).toBe("role");
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

const row = (id: string, version: string) => ({ id, version, digest: pkg.digest, selection: "requested" as const, requiredBy: [] as string[], description: pkg.description, instructions: pkg.instructions });

describe("rest-openapi skill: behaviour", () => {
  it("the coder block holds the instructions and not the review checks", () => {
    const p = renderSkillPayload([row(ID, "1.0.0")], { maxTokens: 5000 });
    expect(p.text).toContain("Keep contract and implementation in sync");
    expect(p.text).not.toContain(pkg.review!.split("\n")[0]);
  });

  it("the reviewer block holds the review checks and not the instructions", () => {
    const p = renderReviewPayload(
      [{ id: ID, version: "1.0.0", digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
    );
    expect(p.text).toContain('role="reviewer"');
    expect(p.text).toContain("Is it backwards compatible?");
    expect(p.text).not.toContain("## Pagination");
  });

  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["contract/code sync", /in the same change, into: the OpenAPI document, the server code, the validation, the clients in this repository, and the tests/, /all change together and agree, for every part the repository holds/],
    ["breaking change", /Never break a published contract in place/, /Is it backwards compatible\?/],
    ["new required field", /a new required request field/, /new required request field/],
    ["response evolution", /A new response field or enum value can still break/, /response field or enum value/],
    ["failure responses", /Every failure that can happen on an operation/, /Failure responses:[^]*invalid input, not authenticated, not allowed, not found and conflict/],
    ["200 with error", /Never return 200 with an error body/, /200 with an error body/],
    ["error envelope", /One error envelope for the whole API/, /envelope/],
    ["leaking errors", /No stack traces, SQL/, /leak stack traces/],
    ["validation", /Validate path, query, header and body at the boundary/, /validated at the boundary/],
    ["pagination", /paged, with a default and a maximum size/, /paged with a maximum/],
    ["idempotency", /not always the same response/, /retried write safe, also for concurrent duplicates/],
    ["auth", /A new endpoint is not public by default/, /declare \(own or inherited/],
    ["object access", /must belong to the caller/, /access to the object itself/],
    ["generated file", /Do not edit a generated file by hand/, /generated file edited by hand/],
    ["contract-only", /Contract-only, server-only or client-only change:[^]*Do not invent a server, a client or a contract/, /holds the contract alone/],
    ["unrelated HTTP", /only mentions HTTP/, /own skills/],
    ["new dependency", /Do not add a dependency or a generator/, /./],
  ];
  it.each(SCENARIOS)("%s", (_n, inst, rev) => {
    expect(pkg.instructions).toMatch(inst);
    expect(pkg.review).toMatch(rev);
  });

  it("a removed rule is noticed", () => {
    const cut = pkg.instructions.split("\n").filter((l) => !l.includes("Never return 200")).join("\n");
    expect(cut).not.toMatch(/Never return 200 with an error body/);
  });

  const lock = (ids: string[]) => ({
    version: 1 as const, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: 100,
    skills: ids.map((id) => ({ id, version: "1.0.0", digest: pkg.digest, selection: "requested" as const })),
  });
  const runOf = (ids: string[], loaded: boolean): SkillEvalRun => ({
    status: "succeeded",
    skillLock: ids.length ? lock(ids) : undefined,
    history: (ids.length && loaded
      ? [{ id: "impl", type: "claude", ok: true, output: "", skills: { loaded: ids.map((i) => `${i}@1.0.0`), bytes: 1, estimatedTokens: 50, state: "loaded" } }]
      : []) as unknown as SkillEvalRun["history"],
  });
  const ev = (r: SkillEvalRun, e: object) => evaluateSkillRun(r, SkillExpectSchema.parse(e));

  it("evaluations: selected and loaded, wrongly selected, and not selected", () => {
    const ok = ev(runOf([ID], true), { selected: [ID], absent: ["kafka"], max_tokens: budget("budget-coder-tokens") + 300 });
    expect(ok.ok).toBe(true);
    expect(ok.activation.status).toBe("loaded");
    expect(ev(runOf([ID], true), { absent: [ID] }).ok).toBe(false);
    const none = ev(runOf([], false), { absent: [ID] });
    expect(none.ok).toBe(true);
    expect(none.activation.status).toBe("none");
  });
});
