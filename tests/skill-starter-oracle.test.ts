import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { CATALOGUE_DETAIL } from "../src/skills/catalogue-rules.js";
import { credentialProblem } from "../src/skills/credential-scan.js";
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
import { RESOLVE_DEFAULTS, UNRESOLVED_HIGH_RISK_DEFAULT } from "../src/skills/resolve-rules.js";
import { REVIEW_DEFAULTS } from "../src/skills/schema.js";
import { skillRisk } from "../src/skills/unresolved.js";

const ID = "oracle";
const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillora-")));
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

type Files = Record<string, string>;
type Opts = { task?: string; modules?: string[] };
function profileOf(files: Files) {
  const root = tmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return buildRepoProfile(root);
}
function entry(files: Files, opts: Opts = {}) {
  const cat = buildSkillCatalogue(registry(), { profile: profileOf(files), ...opts });
  return { entry: cat.entries.find((e) => e.id === ID), entries: cat.entries };
}
const npm = (deps: Record<string, string>) => JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps });
const pom = (group: string, artifact: string) =>
  `<project>\n<dependencies>\n<dependency>\n<groupId>${group}</groupId>\n<artifactId>${artifact}</artifactId>\n</dependency>\n</dependencies>\n</project>\n`;
const OJDBC = pom("com.oracle.database.jdbc", "ojdbc11");
const MIGRATION = "CREATE TABLE orders (id NUMBER(19) PRIMARY KEY, placed_at TIMESTAMP NOT NULL);\n";

describe("oracle skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("database");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.files.references).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
    expect(pkg.capabilities).toEqual(["oracle", "oracle-jdbc", "oracle-migrations", "pl-sql", "plsql"]);
    expect(pkg.detectors.map((d) => d.glob)).toEqual(["**/*.pks", "**/*.pkb", "**/tnsnames.ora"]);
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, ID);
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
    expect(s?.label).toBe("built-in");
    expect(existsSync(join(BUILTIN_SKILLS, ID, "REVIEW.md"))).toBe(true);
  });

  it("grants no shell, network, write access or connector, and holds no credential or connect string", () => {
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.connectors).toEqual([]);
    for (const text of [pkg.instructions, pkg.review!]) {
      expect(credentialProblem(text)).toBeUndefined();
      expect(text).not.toMatch(/jdbc:oracle:|\(DESCRIPTION\s*=|password\s*=/i);
    }
    expect(pkg.instructions).toMatch(/This skill gives no database access/);
    expect(pkg.instructions).toMatch(/never connect to a production database/);
  });
});

describe("oracle skill: description", () => {
  it("says when it applies and when it does not", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/^Oracle Database:/);
    expect(d).toMatch(/use with oracle drivers, pl\/sql or oracle config/i);
    expect(d).toMatch(/not for other databases or plain sql/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "pom.xml": OJDBC }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("oracle skill: budgets", () => {
  it("planner: the description fits its character budget and the catalogue", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(budget("budget-planner-chars"));
    expect(budget("budget-planner-chars")).toBeLessThanOrEqual(CATALOGUE_DETAIL.full.descriptionChars);
  });

  it("coder: the context fits its budget, and the delivered block adds only the wrapper", () => {
    const b = budget("budget-coder-tokens");
    const wrapper = 300;
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
    const p = renderSkillPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
      { maxTokens: b + wrapper },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.estimatedTokens).toBeLessThanOrEqual(b + wrapper);
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

  it("covers every topic of the story", () => {
    for (const h of [
      "When this applies", "Follow the repository first", "Not PostgreSQL or MySQL", "Bind variables", "Transactions and isolation", "Locking",
      "Sequences and identity", "Dates and timestamps", "LOBs", "Indexing and queries", "Pagination", "Migrations", "PL/SQL boundaries",
      "Error handling", "Tests",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

const JDBC: Files = {
  "pom.xml": OJDBC,
  "src/main/java/shop/OrderDao.java":
    'package shop;\nimport java.sql.PreparedStatement;\nimport oracle.jdbc.OracleConnection;\nclass OrderDao {\n  static final String BY_ID = "SELECT id FROM orders WHERE id = ?";\n}\n',
};
const MIGRATIONS: Files = { "pom.xml": OJDBC, "src/main/resources/db/migration/V1__create_orders.sql": MIGRATION };
const PLSQL: Files = {
  "db/packages/orders_api.pks": "CREATE OR REPLACE PACKAGE orders_api AS\n  PROCEDURE place(p_id IN orders.id%TYPE);\nEND orders_api;\n/\n",
  "db/packages/orders_api.pkb": "CREATE OR REPLACE PACKAGE BODY orders_api AS\n  PROCEDURE place(p_id IN orders.id%TYPE) IS BEGIN NULL; END;\nEND orders_api;\n/\n",
  "pom.xml": "<project><dependencies/></project>",
  "src/main/java/shop/OrderCalls.java": 'package shop;\nimport java.sql.CallableStatement;\nclass OrderCalls { static final String CALL = "{call orders_api.place(?)}"; }\n',
};
const MONO: Files = {
  "billing/pom.xml": OJDBC, "billing/src/main/resources/db/migration/V1__create_orders.sql": MIGRATION,
  "search/package.json": npm({ pg: "8" }), "search/migrations/001_init.sql": "CREATE TABLE docs (id SERIAL PRIMARY KEY);\n",
};
const POSITIVE: [string, Files, Opts, string][] = [
  ["jdbc-access", JDBC, {}, "high"],
  ["sql-migrations-with-driver", MIGRATIONS, {}, "medium"],
  ["plsql-boundary", PLSQL, {}, "low"],
  ["plsql-boundary-with-driver", { ...PLSQL, ...JDBC }, {}, "high"],
  ["node-oracledb", { "package.json": npm({ oracledb: "6" }), "src/db.ts": 'import oracledb from "oracledb";\n' }, {}, "high"],
  ["python-oracledb", { "requirements.txt": "oracledb==2.4.1\n" }, {}, "medium"],
  ["oracle-net-config", { "config/tnsnames.ora": "# aliases live here\n", "scripts/report.sql": "SELECT 1 FROM dual;\n" }, {}, "low"],
  ["monorepo-oracle-module", MONO, { modules: ["billing"] }, "medium"],
];

const GENERIC_TASK = "Add a migration with an index on orders.placed_at and fix the SQL pagination and the transaction in the repository";
const NEGATIVE: [string, Files, Opts][] = [
  ["postgresql-jdbc", { "pom.xml": pom("org.postgresql", "postgresql"), "src/main/resources/db/migration/V1__init.sql": "CREATE TABLE t (id SERIAL PRIMARY KEY);\n", "src/main/java/A.java": "import java.sql.Connection;\nclass A {}\n" }, { task: GENERIC_TASK }],
  ["mysql-node", { "package.json": npm({ mysql2: "3" }), "db/schema.sql": "CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);\n", "src/db.ts": 'import mysql from "mysql2";\n' }, { task: GENERIC_TASK }],
  ["cassandra", { "requirements.txt": "cassandra-driver==3.29.0\n", "schema/keyspace.cql": "CREATE KEYSPACE k;\n" }, { task: "Change the table's clustering order" }],
  ["sqlite-and-h2", { "package.json": npm({ "better-sqlite3": "9" }), "pom.xml": pom("com.h2database", "h2") }, { task: GENERIC_TASK }],
  ["sql-files-only", { "migrations/001_init.sql": MIGRATION, "queries/report.sql": "SELECT COUNT(*) FROM orders;\n" }, { task: GENERIC_TASK }],
  ["plain-jdbc-no-driver", { "pom.xml": "<project><dependencies/></project>", "src/main/java/A.java": "import java.sql.PreparedStatement;\nimport javax.sql.DataSource;\nclass A {}\n" }, { task: GENERIC_TASK }],
  ["monorepo-postgresql-module", MONO, { modules: ["search"], task: GENERIC_TASK }],
  ["docs-text-only", { "README.md": "We once used Oracle and PL/SQL.\n", "docs/oracle.md": "# notes\n" }, { task: "Fix a typo in the README" }],
];

describe("oracle skill: selection", () => {
  it.each(POSITIVE)("%s is a candidate", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence[0]).toMatch(new RegExp(`^oracle: ${conf} confidence`));
    const ids = entries.map((x) => x.id);
    expect(ids.indexOf(ID)).toBeLessThan(ids.indexOf("small-changes"));
  });

  it.each(NEGATIVE)("%s is not a candidate", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("generic SQL words in a task never name the skill", () => {
    const files = { "migrations/001_init.sql": MIGRATION };
    for (const task of ["Tune the SQL query", "Add a database migration", "Use bind parameters in the JDBC call", "Fix the transaction isolation and the row locking", "Ask the price oracles service"])
      expect(entry(files, { task }).entry?.evidence).toEqual([]);
  });

  it("a task that names Oracle or PL/SQL names the skill without repository evidence", () => {
    const files = { "migrations/001_init.sql": MIGRATION };
    const named = (task: string) => entry(files, { task }).entry?.evidence;
    expect(named("Make the report query work on Oracle")).toEqual(["named in the task: oracle"]);
    expect(named("Change the PL/SQL package for orders")).toEqual(["named in the task: pl-sql"]);
    expect(named("Move the PLSQL call behind an interface")).toEqual(["named in the task: plsql"]);
    expect(named("Write the Oracle migrations for the new table")).toEqual(["named in the task: oracle, oracle-migrations"]);
  });

  it("Oracle material under docs/ only is low confidence", () => {
    expect(entry({ "docs/examples/demo.pkb": "BEGIN NULL; END;\n/\n" }).entry?.evidence[0]).toMatch(/^oracle: low confidence/);
  });
});

describe("oracle skill: integrity and resolve", () => {
  it("the pin matches the package digest", () => {
    pinBuiltinSkills(registry());
    expect(selectSkill(registry(), ID, "1.0.0").digest).toBe(pkg.digest);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, ID)).digest).toBe(pkg.digest);
  });

  it("is selected when requested, and refused for another role", () => {
    pinBuiltinSkills(registry());
    const r = resolveSkills(registry(), [ID]);
    expect(r.selected.map((s) => [s.id, s.reason])).toEqual([[ID, "requested"]]);
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

  it("counts as high risk through its migrations capability, and low with no high-risk list", () => {
    expect(skillRisk(ID, registry(), UNRESOLVED_HIGH_RISK_DEFAULT)).toBe("high");
    expect(skillRisk(ID, registry(), [])).toBe("low");
  });
});

const row = () => ({ id: ID, version: "1.0.0", digest: pkg.digest, selection: "requested" as const, requiredBy: [] as string[], description: pkg.description, instructions: pkg.instructions });

describe("oracle skill: behaviour", () => {
  it("the coder block holds the instructions and not the review checks", () => {
    const p = renderSkillPayload([row()], { maxTokens: RESOLVE_DEFAULTS.maxSkillTokens });
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.text).toContain("## Bind variables");
    expect(p.text).not.toContain(pkg.review!.split("\n")[0]!);
  });

  it("the reviewer block holds the review checks and not the instructions", () => {
    const p = renderReviewPayload(
      [{ id: ID, version: "1.0.0", digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
    );
    expect(p.text).toContain('role="reviewer"');
    for (const check of ["Transaction boundaries:", "Locking:", "Migration reversibility:", "Binding:", "Temporal semantics:"]) expect(p.text).toContain(check);
    expect(p.text).not.toContain("## Pagination");
  });

  // The skill is guidance only; each scenario checks that a concern has an instruction and a review check.
  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["string concatenation", /Never build SQL by joining input/, /Binding: is any value joined into SQL text instead of bound/],
    ["dynamic identifier", /A table or column name cannot be bound[^]*allowlist/, /dynamic table or column name taken from an allowlist/],
    ["bind type", /Bind the column's own type/, /bind of another type than its column/],
    ["transaction boundary", /one clear transaction boundary per unit of work/, /Transaction boundaries: is there one clear boundary per unit of work, with commit or rollback on every path/],
    ["auto-commit", /Do not rely on auto-commit/, /reliance on auto-commit/],
    ["isolation levels", /`READ COMMITTED`[^]*`SERIALIZABLE`[^]*ORA-08177[^]*no `REPEATABLE READ`/, /./],
    ["lock wait", /A bare `FOR UPDATE` waits forever/, /Locking: can a `FOR UPDATE` wait forever/],
    ["deadlock", /ORA-00060[^]*roll back the transaction and retry it/, /lock order consistent/],
    ["foreign key index", /Index a foreign key/, /foreign key left without an index/],
    ["sequence gaps", /Never `MAX\(id\) \+ 1`[^]*Sequence values have gaps/, /`MAX\(id\) \+ 1` used, or sequence order or gaplessness assumed/],
    ["time zone", /`SYSDATE` and `SYSTIMESTAMP` use the database server's zone/, /Temporal semantics:[^]*server time \(`SYSDATE`\) and session time mixed/],
    ["NLS", /Never depend on NLS settings/, /conversion depend on NLS settings/],
    ["day range", /half-open range/, /half-open range/],
    ["LOB locator", /A LOB locator is valid only inside its transaction and connection/, /locator used after commit or close/],
    ["index and function", /stops a normal index/, /./],
    ["pagination", /`WHERE ROWNUM <= :n ORDER BY \.\.\.` limits before it sorts/, /`ROWNUM` applied before the sort/],
    ["applied migration", /Never edit a migration that has been applied or merged/, /applied migration edited/],
    ["migration reversibility", /Reversibility: give the rollback the tool supports[^]*cannot be reversed[^]*say so in your summary/, /Migration reversibility:[^]*have a rollback, or does the summary say why it cannot be reversed/],
    ["DDL commits", /DDL commits, before and after itself/, /survive a failure half way \(DDL commits\)/],
    ["PL/SQL boundary", /specification \(`\.pks`\), the body \(`\.pkb`\) and every caller[^]*together/, /specification, body and callers change together/],
    ["swallowed error", /Never `WHEN OTHERS THEN NULL`/, /`WHEN OTHERS` that does not re-raise/],
    ["error numbers", /ORA error number[^]*never by the message text/, /ORA numbers used rather than message text/],
    ["retry", /Never retry a constraint violation/, /only transient errors retried/],
    ["PostgreSQL and MySQL habits", /There is no `LIMIT`, `ILIKE`, `ON CONFLICT`, `ON DUPLICATE KEY`, `AUTO_INCREMENT`/, /Dialect: does any statement assume PostgreSQL or MySQL/],
    ["empty string", /The empty string is `NULL`/, /non-null empty string/],
    ["credentials", /Never ask for, invent or write credentials, wallets or connect strings/, /credentials, wallets or connect strings added, or a production database used/],
    ["tests on Oracle", /"Oracle mode" does not prove/, /tests run against Oracle/],
    ["unrelated database", /Do not use it for PostgreSQL, MySQL, SQL Server, SQLite or Cassandra/, /other databases to their own skills/],
    ["new dependency", /Do not add a dependency/, /./],
  ];
  it.each(SCENARIOS)("covers: %s", (_n, rule, check) => {
    expect(pkg.instructions).toMatch(rule);
    expect(pkg.review).toMatch(check);
  });

  it("gives no syntax of another dialect as something to write", () => {
    // Every line that names a PostgreSQL or MySQL form says not to use it or marks it as a mistake.
    const lines = pkg.instructions.split("\n").filter((l) => /\b(?:LIMIT|ILIKE|ON CONFLICT|AUTO_INCREMENT|SERIAL)\b|NOW\(\)/.test(l.replace(/BULK COLLECT \.\.\. LIMIT/g, "")));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^- There is no /);
  });

  it("a removed rule is noticed", () => {
    const cut = pkg.instructions.split("\n").filter((l) => !l.includes("Never build SQL by joining input")).join("\n");
    expect(cut).not.toMatch(/Never build SQL by joining input/);
  });

  const lock = (ids: string[]) => ({
    version: 1 as const, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: 100,
    skills: ids.map((id) => ({ id, version: "1.0.0", digest: pkg.digest, selection: "requested" as const })),
  });
  const runOf = (ids: string[], step = "impl"): SkillEvalRun => ({
    status: "succeeded",
    skillLock: ids.length ? lock(ids) : undefined,
    history: (ids.length
      ? [{ id: step, type: "claude", ok: true, output: "", skills: { loaded: ids.map((i) => `${i}@1.0.0`), bytes: 1, estimatedTokens: 50, state: "loaded" } }]
      : []) as unknown as SkillEvalRun["history"],
  });
  const ev = (r: SkillEvalRun, e: object) => evaluateSkillRun(r, SkillExpectSchema.parse(e));

  it.each(["impl-jdbc", "impl-migration", "impl-plsql"])("evaluation: an Oracle task (%s) is selected, loaded and within the budget", (step) => {
    const ok = ev(runOf([ID], step), { selected: [ID], absent: ["cassandra"], max_tokens: budget("budget-coder-tokens") + 300 });
    expect(ok.ok).toBe(true);
    expect(ok.activation.status).toBe("loaded");
  });

  it("evaluation: wrongly selected for another database fails, and not selected passes", () => {
    expect(ev(runOf([ID]), { absent: [ID] }).ok).toBe(false);
    const none = ev(runOf([]), { absent: [ID] });
    expect(none.ok).toBe(true);
    expect(none.activation.status).toBe("none");
  });
});
