import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { timeLimitReason } from "../src/engine/auto-retry.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

describe("a story that ran out of time", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let first: Scheduler;
  let held: Scheduler;
  let runId: string;
  const runs = () => join(gh.tmp, "runs");
  const config = ConfigSchema.parse({ protected_branches: [], concurrency: 2 });
  // concurrency 0: nothing starts, so a queued retry stays queued and can be looked at
  const idle = { ...config, concurrency: 0 };

  const mk = (scheduler: Scheduler, over: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, ...over, flow: oldFlowFor(over) }), {
      scheduler, runsDir: runs(), repo: gh.tmp, log: () => {}, ...deps,
    });
  const issues = (label?: string) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 8, title: "issue 8", labels: [{ name: "claude-factory" }, ...(label ? [{ name: label }] : [])] }]);
  };

  beforeEach(async () => {
    gh = fakeGithub();
    // the watcher reads the issue's comments from the log of the fake gh, so a note it posted is seen on the next check
    process.env.FAKE_GH_COMMENTS_FROM_LOG = "1";
    first = new Scheduler({ runsDir: runs(), config: () => config, claudeBin });
    issues();
    await mk(first).tick();
    await first.idle();
    runId = first.list().find((s) => s.vars.issue === "8")!.runId;
    const s = loadRun(runs(), runId)!;
    Object.assign(s, {
      status: "stopped", reason: timeLimitReason("implement", 1, 2), finishedAt: undefined,
      timeLimits: [{ at: new Date().toISOString(), step: "implement", attempt: 1, of: 2 }], retryStep: undefined,
    });
    s.state.next = "push_result";
    saveRun(s);
    held = new Scheduler({ runsDir: runs(), config: () => idle, claudeBin });
    issues("factory:working");
    gh.ghLog(); // read once
  });
  afterEach(() => gh.restore());

  const notes = () => gh.comments().filter((c) => c.body.includes("ran out of time"));

  const text = () => `**Nothing needed from you** — ran out of time in \`implement\`; trying again (1 of 2).\n\n<!-- claude-factory run=${runId} retry=1 -->`;

  it("queues one retry as a new run; the note follows on the next check, once, and keeps the working label", async () => {
    const w = mk(held);
    await w.tick();
    expect(held.queue().pending).toHaveLength(1);
    expect(held.queue().pending[0]).toMatchObject({ runId, kind: "resume" });
    expect(notes()).toHaveLength(0);
    await w.tick();
    expect(notes().map((c) => c.body)).toEqual([text()]);
    await w.tick();
    expect(notes()).toHaveLength(1);
    expect(gh.ghLog()).not.toMatch(/issue edit .*--add-label (Factory_ERROR|factory:failed|factory:needs-info)/);
  });

  it("posts the note again on a later check when the post failed, and never twice", async () => {
    const w = mk(held);
    await w.tick();
    // the post fails on the next check only: the retry stays queued and the note is tried again
    process.env.FAKE_GH_FAIL_ON = "issue comment 8";
    await w.tick();
    delete process.env.FAKE_GH_FAIL_ON;
    expect(notes()).toHaveLength(0);
    expect(held.queue().pending).toHaveLength(1);
    await w.tick();
    expect(notes().map((c) => c.body)).toEqual([text()]);
    // a fresh watcher (a restart) sees the note in the issue and posts nothing
    await mk(held).tick();
    expect(notes()).toHaveLength(1);
  });

  it("holds the retry and says nothing while the daily budget is used up", async () => {
    const w = mk(held, {}, { dailyBudget: () => 0 });
    await w.tick();
    expect(held.queue().pending).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    expect(w.status.holds).toMatchObject([{ issue: 8, next: { kind: "daily_budget" } }]);
  });

  it("does not queue the retry of a run that was cancelled while queued", async () => {
    const w = mk(held);
    await w.tick();
    expect(held.cancel(runId)).toBe(true);
    expect(loadRun(runs(), runId)).toMatchObject({ status: "cancelled" });
    expect(loadRun(runs(), runId)!.timeLimits![0]!.startedAt).toBeUndefined();
    await w.tick();
    expect(held.queue().pending).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });

  it("does not comment when the run stopped for another reason", async () => {
    const s = loadRun(runs(), runId)!;
    Object.assign(s, { reason: 'stopped at step "wait_for_area" — needs attention' });
    saveRun(s);
    await mk(held).tick();
    expect(notes()).toHaveLength(0);
  });
});
