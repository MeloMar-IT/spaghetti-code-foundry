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
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillmq-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const ID = "ibm-mq";
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

describe("ibm-mq skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("interface");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.files.references).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
    expect(pkg.capabilities).toEqual(["ibm-mq-jms", "mqi", "mqmd", "mqsc", "websphere-mq"]);
  });

  it("grants no access: no shell, no network, no connector, read-only files", () => {
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.connectors).toEqual([]);
    expect(pkg.instructions).toMatch(/This skill grants no access to any queue manager/);
    expect(pkg.instructions).toMatch(/do not ask for, guess or invent credentials/);
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

describe("ibm-mq skill: description", () => {
  it("says when it applies and when it does not", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/use when code or config uses an IBM MQ client/i);
    expect(d).toMatch(/not for Kafka, AMQP or a bare mention of MQ/i);
  });

  it("is shown whole in the catalogue", () => {
    const e = entry(PUT_GET).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("ibm-mq skill: budgets", () => {
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
      "When this applies", "Follow the repository first", "Credentials and connections", "Transaction and acknowledgement boundaries",
      "Messages: MQMD, identifiers, correlation", "Encoding", "Poison messages and backout", "Duplicates and retries", "Reconnect",
      "Publish/subscribe", "Tests",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

// Fixtures: put/get (Node.js), request/reply (Java, JMS), pub/sub (Go), and messaging work that is not IBM MQ.
const PUT_GET = {
  "package.json": npm({ ibmmq: "2" }),
  "src/orders-queue.ts": 'import * as mq from "ibmmq";\n// MQPUT1 with MQPMO_SYNCPOINT, then MQGET with MQGMO_SYNCPOINT and MQCMIT\nexport {};\n',
};
const POM_MQ = "<project><dependencies><dependency><groupId>com.ibm.mq</groupId><artifactId>com.ibm.mq.jakarta.client</artifactId><version>9.4.0.0</version></dependency></dependencies></project>";
const REQUEST_REPLY = {
  "pom.xml": POM_MQ,
  "src/main/java/quote/QuoteRequester.java":
    "import com.ibm.msg.client.jakarta.wmq.WMQConstants;\nimport jakarta.jms.Message;\nclass QuoteRequester { /* setJMSReplyTo, receive by JMSCorrelationID */ }\n",
};
const PUB_SUB = {
  "go.mod": "module prices\n\ngo 1.22\n\nrequire github.com/ibm-messaging/mq-golang/v5 v5.6.0\n",
  "internal/prices/subscriber.go": 'package prices\n\nimport "github.com/ibm-messaging/mq-golang/v5/ibmmq"\n\n// MQSUB with MQSO_DURABLE | MQSO_RESUME\nvar _ = ibmmq.MQSO_DURABLE\n',
};
const RABBIT = { "package.json": npm({ amqplib: "0.10" }), "src/worker.ts": 'import amqp from "amqplib";\n// the MQ consumer\nexport {};\n', "README.md": "The MQ worker reads the queue.\n" };
const ACTIVEMQ = {
  "pom.xml": "<project><dependencies><dependency><groupId>org.apache.activemq</groupId><artifactId>activemq-client</artifactId></dependency></dependencies></project>",
  "src/main/java/mq/MqListener.java": "import jakarta.jms.MessageListener;\nimport org.apache.activemq.ActiveMQConnectionFactory;\nclass MqListener {}\n",
};
const MONO = { "billing/package.json": npm({ ibmmq: "2" }), "billing/src/put.ts": 'import * as mq from "ibmmq";\nexport {};\n', "web/package.json": npm({ lodash: "4" }), "web/src/page.ts": "export {};\n" };
type Opts = { task?: string; modules?: string[] };

describe("ibm-mq skill: selection", () => {
  it.each<[string, Record<string, string>, Opts, string]>([
    ["put-get-node", PUT_GET, {}, "high"],
    ["request-reply-java-jms", REQUEST_REPLY, {}, "high"],
    ["pub-sub-go", PUB_SUB, {}, "high"],
    ["python-pymqi", { "requirements.txt": "pymqi==1.12.10\n", "app/reader.py": "import pymqi\n" }, {}, "high"],
    ["dependency-and-mqsc", { "pom.xml": POM_MQ, "mq/queues.mqsc": "DEFINE QLOCAL(ORDERS.IN) BOTHRESH(3) BOQNAME(ORDERS.IN.BOQ)\n" }, {}, "high"],
    ["dependency-only", { "package.json": npm({ ibmmq: "2" }) }, {}, "medium"],
    ["affected-module", MONO, { modules: ["billing"] }, "high"],
  ])("%s is a candidate", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(new RegExp(`^${ID}: ${conf} confidence`));
    const ids = entries.map((x) => x.id);
    expect(ids.indexOf(ID)).toBeLessThan(ids.indexOf("small-changes"));
  });

  it.each<[string, Record<string, string>, Opts]>([
    ["generic-mq-rabbitmq", RABBIT, { task: "Fix the retry of the MQ consumer and add a dead-letter queue for the MQ messages." }],
    ["generic-mq-activemq-jms", ACTIVEMQ, { task: "The MQ listener must acknowledge JMS messages after the database commit." }],
    ["kafka", { "package.json": npm({ kafkajs: "2" }), "src/a.ts": 'import { Kafka } from "kafkajs";\n' }, { task: "Commit the offset after the message is handled." }],
    ["no-messaging", { "package.json": npm({ lodash: "4" }), "src/queue.ts": "export const queue: string[] = [];\n" }, { task: "Speed up the in-memory work queue (our own small mq)." }],
    ["docs-text-only", { "README.md": "IBM MQ, MQSC, MQI, WebSphere MQ\n", "docs/mq.md": "# MQ notes\n" }, {}],
    ["unaffected-module", MONO, { modules: ["web"] }],
  ])("%s is not a candidate", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
  });

  it("the generic words MQ, JMS, queue and topic never name the skill", () => {
    const generic = ["mq", "jms", "queue", "queues", "topic", "messaging", "amqp", "ibm"];
    for (const n of [pkg.id, ...pkg.capabilities]) expect(generic).not.toContain(n);
    const e = entry(PUT_GET, { task: "Rework the MQ queue and topic handling of the JMS messaging layer." }).entry;
    expect(e?.evidence.some((l) => l.startsWith("named in the task"))).toBe(false);
  });

  it("an MQSC file alone, or a dependency only in an example, is low confidence", () => {
    expect(entry({ "mq/queues.mqsc": "DEFINE QLOCAL(A)\n" }).entry?.evidence[0]).toMatch(/^ibm-mq: low confidence/);
    expect(entry({ "examples/package.json": npm({ ibmmq: "2" }) }).entry?.evidence[0]).toMatch(/^ibm-mq: low confidence/);
  });

  it("a task that names IBM MQ itself names the skill, without a confidence claim", () => {
    const named = (task: string) => entry(RABBIT, { task }).entry?.evidence;
    expect(named("Move the worker from RabbitMQ to IBM MQ")).toEqual(["named in the task: ibm-mq"]);
    expect(named("Read the MQMD backout count in the WebSphere MQ adapter")).toEqual(["named in the task: mqmd, websphere-mq"]);
  });

  it("Kafka and IBM MQ in one repository stay two separate candidates", () => {
    const { entries } = entry({ "package.json": npm({ ibmmq: "2", kafkajs: "2" }), "src/a.ts": 'import * as mq from "ibmmq";\n' });
    const mq = entries.find((e) => e.id === ID)!;
    expect(mq.evidence.join(" ")).not.toMatch(/kafka/);
    expect(pkg.capabilities).not.toContain("kafka");
    expect(pkg.instructions).toMatch(/Offsets, consumer groups, exchanges and broker acks are not IBM MQ concepts/);
  });
});

describe("ibm-mq skill: integrity and resolve", () => {
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

const section = (title: string): string => {
  const from = pkg.instructions.indexOf(`## ${title}\n`);
  expect(from).toBeGreaterThanOrEqual(0);
  const next = pkg.instructions.indexOf("\n## ", from + 1);
  return pkg.instructions.slice(from, next < 0 ? undefined : next);
};

describe("ibm-mq skill: behaviour", () => {
  it("the coder block holds the instructions and not the review checks", () => {
    const p = renderSkillPayload([row(ID, "1.0.0")], { maxTokens: 5000 });
    expect(p.text).toContain("## Transaction and acknowledgement boundaries");
    expect(p.text).not.toContain(pkg.review!.split("\n")[0]);
  });

  it("the reviewer block holds the review checks and not the instructions", () => {
    const p = renderReviewPayload(
      [{ id: ID, version: "1.0.0", digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
    );
    expect(p.text).toContain('role="reviewer"');
    expect(p.text).toContain("Reconnect safety:");
    expect(p.text).not.toContain("## Publish/subscribe");
  });

  it("transaction and acknowledgement boundaries are explicit", () => {
    const s = section("Transaction and acknowledgement boundaries");
    for (const re of [
      /For every get and put, state in the code whether it is inside a unit of work/,
      /`MQGMO_SYNCPOINT` \/ `MQPMO_SYNCPOINT` or the `NO_SYNCPOINT` form/,
      /the default differs per platform/,
      /transacted, `CLIENT_ACKNOWLEDGE` or `AUTO_ACKNOWLEDGE`/,
      /A get outside syncpoint removes the message at once/,
      /put the output in the same unit of work, commit once at the end/,
      /never commit in a `finally`/,
      /a normal `MQDISC` commits a pending unit of work/,
      /acknowledges every message the session has consumed so far, not one/,
      /invisible until the commit/,
      /commit the database first, then MQ, and make the handler idempotent/,
      /Do not claim exactly-once/,
    ]) expect(s).toMatch(re);
  });

  it("the reviewer checks duplicates, poison messages, backout thresholds and reconnect safety", () => {
    const line = (start: string) => pkg.review!.split("\n").find((l) => l.startsWith(`- ${start}:`)) ?? "";
    expect(line("Boundaries")).toMatch(/explicitly inside or outside a unit of work/);
    expect(line("Duplicates")).toMatch(/apply the effect twice[^]*idempotent[^]*exactly-once without XA/);
    expect(line("Poison messages")).toMatch(/always fails[^]*backout queue in the same unit of work as the get[^]*committed away, discarded/);
    expect(line("Backout thresholds")).toMatch(/`BackoutCount`[^]*`BOTHRESH`[^]*missing `BOQNAME`[^]*transient failure/);
    expect(line("Reconnect safety")).toMatch(/2003[^]*whole unit of work redone from the get[^]*never reused[^]*bounded/);
  });

  // [scenario, the section of the instructions, what the coder is told, what the reviewer checks]
  const SCENARIOS: [string, string, RegExp, RegExp][] = [
    ["put/get: lost message", "Transaction and acknowledgement boundaries", /must not be lost is got under syncpoint/, /must not be lost got under syncpoint/],
    ["put/get: message id", "Messages: MQMD, identifiers, correlation", /A reused MQMD otherwise repeats the last id/, /ids handled as bytes/],
    ["put/get: persistence", "Messages: MQMD, identifiers, correlation", /Set persistence on purpose/, /Persistence, expiry, format and CCSID/],
    ["put/get: encoding", "Encoding", /`MQFMT_STRING` with the right `CodedCharSetId`[^]*EBCDIC partner/, /non-JMS or EBCDIC partner/],
    ["put/get: JMS header", "Encoding", /`targetClient=1`[^]*`MQRFH2` header before the payload/, /non-JMS/],
    ["request/reply: correlation", "Messages: MQMD, identifiers, correlation", /gets the reply by correlation id[^]*with a bounded wait/, /reply got by correlation id with a timeout/],
    ["request/reply: responder", "Messages: MQMD, identifiers, correlation", /copies the request `MsgId` into the reply `CorrelId`/, /Correlation:/],
    ["request/reply: stale ids", "Messages: MQMD, identifiers, correlation", /Reset them before each get/, /reset before each get/],
    ["request/reply: late reply", "Messages: MQMD, identifiers, correlation", /a reply that comes after the requester gave up/, /late reply handled/],
    ["request/reply: uncommitted request", "Transaction and acknowledgement boundaries", /Commit the request before you wait for its reply/, /Boundaries:/],
    ["pub/sub: durable", "Publish/subscribe", /Choose durable or non-durable on purpose[^]*fixed name from configuration/, /durable or not on purpose, a fixed subscription name/],
    ["pub/sub: several instances", "Publish/subscribe", /must share one subscription/, /one shared subscription for several instances/],
    ["pub/sub: retained", "Publish/subscribe", /retained publication: tolerate an old message/, /Pub\/sub:/],
    ["poison: threshold", "Poison messages and backout", /Compare the count with the queue's `BOTHRESH`[^]*`BOQNAME` in the same unit of work as the get/, /`BOTHRESH`, not a made-up number/],
    ["poison: who does it", "Poison messages and backout", /MQI, Node\.js, Python and Go code must do it/, /moved unchanged to the backout queue/],
    ["poison: never discard", "Poison messages and backout", /Never commit to get rid of a bad message, and never discard one/, /committed away, discarded/],
    ["poison: transient", "Poison messages and backout", /do not drain the queue into the backout queue/, /drain the queue into the backout queue/],
    ["duplicates: idempotent", "Duplicates and retries", /Delivery is at least once[^]*Make the handler idempotent/, /Is the handler idempotent/],
    ["duplicates: unknown outcome", "Duplicates and retries", /broken connection \(2009\) has an unknown outcome/, /retry after a broken connection \(2009\)/],
    ["retries: reason codes", "Duplicates and retries", /Do not retry 2035 \(not authorised\) or 2085 \(unknown object\)/, /2035 and 2085 not retried/],
    ["reconnect: unit of work", "Reconnect", /Redo the whole unit from the get; never continue it or resend only the put/, /whole unit of work redone from the get/],
    ["reconnect: handles", "Reconnect", /never reuse a handle/, /handles rebuilt and never reused/],
    ["reconnect: bounded wait", "Reconnect", /bounded wait and `MQGMO_FAIL_IF_QUIESCING`, never a sleep-and-poll loop/, /Is every wait bounded/],
    ["credentials", "Credentials and connections", /Never put them in code, MQSC, a CCDT, tests, logs or error text/, /credentials, host names or channel secrets in code, MQSC, tests or logs/],
    ["channel security", "Credentials and connections", /no disabled `CHLAUTH` or `CONNAUTH`/, /channel security weakened/],
    ["unrelated messaging", "When this applies", /a task that only says "MQ" or "queue"\. Then ignore this skill/, /Kafka or AMQP ideas[^]*own skills/],
    ["new dependency", "Follow the repository first", /Do not add a second client or a dependency/, /./],
    ["tests", "Tests", /commit and with backout[^]*a timeout and a late reply[^]*backout queue at the threshold[^]*duplicate delivery[^]*connection lost inside a unit of work/, /test use a shared queue manager/],
  ];
  it.each(SCENARIOS)("%s", (_n, title, inst, rev) => {
    expect(section(title)).toMatch(inst);
    expect(pkg.review).toMatch(rev);
  });

  it("names no real endpoint and holds no credential", () => {
    const text = `${pkg.instructions}\n${pkg.review}`;
    expect(text).not.toMatch(/\b[\w.-]+\(\d{4,5}\)/); // host(port) connection names
    expect(text).not.toMatch(/\b(?:password|passwd|pwd)\s*[:=]/i);
    expect(text).not.toMatch(/[a-z]+:\/\/\S/i);
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
