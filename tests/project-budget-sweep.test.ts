import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { PROJECT_BUDGET_REASON, loadRun } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { resumeProjectStopped } from "../src/server/project-budget-sweep.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const TODAY = new Date(2026, 9, 7, 12, 0, 0);
const YESTERDAY = new Date(2026, 9, 6, 9, 0, 0);
const TOMORROW = new Date(2026, 9, 8, 9, 0, 0);

let tmp: string;
let runsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-project-sweep-"));
  runsDir = join(tmp, "runs");
  mkdirSync(runsDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A stopped run file of a project, as the runner leaves it. */
function stoppedRun(id: string, startedAt: Date, cost: number, over: Record<string, unknown> = {}) {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({
    runId: id, flow: "f", status: "stopped", reason: PROJECT_BUDGET_REASON, startedAt: startedAt.toISOString(),
    totalCostUsd: cost, owner: "u1", vars: { github_repo: "acme/a" }, ...over,
  }));
}

/** A fake scheduler: records what it queues; `cap` is the project's cap. */
function fakeScheduler(cap: number | undefined) {
  const submitted: string[] = [];
  return {
    submitted,
    scheduler: {
      isActive: () => false,
      isQueued: () => false,
      projectDailyBudget: () => cap,
      submit: (job: { kind: string; runId?: string }) => {
        submitted.push(job.runId ?? "");
        return job.runId ?? "";
      },
    },
  };
}

describe("resuming runs that the project cap stopped (#792)", () => {
  it("day rollover: a run of today is held while today's spend reaches the cap; the next day it is resumed", () => {
    // another project of today: its spend is over the cap of 5, so its run is held
    stoppedRun("20261007-090000-aaaa", TODAY, 6, { vars: { github_repo: "acme/b" } });
    // the project of the second run spent nothing today; its run stopped yesterday and goes on today
    stoppedRun("20261006-090000-bbbb", YESTERDAY, 6);
    const f = fakeScheduler(5);
    expect(resumeProjectStopped({ scheduler: f.scheduler, runsDir, log: () => {}, now: () => TODAY })).toEqual(["20261006-090000-bbbb"]);
    // tomorrow nothing of today counts any more, so the run of today goes on too
    f.submitted.length = 0;
    expect(resumeProjectStopped({ scheduler: f.scheduler, runsDir, log: () => {}, now: () => TOMORROW })).toEqual(["20261007-090000-aaaa", "20261006-090000-bbbb"]);
  });

  it("after a restart a new sweep finds the same runs from the run files alone", () => {
    stoppedRun("20261006-090000-cccc", YESTERDAY, 6);
    const before = fakeScheduler(5);
    expect(resumeProjectStopped({ scheduler: before.scheduler, runsDir, log: () => {}, now: () => TODAY })).toHaveLength(1);
    // a fresh scheduler knows nothing of the earlier queue; the run files still say what happened
    const after = fakeScheduler(5);
    expect(resumeProjectStopped({ scheduler: after.scheduler, runsDir, log: () => {}, now: () => TODAY })).toEqual(["20261006-090000-cccc"]);
  });

  it("skips runs that are queued or active, archived runs, other stop reasons, runs without a project, and projects without a cap", () => {
    stoppedRun("20261006-090001-dddd", YESTERDAY, 6, { archivedAt: TODAY.toISOString() });
    stoppedRun("20261006-090002-eeee", YESTERDAY, 6, { reason: "your daily limit is reached — resume tomorrow" });
    stoppedRun("20261006-090003-ffff", YESTERDAY, 6, { vars: {} });
    stoppedRun("20261006-090004-gggg", YESTERDAY, 6);
    stoppedRun("20261006-090005-hhhh", YESTERDAY, 6, { status: "failed" });
    const queued = "20261006-090004-gggg";
    const s = { isActive: () => false, isQueued: (id: string) => id === queued, projectDailyBudget: () => 5, submit: () => "" };
    expect(resumeProjectStopped({ scheduler: s, runsDir, log: () => {}, now: () => TODAY })).toEqual([]);
    expect(resumeProjectStopped({ scheduler: { ...s, projectDailyBudget: () => undefined, isQueued: () => false }, runsDir, log: () => {}, now: () => TODAY })).toEqual([]);
  });

  it("a real scheduler resumes a run the cap stopped, once the cap allows, and the run completes", async () => {
    const config = ConfigSchema.parse({ protected_branches: [], bot: { name: "Bot", email: "bot@example.com" } });
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const flow = parseFlow(`
name: t
workspace: empty
steps:
  - {id: a, type: claude, prompt: one}
  - {id: b, type: claude, prompt: two}
`);
    // the run stops after step a: its cost is over the project's cap of 0.01
    const stopped = await runFlow(flow, { task: "t", repo, runsDir, claudeBin, config, owner: "u1", vars: { github_repo: "acme/a" }, projectDailyBudget: () => 0.01 });
    expect(stopped.reason).toBe(PROJECT_BUDGET_REASON);

    let cap = 0.01;
    const scheduler = new Scheduler({
      runsDir, claudeBin, config: () => config, queueFile: join(tmp, "queue.json"), projectDailyBudget: () => cap,
    });
    const log: string[] = [];
    // over the cap: nothing starts
    expect(resumeProjectStopped({ scheduler, runsDir, log: (m) => log.push(m) })).toEqual([]);
    expect(scheduler.queue().active).toEqual([]);
    // the cap allows again (in practice: the next day): the sweep queues the resume and the run goes on to its end
    cap = 50;
    expect(resumeProjectStopped({ scheduler, runsDir, log: (m) => log.push(m) })).toEqual([stopped.runId]);
    for (let i = 0; i < 400 && loadRun(runsDir, stopped.runId)?.status !== "succeeded"; i++) await new Promise((r) => setTimeout(r, 25));
    expect(loadRun(runsDir, stopped.runId)?.status).toBe("succeeded");
    expect(loadRun(runsDir, stopped.runId)?.history.map((h) => h.id)).toEqual(["a", "b"]);
    // a finished run is not resumed again
    expect(resumeProjectStopped({ scheduler, runsDir, log: () => {} })).toEqual([]);
  });
});
