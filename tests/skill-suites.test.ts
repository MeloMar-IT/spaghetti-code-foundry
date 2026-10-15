import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import { overlapLines, overlapReport, versionLines, type OverlapStagedSkill } from "../src/skills/overlap.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";
import {
  compatibilitySuite, declaredVersions, effectiveSkill, messagingSemantics, requiredSuites, suiteLines, suiteRefusal, suiteVerdicts,
  type SelectionLike,
} from "../src/skills/suite-checks.js";
import { parseSuiteRecords, readSuiteRecords } from "../src/skills/suite-records.js";
import type { SuiteRecord } from "../src/skills/suite-rules.js";

const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT };
const TODAY = "2026-10-15";
// Built at run time so that no line of this file looks like a credential to the secret scan.
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const f = (path: string, text: string) => ({ path, content: new Uint8Array(Buffer.from(text)) });

function skill(name: string, yaml = "", body = "Do the work."): NormalizedSkill {
  const files = [f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n---\n\n${body}\n`), ...(yaml ? [f("skill.yaml", yaml)] : [])];
  const r = normalizeSkill(ORIGIN, { root: `skills/${name}`, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
const withCaps = (name: string, caps: string[], extra = "") => skill(name, `capabilities: [${caps.join(", ")}]\n${extra}`);
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
  id: "lib", repository: ORIGIN.repository, repositoryKey: ORIGIN.repositoryKey, status: "enabled", ref: { approved: COMMIT }, paths: ["skills"],
  adapter: "agent-skills", trust: "community", licence: { allow: ["Apache-2.0"] }, update: { cadence: "manual" }, owner: "@example", ...over,
});
const CONFLUENT = {
  provider: "confluent",
  portable: [{ upstream: "producer", capability: "kafka-producer" }, { upstream: "streams", capability: "kafka-streams" }],
  products: [{ name: "apache-kafka", version: ">=4.0" }, { name: "confluent-platform", version: ">=8.0" }, { name: "flink", version: ">=1.19" }],
};
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object" && !ArrayBuffer.isView(v) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
};
const sel = (s: NormalizedSkill, over: Partial<SelectionLike> = {}): SelectionLike => ({
  source: "lib", skill: s.provenance.name, digest: s.package.digest, scope: "portable", capabilities: ["kafka-schema", "kafka-streams"], ...over,
});

const kafkaSkill = readFileSync("skills/kafka/SKILL.md", "utf8");
const kafkaReview = readFileSync("skills/kafka/REVIEW.md", "utf8");
const lineCodes = (line: string) => messagingSemantics([{ path: "SKILL.md", text: line }]).codes;

describe("messagingSemantics", () => {
  it("gives no codes for the built-in kafka skill", () => {
    expect(messagingSemantics([{ path: "SKILL.md", text: kafkaSkill }])).toEqual({ codes: [], at: [] });
    expect(messagingSemantics([{ path: "REVIEW.md", text: kafkaReview }])).toEqual({ codes: [], at: [] });
  });

  const FULL = "Exactly-once needs an idempotent producer with a transactional.id, offsets in the same transaction, readers on read_committed and a boundary inside Kafka";
  it.each([
    ["Kafka gives exactly-once delivery.", "exactly-once"],
    ["Exactly-once needs an idempotent producer, a transactional.id and read_committed readers, all inside Kafka.", "exactly-once"],
    [`${FULL}, and it also gives exactly-once into the database.`, "exactly-once"],
    ["Set processing.guarantee=exactly_once_v2 for exactly-once.", "exactly-once"],
    ["With exactly_once_v2, exactly-once inside Kafka also guarantees exactly-once database writes outside Kafka.", "exactly-once"],
    ["Order is kept across partitions.", "ordering"],
    ["You can increase the partition count safely.", "keys"],
    ["Consumers never see duplicates.", "duplicates"],
    ["Retry the message forever.", "retries"],
    ["Skip the poison message.", "dead-letters"],
    ["Send it to the dead letter topic without the original key.", "dead-letters"],
    ["Remove the key before you send it to the dead-letter topic.", "dead-letters"],
    ["Without transactions Kafka gives exactly-once delivery.", "exactly-once"],
  ])("fails %j with %s", (line, code) => {
    const r = messagingSemantics([{ path: "SKILL.md", text: `intro\n${line}\n` }]);
    expect(r).toEqual({ codes: [code], at: ["SKILL.md:2"] });
  });

  it.each([
    "Order is not kept across partitions.",
    "At most once, at least once, or exactly once inside Kafka.",
    `${FULL}. A database write stays outside and must be idempotent.`,
    "With processing.guarantee=exactly_once_v2 a topology is exactly-once inside Kafka. A database write stays outside and must be idempotent.",
    "Kafka does not guarantee exactly-once delivery.",
    "Never send a message to the dead letter topic without the original key.",
    "Do not remove the key before you send it to the dead-letter topic.",
    "skip the failed message and send it to the dead-letter topic",
  ])("passes %j", (line) => {
    expect(lineCodes(line)).toEqual([]);
  });

  it("sorts and caps the places, and shows a path with control characters escaped", () => {
    const text = Array.from({ length: 12 }, () => "Order is kept across partitions.").join("\n");
    const r = messagingSemantics([{ path: "b/SKILL.md", text }, { path: "a/\u001b[31mx.md", text: "Kafka gives exactly-once delivery." }]);
    expect(r.codes).toEqual(["exactly-once", "ordering"]);
    expect(r.at).toHaveLength(11);
    expect(r.at[0]).toBe("a/\\u{1b}[31mx.md:1");
    expect(r.at[10]).toBe("+3 more");
    expect(r.at.slice(1, 10)).toEqual(Array.from({ length: 9 }, (_, i) => `b/SKILL.md:${[1, 10, 11, 12, 2, 3, 4, 5, 6][i]}`));
  });
});

describe("compatibilitySuite", () => {
  const declared = [{ name: "apache-kafka", version: ">=4.0" }];
  it("passes when the version fits", () => {
    expect(compatibilitySuite(declared, [{ name: "apache-kafka", version: "4.1.0" }])).toBeUndefined();
  });
  it("fails with its own code", () => {
    expect(compatibilitySuite(declared, [{ name: "apache-kafka", version: "3.8.0" }])).toBe("incompatible");
    expect(compatibilitySuite([{ name: "apache-kafka", version: "not a range" }], [{ name: "apache-kafka", version: "4.1.0" }])).toBe("unchecked");
    expect(compatibilitySuite([], [{ name: "apache-kafka", version: "4.1.0" }])).toBe("no-declared-versions");
    expect(compatibilitySuite([{ name: "java", version: "<=8" }], [{ name: "java", version: "8" }])).toBe("stale");
  });
  it("needs evidence for every declared version, not just one", () => {
    const three = [...declared, { name: "confluent-platform", version: ">=8.0" }, { name: "flink", version: ">=1.19" }];
    expect(compatibilitySuite(three, [{ name: "apache-kafka", version: "4.1.0" }])).toBe("unchecked");
    expect(compatibilitySuite(three, [{ name: "apache-kafka", version: "4.1.0" }, { name: "confluent-platform", version: "8.0.0" }])).toBe("unchecked");
    expect(
      compatibilitySuite(three, [{ name: "apache-kafka", version: "4.1.0" }, { name: "confluent-platform", version: "8.0.0" }, { name: "flink", version: "1.20.0" }]),
    ).toBeUndefined();
  });
});

describe("effectiveSkill", () => {
  const src = source({ profile: CONFLUENT });
  it("a portable selection gives a skill without capabilities the catalogue names", () => {
    const s = skill("streams-apps");
    const e = effectiveSkill(s, src, [sel(s)]);
    expect(e).toMatchObject({ portable: ["kafka-schema", "kafka-streams"], vendor: [], selected: true });
    expect(e.skill!.package.capabilities).toEqual(["kafka-schema", "kafka-streams"]);
    expect(e.skill!.package.provider).toBeUndefined();
  });
  it("a provider selection gives vendor capabilities, and its product wins over the profile product", () => {
    const s = skill("registry");
    const e = effectiveSkill(s, src, [sel(s, { scope: "provider", provider: "confluent", capabilities: ["schema-registry"], product: { name: "apache-kafka", version: ">=4.1" } })]);
    expect(e).toMatchObject({ portable: [], vendor: ["confluent-schema-registry"], provider: "confluent", selected: true });
    expect(e.skill!.package.provider!.products).toEqual([
      { name: "apache-kafka", version: ">=4.1" }, { name: "confluent-platform", version: ">=8.0" }, { name: "flink", version: ">=1.19" },
    ]);
  });
  it("a provider selection that does not fit the profile gives no skill", () => {
    const s = skill("registry");
    const e = effectiveSkill(s, src, [sel(s, { scope: "provider", provider: "other", capabilities: ["x"] })]);
    expect(e.skill).toBeUndefined();
  });
  it("ignores a selection for another digest, another source or another skill", () => {
    const s = skill("streams-apps");
    for (const other of [{ digest: "sha256:" + "0".repeat(64) }, { source: "elsewhere" }, { skill: "other" }]) {
      const e = effectiveSkill(s, src, [sel(s, other)]);
      expect(e).toMatchObject({ portable: [], vendor: [], selected: false });
    }
  });
  it("a skill with its own capabilities ignores the selection and equals the profile result", () => {
    const s = withCaps("clients", ["producer", "tools"]);
    const e = effectiveSkill(s, src, [sel(s)]);
    expect(e).toMatchObject({ portable: ["kafka-producer"], vendor: ["confluent-tools"], provider: "confluent", selected: false });
    expect(e.skill!.package.capabilities).toEqual(["confluent-tools", "kafka-producer"]);
  });
  it("does not change its input", () => {
    const s = deepFreeze(skill("streams-apps"));
    const selections = deepFreeze([sel(s)]);
    const frozenSource = deepFreeze(source({ profile: CONFLUENT }));
    expect(() => effectiveSkill(s, frozenSource, selections)).not.toThrow();
    expect(s.package.capabilities).toEqual([]);
  });
});

describe("declaredVersions", () => {
  it("a skill's own technology wins over the scope, and the scope wins over a product; the result is sorted", () => {
    const s = withCaps("a", ["kafka-consumer"], "provider:\n  name: confluent\n  products:\n    - {name: flink, version: '>=1.18'}\n    - {name: apache-kafka, version: '>=2.0'}\n");
    const own = { ...s, provenance: { ...s.provenance, technologies: [{ name: "zeta", version: "1.0" }, { name: "flink" }] } };
    const v = declaredVersions(own, { scope: { capabilities: [], technologies: [{ name: "zeta", version: "9.9" }, { name: "apache-kafka", version: ">=4.0" }] } });
    expect(v).toEqual([{ name: "apache-kafka", version: ">=4.0" }, { name: "flink", version: ">=1.18" }, { name: "zeta", version: "1.0" }]);
  });
});

describe("requiredSuites", () => {
  const BOTH = ["messaging-semantics", "compatibility"];
  it("needs both for a kafka- or confluent- capability", () => {
    expect(requiredSuites(withCaps("a", ["kafka-consumer"]), source(), []).suites).toEqual(BOTH);
    expect(requiredSuites(withCaps("a", ["confluent-sql"]), source(), []).suites).toEqual(BOTH);
  });
  it("needs both for a capability-less skill of a confluent source", () => {
    expect(requiredSuites(skill("a"), source({ profile: CONFLUENT }), [])).toEqual({ suites: BOTH, profileFailed: false });
  });
  it("needs both when the source scope adds a kafka- capability", () => {
    const src = source({ scope: { capabilities: ["kafka-consumer"], technologies: [] } });
    expect(requiredSuites(skill("a"), src, [])).toEqual({ suites: BOTH, profileFailed: false });
  });
  it("needs both, with profileFailed, when the profile cannot be applied", () => {
    const long = "x".repeat(60);
    expect(requiredSuites(withCaps("a", [long]), source({ profile: CONFLUENT }), [])).toEqual({ suites: BOTH, profileFailed: true });
  });
  it("needs none for another skill of another source", () => {
    expect(requiredSuites(withCaps("a", ["code-review"]), source(), [])).toEqual({ suites: [], profileFailed: false });
  });
  it("a selection can bring a skill into the gate", () => {
    const s = skill("a");
    expect(requiredSuites(s, source(), []).suites).toEqual([]);
    expect(requiredSuites(s, source(), [sel(s)]).suites).toEqual(BOTH);
  });
});

const DIGEST = "sha256:" + "1".repeat(64);
const entry = (over: Record<string, unknown> = {}) => ({
  source: "lib", skill: "a", digest: DIGEST, suite: "messaging-semantics", result: "passed", owner: "@octocat", reviewed: "2026-10-01", ...over,
});
const file = (...evaluations: unknown[]) => ({ schema: 1, evaluations });
const problems = (raw: unknown) => parseSuiteRecords(raw, TODAY).problems.map((p) => `${p.where}: ${p.message}`);

describe("parseSuiteRecords", () => {
  it("accepts valid input and sorts project", () => {
    const r = parseSuiteRecords(file(entry(), entry({ suite: "compatibility", project: { flink: "1.20.0", "apache-kafka": "4.1.0" }, note: "checked" })), TODAY);
    expect(r.problems).toEqual([]);
    expect(r.manifest!.evaluations[1]!.project).toEqual([{ name: "apache-kafka", version: "4.1.0" }, { name: "flink", version: "1.20.0" }]);
  });
  it.each([
    ["an unknown key", entry({ extra: 1 }), /unknown key "extra"/],
    ["a wildcard", entry({ skill: "a*" }), /wildcards are not allowed/],
    ["a bad digest", entry({ digest: "sha256:abc" }), /package digest/],
    ["a future date", entry({ reviewed: "2026-10-16" }), /must not be in the future/],
    ["a missing project", entry({ suite: "compatibility" }), /project is required|is required for the compatibility/],
    ["a project for messaging", entry({ project: { flink: "1.20.0" } }), /not allowed for the messaging-semantics/],
    ["nine project entries", entry({ suite: "compatibility", project: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`t${i}`, "1.0"])) }), /1 to 8 technologies/],
    ["a version that is not plain", entry({ suite: "compatibility", project: { flink: ">=1.0" } }), /plain version/],
    ["a bad result", entry({ result: "maybe" }), /"passed" or "failed"/],
  ])("refuses %s", (_name, e, re) => {
    expect(problems(file(e)).join("\n")).toMatch(re);
  });
  it("refuses a duplicate of source, skill and suite", () => {
    expect(problems(file(entry(), entry({ result: "failed" })))).toEqual(["evaluations[1] (lib/a): is already listed by evaluations[0]"]);
  });
  it("refuses a credential-like note and names the rule, not the text", () => {
    const p = problems(file(entry({ note: `key ${AWS_KEY}` })));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("(AWS access key)");
    expect(p[0]).not.toContain(AWS_KEY);
  });
  it("refuses schema 2 and too many entries", () => {
    expect(problems({ schema: 2, evaluations: [] })).toEqual(["schema: schema must be 1"]);
    expect(problems(file(...Array.from({ length: 501 }, (_, i) => entry({ skill: `s-${i}` }))))).toEqual(["evaluations: must hold at most 500 evaluations"]);
  });
  it("accepts 500 valid compatibility records with projects", () => {
    const project = () => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tech-${i}`, "1.2.3"]));
    const r = parseSuiteRecords(file(...Array.from({ length: 500 }, (_, i) => entry({ skill: `s-${i}`, suite: "compatibility", project: project() }))), TODAY);
    expect(r.problems).toEqual([]);
    expect(r.manifest!.evaluations).toHaveLength(500);
  });
});

describe("readSuiteRecords", () => {
  const made: string[] = [];
  afterEach(() => void made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "suiterecords-"));
    made.push(d);
    return d;
  };
  it("a missing file is none", () => {
    expect(readSuiteRecords(join(dir(), "missing.yaml"), TODAY)).toEqual({ state: "none" });
  });
  it("reads a valid file, and refuses a symbolic link", () => {
    const d = dir();
    writeFileSync(join(d, "real.yaml"), `schema: 1\nevaluations:\n  - {source: lib, skill: a, digest: '${DIGEST}', suite: messaging-semantics, result: passed, owner: '@octocat', reviewed: '2026-10-01'}\n`);
    symlinkSync(join(d, "real.yaml"), join(d, "link.yaml"));
    expect(readSuiteRecords(join(d, "real.yaml"), TODAY).state).toBe("ok");
    expect(readSuiteRecords(join(d, "link.yaml"), TODAY)).toMatchObject({ state: "invalid", problems: [{ message: "is a symbolic link" }] });
  });
  it("refuses text that is not YAML", () => {
    const d = dir();
    writeFileSync(join(d, "bad.yaml"), "a: [\n");
    expect(readSuiteRecords(join(d, "bad.yaml"), TODAY).state).toBe("invalid");
  });
});

describe("suiteVerdicts", () => {
  const kafkaSource = source({ scope: { capabilities: [], technologies: [{ name: "apache-kafka", version: ">=4.0" }] } });
  const s = withCaps("a", ["kafka-consumer"]);
  const rec = (suite: SuiteRecord["suite"], over: Partial<SuiteRecord> = {}): SuiteRecord => ({
    source: "lib", skill: "a", digest: s.package.digest, suite, result: "passed", owner: "@octocat", reviewed: "2026-10-01",
    ...(suite === "compatibility" ? { project: [{ name: "apache-kafka", version: "4.1.0" }] } : {}), ...over,
  });
  const run = (records: SuiteRecord[], texts: { path: string; text: string }[] = [], src = kafkaSource) =>
    suiteVerdicts({ source: src, skill: s, selections: [], records, texts });

  it("is empty for a skill that needs no suite", () => {
    expect(suiteVerdicts({ source: source(), skill: skill("b"), selections: [], records: [], texts: [] })).toEqual([]);
  });
  it("not-recorded", () => {
    const v = run([]);
    expect(v.map((x) => [x.suite, x.codes])).toEqual([["messaging-semantics", ["not-recorded"]], ["compatibility", ["not-recorded"]]]);
    expect(suiteRefusal(v)).toBe("messaging-semantics: not-recorded; compatibility: not-recorded");
  });
  it("recorded-failed and other-digest", () => {
    const v = run([rec("messaging-semantics", { result: "failed" }), rec("compatibility", { digest: "sha256:" + "0".repeat(64) })]);
    expect(v.map((x) => x.codes)).toEqual([["recorded-failed"], ["other-digest"]]);
  });
  it("profile", () => {
    const bad = withCaps("a", ["x".repeat(60)]);
    const v = suiteVerdicts({ source: source({ profile: CONFLUENT }), skill: bad, selections: [], records: [], texts: [] });
    expect(v.map((x) => x.codes)).toEqual([["profile"], ["profile"]]);
  });
  it("passes with matching records", () => {
    const v = run([rec("messaging-semantics"), rec("compatibility")]);
    expect(v.every((x) => x.ok)).toBe(true);
    expect(suiteRefusal(v)).toBeUndefined();
    expect(suiteLines("lib", s, v)).toEqual([
      `EVALUATION lib/a messaging-semantics ${s.package.digest}: passed`,
      `EVALUATION lib/a compatibility ${s.package.digest}: passed`,
    ]);
  });
  it("a check failure shows even with a passed record", () => {
    const v = run([rec("messaging-semantics"), rec("compatibility", { project: [{ name: "apache-kafka", version: "3.8.0" }] })], [{ path: "SKILL.md", text: "Order is kept across partitions." }]);
    expect(v[0]).toMatchObject({ ok: false, codes: ["ordering"], at: ["SKILL.md:1"] });
    expect(v[1]).toMatchObject({ ok: false, codes: ["incompatible"] });
    expect(suiteLines("lib", s, v)[0]).toBe(`EVALUATION lib/a messaging-semantics ${s.package.digest}: ordering at SKILL.md:1`);
  });
  it("a compatibility record with only part of the declared evidence is unchecked", () => {
    const src = source({ scope: { capabilities: [], technologies: [{ name: "apache-kafka", version: ">=4.0" }, { name: "flink", version: ">=1.19" }] } });
    expect(run([rec("messaging-semantics"), rec("compatibility")], [], src)[1]!.codes).toEqual(["unchecked"]);
  });
  it("does not change its input", () => {
    const input = deepFreeze({ source: kafkaSource, skill: s, selections: [], records: [rec("messaging-semantics")], texts: [{ path: "SKILL.md", text: "x" }] });
    expect(() => suiteVerdicts(input)).not.toThrow();
  });
});

describe("overlap: versions and selections", () => {
  const reg = (id: string, caps: string[], provider?: string): RegisteredSkill =>
    ({
      key: `${id}@1.0.0`, id, version: "1.0.0", source: "builtin", label: "builtin", dir: "/x", active: true, trust: "builtin", pin: "pinned", digest: "sha256:" + id.padEnd(64, "b").slice(0, 64),
      pkg: {
        id, version: "1.0.0", capabilities: caps, category: "database", risk: "low", connectors: [], tool_profile: { shell: false, network: false, filesystem: "read" },
        files: { references: [], scripts: [], assets: [], evals: [] }, description: id, instructions: id, digest: "sha256:" + id,
        ...(provider ? { provider: { name: provider, products: [], tools: [] } } : {}),
      },
    }) as unknown as RegisteredSkill;
  const entry = (sk: NormalizedSkill): OverlapStagedSkill => ({ skill: sk, licence: "allowed", safe: true });
  const run = (src: SkillLibrarySource, staged: NormalizedSkill[], regs: RegisteredSkill[], selections: SelectionLike[] = []) => {
    const report = overlapReport({ source: src, skills: staged.map(entry), selections }, regs, { highRisk: [] });
    return { report, lines: overlapLines(report) };
  };
  const ref = (x: NormalizedSkill) => `${x.package.id}@${x.package.version}`;

  it("versionLines: a vendor skill, a portable skill, and none for a skill with neither", () => {
    const vendor = withCaps("vendor", ["tools"]);
    const portable = withCaps("portable", ["producer"]);
    const plain = withCaps("plain", ["code-review"]);
    const src = source({ profile: { ...CONFLUENT, portable: [{ upstream: "producer", capability: "kafka-producer" }] }, scope: { capabilities: [], technologies: [{ name: "apache-kafka", version: ">=4.0" }] } });
    const { report } = run(src, [vendor, portable], []);
    expect(versionLines(report)).toEqual([
      `VERSIONS ${ref(portable)}: apache-kafka >=4.0`,
      `VERSIONS ${ref(vendor)}: apache-kafka >=4.0, confluent-platform >=8.0, flink >=1.19`,
    ].sort());
    const none = run(source(), [plain], []);
    expect(versionLines(none.report)).toEqual([]);
    expect(none.lines).toEqual([`NEW code-review: ${ref(plain)}`]);
  });

  it("a provider selection without a source profile keeps the registered skills of that provider", () => {
    const s = skill("registry");
    const select = [sel(s, { scope: "provider", provider: "acme", capabilities: ["flink-sql"] })];
    const same = run(source(), [s], [reg("acme-tools", ["acme-flink-sql"], "acme")], select);
    expect(same.report.entries.map((e) => [e.kind, e.capability])).toEqual([["canonical", "acme-flink-sql"]]);
    const other = run(source(), [s], [reg("other-tools", ["acme-flink-sql"], "other")], select);
    expect(other.report.entries.map((e) => [e.kind, e.capability])).toEqual([["new", "acme-flink-sql"]]);
    expect(other.report.vendorOnly).toBe(1);
  });
});
