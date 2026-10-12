import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fixture runs for the evidence verifier: a run folder with `run.json`, logs, `evidence.jsonl`, `evidence.json` and
 * `evidence.diff`, written from fixed content. Nothing here uses the code under test: the canonical form, the hashes
 * and the manifest are made here on their own, so a fixture that verifies is a second opinion on the writer.
 *
 * - `valid`: a run that succeeded, with a transcript, a test log and a diff.
 * - `changed-event`: the same, with one value of one event changed afterwards.
 * - `missing-file`: the same, with the test log (a required file) removed.
 * - `old`: a run made before evidence existed: `run.json` and logs only.
 */
export type EvidenceFixture = "valid" | "changed-event" | "missing-file" | "old";

export const FIXTURE_RUN_ID = "20260131-120000-ab12";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Names in order, no spaces: enough of the canonical form for these plain values. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

export const FIXTURE_FILES = {
  "logs/001-code.log": '{"type":"assistant","message":{"content":[{"type":"text","text":"I changed file.txt"}]}}\n{"type":"result","subtype":"success","result":"done"}\n',
  "logs/002-run_tests.log": "> test\n12 tests passed\n",
  "evidence.diff": "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-first\n+changed\n",
} as const;
export const FIXTURE_FLOW = { name: "demo", workspace: "inplace", steps: [{ id: "code", type: "claude", prompt: "change it" }, { id: "run_tests", type: "shell", run: "npm test" }] };

const BASE = "a".repeat(40);
const FINAL = "b".repeat(40);
const ref = (kind: string, path: keyof typeof FIXTURE_FILES, required: boolean) => ({ kind, path, sha256: sha(FIXTURE_FILES[path]), bytes: Buffer.byteLength(FIXTURE_FILES[path]), required });
const code = { id: "code", visit: 1, type: "claude" };
const tests = { id: "run_tests", visit: 1, type: "shell" };
const opus = { agent: "claude", provider: "anthropic", model: "opus" };
const BODIES: Record<string, unknown>[] = [
  { type: "run.created", time: "2026-01-31T12:00:00.000Z", flow: { name: "demo" }, by: { kind: "cli" } },
  { type: "run.started", time: "2026-01-31T12:00:00.100Z", base: { commit: BASE } },
  { type: "step.started", time: "2026-01-31T12:00:00.200Z", step: code },
  { type: "step.routed", time: "2026-01-31T12:00:00.300Z", step: code, model: opus },
  { type: "step.completed", time: "2026-01-31T12:00:01.500Z", step: code, model: opus, durationMs: 1200, artifacts: [ref("transcript", "logs/001-code.log", true)] },
  { type: "step.started", time: "2026-01-31T12:00:01.600Z", step: tests },
  { type: "step.completed", time: "2026-01-31T12:00:02.400Z", step: tests, exitCode: 0, durationMs: 800, artifacts: [ref("log", "logs/002-run_tests.log", true)], test: { suite: "run_tests", outcome: "passed" } },
  { type: "run.completed", time: "2026-01-31T12:00:02.500Z", final: { commit: FINAL } },
];

/** The lines of a chain for these event bodies, and the hash of the last one. */
export function fixtureChain(bodies: Record<string, unknown>[] = BODIES, runId = FIXTURE_RUN_ID): { lines: string[]; terminalHash: string } {
  let prev: string | null = null;
  const lines = bodies.map((body, seq) => {
    const event: Record<string, unknown> = { version: 1, id: `ev-${String(seq).padStart(6, "0")}`, seq, runId, ...body, prevHash: prev };
    prev = sha(canon(event));
    return canon({ ...event, hash: prev });
  });
  return { lines, terminalHash: prev! };
}

/** The manifest of the valid fixture, written out by hand. */
export function fixtureManifest(): Record<string, unknown> {
  const { lines, terminalHash } = fixtureChain();
  return {
    version: 1,
    runId: FIXTURE_RUN_ID,
    status: "succeeded",
    startedAt: "2026-01-31T12:00:00.000Z",
    finishedAt: "2026-01-31T12:00:02.500Z",
    finalizedAt: "2026-01-31T12:00:02.600Z",
    flow: { name: "demo", sha256: sha(canon(FIXTURE_FLOW)) },
    events: { path: "evidence.jsonl", count: lines.length, terminalHash },
    git: { base: BASE, final: FINAL },
    models: [opus],
    policies: [],
    approvals: [],
    tests: [{ step: tests, result: { suite: "run_tests", outcome: "passed" } }],
    artifacts: [ref("transcript", "logs/001-code.log", true), ref("log", "logs/002-run_tests.log", true)],
    diff: ref("diff", "evidence.diff", false),
  };
}

/** Writes the fixture as `<runsDir>/<FIXTURE_RUN_ID>` and returns that folder. */
export function writeEvidenceFixture(runsDir: string, kind: EvidenceFixture): string {
  const runDir = join(runsDir, FIXTURE_RUN_ID);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: FIXTURE_RUN_ID, flow: "demo", flowDef: FIXTURE_FLOW, task: "change it", vars: {}, status: "succeeded", runDir, startedAt: "2026-01-31T12:00:00.000Z", finishedAt: "2026-01-31T12:00:02.500Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} } }, null, 2));
  writeFileSync(join(runDir, "logs", "001-code.log"), FIXTURE_FILES["logs/001-code.log"]);
  writeFileSync(join(runDir, "logs", "002-run_tests.log"), FIXTURE_FILES["logs/002-run_tests.log"]);
  if (kind === "old") return runDir;
  const lines = fixtureChain().lines;
  if (kind === "changed-event") lines[4] = lines[4]!.replace('"durationMs":1200', '"durationMs":1');
  writeFileSync(join(runDir, "evidence.jsonl"), lines.map((l) => `${l}\n`).join(""));
  writeFileSync(join(runDir, "evidence.json"), `${JSON.stringify(fixtureManifest(), null, 2)}\n`);
  writeFileSync(join(runDir, "evidence.diff"), FIXTURE_FILES["evidence.diff"]);
  if (kind === "missing-file") rmSync(join(runDir, "logs", "002-run_tests.log"));
  return runDir;
}
