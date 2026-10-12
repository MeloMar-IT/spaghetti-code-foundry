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
import { UNRESOLVED_HIGH_RISK_DEFAULT } from "../src/skills/resolve-rules.js";
import { skillRisk } from "../src/skills/unresolved.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillkafka-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const ID = "kafka";
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

const mvn = (...deps: [string, string][]) =>
  `<project><dependencies>${deps.map(([g, a]) => `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId></dependency>`).join("")}</dependencies></project>`;

describe("kafka skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("interface");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("high");
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.files.references).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
    expect(pkg.capabilities).toEqual(["kafka-consumer", "kafka-producer", "kafka-schema", "kafka-streams", "kafka-transactions"]);
  });

  it("grants no cluster access: no connectors, no shell, no network, read-only files", () => {
    expect(pkg.connectors).toEqual([]);
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.instructions).toMatch(/No cluster access\.[^\n]*Do not connect to a broker or a schema registry/);
    expect(pkg.instructions).toMatch(/do not create, alter or delete topics, and do not reset offsets/);
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, ID);
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
    expect(s?.label).toBe("built-in");
  });

  it("counts as high risk, with or without the default high-risk list", () => {
    expect(skillRisk(ID, registry(), UNRESOLVED_HIGH_RISK_DEFAULT)).toBe("high");
    expect(skillRisk(ID, registry(), [])).toBe("high");
  });
});

describe("kafka skill: description", () => {
  it("says when it applies and when it does not", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/use when kafka code, config or schemas change/i);
    expect(d).toMatch(/not for a bare mention of events/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "package.json": npm({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";\n' }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("kafka skill: budgets", () => {
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
      "When this applies", "Follow the repository first", "Delivery guarantee", "Producers", "Keys, partitions and ordering",
      "Consumers, groups and offsets", "Duplicates and replay", "Retries, poison messages and dead letters", "Transactions",
      "Schemas and compatibility", "Stream processing", "Observability and security", "Tests", "Java notes", "TypeScript notes",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

// Fixtures: a Java producer, a TypeScript consumer, a stream processor, and modules that have nothing to do with Kafka.
const PRODUCER = {
  "pom.xml": mvn(["org.apache.kafka", "kafka-clients"]),
  "src/main/java/orders/OrderPublisher.java": "import org.apache.kafka.clients.producer.KafkaProducer;\nclass OrderPublisher {}\n",
};
const CONSUMER = { "package.json": npm({ kafkajs: "2" }), "src/consumer.ts": 'import { Kafka } from "kafkajs";\nexport {};\n' };
const STREAMS = {
  "build.gradle": "dependencies {\n  implementation 'org.apache.kafka:kafka-streams:3.7.0'\n}\n",
  "src/main/java/totals/TotalsTopology.java": "import org.apache.kafka.streams.StreamsBuilder;\nclass TotalsTopology {}\n",
};
const MONO = {
  "ingest/package.json": npm({ kafkajs: "2" }), "ingest/src/consumer.ts": 'import { Kafka } from "kafkajs";\nexport {};\n',
  "report/package.json": npm({ lodash: "4" }), "report/src/pdf.ts": "export {};\n",
};
const POSITIVE: [string, Record<string, string>, { task?: string; modules?: string[] }, string][] = [
  ["producer-java", PRODUCER, {}, "high"],
  ["consumer-typescript", CONSUMER, {}, "high"],
  ["stream-processing", STREAMS, {}, "high"],
  [
    "consumer-spring",
    { "pom.xml": mvn(["org.springframework.kafka", "spring-kafka"]), "src/main/java/pay/PaymentListener.java": "import org.springframework.kafka.annotation.KafkaListener;\nclass PaymentListener {}\n" },
    {}, "high",
  ],
  ["dependency-only", { "package.json": npm({ kafkajs: "2" }) }, {}, "medium"],
  ["import-only", { "package.json": npm({}), "src/consumer.ts": 'import { Kafka } from "kafkajs";\nexport {};\n' }, {}, "medium"],
  ["schema-registry-client", { "package.json": npm({ "@kafkajs/confluent-schema-registry": "3" }) }, {}, "medium"],
  ["schema-serializer-java", { "pom.xml": mvn(["io.confluent", "kafka-avro-serializer"]) }, {}, "medium"],
  ["configuration-only", { "config/kafka.properties": "acks=all\n" }, {}, "low"],
  ["configuration-and-dependency", { "package.json": npm({ kafkajs: "2" }), "config/kafka-consumer.yaml": "groupId: x\n" }, {}, "high"],
  ["monorepo-kafka-module", MONO, { modules: ["ingest"] }, "high"],
];

describe("kafka skill: selection", () => {
  it.each(POSITIVE)("%s is a candidate", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(new RegExp(`^${ID}: ${conf} confidence`));
    const ids = entries.map((x) => x.id);
    for (const other of ["small-changes", "rest-openapi"]) if (ids.includes(other)) expect(ids.indexOf(ID)).toBeLessThan(ids.indexOf(other));
  });

  it.each<[string, Record<string, string>, { task?: string; modules?: string[] }]>([
    [
      "documentation-mentions-events",
      { "README.md": "The service publishes events to a topic. Consumers read the events.\n", "docs/events.md": "# Events\n\nOrder events and payment events.\n", "docs/messaging.md": "# Kafka\n" },
      { task: "Update the documentation of the order events and the event flow." },
    ],
    [
      "in-process-events",
      { "package.json": npm({ lodash: "4" }), "src/bus.ts": 'import { EventEmitter } from "node:events";\nexport const bus = new EventEmitter(); // producer and consumer of events\n' },
      { task: "Emit an event when the cache is cleared and let the consumer of the event log it." },
    ],
    ["unrelated-module-java", { "pom.xml": "<project><dependencies/></project>", "src/main/java/pricing/PriceService.java": "class PriceService {}\n" }, { task: "Refactor the pricing service." }],
    ["monorepo-unrelated-module", MONO, { modules: ["report"] }],
    ["other-broker", { "package.json": npm({ ibmmq: "2", amqplib: "0.10" }), "src/q.ts": 'import mq from "ibmmq";\n' }, { task: "Put the message on the queue again." }],
    ["avro-schema-alone", { "schemas/order.avsc": '{"type":"record","name":"Order","fields":[]}' }, {}],
    ["look-alike-package", { "package.json": npm({ "kafkajs-fake": "1", "not-kafka": "1" }) }, {}],
    ["rest-service", { "package.json": npm({ express: "4" }), "openapi.yaml": "openapi: 3.0.0\n" }, {}],
  ])("%s is not a candidate", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("Kafka code that exists only under docs or examples is low confidence", () => {
    const e = entry({ "docs/examples/package.json": npm({ kafkajs: "2" }), "docs/examples/a.ts": 'import { Kafka } from "kafkajs";\n' }).entry;
    expect(e?.evidence[0]).toMatch(/^kafka: low confidence/);
  });

  it("a task that names Kafka names the skill without repository evidence; a task about events does not", () => {
    const files = { "pom.xml": "<project><dependencies/></project>", "src/main/java/pricing/PriceService.java": "class PriceService {}\n" };
    const named = (task: string) => entry(files, { task }).entry?.evidence;
    expect(named("Publish price changes to Kafka")).toEqual(["named in the task: kafka"]);
    expect(named("Add a Kafka consumer for price changes")).toEqual(["named in the task: kafka, kafka-consumer"]);
    expect(named("Publish an event when the price changes and consume the events in the report")).toEqual([]);
    expect(named("Fix the Kafkaesque naming of the producer class")).toEqual([]);
  });
});

describe("kafka skill: integrity and resolve", () => {
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

describe("kafka skill: behaviour", () => {
  it("the coder block holds the instructions and not the review checks", () => {
    const p = renderSkillPayload([row(ID, "1.0.0")], { maxTokens: 5000 });
    expect(p.text).toContain("## Keys, partitions and ordering");
    expect(p.text).not.toContain(pkg.review!.split("\n")[0]);
  });

  it("the reviewer block holds the review checks and not the instructions", () => {
    const p = renderReviewPayload(
      [{ id: ID, version: "1.0.0", digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
    );
    expect(p.text).toContain('role="reviewer"');
    expect(p.text).toContain("Poison messages:");
    expect(p.text).not.toContain("## Producers");
  });

  it("never assumes exactly-once: every mention is tied to verified configuration and the end-to-end boundary", () => {
    const lines = (text: string) => text.split("\n").filter((l) => /exactly[- ]once|exactly_once/i.test(l));
    const coder = lines(pkg.instructions);
    expect(coder.length).toBeGreaterThan(0);
    // The one line that tells the three guarantees apart may name it; every other line must carry the condition.
    for (const l of coder.filter((x) => !/know the guarantee and name it/.test(x))) expect(l).toMatch(/Never assume, write or claim exactly-once behaviour unless you verified all of it/);
    const rule = coder.find((l) => l.includes("Never assume"))!;
    for (const part of ["idempotent producer", "transactional.id", "offsets committed in the same transaction", "read_committed", "exactly_once_v2", "end-to-end boundary that stays inside Kafka", "the consumer must be idempotent", "If one part is not verified, call it at least once"]) expect(rule).toContain(part);
    expect(pkg.instructions).toMatch(/Assume at least once unless the code proves otherwise/);
    const review = lines(pkg.review!);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatch(/Accept it only when the repository shows the whole chain[^]*no effect leaves Kafka\. Otherwise it is at least once/);
  });

  it("the reviewer checks ordering, replay, poison messages and schema compatibility", () => {
    for (const start of ["Ordering:", "Replay and duplicates:", "Poison messages:", "Schema compatibility:"])
      expect(pkg.review!.split("\n").some((l) => l.startsWith(`- ${start}`))).toBe(true);
  });

  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["acknowledgement", /`acks=all` with `enable\.idempotence=true`/, /`acks` and idempotence kept/],
    ["send result", /never fire and forget/, /result of every send handled/],
    ["dual write", /A database write and a send are two writes/, /without an outbox/],
    ["keys and order", /Order holds only inside one partition/, /share a key\?/],
    ["partition change", /Changing the key, the partitioner or the partition count/, /alter a key, the partitioner or a partition count/],
    ["consumer group", /A new group id starts from `auto\.offset\.reset`/, /`group\.id` or `auto\.offset\.reset` changed/],
    ["offsets", /Commit an offset only after its message is fully processed/, /committed only after processing finished/],
    ["poll interval", /must fit in `max\.poll\.interval\.ms`/, /exceed the poll interval/],
    ["duplicates", /safe when the same message arrives twice/, /arrives twice/],
    ["replay", /replayed from an older offset/, /replayed from an older offset/],
    ["retries", /Retry a transient failure a bounded number of times with backoff\. Never retry a permanent one/, /transient and permanent failures told apart, retries bounded/],
    ["poison message", /must neither block its partition forever nor vanish/, /block a partition forever or vanish/],
    ["dead letter", /keep the original key, value and headers, add the reason and the source topic, partition and offset/, /dead letter sent with key, headers, reason and source position/],
    ["deserialization failure", /A deserialization failure happens before your handler runs/, /cannot be deserialized/],
    ["transactions", /send the consumed offsets inside the transaction, abort on failure/, /offsets in the transaction/],
    ["schema evolution", /Breaking: a removed or renamed field, a changed type, unit or meaning, a new required field without a default/, /required field added without a default/],
    ["schema registry", /You cannot ask the registry: say which mode you assumed and who must deploy first/, /assumed compatibility mode and deploy order named/],
    ["protobuf numbers", /never change or reuse a field number/, /Protobuf field number reused/],
    ["streams", /`application\.id` is the group id and the prefix of internal topics and state stores/, /`application\.id` unchanged/],
    ["co-partitioning", /Joins need the same key and the same partition count/, /co-partitioned/],
    ["observable failures", /Log a failure with topic, partition, offset and the reason; not the payload/, /logged with topic, partition and offset, without payloads or secrets/],
    ["secrets", /No broker address, password, token or certificate in code, tests or logs/, /broker address or credential hard-coded/],
    ["tests", /the same message twice, a replay, a message that cannot be parsed/, /duplicate, replay, unparsable message and failed send/],
    ["no cluster in tests", /Never a shared or real cluster/, /without a real or shared cluster/],
    ["java", /`KafkaConsumer` is not: one thread polls it/, /own skills/],
    ["typescript", /a throw retries the same message and blocks the partition/, /own skills/],
    ["unrelated events", /only mentions events, messages or queues/, /./],
    ["new dependency", /Do not add a client, a serializer, a schema registry client or any other dependency/, /add a client, a dependency or cluster administration/],
  ];
  it.each(SCENARIOS)("%s", (_n, inst, rev) => {
    expect(pkg.instructions).toMatch(inst);
    expect(pkg.review).toMatch(rev);
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
    const ok = ev(runOf([ID], true), { selected: [ID], absent: ["rest-openapi"], max_tokens: budget("budget-coder-tokens") + 300 });
    expect(ok.ok).toBe(true);
    expect(ok.activation.status).toBe("loaded");
    expect(ev(runOf([ID], true), { absent: [ID] }).ok).toBe(false);
    const none = ev(runOf([], false), { absent: [ID] });
    expect(none.ok).toBe(true);
    expect(none.activation.status).toBe("none");
  });
});
