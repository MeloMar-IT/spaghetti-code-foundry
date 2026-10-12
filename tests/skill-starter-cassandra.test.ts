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
import { RESOLVE_DEFAULTS, UNRESOLVED_HIGH_RISK_DEFAULT } from "../src/skills/resolve-rules.js";
import { REVIEW_DEFAULTS } from "../src/skills/schema.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillcass-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const ID = "cassandra";
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
type Opts = { task?: string; modules?: string[] };
function entry(files: Record<string, string>, opts: Opts = {}) {
  const cat = buildSkillCatalogue(registry(), { profile: profileOf(files), ...opts });
  return { entry: cat.entries.find((e) => e.id === ID), entries: cat.entries };
}
const npm = (deps: Record<string, string>) => JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps });
const pom = (group: string, artifact: string) =>
  `<project><dependencies><dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>1</version></dependency></dependencies></project>`;

describe("cassandra skill: schema", () => {
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
    expect(pkg.detectors).toEqual([{ type: "file", glob: "**/*.cql" }]);
    expect(pkg.review).toBeDefined();
    expect(pkg.capabilities).toEqual(["cassandra-consistency", "cassandra-data-model", "cassandra-driver", "cassandra-schema", "cql"]);
  });

  it("grants no cluster access: no shell, no network, no connector, read-only files", () => {
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.connectors).toEqual([]);
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, ID);
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
    expect(s?.label).toBe("built-in");
  });

  it("no capability is a generic database word or a high-risk term", () => {
    for (const c of pkg.capabilities) {
      expect(c === "cql" || c.startsWith("cassandra-")).toBe(true);
      expect(UNRESOLVED_HIGH_RISK_DEFAULT as readonly string[]).not.toContain(c);
    }
    expect(UNRESOLVED_HIGH_RISK_DEFAULT as readonly string[]).not.toContain(pkg.category);
  });
});

describe("cassandra skill: description", () => {
  it("says when it applies and when it does not", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/use with a cassandra driver or cql/i);
    expect(d).toMatch(/not for other databases/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "package.json": npm({ "cassandra-driver": "4" }) }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("cassandra skill: budgets", () => {
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
      "When this applies", "Follow the repository first", "Model from the queries", "Partition and clustering keys", "ALLOW FILTERING and indexes",
      "Consistency", "Statements and paging", "Batches and lightweight transactions", "TTL, deletes and tombstones", "Retries and timeouts",
      "Schema changes", "Tests",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

// Fixtures: a schema, repository access, migrations, and database modules that have nothing to do with Cassandra.
const SCHEMA_CQL = "CREATE TABLE shop.orders_by_customer (customer_id uuid, day date, order_id timeuuid, total decimal,\n  PRIMARY KEY ((customer_id, day), order_id)) WITH CLUSTERING ORDER BY (order_id DESC);\n";
const JAVA_REPO = "import com.datastax.oss.driver.api.core.CqlSession;\nimport com.datastax.oss.driver.api.core.cql.PreparedStatement;\nclass OrderRepository {}\n";
const TS_REPO = 'import { Client } from "cassandra-driver";\nexport class OrderRepository { constructor(private readonly client: Client) {} }\n';
const PY_MIGRATE = "from cassandra.cluster import Cluster\n\ndef migrate(session):\n    pass\n";
const SQL_MIGRATION = "ALTER TABLE orders ADD COLUMN note text;\n";
const PG_REPO = 'import { Pool } from "pg";\nexport class OrderRepository { constructor(private readonly pool: Pool) {} }\n';
const MONO = {
  "orders/package.json": npm({ "cassandra-driver": "4" }), "orders/src/order-repository.ts": TS_REPO, "orders/schema/orders.cql": SCHEMA_CQL,
  "billing/package.json": npm({ pg: "8" }), "billing/src/order-repository.ts": PG_REPO, "billing/migrations/002_note.sql": SQL_MIGRATION,
};
const GENERIC_TASK = "Add a migration and a repository query for the orders table: change the data model, the schema, the partition key, " +
  "the consistency, the driver settings, the paging and the tombstones of the database.";

const POSITIVE: [string, Record<string, string>, Opts, string][] = [
  ["schema", { "pom.xml": pom("com.datastax.oss", "java-driver-core"), "src/main/resources/schema/orders.cql": SCHEMA_CQL }, {}, "medium"],
  ["repository-access-java", { "pom.xml": pom("com.datastax.oss", "java-driver-core"), "src/main/java/shop/OrderRepository.java": JAVA_REPO }, {}, "high"],
  ["repository-access-node", { "package.json": npm({ "cassandra-driver": "4" }), "src/order-repository.ts": TS_REPO }, {}, "high"],
  [
    // The dependency alone triggers it: the profile keeps three segments of a JVM import, so the Spring Data import adds nothing.
    "mapping-spring-data",
    {
      "pom.xml": pom("org.springframework.boot", "spring-boot-starter-data-cassandra"),
      "src/main/java/shop/Order.java": "import org.springframework.data.cassandra.core.mapping.Table;\n@Table class Order {}\n",
    },
    {}, "medium",
  ],
  ["migrations", { "requirements.txt": "cassandra-driver==3.29.0\n", "migrations/0002_add_day_bucket.cql": "ALTER TABLE shop.orders ADD note text;\n", "migrations/run.py": PY_MIGRATE }, {}, "high"],
  ["configuration-only", { "go.mod": "module example.test/shop\n\ngo 1.22\n\nrequire github.com/gocql/gocql v1.6.0\n" }, {}, "medium"],
  ["monorepo-cassandra-module", MONO, { modules: ["orders"] }, "high"],
  ["generic-task-in-a-cassandra-repository", { "package.json": npm({ "cassandra-driver": "4" }), "src/order-repository.ts": TS_REPO }, { task: GENERIC_TASK }, "high"],
];

const NEGATIVE: [string, Record<string, string>, Opts][] = [
  ["unrelated-postgres", { "package.json": npm({ pg: "8" }), "src/order-repository.ts": PG_REPO, "migrations/002_note.sql": SQL_MIGRATION }, { task: GENERIC_TASK }],
  [
    "unrelated-oracle-jdbc",
    { "pom.xml": pom("com.oracle.database.jdbc", "ojdbc11"), "src/main/java/shop/OrderRepository.java": "import oracle.jdbc.OracleConnection;\nclass OrderRepository {}\n" },
    { task: GENERIC_TASK },
  ],
  ["unrelated-mongodb", { "package.json": npm({ mongodb: "6" }), "src/orders.ts": 'import { MongoClient } from "mongodb";\n' }, { task: "Add an index and paging to the orders collection" }],
  ["unrelated-jpa", { "pom.xml": pom("org.springframework.boot", "spring-boot-starter-data-jpa"), "src/main/java/shop/Order.java": "import jakarta.persistence.Entity;\n@Entity class Order {}\n" }, { task: GENERIC_TASK }],
  ["monorepo-postgres-module", MONO, { modules: ["billing"] }],
  ["readme-mention-only", { "README.md": "We may move to Cassandra one day.\n", "package.json": npm({ pg: "8" }) }, { task: "Fix the typo in the README" }],
  ["other-integration", { "package.json": npm({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";\n' }, {}],
];

describe("cassandra skill: selection", () => {
  it.each(POSITIVE)("%s is a candidate", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(new RegExp(`^${ID}: ${conf} confidence`));
    const ids = entries.map((x) => x.id);
    if (ids.includes("small-changes")) expect(ids.indexOf(ID)).toBeLessThan(ids.indexOf("small-changes"));
  });

  it.each(NEGATIVE)("%s is not a candidate", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("a .cql file alone is low confidence (it can be Cypher), and lower still under docs/", () => {
    expect(entry({ "db/schema.cql": SCHEMA_CQL }).entry?.evidence[0]).toMatch(/^cassandra: low confidence/);
    expect(entry({ "docs/schema.cql": SCHEMA_CQL }).entry?.evidence[0]).toMatch(/^cassandra: low confidence/);
  });

  it("a task that names Cassandra or CQL names the skill; generic database words do not", () => {
    const files = { "package.json": npm({ pg: "8" }), "src/order-repository.ts": PG_REPO };
    const named = (task: string) => entry(files, { task }).entry?.evidence;
    expect(named("Move the order history to a Cassandra table")).toEqual(["named in the task: cassandra"]);
    expect(named("Review the CQL of the order history")).toEqual(["named in the task: cql"]);
    expect(named("Fix the Cassandra driver timeouts")).toEqual(["named in the task: cassandra, cassandra-driver"]);
    expect(named(GENERIC_TASK)).toEqual([]);
  });
});

describe("cassandra skill: integrity and resolve", () => {
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

describe("cassandra skill: behaviour", () => {
  it("the coder block holds the instructions and not the review checks", () => {
    const p = renderSkillPayload([row(ID, "1.0.0")], { maxTokens: 5000 });
    expect(p.text).toContain("Model from the queries");
    expect(p.text).not.toContain(pkg.review!.split("\n")[0]);
  });

  it("the reviewer block holds the review checks and not the instructions", () => {
    const p = renderReviewPayload(
      [{ id: ID, version: "1.0.0", digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
    );
    expect(p.text).toContain('role="reviewer"');
    expect(p.text).toContain("Hot partitions:");
    expect(p.text).not.toContain("## Consistency");
  });

  it("rejects ALLOW FILTERING as a default design solution and explains the exceptional use", () => {
    const start = pkg.instructions.indexOf("## ALLOW FILTERING and indexes");
    const section = pkg.instructions.slice(start, pkg.instructions.indexOf("\n## ", start + 1));
    expect(section).toMatch(/`ALLOW FILTERING` is not a design solution/);
    expect(section).toMatch(/the cost grows with the table, not with the result/);
    expect(section).toMatch(/the table is wrong for that query: add a table for it/);
    expect(section).toMatch(/Exceptional use, each with a comment that says why it is bounded/);
    expect(section).toMatch(/inside one partition that the query names in full and whose size is bounded/);
    expect(section).toMatch(/one-off maintenance or export job outside the request path, paged/);
    expect(section).toMatch(/Never as the default/);
    expect(pkg.review).toMatch(/`ALLOW FILTERING` is acceptable only inside one bounded partition/);
  });

  it("the reviewer checks hot partitions, unbounded partitions, tombstones, consistency and migration rollout", () => {
    for (const label of ["Hot partitions:", "Unbounded partitions:", "Tombstones:", "Consistency:", "Migration rollout:"]) {
      expect(pkg.review!.split("\n").some((l) => l.startsWith(`- ${label}`))).toBe(true);
    }
  });

  it("makes no assumption about a production topology", () => {
    expect(pkg.instructions).toMatch(/This skill grants no cluster access/);
    expect(pkg.instructions).toMatch(/Do not assume a topology/);
    const all = `${pkg.instructions}\n${pkg.review}`;
    expect(all).not.toMatch(/\bdc1\b|\bdatacenter1\b|NetworkTopologyStrategy|replication_factor|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|:9042/i);
  });

  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["query-first", /Start from the list of queries the feature needs, not from the entities/, /avoid designing a table/],
    ["whole partition key", /gives the whole partition key by equality/, /give the whole partition key/],
    ["hot partition", /few values[^]*makes a hot partition/, /Hot partitions:[^]*few values or one dominant value/],
    ["unbounded partition", /grows for ever[^]*Add a bucket/, /Unbounded partitions:[^]*no time bucket or shard/],
    ["secondary index", /A secondary index is not a free alternative/, /new secondary index or a materialized view/],
    ["consistency on purpose", /Set the consistency level on purpose/, /Consistency: is the level chosen on purpose/],
    ["lowered consistency", /Never lower a consistency level to make a timeout/, /level lowered to hide a timeout/],
    ["prepared statements", /Prepare each statement once and reuse it\. Bind every value/, /prepared once and bound/],
    ["paging", /sets a page size and is consumed page by page/, /large read paged/],
    ["paging token", /treat a token that comes back from a client as untrusted/, /paging token from a client treated as untrusted/],
    ["batches", /A batch is not a speed-up/, /batch used for speed/],
    ["lightweight transaction", /use it only for uniqueness or compare-and-set/, /lightweight transaction/],
    ["null tombstone", /A bound `null` writes a tombstone/, /Tombstones: does the change write `null`/],
    ["queue table", /Do not build a queue or any delete-after-read pattern/, /use a table as a queue/],
    ["TTL", /A TTL belongs to the written columns/, /rows with a TTL/],
    ["gc grace", /lowering `gc_grace_seconds` below the repair interval brings deleted data back/, /`gc_grace_seconds`, compaction or replication changed unasked/],
    ["write timeout", /A write timeout means "unknown", not "failed"/, /not idempotent[^]*retried or marked idempotent/],
    ["schema agreement", /One schema statement at a time, each waiting for schema agreement/, /not by every instance at start/],
    ["rollout order", /add the schema; deploy code that writes old and new; backfill[^]*switch the reads; stop the old writes; drop later/, /schema first, write both, backfill, switch reads, drop later/],
    ["dropped column", /Never drop a column and add it again with the same name/, /re-add a dropped column name/],
    ["destructive change", /`DROP` and `TRUNCATE` destroy data/, /`DROP`\/`TRUNCATE` without the task asking/],
    ["tests", /a mocked session proves nothing about a key or a filter/, /tested against a real Cassandra where the repository can/],
    ["unrelated database", /database work with no Cassandra in it[^]*Then ignore this skill/, /other database checks to their own skills/],
    ["new dependency", /Do not add a driver, a mapper or a migration tool/, /./],
  ];
  it.each(SCENARIOS)("%s", (_n, inst, rev) => {
    expect(pkg.instructions).toMatch(inst);
    expect(pkg.review).toMatch(rev);
  });

  it("a removed rule is noticed", () => {
    const cut = pkg.instructions.split("\n").filter((l) => !l.includes("is not a design solution")).join("\n");
    expect(cut).not.toMatch(/`ALLOW FILTERING` is not a design solution/);
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
    const ok = ev(runOf([ID], true), { selected: [ID], absent: ["oracle"], max_tokens: budget("budget-coder-tokens") + 300 });
    expect(ok.ok).toBe(true);
    expect(ok.activation.status).toBe("loaded");
    expect(ev(runOf([ID], true), { absent: [ID] }).ok).toBe(false);
    const none = ev(runOf([], false), { absent: [ID] });
    expect(none.ok).toBe(true);
    expect(none.activation.status).toBe("none");
  });
});
