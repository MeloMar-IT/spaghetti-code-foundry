import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson, eventHash } from "../src/evidence/canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "../src/evidence/chain.js";
import { buildRunEvidence, flowDefinitionHash, NotFinalizable, terminalStatus } from "../src/evidence/finalize.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { RunEvidenceSchema, type EvidenceEvent } from "../src/evidence/schema.js";
import { EvidenceStream } from "../src/evidence/stream.js";
import { EVIDENCE_EVENT_VERSION } from "../src/evidence/version.js";

/**
 * Golden vectors. The canonical texts are written out here by hand, and their hashes were made outside this code
 * (`printf '%s' '<text>' | shasum -a 256`). They may only change together with EVIDENCE_EVENT_VERSION.
 */
const STEP = { id: "build", visit: 2, type: "shell", parent: "outer" } as const;
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = [
  "5e2385765ef570778e0968ba0672cd53bb42ab39bc82dc936e2c0863686beba8",
  "33a9b616c31adf63fea3261c9c12e46f5e31972bf6bbc31d3bbfb962bea4f35f",
  "e4c6e2cbd3e3fcd6d620c61fab3ddd135252c74c889cf4e1027452e47ce215e7",
  "e9e6667a0eb776c415965032115f6a619a69fbba5f5970ddcd39540af621730a",
] as const;
/** The canonical form of each event without its `hash`: what the hash is taken over. */
const UNHASHED = [
  `{"by":{"kind":"cli"},"flow":{"name":"demo"},"id":"ev-000000","prevHash":null,"runId":"run-1","seq":0,"time":"2026-01-31T12:00:00.000Z","type":"run.created","version":1}`,
  `{"id":"ev-000001","prevHash":"${HASH[0]}","runId":"run-1","seq":1,"step":{"id":"build","parent":"outer","type":"shell","visit":2},"time":"2026-01-31T12:00:01.500Z","type":"step.started","version":1}`,
  `{"artifacts":[{"bytes":0,"kind":"log","path":"logs/001-build.log","required":true,"sha256":"${EMPTY}"}],"durationMs":1500,"exitCode":-1,"id":"ev-000002","prevHash":"${HASH[1]}","runId":"run-1","seq":2,"step":{"id":"build","parent":"outer","type":"shell","visit":2},"time":"2026-01-31T12:00:03.000Z","type":"step.failed","version":1}`,
  `{"id":"ev-000003","prevHash":"${HASH[2]}","runId":"run-1","seq":3,"step":{"id":"build","parent":"outer","type":"shell","visit":2},"time":"2026-01-31T12:00:03.001Z","type":"run.failed","version":1}`,
] as const;
/** The lines of the file: the same with `"hash"` in its place (after "flow", "exitCode" or at the front, by name). */
const LINES = [
  UNHASHED[0].replace(`,"id":`, `,"hash":"${HASH[0]}","id":`),
  UNHASHED[1].replace(`{"id":`, `{"hash":"${HASH[1]}","id":`),
  UNHASHED[2].replace(`,"id":`, `,"hash":"${HASH[2]}","id":`),
  UNHASHED[3].replace(`{"id":`, `{"hash":"${HASH[3]}","id":`),
];
const events = (): EvidenceEvent[] => LINES.map((l) => JSON.parse(l) as EvidenceEvent);
const chained = (bodies: Record<string, unknown>[], runId = "run-1"): string[] => {
  let prev: string | null = null;
  return bodies.map((b, seq) => {
    const e: Record<string, unknown> = { version: 1, id: `ev-${String(seq).padStart(6, "0")}`, seq, runId, time: "2026-01-31T12:00:00.000Z", ...b, prevHash: prev };
    prev = eventHash(e);
    return canonicalJson({ ...e, hash: prev });
  });
};

describe("the canonical form", () => {
  it("is one fixed text: names in order, no spaces, strings and numbers as written here", () => {
    const value = { b: { z: 1, y: "2", gone: undefined }, a: [1, -3, 0.5, 1e21, -0, true, false, null, {}], "€": "𝄞", A: 'é\u0001"\\\n', "": [] };
    const text = '{"":[],"A":"é\\u0001\\"\\\\\\n","a":[1,-3,0.5,1e+21,0,true,false,null,{}],"b":{"y":"2","z":1},"€":"𝄞"}';
    expect(canonicalJson(value)).toBe(text);
    expect(canonicalHash(value)).toBe("d96ce5fde79e2221a9a48cf20277e4a5b916796f8c8b68c265c0ace8fc5ecdb0");
    expect(canonicalHash(value)).toBe(sha256Hex(Buffer.from(text, "utf8")));
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson(JSON.parse('{ "a": 2,\n "b": 1 }')));
    expect(canonicalJson("\u001f\u007f\u2028\ud800")).toBe('"\\u001f\u007f\u2028\\ud800"');
  });

  it("refuses what has no canonical form", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, 1n, Symbol("x"), new Date(0), new Map(), [undefined]]) expect(() => canonicalJson(bad), String(bad)).toThrow(TypeError);
  });

  it("hashes an event without its own hash and with the hash before it", () => {
    events().forEach((e, i) => {
      const { hash: _hash, ...rest } = e;
      expect(canonicalJson(rest)).toBe(UNHASHED[i]);
      expect(eventHash(e as unknown as Record<string, unknown>)).toBe(HASH[i]);
      expect(sha256Hex(Buffer.from(UNHASHED[i]!, "utf8"))).toBe(HASH[i]);
      expect(e.prevHash).toBe(i === 0 ? null : HASH[i - 1]);
    });
    // the order the fields were given in does not matter
    const [first] = events();
    expect(eventHash(Object.fromEntries(Object.entries(first!).reverse()))).toBe(HASH[0]);
  });
});

describe("the hash chain", () => {
  let tmp: string;
  let runDir: string;
  let said: string[];
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "evidence-chain-"));
    runDir = join(tmp, "run-1");
    mkdirSync(runDir);
    said = [];
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const file = () => join(runDir, "evidence.jsonl");
  const stream = () => new EvidenceStream(runDir, "run-1", (l) => said.push(l));
  const artifact = { kind: "log" as const, path: "logs/001-build.log", sha256: EMPTY, bytes: 0, required: true };

  it("the writer writes the golden events as canonical lines of the current version, in one chain", () => {
    const s = stream();
    s.append({ type: "run.created", flow: { name: "demo" }, by: { kind: "cli" } }, "2026-01-31T12:00:00.000Z");
    s.append({ type: "step.started", step: STEP }, "2026-01-31T12:00:01.500Z");
    const other = stream(); // a restart: the chain goes on from the hash on disk
    other.append({ type: "step.failed", step: STEP, exitCode: -1, durationMs: 1500, artifacts: [artifact] }, "2026-01-31T12:00:03.000Z");
    const last = other.append({ type: "run.failed", step: STEP }, "2026-01-31T12:00:03.001Z");
    // the golden vectors are version 1 lines (they still read, see below): the writer's lines are the same with version 3
    const written = readFileSync(file(), "utf8").split("\n").slice(0, -1);
    expect(written).toHaveLength(LINES.length);
    written.forEach((line, i) => {
      const { hash, ...rest } = JSON.parse(line) as Record<string, unknown>;
      expect(line).toBe(canonicalJson({ ...rest, hash }));
      expect(rest.version).toBe(EVIDENCE_EVENT_VERSION);
      expect(hash).toBe(eventHash(rest));
      const old = JSON.parse(LINES[i]!) as Record<string, unknown>;
      const { hash: _h, prevHash: _p, ...oldRest } = old;
      const { prevHash: _q, ...newRest } = rest;
      expect(newRest).toEqual({ ...oldRest, version: EVIDENCE_EVENT_VERSION });
    });
    expect(last?.hash).toBe((JSON.parse(written[3]!) as { hash: string }).hash);
    expect(readEvidenceChain(written, "run-1")).toMatchObject({ ok: true, terminalHash: last?.hash });
    expect(said).toEqual([]);
  });

  it("reads the golden lines as one chain", () => {
    const read = readEvidenceChain(LINES, "run-1");
    expect(read).toMatchObject({ ok: true, terminalHash: HASH[3] });
    expect(read.events).toHaveLength(4);
    expect(readEvidenceChain([], "run-1")).toEqual({ ok: true, events: [], terminalHash: null });
    expect(splitEvidenceLines("a\nb\nc")).toEqual({ lines: ["a", "b"], tail: "c" });
    expect(splitEvidenceLines("")).toEqual({ lines: [], tail: "" });
  });

  it("finds every kind of change at the first line that is wrong", () => {
    const swap = (i: number, from: string, to: string) => LINES.map((l, n) => (n === i ? l.replace(from, to) : l));
    const cases: [string, string[], number, string][] = [
      ["a changed value", swap(1, '"visit":2', '"visit":3'), 2, "hash"],
      ["a changed time", swap(0, "12:00:00.000Z", "12:00:00.001Z"), 1, "hash"],
      ["a changed hash", swap(2, HASH[2], HASH[0]), 3, "hash"],
      ["a removed line", [LINES[0]!, LINES[2]!, LINES[3]!], 2, "order"],
      ["a removed first line", LINES.slice(1), 1, "order"],
      ["two lines the other way round", [LINES[0]!, LINES[2]!, LINES[1]!, LINES[3]!], 2, "order"],
      ["a line added twice", [LINES[0]!, LINES[1]!, LINES[1]!, LINES[2]!], 3, "order"],
      ["fields in another order", [`{"version":1,${LINES[0]!.slice(1, LINES[0]!.lastIndexOf(',"version"'))}}`, ...LINES.slice(1)], 1, "not-canonical"],
      ["a space", [LINES[0]!.replace('"seq":0', '"seq": 0'), ...LINES.slice(1)], 1, "not-canonical"],
      ["a number written another way", swap(2, '"durationMs":1500', '"durationMs":1.5e3'), 3, "not-canonical"],
      ["a field twice", swap(1, '"seq":1', '"seq":7,"seq":1'), 2, "not-canonical"],
      ["not JSON", swap(3, '"version":1}', '"version":1'), 4, "not-json"],
      ["an empty line", [LINES[0]!, "", ...LINES.slice(1)], 2, "not-json"],
      ["an array", ["[]"], 1, "not-json"],
      ["an unknown field", swap(0, '"seq":0', '"secret":"x","seq":0'), 1, "invalid"],
      ["a newer version", swap(0, '"version":1', '"version":99'), 1, "unsupported-version"],
      ["another run", chained([{ type: "run.started" }], "run-2"), 1, "order"],
      ["no hashes", ['{"id":"ev-000000","runId":"run-1","seq":0,"time":"2026-01-31T12:00:00.000Z","type":"run.started","version":1}'], 1, "unchained"],
    ];
    for (const [name, lines, line, fault] of cases) {
      const read = readEvidenceChain(lines, "run-1");
      expect(read, name).toMatchObject({ ok: false, line, fault });
      if (!read.ok) {
        expect(read.events, name).toHaveLength(line - 1);
        expect(read.message, name).toMatch(new RegExp(`^line ${line}: `));
        expect(read.message, name).not.toContain("secret");
      }
    }
  });

  it("finds a line that was replaced by another well-made event", () => {
    // someone rewrites line 2 and gives it a right hash of its own: line 3 no longer follows it
    const e = JSON.parse(LINES[1]!) as Record<string, unknown>;
    const again = { ...e, hash: undefined, step: { ...STEP, visit: 9 } };
    const rehashed = canonicalJson({ ...again, hash: eventHash(again) });
    expect(readEvidenceChain([LINES[0]!, rehashed], "run-1").ok).toBe(true);
    expect(readEvidenceChain([LINES[0]!, rehashed, LINES[2]!, LINES[3]!], "run-1")).toMatchObject({ ok: false, line: 3, fault: "link" });
    // the same with only the content changed: the line itself is wrong
    expect(readEvidenceChain([LINES[0]!, canonicalJson({ ...again, hash: HASH[1] }), LINES[2]!, LINES[3]!], "run-1")).toMatchObject({ ok: false, line: 2, fault: "hash" });
    // an id that an earlier line has
    const twice = chained([{ type: "run.started" }, { type: "run.started", id: "ev-000000" }]);
    expect(readEvidenceChain(twice, "run-1")).toMatchObject({ ok: false, line: 2, fault: "order" });
  });

  it("the writer does not go on after a changed stream, leaves it as it is, and marks the run", () => {
    const text = `${LINES[0]}\n${LINES[1]!.replace('"visit":2', '"visit":3')}\n`;
    writeFileSync(file(), text);
    expect(stream().append({ type: "run.started" })).toBeUndefined();
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^! evidence: evidence\.jsonl is not an unbroken chain of this run \(line 2: .*cannot be verified/);
    expect(existsSync(join(runDir, "evidence.incomplete"))).toBe(true);

    // a later start, with the file put right again, still does not continue it: events were lost in between
    writeFileSync(file(), `${LINES[0]}\n${LINES[1]}\n`);
    said = [];
    const later = stream();
    expect(later.append({ type: "run.started" })).toBeUndefined();
    expect(later.append({ type: "run.started" })).toBeUndefined();
    expect(said).toEqual(["· evidence: the evidence of this run stopped earlier; it is not continued"]);
    expect(readFileSync(file(), "utf8")).toBe(`${LINES[0]}\n${LINES[1]}\n`);
  });

  it("removes a cut-off last line only when the lines before it are a chain", () => {
    writeFileSync(file(), `${LINES[0]}\n${LINES[1]}\n${LINES[2]!.slice(0, 40)}`);
    expect(stream().append({ type: "run.resumed", from: "build", by: { kind: "system" } })?.prevHash).toBe(HASH[1]);
    const read = readEvidenceChain(splitEvidenceLines(readFileSync(file(), "utf8")).lines, "run-1");
    expect(read.ok).toBe(true);
    expect(read.events.map((e) => e.type)).toEqual(["run.created", "step.started", "run.resumed"]);

    const broken = `${LINES[0]!.replace("demo", "other")}\n${LINES[1]!.slice(0, 40)}`;
    rmSync(join(runDir, "evidence.incomplete"), { force: true });
    writeFileSync(file(), broken);
    expect(stream().append({ type: "run.started" })).toBeUndefined();
    expect(readFileSync(file(), "utf8")).toBe(broken);
  });
});

describe("the manifest of a chain", () => {
  const FLOW = "f".repeat(64);
  const AT = "2026-01-31T12:05:00.000Z";
  const build = (lines: string[], extra: Partial<Parameters<typeof buildRunEvidence>[1]> = {}) => {
    const read = readEvidenceChain(lines, "run-1");
    if (!read.ok) throw new Error(read.message);
    return buildRunEvidence(read.events, { terminalHash: read.terminalHash!, flowSha256: FLOW, finalizedAt: AT, ...extra });
  };

  it("is exactly this for the golden events", () => {
    const m = build(LINES);
    expect(m).toEqual({
      version: 1,
      runId: "run-1",
      status: "failed",
      startedAt: "2026-01-31T12:00:00.000Z",
      finishedAt: "2026-01-31T12:00:03.001Z",
      finalizedAt: AT,
      flow: { name: "demo", sha256: FLOW },
      events: { path: "evidence.jsonl", count: 4, terminalHash: HASH[3] },
      git: {},
      models: [],
      policies: [],
      approvals: [],
      tests: [],
      artifacts: [{ kind: "log", path: "logs/001-build.log", sha256: EMPTY, bytes: 0, required: true }],
    });
    expect(RunEvidenceSchema.safeParse(m).success).toBe(true);
    expect(build(LINES, { finalizedAt: "2027-01-01T00:00:00.000Z" })).toEqual({ ...m, finalizedAt: "2027-01-01T00:00:00.000Z" });
  });

  it("gathers commits, models, approvals, tests, files, the diff and the pull request from the events", () => {
    const USER = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";
    const opus = { agent: "claude", provider: "anthropic", model: "opus", effort: "high" };
    const gpt = { agent: "codex", provider: "openai", model: "default" };
    const pr = { repository: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12" };
    const step = (id: string, type = "shell") => ({ id, visit: 1, type });
    const log = (path: string, sha: string) => ({ kind: "log", path, sha256: sha.repeat(64), bytes: 3, required: true });
    const lines = chained([
      { type: "run.queued", time: "2026-01-31T11:59:00.000Z" },
      { type: "run.created", flow: { name: "demo", version: 3 }, by: { kind: "user", id: USER }, time: "2026-01-31T12:00:00.000Z" },
      { type: "run.started", base: { commit: "a".repeat(40), branch: "factory/x", repository: "acme/app" } },
      { type: "step.routed", step: step("code", "claude"), model: opus },
      { type: "step.retried", step: step("code", "claude"), cause: "limit" },
      { type: "step.routed", step: step("code", "claude"), model: gpt, fallbackFrom: opus },
      { type: "step.completed", step: step("code", "claude"), model: gpt, durationMs: 5, artifacts: [{ ...log("logs/001-code.log", "1"), kind: "transcript" }] },
      { type: "step.failed", step: step("run_tests"), durationMs: 5, exitCode: 1, artifacts: [log("logs/002-run_tests.log", "2")], test: { suite: "run_tests", outcome: "failed" } },
      { type: "run.failed", step: step("run_tests") },
      { type: "run.resumed", from: "run_tests", by: { kind: "cli" } },
      { type: "step.completed", step: step("run_tests"), durationMs: 5, exitCode: 0, artifacts: [log("logs/002-run_tests.log", "3")], test: { suite: "run_tests", outcome: "passed", report: { kind: "test-report", path: "logs/report.xml", sha256: "4".repeat(64), bytes: 9, required: false } } },
      { type: "step.approved", step: step("ok", "approval"), by: { kind: "user", id: USER }, time: "2026-01-31T12:01:00.000Z" },
      { type: "step.denied", step: step("ok2", "approval"), denial: { kind: "approval", by: { kind: "cli" } }, time: "2026-01-31T12:02:00.000Z" },
      { type: "step.denied", step: step("code", "claude"), denial: { kind: "tool", tool: { name: "Bash" } } },
      { type: "step.denied", step: step("code", "claude"), denial: { kind: "policy", policy: { id: "baseline", version: "1.2" }, reasonCode: "no-push" } },
      { type: "step.denied", step: step("code", "claude"), denial: { kind: "policy", policy: { id: "baseline", version: "1.2" }, reasonCode: "no-network" } },
      { type: "step.denied", denial: { kind: "policy", policy: { id: "zeta", version: "2" }, packSha256: "8".repeat(64), reasonCode: "no-run" } },
      { type: "run.completed", final: { commit: "b".repeat(40), branch: "factory/y", repository: "acme/app" }, pullRequest: pr, time: "2026-01-31T12:03:00.000Z" },
    ]);
    const diff = { kind: "diff" as const, path: "evidence.diff", sha256: "5".repeat(64), bytes: 10, required: false };
    const m = build(lines, { diff });
    expect(RunEvidenceSchema.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({ status: "succeeded", startedAt: "2026-01-31T12:00:00.000Z", finishedAt: "2026-01-31T12:03:00.000Z", flow: { name: "demo", version: 3, sha256: FLOW }, events: { count: 18 } });
    expect(m.git).toEqual({ repository: "acme/app", branch: "factory/y", base: "a".repeat(40), final: "b".repeat(40) });
    expect(m.models).toEqual([opus, gpt]);
    expect(m.policies).toEqual([{ id: "baseline", version: "1.2" }, { id: "zeta", version: "2" }]);
    expect(m.approvals).toEqual([
      { step: step("ok", "approval"), time: "2026-01-31T12:01:00.000Z", decision: "approved", by: { kind: "user", id: USER } },
      { step: step("ok2", "approval"), time: "2026-01-31T12:02:00.000Z", decision: "rejected", by: { kind: "cli" } },
    ]);
    expect(m.tests.map((t) => [t.step.id, t.result.outcome])).toEqual([["run_tests", "failed"], ["run_tests", "passed"]]);
    // each path once; a log that was named again counts as it was named last
    expect(m.artifacts.map((a) => [a.path, a.sha256[0]])).toEqual([["logs/001-code.log", "1"], ["logs/002-run_tests.log", "3"], ["logs/report.xml", "4"]]);
    expect(m.diff).toEqual(diff);
    expect(m.pullRequest).toEqual(pr);
  });

  it("lists the context bundle of a written event as a file, and nothing for a failed one", () => {
    const bundle = { kind: "other", path: "context.json", sha256: "6".repeat(64), bytes: 40, required: true };
    const written = { type: "context.bundled", outcome: "written", bundle, sourcesSha256: "7".repeat(64), limits: { maxSources: 5, maxSourceBytes: 10, maxTotalBytes: 50 }, sources: 1, bytes: 4, omitted: { missing: 0, stale: 0, ambiguous: 0, "over-budget": 0, classification: 0, generated: 0, unsupported: 0 } };
    const around = (middle: Record<string, unknown>) => chained([{ type: "run.created", flow: { name: "demo" }, by: { kind: "cli" } }, middle, { type: "run.completed" }]);
    expect(build(around(written)).artifacts).toEqual([bundle]);
    expect(build(around({ type: "context.bundled", outcome: "failed", failure: "internal" })).artifacts).toEqual([]);
  });

  it("is refused for events that are not those of a whole run that ended", () => {
    expect(terminalStatus(events())).toBe("failed");
    expect(terminalStatus(events().slice(0, 3))).toBeUndefined();
    expect(() => build(LINES.slice(0, 3))).toThrow(NotFinalizable);
    expect(() => build(chained([{ type: "run.created", flow: { name: "demo" }, by: { kind: "cli" } }, { type: "run.stopped", at: "a" }]))).toThrow(/do not end with the end of the run/);
    // a run of an older version that was resumed: its stream starts in the middle
    const old = chained([{ type: "run.resumed", from: "a", by: { kind: "cli" } }, { type: "run.completed" }]);
    expect(() => build(old)).toThrow(/do not begin with the start of the run/);
    expect(() => buildRunEvidence([], { terminalHash: HASH[0], flowSha256: FLOW, finalizedAt: AT })).toThrow(NotFinalizable);
  });

  it("hashes a flow definition by its canonical form, as it is stored", () => {
    const flow = { name: "f", steps: [{ id: "a", type: "shell", run: "echo" }], limits: { max_cost_usd: 0.5 }, extra: undefined };
    expect(flowDefinitionHash(flow)).toBe(sha256Hex('{"limits":{"max_cost_usd":0.5},"name":"f","steps":[{"id":"a","run":"echo","type":"shell"}]}'));
    expect(flowDefinitionHash(JSON.parse(JSON.stringify(flow)))).toBe(flowDefinitionHash(flow));
    expect(flowDefinitionHash({ ...flow, steps: [{ id: "a", type: "shell", run: "echo changed" }] })).not.toBe(flowDefinitionHash(flow));
  });
});
