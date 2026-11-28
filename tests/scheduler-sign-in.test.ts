import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type SchedulerOptions } from "../src/queue/scheduler.js";

// The queue waits while the AI sign-in is missing. concurrency 1 and a stand-in for `start`: no run is really made.

const CLAUDE = parseFlow("name: ai\nworkspace: empty\nsteps:\n  - {id: a, type: claude, prompt: x}\n");
const SHELL = parseFlow('name: plain\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "true"}\n');

let tmp: string;
let s: Scheduler;
let started: string[];
let onStart: () => void;

function make(extra: Partial<SchedulerOptions> = {}) {
  s = new Scheduler({ runsDir: join(tmp, "runs"), config: () => ConfigSchema.parse({ concurrency: 5 }), ...extra });
  // a started job only leaves the queue: what is looked at is who may start
  (s as unknown as { start: (q: { source?: string }) => void }).start = (q) => {
    started.push(q.source!);
    onStart();
  };
  return s;
}
const submit = (flow: typeof CLAUDE, source: string) => s.submit({ kind: "run", flow, task: "t", repo: tmp, vars: {} }, { source });
const limitOf = (runId: string) => s.queue().pending.find((p) => p.runId === runId)?.limit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-sign-in-queue-"));
  mkdirSync(join(tmp, "runs"));
  started = [];
  onStart = () => {};
});
afterEach(() => {
  s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the queue without an AI sign-in", () => {
  it("holds jobs that need Claude, also chores and architect runs, and starts shell-only flows", () => {
    make({ aiSignIn: { missing: () => true, recheck: () => {} } });
    const ai = submit(CLAUDE, "ui");
    const chore = submit(CLAUDE, "watcher rel schedule");
    const architect = submit(CLAUDE, "refinement 7d2b0c1e-0000-4000-8000-000000000001");
    submit(SHELL, "shell");
    expect(started).toEqual(["shell"]);
    for (const id of [ai, chore, architect]) expect(limitOf(id)).toBe("sign_in");
  });

  it("holds the resume of a run whose flow has a Claude step", () => {
    const stored = (id: string, flowDef: unknown) => {
      mkdirSync(join(tmp, "runs", id));
      writeFileSync(join(tmp, "runs", id, "run.json"), JSON.stringify({ runId: id, flow: "f", flowDef, repo: tmp, status: "stopped", startedAt: new Date().toISOString(), vars: {}, history: [], totalCostUsd: 0 }));
    };
    stored("20261001-120000-aaaa", CLAUDE);
    stored("20261001-120000-bbbb", SHELL);
    make({ aiSignIn: { missing: () => true, recheck: () => {} } });
    s.submit({ kind: "resume", runId: "20261001-120000-aaaa" }, { source: "ai" });
    s.submit({ kind: "resume", runId: "20261001-120000-bbbb" }, { source: "shell" });
    expect(started).toEqual(["shell"]);
    expect(limitOf("20261001-120000-aaaa")).toBe("sign_in");
  });

  it("looks again by itself and starts the held job once the token is there", async () => {
    let missing = true;
    let rechecks = 0;
    make({ signInRecheckMs: 10, aiSignIn: { missing: () => missing, recheck: () => void (++rechecks === 2 && (missing = false)) } });
    const start = new Promise<void>((done) => (onStart = done));
    submit(CLAUDE, "ui");
    expect(started).toEqual([]);
    // the scheduler's timer is unref'd: something has to keep the process waiting
    const keep = setInterval(() => {}, 1000);
    try {
      await start;
    } finally {
      clearInterval(keep);
    }
    expect(started).toEqual(["ui"]);
    expect(rechecks).toBe(2);
  });

  it("holds nothing without the option, when the state cannot be read, or in an eval", () => {
    make();
    submit(CLAUDE, "cli");
    s.close();
    make({ aiSignIn: { missing: () => { throw new Error("x"); }, recheck: () => {} } });
    submit(CLAUDE, "broken");
    s.close();
    make({ localTest: true, aiSignIn: { missing: () => true, recheck: () => {} } });
    submit(CLAUDE, "eval");
    expect(started).toEqual(["cli", "broken", "eval"]);
  });
});
