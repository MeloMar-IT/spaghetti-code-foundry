import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { RESTART_INTERRUPT, RESTART_INTERRUPTED } from "../src/engine/running.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type QueuedJob } from "../src/queue/scheduler.js";

/** A fake engine: the test moves each run from step to step, in the order of the real loop. No process runs. */
const engine = vi.hoisted(() => ({ runs: new Map<string, any>(), resumed: [] as string[], endOnAbort: true }));
vi.mock("../src/engine/runner.js", async (original) => {
  const start = (opts: any, runId: string) =>
    new Promise((resolve) => {
      let reason: unknown;
      const end = () => resolve({ runId, status: "cancelled", reason, state: {}, vars: {} });
      engine.runs.set(runId, {
        end,
        started: [] as string[],
        /** The abort check and stopBefore in one turn; the step starts after an asynchronous gate. */
        async step(id: string, gate: Promise<unknown> = Promise.resolve()) {
          if (opts.signal.aborted) return;
          opts.stopBefore(id);
          await gate;
          this.started.push(id);
        },
      });
      opts.signal.addEventListener("abort", () => {
        reason = opts.signal.reason === RESTART_INTERRUPT ? RESTART_INTERRUPTED : "cancelled by user";
        if (engine.endOnAbort) queueMicrotask(end);
      });
    });
  return {
    ...(await original<object>()),
    runFlow: (_flow: unknown, opts: any) => start(opts, opts.runId),
    resumeRun: (opts: any) => {
      engine.resumed.push(opts.runId);
      return start(opts, opts.runId);
    },
  };
});

describe("Scheduler: steps and interrupted runs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    engine.runs.clear();
    engine.resumed.length = 0;
    engine.endOnAbort = true;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const setup = () => {
    const tmp = mkdtempSync(join(tmpdir(), "safe-restart-"));
    dirs.push(tmp);
    const queueFile = join(tmp, "queue.json");
    const make = () => new Scheduler({ runsDir: join(tmp, "runs"), queueFile, config: () => ({ ...ConfigSchema.parse({}), concurrency: 3 }) });
    const s = make();
    const flow = parseFlow("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: x}\n");
    const submit = (source: string, meta: object = {}) => s.submit({ kind: "run", flow, task: "t", repo: tmp, vars: {} }, { source, ...meta });
    const saved = () => JSON.parse(readFileSync(queueFile, "utf8")) as QueuedJob[];
    return { s, make, submit, saved, queueFile };
  };

  it("knows the step before its gate, and an interrupt stops the run before the next protected step", async () => {
    const { s, submit, saved } = setup();
    const id = submit("ui");
    const run = engine.runs.get(id);
    expect(s.currentStep(id)).toBeUndefined();
    await run.step("implement");
    expect(s.currentStep(id)).toBe("implement");
    let open!: () => void;
    const pushing = run.step("push_develop", new Promise<void>((r) => (open = r)));
    expect(s.currentStep(id)).toBe("push_develop");
    expect(run.started).toEqual(["implement"]);
    open();
    await pushing;
    await run.step("report");
    s.drain();
    const done = s.interrupt([id]);
    await run.step("push_main");
    expect(run.started).toEqual(["implement", "push_develop", "report"]);
    expect(await done).toBe(true);
    expect(s.currentStep(id)).toBeUndefined();
    expect(s.currentStep("nope")).toBeUndefined();
    expect(saved()).toEqual([]); // without `resume` nothing is queued
  });

  it("saves one resume for an unwatched run, which the next server starts", async () => {
    const { s, make, submit, saved } = setup();
    const meta = { lockKey: "o/r#1", owner: "u1", queuedBy: "u1", priority: true, storyAt: "2026-01-01T00:00:00Z" };
    const ui = submit("ui", meta);
    const watched = submit("watcher w issue #2", { lockKey: "o/r#2" });
    s.drain();
    const resume = (q: QueuedJob) => q.source === "ui";
    const both = [s.interrupt([ui, watched], 60_000, { resume }), s.interrupt([ui, watched], 60_000, { resume })];
    expect(await Promise.all(both)).toEqual([true, true]);
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ runId: ui, job: { kind: "resume", runId: ui }, source: "ui", ...meta });
    const next = make();
    await Promise.resolve();
    expect(next.queue().active.map((a) => a.runId)).toEqual([ui]);
    expect(next.queue().pending).toEqual([]);
    expect(engine.resumed).toEqual([ui]);
  });

  it("saves the resume also when the run ends after the timeout", async () => {
    const { s, submit, saved } = setup();
    const id = submit("ui");
    engine.endOnAbort = false;
    s.drain();
    expect(await s.interrupt([id], 1, { resume: () => true })).toBe(false);
    expect(saved()).toEqual([]);
    engine.runs.get(id).end();
    await vi.waitFor(() => expect(s.isActive(id)).toBe(false));
    expect(saved().map((q) => q.runId)).toEqual([id]);
  });

  it("keeps a resume that could not be saved, and retries it until it is saved", async () => {
    const { s, submit, saved, queueFile } = setup();
    const id = submit("ui");
    s.drain();
    rmSync(queueFile, { force: true });
    mkdirSync(queueFile); // the queue file cannot be replaced: every save fails
    expect(await s.interrupt([id], 60_000, { resume: () => true })).toBe(true);
    expect(s.retryResumes()).toBe(false);
    rmSync(queueFile, { recursive: true });
    expect(s.retryResumes()).toBe(true);
    expect(s.retryResumes()).toBe(true);
    expect(saved().map((q) => q.runId)).toEqual([id]);
  });

  it("does not resume a run that a person cancelled, before or during the interrupt", async () => {
    const { s, submit, saved } = setup();
    const before = submit("ui");
    const during = submit("ui");
    s.drain();
    s.cancel(before);
    const a = s.interrupt([before], 60_000, { resume: () => true });
    const b = s.interrupt([during], 60_000, { resume: () => true });
    s.cancel(during);
    await Promise.all([a, b]);
    expect(saved()).toEqual([]);
  });
});
