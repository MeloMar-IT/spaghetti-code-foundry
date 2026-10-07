import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectIntegrationCandidates, IntegrationCandidateSchema, type IntegrationCandidate } from "../src/skills/integration-candidates.js";
import { buildRepoProfile, serializeRepoProfile, type RepoProfile } from "../src/skills/repo-profile.js";
import { relativePathProblem } from "../src/skills/schema.js";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "integ-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tree = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
};
const make = (files: Record<string, string>) => tree(tmp(), files);
const run = (files: Record<string, string>, affectedModules?: string[]) => detectIntegrationCandidates(buildRepoProfile(make(files)), { affectedModules });
const caps = (c: IntegrationCandidate[]) => c.map((x) => x.capability);
const get = (c: IntegrationCandidate[], cap: string) => c.find((x) => x.capability === cap);
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });
const mvn = (g: string, a: string) => `<dependency>\n<groupId>${g}</groupId>\n<artifactId>${a}</artifactId>\n</dependency>\n`;

const monorepo = {
  "services/orders/pom.xml": mvn("org.apache.kafka", "kafka-clients"),
  "services/orders/src/A.java": "import org.apache.kafka.clients.producer.KafkaProducer;\n",
  "services/ledger/requirements.txt": "cx_Oracle==8.0\n",
  "services/ledger/app.py": "import cx_Oracle\n",
  "web/package.json": pkg({ express: "^4.0.0" }),
  "web/openapi.yaml": "openapi: 3.0.0\n",
  "tools/loader/go.mod": "module loader\n\nrequire github.com/gocql/gocql v1.6.0\n",
  "tools/loader/main.go": 'package main\nimport "github.com/gocql/gocql"\n',
};

describe("positive cases", () => {
  it("kafkajs dependency and import", () => {
    const c = run({ "package.json": pkg({ kafkajs: "^2.0.0" }), "src/a.ts": 'import { Kafka } from "kafkajs";\n' });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ capability: "kafka", category: "interface", score: 80, confidence: "high" });
    expect(c[0]!.evidence.map((e) => [e.kind, e.path, e.detector])).toEqual([
      ["dependency", "package.json", "dependency-package-json"],
      ["import", "src/a.ts", "import-npm"],
    ]);
  });
  it("oracle from pom and import", () => {
    const c = run({ "pom.xml": mvn("com.oracle.database.jdbc", "ojdbc11"), "src/D.java": "import oracle.jdbc.OracleDriver;\n" });
    expect(c[0]).toMatchObject({ capability: "oracle", category: "database", confidence: "high" });
  });
  it("openapi file alone and with express", () => {
    expect(get(run({ "openapi.yaml": "openapi: 3.0.0\n" }), "rest-openapi")).toMatchObject({ score: 50, confidence: "medium" });
    expect(get(run({ "openapi.yaml": "x", "package.json": pkg({ express: "4" }) }), "rest-openapi")).toMatchObject({ score: 70, confidence: "high" });
    expect(get(run({ "api/petstore.openapi.yaml": "x" }), "rest-openapi")?.score).toBe(50);
  });
  it("cassandra, ibm mq and python name normalization", () => {
    expect(get(run({ "requirements.txt": "cassandra-driver\n", "a.py": "from cassandra.cluster import Cluster\n" }), "cassandra")?.confidence).toBe("high");
    expect(get(run({ "go.mod": "module x\n\nrequire github.com/ibm-messaging/mq-golang/v5 v5.0.0\n", "q.mqsc": "DEFINE QLOCAL(A)\n" }), "ibm-mq")?.score).toBe(70);
    const o = run({ "requirements.txt": "cx_Oracle\n", "a.py": "import cx_Oracle\n" });
    expect(get(o, "oracle")?.evidence).toHaveLength(2);
  });
  it("configuration files alone are named, never read", () => {
    const k = run({ "config/kafka.properties": "bootstrap.servers=broker.example.com:9092\npassword=hunter2\n" });
    expect(get(k, "kafka")).toMatchObject({ score: 30, confidence: "low" });
    const o = run({ "net/tnsnames.ora": "X=(HOST=db.example.com)\n" });
    expect(o[0]).toMatchObject({ capability: "oracle", score: 30 });
    for (const text of [JSON.stringify(k), JSON.stringify(o)]) {
      expect(text).not.toContain("example.com");
      expect(text).not.toContain("hunter2");
    }
  });
});

describe("negative cases", () => {
  it("documentation text and non-spec openapi names make no candidate", () => {
    expect(
      run({
        "README.md": "Kafka IBM MQ Oracle Cassandra REST\n",
        "docs/architecture.md": "We use Kafka and Oracle.\n",
        "openapi.md": "x",
        "swagger.txt": "x",
        "docs/swagger.md": "x",
      }),
    ).toEqual([]);
  });
  it("evidence only under docs stays low", () => {
    const c = run({ "docs/examples/package.json": pkg({ kafkajs: "1.0.0" }), "docs/examples/a.ts": 'import { Kafka } from "kafkajs";\n' });
    expect(c).toHaveLength(1);
    expect(c[0]!.score).toBeLessThanOrEqual(30);
    expect(c[0]!.confidence).toBe("low");
    expect(c[0]!.evidence.every((e) => e.documentation)).toBe(true);
    expect(run({ "docs/openapi.yaml": "x" })[0]).toMatchObject({ score: 25, confidence: "low" });
  });
  it("generic database and messaging terms", () => {
    const db = run({
      "schema.sql": "create table a(id int);\n",
      "package.json": pkg({ pg: "8", typeorm: "0.3", mongodb: "6" }),
      "requirements.txt": "sqlalchemy\n",
      "pom.xml": mvn("org.springframework.boot", "spring-boot-starter-jdbc") + mvn("org.hibernate.orm", "hibernate-core"),
    });
    expect(caps(db)).not.toContain("oracle");
    expect(caps(db)).not.toContain("cassandra");
    const mq = run({
      "package.json": pkg({ amqplib: "0.10" }),
      "pom.xml": mvn("jakarta.jms", "jakarta.jms-api") + mvn("org.springframework", "spring-jms"),
      "a.avsc": "{}",
    });
    expect(caps(mq)).not.toContain("kafka");
    expect(caps(mq)).not.toContain("ibm-mq");
  });
  it("a lone cql file and lookalike names", () => {
    expect(run({ "db/a.cql": "CREATE KEYSPACE k;\n" })[0]).toMatchObject({ capability: "cassandra", score: 20, confidence: "low" });
    expect(run({ "package.json": pkg({ "kafkajs-fake": "1", "my-oracledb": "1", "oracle-cloud-sdk": "1", "ibm-watson": "1" }) })).toEqual([]);
  });
});

describe("kafka and ibm mq are distinct", () => {
  it("separates them", () => {
    expect(caps(run({ "go.mod": "module x\n\nrequire github.com/IBM/sarama v1.0.0\n" }))).toEqual(["kafka"]);
    expect(caps(run({ "package.json": pkg({ ibmmq: "1.0.0" }) }))).toEqual(["ibm-mq"]);
    const both = run({ "package.json": pkg({ ibmmq: "1.0.0", kafkajs: "2.0.0" }) });
    expect(caps(both).sort()).toEqual(["ibm-mq", "kafka"]);
    expect(get(both, "kafka")!.evidence.map((e) => e.name)).toEqual(["kafkajs"]);
    expect(get(both, "ibm-mq")!.evidence.map((e) => e.name)).toEqual(["ibmmq"]);
  });
});

describe("polyglot and modules", () => {
  it("four candidates with their own evidence", () => {
    const c = run(monorepo);
    expect(c.map((x) => [x.capability, x.score])).toEqual([["kafka", 80], ["cassandra", 80], ["oracle", 80], ["rest-openapi", 70]]);
    const folder: Record<string, string> = { kafka: "services/orders/", oracle: "services/ledger/", "rest-openapi": "web/", cassandra: "tools/loader/" };
    for (const x of c) for (const e of x.evidence) expect(e.path.startsWith(folder[x.capability]!)).toBe(true);
  });
  it("affectedModules limits the scope", () => {
    expect(caps(run(monorepo, ["web"]))).toEqual(["rest-openapi"]);
    expect(caps(run(monorepo, ["services/orders"]))).toEqual(["kafka"]);
    expect(run({ "website/package.json": pkg({ kafkajs: "2" }) }, ["web"])).toEqual([]);
  });
  it("a root manifest counts for a module without its own manifest", () => {
    const c = run({ "package.json": pkg({ kafkajs: "2" }), "packages/api/index.ts": "export {};\n" }, ["packages/api"]);
    expect(c[0]).toMatchObject({ capability: "kafka", score: 40, confidence: "medium" });
  });
  it("a nearer manifest of the same build system owns the module", () => {
    const files = { "package.json": pkg({ kafkajs: "2" }), "packages/api/package.json": pkg({ lodash: "4" }) };
    expect(run(files, ["packages/api"])).toEqual([]);
    expect(caps(run(files, ["packages/api", ""]))).toEqual(["kafka"]);
    expect(caps(run({ "pom.xml": mvn("org.apache.kafka", "kafka-clients"), "mod/pom.xml": "<project/>" }, ["mod"]))).toEqual(["kafka"]);
  });
  it("sibling imports do not count", () => {
    const files = { "package.json": "{}", "packages/other/a.ts": 'import { Kafka } from "kafkajs";\n', "packages/api/b.ts": "export {};\n" };
    expect(run(files, ["packages/api"])).toEqual([]);
    expect(caps(run(files, ["packages/other"]))).toEqual(["kafka"]);
  });
  it("root forms mean the whole repository; bad paths throw", () => {
    const p = buildRepoProfile(make(monorepo));
    const all = detectIntegrationCandidates(p);
    for (const m of [[""], ["."], []]) expect(detectIntegrationCandidates(p, { affectedModules: m })).toEqual(all);
    expect(detectIntegrationCandidates(p, { affectedModules: ["web/"] })).toEqual(detectIntegrationCandidates(p, { affectedModules: ["web"] }));
    for (const m of ["../x", "/abs"]) expect(() => detectIntegrationCandidates(p, { affectedModules: [m] })).toThrow("invalid module path");
  });
});

describe("safety and shape", () => {
  it("credentialed versions never reach the output", () => {
    const p = buildRepoProfile(make({ "package.json": pkg({ kafkajs: "git+https://user:tok@example.com/k.git" }) }));
    const c = detectIntegrationCandidates(p);
    expect(c).toHaveLength(1);
    for (const text of [JSON.stringify(c), serializeRepoProfile(p)]) {
      expect(text).not.toContain("tok");
      expect(text).not.toContain("example.com");
    }
  });
  it("hand-built hostile names give no evidence", () => {
    const base = buildRepoProfile(make({ "pom.xml": "<project/>" }));
    const f = (name: string): RepoProfile => ({ ...base, findings: [{ kind: "dependency", name, path: "pom.xml", detector: "dependency-pom-xml", reason: "x" }] });
    expect(detectIntegrationCandidates(f("org.apache.kafka:x@evil"))).toEqual([]);
    expect(detectIntegrationCandidates(f("org.apache.kafka://x"))).toEqual([]);
    expect(caps(detectIntegrationCandidates(f("org.apache.kafka:x")))).toEqual(["kafka"]);
  });
  it("results are valid, deterministic and clean", () => {
    const root = make(monorepo);
    const a = detectIntegrationCandidates(buildRepoProfile(root));
    expect(detectIntegrationCandidates(buildRepoProfile(root))).toEqual(a);
    for (const c of a) {
      expect(IntegrationCandidateSchema.safeParse(c).success).toBe(true);
      for (const e of c.evidence) expect(relativePathProblem(e.path)).toBeUndefined();
    }
    expect(JSON.stringify(a)).not.toContain(tmpdir());
    const rev = Object.fromEntries(Object.entries(monorepo).reverse());
    expect(detectIntegrationCandidates(buildRepoProfile(make(rev)))).toEqual(a);
  });
  it("keeps 10 evidence items and counts the rest", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 14; i++) files[`m${i}/package.json`] = pkg({ kafkajs: "1" });
    const c = run(files);
    expect(c[0]!.evidence).toHaveLength(10);
    expect(c[0]!.evidenceMore).toBe(4);
  });
  it("an empty profile gives []", () => {
    expect(detectIntegrationCandidates(buildRepoProfile(tmp()))).toEqual([]);
  });
});
