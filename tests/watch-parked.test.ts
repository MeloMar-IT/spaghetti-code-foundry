import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, STOPPED_CANCEL_REASON, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const TRIGGER = "claude-factory";
const ASKS = "factory:needs-info";

describe("a story whose trigger label is removed is parked", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
    process.env.FAKE_GH_LABEL_FILTER = "1";
  });
  afterEach(() => { gh.restore(); delete process.env.FAKE_PLAN; delete process.env.FAKE_GH_LABEL_FILTER; });
  const watcher = () =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, flow: oldFlowFor({}) }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
    });
  const issue4 = (labels: string[], state = "OPEN") => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "issue 4", state, labels: labels.map((name) => ({ name })) }]);
  };
  const settle = async () => { await scheduler.idle(); await new Promise((r) => setTimeout(r, 300)); };
  const runs = () => scheduler.list().filter((s) => s.vars.issue === "4");
  const lines = (from = 0) => gh.ghLog().split("\n").slice(from);
  const edits = (from = 0) => lines(from).filter((l) => l.includes("issue edit 4 "));
  const views = (from = 0) => lines(from).filter((l) => /issue view 4 .*--json state,labels/.test(l));
  const hold4 = (w: Watcher) => w.status.holds?.find((h) => h.issue === 4)?.next.kind;

  /** A run that stopped with questions: the watcher saw the trigger label, the planner asked. */
  const stopWithQuestions = async (w: Watcher) => {
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issue4([TRIGGER]);
    await w.tick();
    await settle();
    delete process.env.FAKE_PLAN;
    const run = runs()[0]!;
    expect(run.status).toBe("stopped");
    expect(run.parkedAt).toBeUndefined();
    return run;
  };

  it("parks the run when the label is gone, and starts a new run when it comes back", async () => {
    const w = watcher();
    const first = await stopWithQuestions(w);
    issue4([TRIGGER, ASKS]);
    await w.tick();
    expect(hold4(w)).toBe("planner_questions");
    expect(scheduler.get(first.runId)?.parkedAt).toBeUndefined();

    // The owner removes the trigger label and keeps the needs-info label.
    issue4([ASKS]);
    const at = lines().length;
    await w.tick();
    expect(scheduler.get(first.runId)?.parkedAt).toBeTruthy();
    expect(views(at)).toHaveLength(1);
    expect(w.status.lastActions.join("\n")).toContain(`#4 has no ${TRIGGER} label → run ${first.runId} is parked`);
    expect(hold4(w)).toBeUndefined();
    const at2 = lines().length;
    await w.tick();
    expect(views(at2)).toHaveLength(0);

    // The label is back with the needs-info label still there: the status label goes, nothing else yet.
    issue4([TRIGGER, ASKS]);
    const at3 = lines().length;
    await w.tick();
    expect(edits(at3)).toHaveLength(1);
    expect(edits(at3)[0]).toContain(`--remove-label ${ASKS}`);
    expect(hold4(w)).toBe("starting");
    expect(runs()).toHaveLength(1);

    // Only the trigger label is left: a new run starts and the old one stays parked.
    issue4([TRIGGER]);
    const at4 = lines().length;
    await w.tick();
    await settle();
    expect(runs()).toHaveLength(2);
    expect(edits(at4).join("\n")).toContain("--add-label factory:working");
    const old = scheduler.get(first.runId)!;
    expect(old.status).toBe("stopped");
    expect(old.parkedAt).toBeTruthy();
  });

  it("is not parked: a story that keeps its label, a closed issue, an issue the list lacks while GitHub has the label", async () => {
    const w = watcher();
    const first = await stopWithQuestions(w);
    const parked = () => scheduler.get(first.runId)?.parkedAt;
    issue4([TRIGGER, ASKS]);
    const at = lines().length;
    await w.tick();
    await w.tick();
    expect(parked()).toBeUndefined();
    expect(views(at)).toHaveLength(0);
    expect(hold4(w)).toBe("planner_questions");

    issue4([ASKS], "CLOSED");
    const at2 = lines().length;
    await w.tick();
    expect(parked()).toBeUndefined();
    expect(views(at2)).toHaveLength(0);

    // The issue list is empty (cut or lagging), but GitHub still has the trigger label on the issue: one confirmation, then a pause.
    process.env.FAKE_GH_ISSUES = "[]";
    process.env.FAKE_GH_FRESH = JSON.stringify([{ number: 4, state: "OPEN", labels: [{ name: TRIGGER }] }]);
    const at3 = lines().length;
    await w.tick();
    await w.tick();
    delete process.env.FAKE_GH_FRESH;
    expect(views(at3)).toHaveLength(1);
    expect(parked()).toBeUndefined();
  });

  it("confirms at most ten issues per check, and the next checks reach the others", async () => {
    const flow = oldFlowFor({});
    for (let n = 10; n < 22; n++) {
      const runDir = join(gh.tmp, "runs", `old-${n}`);
      mkdirSync(runDir, { recursive: true });
      saveRun({
        runId: `old-${n}`, flow, task: "t", vars: { github_repo: "acme/app", issue: String(n) }, repo: "/x", status: "stopped", reason: 'stopped at step "ask_for_info"', runDir,
        startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [],
        flowDef: { name: flow, steps: [] }, state: { next: "ask_for_info", steps: {}, visits: {} },
      } as unknown as RunSummary);
    }
    // No issue is in the lists, and GitHub has the trigger label on all of them: every confirmation says no.
    process.env.FAKE_GH_ISSUES = "[]";
    process.env.FAKE_GH_FRESH = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ number: 10 + i, state: "OPEN", labels: [{ name: TRIGGER }] })));
    try {
      const w = watcher();
      const asked = (from: number) => lines(from).filter((l) => /issue view \d+ .*--json state,labels/.test(l)).length;
      let at = lines().length;
      await w.tick();
      expect(asked(at)).toBe(10);
      at = lines().length;
      await w.tick();
      expect(asked(at)).toBe(2);
      at = lines().length;
      await w.tick();
      expect(asked(at)).toBe(0);
    } finally {
      delete process.env.FAKE_GH_FRESH;
    }
  });

  it("a run that stopped but is still finishing (its notification runs) is cancelled for good", async () => {
    const gate = join(gh.tmp, "gate");
    writeFileSync(gate, "");
    const held = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2, notify: { macos: false, command: `while [ -e '${gate}' ]; do sleep 0.05; done`, on: ["stopped"] } });
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => held, claudeBin });
    process.env.FACTORY_NO_NOTIFY = "0";
    try {
      const w = watcher();
      process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
      issue4([TRIGGER]);
      await w.tick();
      // The stop is saved, but the run is still active: its notification has not ended.
      const id = await vi.waitFor(() => {
        const r = runs()[0];
        if (r?.status !== "stopped" || !scheduler.isActive(r.runId)) throw new Error("not stopped yet");
        return r.runId;
      }, { timeout: 20000 });
      expect(scheduler.cancel(id)).toBe(true);
      expect(scheduler.get(id)?.status).toBe("cancelled");
      rmSync(gate);
      const done = await scheduler.wait(id);
      await settle();
      expect(done?.status).toBe("cancelled");
      expect(done?.reason).toBe(STOPPED_CANCEL_REASON);
      issue4([TRIGGER, ASKS]);
      await w.tick();
      expect(runs()).toHaveLength(1);
      expect(hold4(w)).toBeUndefined();
    } finally {
      process.env.FACTORY_NO_NOTIFY = "1";
      rmSync(gate, { force: true });
    }
  });

  it("a stopped run that is cancelled leaves no status label and starts nothing; park and re-add start over", async () => {
    const w = watcher();
    const first = await stopWithQuestions(w);
    expect(scheduler.cancel(first.runId)).toBe(true);
    expect(scheduler.get(first.runId)).toMatchObject({ status: "cancelled", reason: STOPPED_CANCEL_REASON });

    issue4([TRIGGER, ASKS]);
    const at = lines().length;
    await w.tick();
    await settle();
    expect(edits(at)).toHaveLength(1);
    expect(edits(at)[0]).toContain(`--remove-label ${ASKS}`);
    expect(hold4(w)).toBeUndefined();
    expect(runs()).toHaveLength(1);

    issue4([TRIGGER]);
    const at2 = lines().length;
    await w.tick();
    await settle();
    expect(edits(at2)).toHaveLength(0);
    expect(runs()).toHaveLength(1);

    issue4([]);
    await w.tick();
    expect(scheduler.get(first.runId)?.parkedAt).toBeTruthy();

    issue4([TRIGGER]);
    await w.tick();
    await settle();
    expect(runs()).toHaveLength(2);
  });

});
