import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { cancelWaitingRun, resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
const USER = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";
let tmp: string;
let repo: string;
let runsDir: string;

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  delete process.env.CODEX_API_KEY;
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const start = (yaml: string, o: Partial<Parameters<typeof runFlow>[1]> = {}) => runFlow(parseFlow(yaml), { task: "the task with sk-secret-in-task", repo, runsDir, claudeBin, config: cfg(), ...o });
const text = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8");
const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => text(s).split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
/** The events without the decisions of the policy, which every run has: for lookups by place. */
const steps = (s: Pick<RunSummary, "runDir">) => events(s).filter((e) => e.type !== "policy.decided");
const types = (s: Pick<RunSummary, "runDir">) => steps(s).map((e) => e.type + ("step" in e && e.step ? `:${e.step.id}` : ""));
/** Every stream: places 0, 1, 2, … and no id twice. */
const inOrder = (s: Pick<RunSummary, "runDir">) => {
  const all = events(s);
  expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i));
  expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  expect(text(s).endsWith("\n")).toBe(true);
};

const TWO = `
name: two
workspace: inplace
steps:
  - {id: write, type: claude, prompt: "WRITE out.txt hello"}
  - {id: check, type: shell, run: "grep -q hello out.txt && echo check-passed-zq7"}
`;

describe("the evidence stream of a run", () => {
  it("has the events of a run that succeeds, and refers to its logs without copying them", async () => {
    const s = await start(TWO, { source: "cli" });
    expect(s.status).toBe("succeeded");
    expect(types(s)).toEqual(["run.created", "run.started", "step.started:write", "step.routed:write", "step.profiled:write", "step.completed:write", "step.started:check", "step.completed:check", "run.completed"]);
    inOrder(s);
    const all = steps(s);
    expect(all[0]).toMatchObject({ type: "run.created", runId: s.runId, flow: { name: "two" }, by: { kind: "cli" } });
    expect(all[3]).toMatchObject({ step: { id: "write", visit: 1, type: "claude" }, model: { agent: "claude", provider: "anthropic" } });
    for (const i of [5, 7]) {
      const e = all[i] as Extract<EvidenceEvent, { type: "step.completed" }>;
      const log = readFileSync(s.history[i === 5 ? 0 : 1]!.logFile);
      expect(e.artifacts).toEqual([{ kind: i === 5 ? "transcript" : "log", path: `logs/${i === 5 ? "001-write" : "002-check"}.log`, sha256: sha256Hex(log), bytes: log.length, required: true }]);
    }
    expect(all[7]).toMatchObject({ exitCode: 0 });
    // nothing of the run's text is in the stream, and run.json has no evidence in it
    for (const word of ["sk-secret-in-task", "hello", "check-passed-zq7", "WRITE", tmp]) expect(text(s)).not.toContain(word);
    const saved = readFileSync(join(s.runDir, "run.json"), "utf8");
    expect(saved).not.toContain("ev-0000");
    expect(Object.keys(JSON.parse(saved)).filter((k) => /evidence/i.test(k))).toEqual([]);
  });

  it("records a failed step, the failed run, and the test result of a test step", async () => {
    const s = await start(`
name: f
workspace: inplace
steps:
  - {id: run_tests, type: shell, run: "echo no; exit 3"}
`);
    expect(s.status).toBe("failed");
    expect(types(s)).toEqual(["run.created", "run.started", "step.started:run_tests", "step.failed:run_tests", "run.failed:run_tests"]);
    expect(steps(s)[3]).toMatchObject({ exitCode: 3, test: { suite: "run_tests", outcome: "failed" } });
    expect(steps(s)[0]).toMatchObject({ by: { kind: "system" } });
    inOrder(s);
  });

  it("keeps one ordered stream when steps end at the same time", async () => {
    const s = await start(`
name: p
workspace: inplace
steps:
  - {id: all, type: parallel, steps: [a, b, c]}
  - {id: a, type: shell, run: "sleep 0.2; echo A", jump_only: true}
  - {id: b, type: shell, run: "sleep 0.2; echo B", jump_only: true}
  - {id: c, type: shell, run: "sleep 0.2; echo C", jump_only: true}
`);
    expect(s.status).toBe("succeeded");
    inOrder(s);
    const t = types(s);
    expect(t.slice(0, 6)).toEqual(["run.created", "run.started", "step.started:all", "step.started:a", "step.started:b", "step.started:c"]);
    expect(t.slice(6, 9).sort()).toEqual(["step.completed:a", "step.completed:b", "step.completed:c"]);
    expect(t.slice(9)).toEqual(["step.completed:all", "run.completed"]);
    const paths = events(s).flatMap((e) => (e.type === "step.completed" ? e.artifacts.map((a) => a.path) : []));
    expect(new Set(paths).size).toBe(3); // the parallel step itself has no log
  });

  it("records the steps of a sub-flow under their parent", async () => {
    mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "flows", "inner.yaml"), "name: inner\nsteps:\n  - {id: x, type: shell, run: echo X}\n");
    const s = await start(`
name: outer
workspace: inplace
steps:
  - {id: build, type: flow, flow: inner}
`);
    expect(s.status).toBe("succeeded");
    expect(types(s)).toEqual(["run.created", "run.started", "step.started:build", "step.started:x", "step.completed:x", "step.completed:build", "run.completed"]);
    expect(steps(s)[4]).toMatchObject({ step: { id: "x", visit: 1, type: "shell", parent: "build" }, artifacts: [{ path: "logs/001-build__x.log" }] });
  });

  it("stops at an approval step, and records who approved or rejected", async () => {
    const flow = `
name: ap
workspace: inplace
steps:
  - {id: a, type: shell, run: echo one}
  - {id: ok, type: approval, message: "go on?"}
  - {id: b, type: shell, run: echo two}
`;
    const s = await start(flow);
    expect(s.status).toBe("waiting");
    expect(types(s).slice(-2)).toEqual(["step.completed:a", "run.stopped"]);
    expect(steps(s).at(-1)).toMatchObject({ type: "run.stopped", at: "ok" });
    const before = text(s);
    const n = types(s).length;

    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg(), decision: { approved: true, by: "someone", note: "a note with sk-secret" }, actor: { kind: "user", id: USER }, queuedAt: "2026-01-31T12:00:00.000Z" });
    expect(r.status).toBe("succeeded");
    expect(text(r).startsWith(before)).toBe(true);
    expect(types(r).slice(n)).toEqual(["run.queued", "run.resumed", "step.started:ok", "step.approved:ok", "step.completed:ok", "step.started:b", "step.completed:b", "run.completed"]);
    const all = steps(r);
    expect(all.find((e) => e.type === "run.queued")).toMatchObject({ time: "2026-01-31T12:00:00.000Z" });
    expect(all.find((e) => e.type === "run.resumed")).toMatchObject({ from: "ok", by: { kind: "user", id: USER } });
    expect(all.find((e) => e.type === "step.approved")).toMatchObject({ step: { id: "ok", visit: 1, type: "approval" }, by: { kind: "user", id: USER } });
    expect(text(r)).not.toContain("sk-secret");
    expect(text(r)).not.toContain("someone");
    inOrder(r);

    const s2 = await start(flow);
    const r2 = await resumeRun({ runId: s2.runId, runsDir, claudeBin, config: cfg(), decision: { approved: false, by: "cli" }, actor: { kind: "cli" } });
    expect(r2.status).toBe("failed");
    expect(types(r2).slice(-4)).toEqual(["step.started:ok", "step.denied:ok", "step.failed:ok", "run.failed:ok"]);
    expect(steps(r2).find((e) => e.type === "step.denied")).toMatchObject({ denial: { kind: "approval", by: { kind: "cli" } } });

    const s3 = await start(flow);
    expect(cancelWaitingRun(runsDir, s3.runId, cfg(), { kind: "user", id: USER })?.status).toBe("cancelled");
    expect(steps(s3).at(-1)).toMatchObject({ type: "run.cancelled", by: { kind: "user", id: USER } });
    inOrder(s3);
  });

  it("goes on after an interruption: the lines before stay as they are", async () => {
    const s = await start(TWO);
    // the process died while the second step ran: its end and the end of the run were never written, the last line was cut off
    const raw = text(s).split("\n");
    const k = raw.findIndex((l) => {
      const e = parseEvidenceEventLine(l);
      return e.type === "step.started" && e.step.id === "check";
    });
    const whole = raw.slice(0, k + 1).join("\n") + "\n";
    const kept = types(s).indexOf("step.started:check") + 1; // the events of the run before the cut, without policy decisions
    writeFileSync(join(s.runDir, "evidence.jsonl"), whole + `{"version":1,"id":"ev-${String(k + 1).padStart(6, "0")}","se`);
    writeFileSync(join(s.runDir, "run.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")), status: "running", finishedAt: undefined, state: { ...s.state, next: "check" } }));

    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg() });
    expect(r.status).toBe("succeeded");
    expect(text(r).startsWith(whole)).toBe(true);
    expect(types(r).slice(kept)).toEqual(["run.resumed", "step.started:check", "step.completed:check", "run.completed"]);
    expect(steps(r)[kept]).toMatchObject({ from: "check", by: { kind: "system" } });
    expect(steps(r)[kept + 1]).toMatchObject({ step: { id: "check", visit: 1 } });
    inOrder(r);
    expect(readFileSync(join(r.runDir, "live.log"), "utf8").match(/evidence:/g)).toHaveLength(1);
  });

  it("records a cancel with who asked for it", async () => {
    const stop = new AbortController();
    const running = start("name: c\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: sleep 30}\n", { signal: stop.signal, cancelledBy: () => ({ kind: "user", id: USER }), log: (l) => void (l.startsWith("▶ a") && setTimeout(() => stop.abort(), 50)) });
    const s = await running;
    expect(s.status).toBe("cancelled");
    expect(types(s)).toEqual(["run.created", "run.started", "step.started:a", "step.failed:a", "run.cancelled"]);
    expect(steps(s).at(-1)).toMatchObject({ by: { kind: "user", id: USER } });
  });

  it("never fails or changes a run when evidence cannot be written, and says so once", async () => {
    const runId = "20260131-120000-aaaa";
    mkdirSync(join(runsDir, runId, "evidence.jsonl"), { recursive: true }); // a folder where the file should be
    const s = await start(TWO, { runId });
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.ok)).toEqual([true, true]);
    expect(readFileSync(join(s.runDir, "live.log"), "utf8").match(/! evidence:/g)).toHaveLength(1);
  });

  it("runs and resumes a run that has no evidence (a run of an older version)", async () => {
    const s = await start(TWO);
    rmSync(join(s.runDir, "evidence.jsonl"));
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg(), from: "check" });
    expect(r.status).toBe("succeeded");
    expect(types(r)).toEqual(["run.resumed", "step.started:check", "step.completed:check", "run.completed"]);
    inOrder(r);
  });

  it("records a fallback to another model, a retry after an outage, and a refused tool", async () => {
    const s = await start("name: fb\nworkspace: inplace\nsteps:\n  - {id: a, type: claude, prompt: \"CLAUDE_LIMIT\\nSAY from codex\"}\n", { config: cfg({ router: { fallback: ["codex"] } }) });
    expect(s.status).toBe("succeeded");
    expect(types(s)).toEqual(["run.created", "run.started", "step.started:a", "step.routed:a", "step.profiled:a", "step.retried:a", "step.routed:a", "step.profiled:a", "step.completed:a", "run.completed"]);
    const all = steps(s);
    expect(all[5]).toMatchObject({ cause: "limit" });
    expect(all[6]).toMatchObject({ model: { agent: "codex", provider: "openai", model: "default" }, fallbackFrom: { agent: "claude", provider: "anthropic" } });
    expect(all[8]).toMatchObject({ model: { agent: "codex", provider: "openai", model: "default" } });

    const out = await start("name: un\nworkspace: inplace\nsteps:\n  - {id: a, type: claude, prompt: CLAUDE_UNREACHABLE}\n");
    expect(out.status).toBe("stopped");
    expect(types(out)).toEqual(["run.created", "run.started", "step.started:a", "step.routed:a", "step.profiled:a", "step.retried:a", "step.profiled:a", "step.retried:a", "step.profiled:a", "step.failed:a", "run.stopped"]);
    expect(steps(out)[5]).toMatchObject({ cause: "outage" });
    expect(steps(out).at(-1)).toMatchObject({ at: "a" });

    const d = await start("name: dn\nworkspace: inplace\nsteps:\n  - {id: a, type: claude, prompt: \"DENY Bash mkdir secret-folder\"}\n");
    expect(types(d)).toContain("step.denied:a");
    expect(events(d).find((e) => e.type === "step.denied")).toMatchObject({ denial: { kind: "tool", tool: { name: "Bash" } } });
    expect(text(d)).not.toContain("secret-folder");
  });

  it("records the queue: when a run was queued, who asked, and who cancelled", async () => {
    const s = new Scheduler({ runsDir, config: () => ({ ...cfg(), concurrency: 1 }), claudeBin });
    const flow = parseFlow("name: q\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: echo one}\n  - {id: ok, type: approval, message: \"go?\"}\n");
    const runId = s.submit({ kind: "run", flow, task: "t", repo, vars: {} }, { source: "ui", queuedBy: USER });
    const done = await s.wait(runId);
    expect(done?.status).toBe("waiting");
    const run = { runDir: join(runsDir, runId) };
    expect(types(run)).toEqual(["run.queued", "run.created", "run.started", "step.started:a", "step.completed:a", "run.stopped"]);
    const [queued, created] = steps(run);
    expect(Date.parse(queued!.time)).toBeLessThanOrEqual(Date.parse(created!.time));
    expect(created).toMatchObject({ by: { kind: "user", id: USER } });
    expect(s.cancel(runId, { kind: "user", id: USER })).toBe(true);
    expect(steps(run).at(-1)).toMatchObject({ type: "run.cancelled", by: { kind: "user", id: USER } });

    const w = s.submit({ kind: "run", flow, task: "t", repo, vars: {} }, { source: "watcher w1 issue #7" });
    await s.wait(w);
    expect(steps({ runDir: join(runsDir, w) })[1]).toMatchObject({ type: "run.created", by: { kind: "watcher", id: "w1" } });
    expect(s.cancel(w)).toBe(true);
    expect(steps({ runDir: join(runsDir, w) }).at(-1)).toMatchObject({ type: "run.cancelled", by: { kind: "system" } });
    expect(existsSync(join(runsDir, w, "evidence.json"))).toBe(true); // a cancelled run has ended
  });
});
