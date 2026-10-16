import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scenarioOffers } from "../src/skill-eval/effect.js";
import {
  effectLines, effectVerdict, fisherExact, parseEffectOperands, parseEffectRecord, type EffectRecord, type EffectRun, type EffectScenario,
} from "../src/skills/effect.js";
import { findNewestRecordOf, readNewestEffect, writeEffectRecord } from "../src/skills/evaluation-store.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";
import { skillsCommand, SKILLS_USAGE } from "../src/skills/cli.js";
import { loadSkillPackage } from "../src/skills/package.js";
import type { RegisteredSkill } from "../src/skills/registry.js";

// Secret-like text is built from pieces: tools/secret-scan reads this file too.
const PW = "Abcdefgh" + "123456789";
const ANT = "sk-" + "ant-" + "a1B2c3D4e5".repeat(3);

const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
const SUITE = "sha256:" + "3".repeat(64);
const COMMIT = "a".repeat(40);

describe("fisherExact", () => {
  it("matches known values", () => {
    expect(fisherExact(18, 20, 10, 20)).toBeCloseTo(0.0138, 3);
    expect(fisherExact(16, 20, 10, 20)).toBeCloseTo(0.0958, 3);
    expect(fisherExact(16, 20, 10, 20)).toBeGreaterThan(0.05);
    expect(fisherExact(4, 4, 0, 4)).toBeCloseTo(2 / 70, 10);
    expect(fisherExact(3, 3, 0, 3)).toBeCloseTo(0.1, 10);
    expect(fisherExact(0, 0, 0, 0)).toBe(1);
    expect(fisherExact(5, 5, 5, 5)).toBeCloseTo(1, 10);
  });

  it("is symmetric in the arms", () => {
    expect(fisherExact(18, 20, 10, 20)).toBe(fisherExact(10, 20, 18, 20));
    expect(fisherExact(7, 9, 3, 14)).toBe(fisherExact(3, 14, 7, 9));
  });

  it("refuses counts that are out of range", () => {
    expect(() => fisherExact(1, 201, 1, 5)).toThrow(RangeError);
    expect(() => fisherExact(1, 5, 1, 201)).toThrow(RangeError);
    expect(() => fisherExact(6, 5, 1, 5)).toThrow(RangeError);
    expect(() => fisherExact(1, 5, 6, 5)).toThrow(RangeError);
    expect(() => fisherExact(1.5, 5, 1, 5)).toThrow(RangeError);
    expect(() => fisherExact(-1, 5, 1, 5)).toThrow(RangeError);
  });
});

const sc = (id: string, offered = true): EffectScenario => ({ id, task: `Task of ${id}.`, offered });
const arm = (passed: number, runs: number, loaded = true) => Array.from({ length: runs }, (_, i) => ({ pass: i < passed, loaded }));

describe("effectVerdict", () => {
  const one = [sc("a")];
  it("helps when the pass rate is significantly higher", () => {
    const v = effectVerdict({ scenarios: one, with: arm(18, 20), without: arm(10, 20, false) });
    expect(v).toMatchObject({ verdict: "helps", reason: "pass-rate-higher", with: { passed: 18, runs: 20 }, without: { passed: 10, runs: 20 } });
    expect(v.difference).toBeCloseTo(0.4, 6);
    expect(v.p).toBeCloseTo(0.0138, 3);
  });
  it("harms in the mirror case", () => {
    const v = effectVerdict({ scenarios: one, with: arm(10, 20), without: arm(18, 20, false) });
    expect(v).toMatchObject({ verdict: "harms", reason: "pass-rate-lower" });
    expect(v.difference).toBeCloseTo(-0.4, 6);
  });
  it("needs a p value of 0.05 or less", () => {
    const v = effectVerdict({ scenarios: one, with: arm(16, 20), without: arm(10, 20, false) });
    expect(v).toMatchObject({ verdict: "no-measurable-effect", reason: "not-significant" });
    expect(v.difference).toBeCloseTo(0.3, 6);
  });
  it("needs a difference of 0.2 or more", () => {
    const v = effectVerdict({ scenarios: one, with: arm(120, 200), without: arm(90, 200, false) });
    expect(v.p).toBeLessThan(0.05);
    expect(v).toMatchObject({ verdict: "no-measurable-effect", reason: "not-significant" });
    expect(v.difference).toBeCloseTo(0.15, 6);
  });
  it("is never-selected when nothing is offered", () => {
    expect(effectVerdict({ scenarios: [sc("a", false)], with: [], without: [] })).toEqual({
      verdict: "no-measurable-effect", reason: "never-selected", with: { passed: 0, runs: 0 }, without: { passed: 0, runs: 0 }, difference: 0, p: 1,
    });
  });
  it("is never-selected when no run loaded the skill", () => {
    const v = effectVerdict({ scenarios: one, with: arm(20, 20, false), without: arm(0, 20, false) });
    expect(v).toMatchObject({ verdict: "no-measurable-effect", reason: "never-selected", p: 1, with: { passed: 20, runs: 20 } });
  });
  it("does not look at tokens or time", () => {
    const base = { scenarios: one };
    const slow = (r: { pass: boolean; loaded: boolean }) => ({ ...r, tokens: 9_000_000, durationMs: 9_000_000 });
    const quick = (r: { pass: boolean; loaded: boolean }) => ({ ...r, tokens: 1, durationMs: 1 });
    const a = effectVerdict({ ...base, with: arm(18, 20).map(slow), without: arm(10, 20, false).map(quick) });
    const b = effectVerdict({ ...base, with: arm(18, 20).map(quick), without: arm(10, 20, false).map(slow) });
    expect(a).toEqual(b);
  });
});

function runs(scenario: string, n: number, pass: (i: number) => boolean, loaded: boolean, prefix: string): EffectRun[] {
  return Array.from({ length: n }, (_, i) => ({ scenario, attempt: i + 1, runId: `${prefix}-${scenario}-${i + 1}`, pass: pass(i), loaded, tokens: 100 + i, durationMs: 1500 }));
}

/** Two offered scenarios (repeat 3) and one that is not offered. With: all pass. Without: none passes. */
function record(over: { withPass?: boolean; withoutPass?: boolean; loaded?: boolean } = {}): EffectRecord {
  const scenarios = [sc("a"), sc("b"), sc("c", false)];
  const withRuns = [...runs("a", 3, () => over.withPass ?? true, over.loaded ?? true, "w"), ...runs("b", 3, () => over.withPass ?? true, over.loaded ?? true, "w")];
  const withoutRuns = [...runs("a", 3, () => over.withoutPass ?? false, false, "n"), ...runs("b", 3, () => over.withoutPass ?? false, false, "n")];
  return {
    schema: 1,
    skill: { id: "lib-kafka", version: "1.0.0", digest: D1, source: "lib", commit: COMMIT },
    suite: { digest: SUITE, repeat: 3 },
    runtime: { foundry: "test", node: "v20.11.0", agent: "claude", model: "default" },
    ranAt: "2026-10-15T10:00:00Z",
    scenarios,
    runs: { with: withRuns, without: withoutRuns },
    verdict: effectVerdict({ scenarios, with: withRuns, without: withoutRuns }),
  };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const problemOf = (raw: unknown): string => {
  const r = parseEffectRecord(raw);
  if (!("problem" in r)) throw new Error("expected a problem");
  return r.problem;
};

describe("parseEffectRecord", () => {
  it("round-trips a valid record", () => {
    const r = record();
    expect(r.verdict.verdict).toBe("helps");
    const parsed = parseEffectRecord(clone(r));
    expect("record" in parsed && parsed.record).toEqual(r);
  });

  it("refuses a verdict that its runs do not give", () => {
    const a = clone(record());
    a.verdict.verdict = "no-measurable-effect";
    expect(problemOf(a)).toMatch(/stored verdict differs/);
    const b = clone(record());
    b.verdict.p = 0.5;
    expect(problemOf(b)).toMatch(/stored verdict differs/);
  });

  it("refuses unknown keys and bad shapes", () => {
    const a = clone(record()) as unknown as Record<string, unknown>;
    a.extra = 1;
    expect(parseEffectRecord(a)).toHaveProperty("problem");
    const b = clone(record());
    b.skill = { id: "lib-kafka", version: "1.0.0", digest: D1, source: "lib" };
    expect(problemOf(b)).toMatch(/source and commit come together/);
  });

  it("refuses runs that break the rules", () => {
    const loaded = clone(record());
    loaded.runs.without[0]!.loaded = true;
    expect(problemOf(loaded)).toMatch(/without the skill/);

    const unknown = clone(record());
    unknown.runs.with[0]!.scenario = "c";
    expect(problemOf(unknown)).toMatch(/not offered/);

    const short = clone(record());
    short.runs.with.pop();
    expect(problemOf(short)).toMatch(/repeat times/);

    const dup = clone(record());
    dup.runs.without[0]!.runId = dup.runs.with[0]!.runId;
    expect(problemOf(dup)).toMatch(/run id is used twice/);
  });

  it("needs both arms to be full when something is offered, even when nothing loaded", () => {
    const empty = clone(record());
    empty.runs.without = [];
    expect(problemOf(empty)).toMatch(/repeat times/);

    const never = record({ loaded: false });
    expect(never.verdict).toMatchObject({ verdict: "no-measurable-effect", reason: "never-selected" });
    expect(parseEffectRecord(clone(never))).toHaveProperty("record");
  });

  it("expects no runs when nothing is offered", () => {
    const r = clone(record());
    r.scenarios.forEach((s) => (s.offered = false));
    expect(problemOf(r)).toMatch(/nothing is offered/);
    r.runs = { with: [], without: [] };
    r.verdict = effectVerdict({ scenarios: r.scenarios, with: [], without: [] });
    expect(parseEffectRecord(r)).toHaveProperty("record");
  });

  it("checks the combined run limit before it recomputes", () => {
    const r = clone(record());
    r.suite.repeat = 20;
    r.scenarios = Array.from({ length: 20 }, (_, i) => sc(`s${String.fromCharCode(97 + i)}`));
    const fill = (prefix: string): EffectRun[] =>
      Array.from({ length: 200 }, (_, i) => ({ scenario: r.scenarios[i % 20]!.id, attempt: Math.floor(i / 20) + 1, runId: `${prefix}-${i}`, pass: true, loaded: prefix === "w", tokens: 1, durationMs: 1 }));
    r.runs = { with: fill("w"), without: fill("n") };
    expect(() => parseEffectRecord(clone(r))).not.toThrow();
    expect(problemOf(clone(r))).toMatch(/too many runs/);
  });

  it("finds credentials in decoded text, not only in the serialized JSON", () => {
    const quoted = clone(record());
    quoted.scenarios[0]!.task = `pass${"word"} = "${PW}"`;
    const p1 = problemOf(quoted);
    expect(p1).toMatch(/credential-like text/);
    expect(p1).not.toContain(PW);

    const token = clone(record());
    token.scenarios[0]!.task = `Use ${ANT} to log in.`;
    const p2 = problemOf(token);
    expect(p2).toMatch(/credential-like text/);
    expect(p2).not.toContain(ANT);
  });
});

describe("effectLines", () => {
  it("prints the skipped scenarios, every run and the verdict", () => {
    const lines = effectLines(record());
    expect(lines[0]).toBe("SKIPPED lib-kafka@1.0.0 c: not offered; not run");
    expect(lines[1]).toBe("RUN lib-kafka@1.0.0 with a 1/3 run w-a-1: 1");
    expect(lines).toContain("RUN lib-kafka@1.0.0 without b 3/3 run n-b-3: 0");
    expect(lines.at(-1)).toBe(
      "EFFECT lib-kafka@1.0.0 helps (pass-rate-higher): with 6/6, without 0/6, difference +1.00, p 0.0022; tokens 606 vs 606; time 9 s vs 9 s",
    );
  });

  it("marks a with run that did not load the skill, and prints a negative difference", () => {
    const lines = effectLines(record({ loaded: false }));
    expect(lines).toContain("RUN lib-kafka@1.0.0 with a 1/3 run w-a-1: 1 (skill-not-loaded)");
    expect(lines.at(-1)).toContain("(never-selected)");
    const harm = effectLines(record({ withPass: false, withoutPass: true }));
    expect(harm.at(-1)).toContain("harms (pass-rate-lower)");
    expect(harm.at(-1)).toContain("difference -1.00");
  });
});

describe("parseEffectOperands", () => {
  it("reads both forms", () => {
    expect(parseEffectOperands(["lib", "s-a"])).toEqual({ kind: "staged", source: "lib", skill: "s-a" });
    expect(parseEffectOperands(["lib", "s-a", "s.yaml"])).toEqual({ kind: "staged", source: "lib", skill: "s-a", suiteFile: "s.yaml" });
    expect(parseEffectOperands(["kafka@1.0.0"])).toEqual({ kind: "approved", id: "kafka", version: "1.0.0" });
    expect(parseEffectOperands(["kafka@1.0.0", "s.yaml"])).toEqual({ kind: "approved", id: "kafka", version: "1.0.0", suiteFile: "s.yaml" });
  });
  it("refuses everything else", () => {
    for (const ops of [[], ["lib"], ["bad@"], ["lib", "s-a", "s.yaml", "x"], ["Lib", "s-a"], ["lib", "bad@1.0.0"], ["k@1.0.0", "s.yaml", "x"]]) {
      expect(parseEffectOperands(ops)).toHaveProperty("problem");
    }
  });
});

describe("the effect store", () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "skilleffect-store-")));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const dir = (digest = D1) => join(home, "skill-effects", "lib-kafka", digest.slice(7));

  it("keeps every record under skill-effects/<id>/<hex>/ and reads the newest", () => {
    const first = writeEffectRecord(record(), { home });
    const second = writeEffectRecord(record({ withPass: false, withoutPass: true }), { home });
    expect(first).toEqual({ file: `skill-effects/lib-kafka/${"1".repeat(12)}/effect--0000000001.json`, seq: 1 });
    expect(second.seq).toBe(2);
    expect(readdirSync(dir()).sort()).toEqual(["effect--0000000001.json", "effect--0000000002.json"]);
    expect(statSync(join(dir(), "effect--0000000001.json")).mode & 0o777).toBe(0o600);
    for (const d of [join(home, "skill-effects"), join(home, "skill-effects", "lib-kafka"), dir()]) expect(statSync(d).mode & 0o777).toBe(0o700);
    const read = readNewestEffect("lib-kafka", D1, { home });
    expect(read.state === "ok" && read.record.verdict.verdict).toBe("harms");
  });

  it("is none without a folder, and never touches the evaluation store", () => {
    expect(readNewestEffect("lib-kafka", D1, { home })).toEqual({ state: "none" });
    writeEffectRecord(record(), { home });
    expect(findNewestRecordOf("lib-kafka", D1, { home })).toEqual({ state: "none" });
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
    expect(readNewestEffect("lib-kafka", D2, { home })).toEqual({ state: "none" });
  });

  it("reports a file with the wrong mode", () => {
    writeEffectRecord(record(), { home });
    chmodSync(join(dir(), "effect--0000000001.json"), 0o644);
    const read = readNewestEffect("lib-kafka", D1, { home });
    expect(read.state).toBe("invalid");
    expect(read.state === "invalid" && read.problem).toMatch(/wrong mode/);
  });

  it("reports a record of another digest", () => {
    writeEffectRecord(record(), { home });
    mkdirSync(dir(D2), { mode: 0o700 });
    writeFileSync(join(dir(D2), "effect--0000000001.json"), readFileSync(join(dir(), "effect--0000000001.json")), { mode: 0o600 });
    const read = readNewestEffect("lib-kafka", D2, { home });
    expect(read.state === "invalid" && read.problem).toMatch(/another skill or digest/);
  });

  it("checks the newest record again and never falls back to an older one", () => {
    writeEffectRecord(record(), { home });
    writeEffectRecord(record(), { home });
    const newest = join(dir(), "effect--0000000002.json");
    const raw = JSON.parse(readFileSync(newest, "utf8")) as EffectRecord;
    raw.verdict.verdict = "harms";
    writeFileSync(newest, JSON.stringify(raw), { mode: 0o600 });
    chmodSync(newest, 0o600);
    const read = readNewestEffect("lib-kafka", D1, { home });
    expect(read.state).toBe("invalid");
    expect(read.state === "invalid" && read.problem).toMatch(/not valid.*stored verdict differs/);
  });

  it("refuses a bad id or digest", () => {
    expect(readNewestEffect("Bad Id", D1, { home }).state).toBe("invalid");
    expect(readNewestEffect("lib-kafka", "sha256:xyz", { home }).state).toBe("invalid");
    const bad = clone(record());
    bad.skill.id = "Bad Id";
    expect(() => writeEffectRecord(bad, { home })).toThrow(/cannot be stored/);
    const badDigest = clone(record());
    badDigest.skill.digest = "sha256:../..";
    expect(() => writeEffectRecord(badDigest, { home })).toThrow(/cannot be stored/);
    expect(existsSync(join(home, "skill-effects"))).toBe(false);
  });
});

describe("scf skills effect syntax", () => {
  const run = (positionals: string[], values: Record<string, unknown> = {}, hook?: (ops: unknown) => void) =>
    skillsCommand({ positionals, values }, () => {}, hook ? { agentEffect: async (ops) => (hook(ops), 0) } : {});

  it("refuses wrong operands and options with the usage", async () => {
    for (const [pos, values] of [[["effect"], {}], [["effect", "lib"], {}], [["effect", "a", "b", "c", "d"], {}], [["effect", "bad@"], {}], [["effect", "lib", "s-a"], { agent: true }]] as const) {
      await expect(run([...pos], { ...values }, () => {})).rejects.toThrow(/usage: scf skills/);
    }
  });

  it("hands the parsed operands to the hook", async () => {
    const seen: unknown[] = [];
    expect(await run(["effect", "lib", "s-a", "s.yaml"], {}, (o) => seen.push(o))).toBe(0);
    expect(await run(["effect", "kafka@1.0.0"], {}, (o) => seen.push(o))).toBe(0);
    expect(seen).toEqual([
      { kind: "staged", source: "lib", skill: "s-a", suiteFile: "s.yaml" },
      { kind: "approved", id: "kafka", version: "1.0.0" },
    ]);
  });

  it("says so when there is no hook", async () => {
    await expect(run(["effect", "kafka@1.0.0"])).rejects.toThrow(/not available here/);
  });

  it("lists both forms in the usage", () => {
    expect(SKILLS_USAGE).toContain("scf skills effect <source-id> <skill-id> [<suite-file>]");
    expect(SKILLS_USAGE).toContain("scf skills effect <id@version> [<suite-file>]");
  });
});

describe("the kafka example set", () => {
  const suiteFile = resolve("evals/skill-effect/kafka/suite.yaml");
  const read = readEvaluationSuite(suiteFile);
  const ins = read.state === "ok" ? read.suite.instructions! : undefined;

  it("is a valid suite with five scenarios and repeat 4", () => {
    expect(read.state).toBe("ok");
    expect(ins?.scenarios.map((s) => s.id).sort()).toEqual(["commit-after-processing", "dead-letter", "idempotent-producer", "key-by-order", "retry-backoff"]);
    expect(ins?.repeat).toBe(4);
  });

  it("offers the built-in kafka skill in every scenario", () => {
    const pkg = loadSkillPackage(resolve("skills/kafka"));
    const entry: RegisteredSkill = { key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: "test", dir: "", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg };
    const offers = scenarioOffers(entry, resolve("evals/skill-effect/kafka"), ins!);
    expect(offers).toHaveLength(5);
    expect(offers.every((o) => o.offered)).toBe(true);
  });

  const REFERENCE_PRODUCER = `export const ORDERS_TOPIC = "orders";
export function createOrderProducer(kafka) {
  return kafka.producer({ idempotent: true });
}
export async function publishOrder(producer, order) {
  await producer.send({ topic: ORDERS_TOPIC, acks: -1, messages: [{ key: String(order.orderId), value: JSON.stringify(order) }] });
}
`;
  const REFERENCE_CONSUMER = `export const ORDERS_TOPIC = "orders";
export function createOrderConsumer(kafka) {
  return kafka.consumer({ groupId: "orders-service" });
}
export async function handleMessage({ topic, partition, message }, deps) {
  const order = JSON.parse(message.value.toString());
  let delay = 100;
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.process(order);
      return;
    } catch (err) {
      if (attempt >= 5) {
        await deps.producer.send({ topic: "orders.dlq", messages: [{ key: message.key, value: message.value }] });
        return;
      }
      await deps.sleep(delay);
      delay *= 2;
    }
  }
}
export async function runOrderConsumer(consumer, deps) {
  await consumer.connect();
  await consumer.subscribe({ topics: [ORDERS_TOPIC] });
  await consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      await handleMessage(payload, deps);
      await consumer.commitOffsets([{ topic: payload.topic, partition: payload.partition, offset: String(Number(payload.message.offset) + 1) }]);
    },
  });
}
`;
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const copy = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "skilleffect-kafka-"));
    made.push(dir);
    cpSync(resolve("evals/skill-effect/kafka/fixtures/orders"), dir, { recursive: true });
    return dir;
  };
  const checks = (): { id: string; check: string }[] => ins!.scenarios.map((s) => ({ id: s.id, check: s.check }));
  const exit = (cwd: string, check: string) => spawnSync("sh", ["-c", check], { cwd, timeout: 20000, encoding: "utf8" }).status;

  it("fails every check on the original fixture, also when the keywords are only in comments", () => {
    const dir = copy();
    const stuffing = "\n// idempotent: true autoCommit: false orders.dlq retry key: order.orderId\n";
    for (const c of checks()) expect({ id: c.id, status: exit(dir, c.check) }).toEqual({ id: c.id, status: 1 });
    appendFileSync(join(dir, "src/producer.js"), stuffing);
    appendFileSync(join(dir, "src/consumer.js"), stuffing);
    for (const c of checks()) expect({ id: c.id, status: exit(dir, c.check) }).toEqual({ id: c.id, status: 1 });
  });

  // The retry task asks for the last error after the bounded retries: its reference has no dead letter.
  const RETRY_ONLY = REFERENCE_CONSUMER.replace(
    /        await deps\.producer\.send\([^\n]*\n        return;\n/,
    "        throw err;\n",
  );
  const status = (consumer: string, id: string): number | null => {
    const dir = copy();
    writeFileSync(join(dir, "src/producer.js"), REFERENCE_PRODUCER);
    writeFileSync(join(dir, "src/consumer.js"), consumer);
    return exit(dir, checks().find((c) => c.id === id)!.check);
  };

  it("passes every check on a reference solution", () => {
    expect(RETRY_ONLY).not.toBe(REFERENCE_CONSUMER);
    for (const c of checks()) {
      expect({ id: c.id, status: status(c.id === "retry-backoff" ? RETRY_ONLY : REFERENCE_CONSUMER, c.id) }).toEqual({ id: c.id, status: 0 });
    }
  });

  it("fails a commit handler that swallows the processing error", () => {
    const swallowing = REFERENCE_CONSUMER.replace("await handleMessage(payload, deps);", "try { await handleMessage(payload, deps); } catch {}");
    expect(swallowing).not.toBe(REFERENCE_CONSUMER);
    expect(status(swallowing, "commit-after-processing")).toBe(1);
  });

  it("fails a dead-letter handler that sends every message without processing it", () => {
    const always = REFERENCE_CONSUMER.replace(
      "  let delay = 100;",
      '  await deps.producer.send({ topic: "orders.dlq", messages: [{ key: message.key, value: message.value }] });\n  return;\n  let delay = 100;',
    );
    expect(status(always, "dead-letter")).toBe(1);
  });

  it("fails a retry handler that ends with something other than the last processing error", () => {
    expect(status(REFERENCE_CONSUMER, "retry-backoff")).toBe(1); // dead letter, no failure
  });
});
