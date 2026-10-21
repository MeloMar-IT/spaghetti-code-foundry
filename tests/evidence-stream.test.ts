import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import { actorOf, isTestStep, RunRecorder, stepIdentity, targetModel } from "../src/evidence/record.js";
import { EvidenceStream, evidenceEventId, hashPlainFile } from "../src/evidence/stream.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { EVIDENCE_EVENT_VERSION } from "../src/evidence/version.js";
import type { StepRecord } from "../src/engine/state.js";

const USER = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";
let tmp: string;
let runDir: string;
let said: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-stream-"));
  runDir = join(tmp, "runs", "r1");
  mkdirSync(join(runDir, "logs"), { recursive: true });
  said = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const file = () => join(runDir, "evidence.jsonl");
const stream = (id = "r1") => new EvidenceStream(runDir, id, (l) => said.push(l));
const lines = () => readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
const step = { id: "a", visit: 1, type: "shell" as const };

describe("EvidenceStream", () => {
  it("appends one valid line per event, with a place and an id that follow from the place", () => {
    const s = stream();
    const first = s.append({ type: "run.created", flow: { name: "f" }, by: { kind: "cli" } }, "2026-01-31T12:00:00.000Z");
    s.append({ type: "run.started" });
    s.append({ type: "step.started", step });
    expect(first).toMatchObject({ version: EVIDENCE_EVENT_VERSION, id: "ev-000000", seq: 0, runId: "r1", time: "2026-01-31T12:00:00.000Z", type: "run.created" });
    const text = readFileSync(file(), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(4);
    expect(lines().map((e) => [e.seq, e.id, e.type])).toEqual([[0, "ev-000000", "run.created"], [1, "ev-000001", "run.started"], [2, "ev-000002", "step.started"]]);
    expect(evidenceEventId(12)).toBe("ev-000012");
    expect(said).toEqual([]);
  });

  it("goes on after a restart without changing what was written", () => {
    const a = stream();
    a.append({ type: "run.created", flow: { name: "f" }, by: { kind: "cli" } });
    a.append({ type: "run.started" });
    const before = readFileSync(file(), "utf8");
    const b = stream(); // a new process
    expect(b.append({ type: "run.resumed", from: "a", by: { kind: "system" } })?.seq).toBe(2);
    const after = readFileSync(file(), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(lines().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("sees what another writer added in between", () => {
    const a = stream();
    const b = stream();
    a.append({ type: "run.started" });
    b.append({ type: "run.started" });
    a.append({ type: "run.started" });
    b.append({ type: "run.started" });
    expect(lines().map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(new Set(lines().map((e) => e.id)).size).toBe(4);
  });

  it("removes a line that was cut off while it was written, and keeps every whole line", () => {
    const a = stream();
    a.append({ type: "run.created", flow: { name: "f" }, by: { kind: "cli" } });
    a.append({ type: "run.started" });
    const whole = readFileSync(file(), "utf8");
    writeFileSync(file(), whole + '{"version":1,"id":"ev-000002","seq":2,"runI');
    const b = stream();
    expect(b.append({ type: "run.resumed", from: "a", by: { kind: "system" } })?.seq).toBe(2);
    expect(readFileSync(file(), "utf8").startsWith(whole)).toBe(true);
    expect(lines().map((e) => e.type)).toEqual(["run.created", "run.started", "run.resumed"]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/cut off/);
    expect(b.hasStopped).toBe(false);
  });

  it("keeps a whole last event that only misses its line end", () => {
    const a = stream();
    a.append({ type: "run.started" });
    a.append({ type: "run.started" });
    const whole = readFileSync(file(), "utf8");
    writeFileSync(file(), whole.slice(0, -1));
    expect(stream().append({ type: "run.started" })?.seq).toBe(2);
    expect(readFileSync(file(), "utf8").startsWith(whole)).toBe(true);
    expect(lines()).toHaveLength(3);
  });

  it("stops, says so once and changes nothing when the file holds a line that is not an event of this run", () => {
    const cases = [
      "not json\n",
      '{"version":1,"id":"ev-000000","seq":0,"runId":"other","time":"2026-01-31T12:00:00.000Z","type":"run.started"}\n',
      '{"version":1,"id":"ev-000001","seq":1,"runId":"r1","time":"2026-01-31T12:00:00.000Z","type":"run.started"}\n',
      '{"version":2,"id":"ev-000000","seq":0,"runId":"r1","time":"2026-01-31T12:00:00.000Z","type":"run.started"}\n',
      '{"version":1,"id":"ev-000000","seq":0,"runId":"r1","time":"2026-01-31T12:00:00.000Z","type":"run.started"}\n\n',
    ];
    for (const text of cases) {
      writeFileSync(file(), text);
      rmSync(join(runDir, "evidence.incomplete"), { force: true });
      said = [];
      const s = stream();
      expect(s.append({ type: "run.started" }), text).toBeUndefined();
      expect(s.append({ type: "run.started" })).toBeUndefined();
      expect(s.hasStopped).toBe(true);
      expect(readFileSync(file(), "utf8")).toBe(text);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/^! evidence: .*The run itself goes on\.$/);
      expect(existsSync(join(runDir, "evidence.incomplete"))).toBe(true);
    }
  });

  it("does not write an event that is not valid, and never repeats a value of it", () => {
    const s = stream();
    s.append({ type: "run.started" });
    const bad = { type: "run.created", flow: { name: "f" }, by: { kind: "cli" }, note: "sk-secret-value" } as never;
    expect(s.append(bad)).toBeUndefined();
    expect(s.append({ type: "run.started" })).toBeUndefined(); // a stream never goes on after a hole
    expect(lines()).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("sk-secret-value");
    expect(said[0]).not.toContain(tmp);
  });

  it("never throws: a missing run folder, a folder or a link in place of the file, a report that throws", () => {
    const gone = new EvidenceStream(join(tmp, "runs", "gone"), "gone", (l) => said.push(l));
    expect(gone.append({ type: "run.started" })).toBeUndefined();
    expect(existsSync(join(tmp, "runs", "gone"))).toBe(false);

    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, "mine\n");
    symlinkSync(outside, file());
    expect(stream().append({ type: "run.started" })).toBeUndefined();
    expect(readFileSync(outside, "utf8")).toBe("mine\n");

    rmSync(file());
    mkdirSync(file());
    const loud = new EvidenceStream(runDir, "r1", () => {
      throw new Error("no log");
    });
    expect(loud.append({ type: "run.started" })).toBeUndefined();
    expect(said).toHaveLength(2);
  });

  it("keeps the order of events that are written while steps end at the same time", async () => {
    const s = stream();
    await Promise.all(Array.from({ length: 40 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i % 3));
      s.append({ type: "step.started", step: { ...step, visit: i + 1 } });
    }));
    const all = lines();
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(new Set(all.map((e) => e.id)).size).toBe(40);
  });
});

describe("what the engine records", () => {
  const rec = (over: Partial<StepRecord> = {}): StepRecord => ({ id: "a", type: "shell", visit: 1, ok: true, output: "the output with sk-secret", startedAt: "2026-01-31T12:00:00.000Z", durationMs: 12.6, logFile: join(runDir, "logs", "001-a.log"), ...over });

  it("names who asked", () => {
    expect(actorOf("ui", USER)).toEqual({ kind: "user", id: USER });
    expect(actorOf("cli")).toEqual({ kind: "cli" });
    expect(actorOf("watcher w-1 issue #7")).toEqual({ kind: "watcher", id: "w-1" });
    expect(actorOf("watcher")).toEqual({ kind: "system" });
    expect(actorOf("eval suite", "not-an-account")).toEqual({ kind: "system" });
    expect(actorOf(undefined)).toEqual({ kind: "system" });
  });

  it("names a step inside a sub-flow, a model without a model name, and a test step", () => {
    expect(stepIdentity({ id: "t", type: "shell" }, "build/inner/", 2)).toEqual({ id: "t", visit: 2, type: "shell", parent: "build/inner" });
    expect(stepIdentity({ id: "t", type: "claude" }, "", 1)).toEqual({ id: "t", visit: 1, type: "claude" });
    expect(targetModel("codex:openai")).toEqual({ agent: "codex", provider: "openai", model: "default" });
    expect(targetModel("claude:ollama:qwen3:30b", "high")).toEqual({ agent: "claude", provider: "ollama", model: "qwen3:30b", effort: "high" });
    expect(targetModel("claude:anthropic:opus", "two\nlines")).toEqual({ agent: "claude", provider: "anthropic", model: "opus" });
    expect(targetModel("robot")).toBeUndefined();
    for (const id of ["test", "run_tests", "test_main", "build/run-tests", "baseline_tests_1"]) expect(isTestStep({ id, type: "shell" }), id).toBe(true);
    for (const id of ["pretest_merge", "contest", "latest", "build"]) expect(isTestStep({ id, type: "shell" }), id).toBe(false);
    expect(isTestStep({ id: "fix_tests", type: "claude" })).toBe(false);
  });

  it("refers to the log of a step by path, hash and size, and copies no output, error or tool input", () => {
    const log = "line 1\nline 2 with sk-secret\n";
    writeFileSync(join(runDir, "logs", "001-a.log"), log);
    writeFileSync(join(runDir, "logs", "002-b.log"), "{}\n");
    const r = new RunRecorder(stream(), runDir);
    r.stepEnded(rec({ exitCode: 0 }));
    r.stepEnded(rec({ id: "build/b", parent: "build", type: "claude", ok: false, error: "it broke: sk-secret", agent: "claude:anthropic:opus", effort: "high", denied: ["Bash: rm -rf /tmp/x", "mcp__a__b", "bad name: x"], logFile: join(runDir, "logs", "002-b.log") }));
    r.stepEnded(rec({ id: "c", exitCode: null, logFile: join(runDir, "logs", "003-missing.log") }));
    r.stepEnded(rec({ id: "d", logFile: join(tmp, "outside.log") }));
    const all = lines();
    expect(all.map((e) => e.type)).toEqual(["step.completed", "step.denied", "step.denied", "step.failed", "step.completed", "step.completed"]);
    expect(all[0]).toMatchObject({ step: { id: "a", visit: 1, type: "shell" }, exitCode: 0, durationMs: 13, artifacts: [{ kind: "log", path: "logs/001-a.log", sha256: sha256Hex(log), bytes: Buffer.byteLength(log), required: true }] });
    expect(all[1]).toMatchObject({ denial: { kind: "tool", tool: { name: "Bash" } } });
    expect(all[2]).toMatchObject({ denial: { kind: "tool", tool: { name: "mcp__a__b" } } });
    expect(all[3]).toMatchObject({ step: { id: "b", parent: "build", type: "claude" }, model: { agent: "claude", provider: "anthropic", model: "opus", effort: "high" }, artifacts: [{ kind: "transcript", path: "logs/002-b.log" }] });
    expect(all[4]).toMatchObject({ artifacts: [] });
    expect(all[5]).toMatchObject({ artifacts: [] });
    const text = readFileSync(file(), "utf8");
    for (const secret of ["sk-secret", "rm -rf", "it broke", tmp]) expect(text).not.toContain(secret);
    expect(said).toEqual([]);
  });

  it("marks a test step, and hashes only a plain file", () => {
    writeFileSync(join(runDir, "logs", "001-a.log"), "x");
    const r = new RunRecorder(stream(), runDir);
    r.stepEnded(rec({ id: "run_tests", ok: false }));
    expect(lines()[0]).toMatchObject({ type: "step.failed", test: { suite: "run_tests", outcome: "failed" } });
    expect(hashPlainFile(join(runDir, "logs", "001-a.log"))).toEqual({ sha256: sha256Hex("x"), bytes: 1 });
    symlinkSync(join(runDir, "logs", "001-a.log"), join(runDir, "logs", "link.log"));
    expect(hashPlainFile(join(runDir, "logs", "link.log"))).toBeUndefined();
    expect(hashPlainFile(join(runDir, "logs"))).toBeUndefined();
    expect(hashPlainFile(join(runDir, "logs", "none.log"))).toBeUndefined();
  });

  it("leaves out what has no valid form instead of guessing", () => {
    const r = new RunRecorder(stream(), runDir);
    r.started({ baseSha: "abc123", branch: "factory/x", vars: {} });
    r.started({ baseSha: "a".repeat(40), branch: "factory/x", vars: { github_repo: "owner/repo" } });
    r.started({ baseSha: "a".repeat(40), branch: "has space", vars: { github_repo: "acme/app" } });
    r.ended({ status: "succeeded", state: { next: null, steps: {}, visits: {} }, vars: { github_repo: "acme/app", pr: "12" } });
    r.ended({ status: "succeeded", state: { next: null, steps: {}, visits: {} }, vars: { github_repo: "acme/app", pr: "12; rm" } });
    r.ended({ status: "stopped", state: { next: "a", steps: {}, visits: {} }, vars: {} });
    r.ended({ status: "cancelled", state: { next: "a", steps: {}, visits: {} }, vars: {} }, { cancelledBy: { kind: "user", id: USER } });
    r.ended({ status: "failed", state: { next: "a", steps: {}, visits: {} }, vars: {} }, { failedStep: step });
    const all = lines();
    expect(all[0]).not.toHaveProperty("base");
    expect(all[1]).toMatchObject({ base: { commit: "a".repeat(40), branch: "factory/x" } });
    expect((all[1] as { base: object }).base).not.toHaveProperty("repository");
    expect(all[2]).toMatchObject({ base: { commit: "a".repeat(40), repository: "acme/app" } });
    expect((all[2] as { base: object }).base).not.toHaveProperty("branch");
    expect(all[3]).toMatchObject({ type: "run.completed", pullRequest: { repository: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12" } });
    expect(all[4]).not.toHaveProperty("pullRequest");
    expect(all[5]).toMatchObject({ type: "run.stopped", at: "a" });
    expect(all[6]).toMatchObject({ type: "run.cancelled", by: { kind: "user", id: USER } });
    expect(all[7]).toMatchObject({ type: "run.failed", step });
  });
});
