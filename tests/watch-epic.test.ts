import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const TRIGGER = "claude-factory";
const ASKS = "factory:needs-info";
const WORKING = "factory:working";
const DONE = "factory:done";
const question = { author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=r1 -->", createdAt: "2026-01-01T00:00:00Z" };

describe("an epic with the trigger label", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let submit: ReturnType<typeof vi.spyOn>;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    process.env.FAKE_GH_PERMISSION = "write";
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
    submit = vi.spyOn(scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FAKE_GH_COMMENTS;
    delete process.env.FAKE_GH_PERMISSION;
    gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}) => {
    return new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: {}, flow: oldFlowFor({}), ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
    });
  };
  const issue = (labels: string[], body = "Overview", number = 4) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number, title: `issue ${number}`, state: "OPEN", body, labels: labels.map((name) => ({ name })) }]);
  };
  const plant = (status: RunSummary["status"], over: Record<string, unknown> = {}) => {
    const runDir = join(gh.tmp, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    const flow = oldFlowFor({});
    saveRun({
      runId: "r1", flow, flowDef: { name: flow, steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: gh.tmp, status, runDir,
      reason: status === "stopped" ? 'stopped at step "ask_for_info"' : undefined,
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [],
      state: { next: "ask_for_info", steps: {}, visits: {} }, ...over,
    } as unknown as RunSummary);
  };
  const hold4 = (w: Watcher) => w.status.holds?.find((h) => h.issue === 4);

  it("by label: no run, an epic hold, one status comment over two checks", async () => {
    issue([TRIGGER, "epic"]);
    const w = watcher();
    await w.tick();
    await w.tick();
    expect(submit).not.toHaveBeenCalled();
    expect(hold4(w)?.next.kind).toBe("epic");
    expect(gh.statusComments()).toHaveLength(1);
    expect(gh.statusComments()[0]).toMatchObject({ issue: 4 });
    expect(gh.statusComments()[0]!.body).toContain("epic");
    expect(gh.ghLog()).not.toContain("issue edit 4");
  });

  it("by a stories heading: no run and no precheck", async () => {
    issue([TRIGGER], "## Stories\n- #5\n- #6");
    const w = watcher({ precheck_flow: oldFlowFor({}) });
    await w.tick();
    expect(hold4(w)?.next.kind).toBe("epic");
    expect(submit).not.toHaveBeenCalled();
  });

  it("removes the status label and parks a stopped run that asks questions, once", async () => {
    plant("stopped");
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [question] });
    issue([TRIGGER, ASKS, "epic"]);
    const w = watcher();
    await w.tick();
    expect(gh.ghLog()).toContain("issue edit 4");
    expect(gh.ghLog()).toContain("--remove-label factory:needs-info");
    expect(scheduler.get("r1")?.parkedAt).toBeTruthy();
    expect(hold4(w)?.next.kind).toBe("epic");
    expect(w.status.lastActions.join("\n")).toContain("run r1 is parked");
    expect(submit).not.toHaveBeenCalled();

    const edits = gh.ghLog().split("issue edit 4").length;
    const actions = w.status.lastActions.filter((a) => a.includes("is parked")).length;
    issue([TRIGGER, "epic"]);
    await w.tick();
    expect(gh.ghLog().split("issue edit 4").length).toBe(edits);
    expect(w.status.lastActions.filter((a) => a.includes("is parked")).length).toBe(actions);
    expect(hold4(w)?.next.kind).toBe("epic");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps the done label", async () => {
    issue([TRIGGER, "epic", DONE]);
    await watcher().tick();
    expect(gh.ghLog()).not.toContain("issue edit 4");
  });

  it("leaves a run that is working alone", async () => {
    plant("running");
    vi.spyOn(scheduler, "isActive").mockImplementation((id) => id === "r1");
    issue([TRIGGER, WORKING, "epic"]);
    const w = watcher();
    await w.tick();
    expect(hold4(w)?.next.kind).not.toBe("epic");
    expect(scheduler.get("r1")?.parkedAt).toBeUndefined();
    expect(gh.ghLog()).not.toContain("--remove-label");
  });

  it("leaves a run of another flow that is working alone", async () => {
    plant("running", { flow: "other-flow" });
    vi.spyOn(scheduler, "isActive").mockImplementation((id) => id === "r1");
    issue([TRIGGER, WORKING, "epic"]);
    const w = watcher();
    await w.tick();
    expect(hold4(w)?.next.kind).not.toBe("epic");
    expect(w.status.lastActions.join("\n")).not.toContain("is an epic");
  });

  it("does not park a run that the scheduler refuses to park", async () => {
    plant("stopped");
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [question] });
    vi.spyOn(scheduler, "setParked").mockReturnValue(false);
    issue([TRIGGER, ASKS, "epic"]);
    const w = watcher();
    await w.tick();
    expect(scheduler.get("r1")?.parkedAt).toBeUndefined();
    expect(w.status.lastActions.join("\n")).not.toContain("is parked");
    expect(hold4(w)?.next.kind).toBe("epic");
  });

  /**
   * A resumed run of this issue that is older than the newest runs: the recent run list is empty, and only the brief
   * index (every run) and the queue know it. It is queued or running as `where` says.
   */
  const outsideWindow = (runId: string, where: "queued" | "active") => {
    const summary = { runId, flow: oldFlowFor({}), status: "running", vars: { github_repo: "acme/app", issue: "4" } } as unknown as RunSummary;
    const brief = { dirName: runId, githubRepo: "acme/app", issue: "4", flow: oldFlowFor({}) };
    vi.spyOn(scheduler, "list").mockReturnValue([]);
    vi.spyOn(scheduler, "briefs").mockReturnValue([brief] as never);
    vi.spyOn(scheduler, "get").mockImplementation((id) => (id === runId ? summary : undefined));
    if (where === "queued") {
      vi.spyOn(scheduler, "isQueued").mockImplementation((id) => id === runId);
      vi.spyOn(scheduler, "queue").mockReturnValue({ pending: [{ runId, source: "ui resume", enqueuedAt: "2026-01-01T00:00:00Z" }], active: [], concurrency: 2 } as never);
    } else {
      vi.spyOn(scheduler, "isActive").mockImplementation((id) => id === runId);
      vi.spyOn(scheduler, "queue").mockReturnValue({ pending: [], active: [{ runId, source: "ui resume" }], concurrency: 2 } as never);
    }
  };

  for (const where of ["queued", "active"] as const) {
    it(`a ${where} resumed run outside the newest runs: no epic hold, no label removed`, async () => {
      outsideWindow("old1", where);
      issue([TRIGGER, WORKING, "epic"]);
      const w = watcher();
      await w.tick();
      expect(hold4(w)?.next.kind).not.toBe("epic");
      expect(w.status.lastActions.join("\n")).not.toContain("is an epic");
      expect(gh.ghLog()).not.toContain("--remove-label");
    });
  }

  it("a bare checklist is not an epic", async () => {
    issue([TRIGGER], "- [ ] #12 docs");
    const w = watcher();
    await w.tick();
    expect(hold4(w)?.next.kind).not.toBe("epic");
    expect(submit).toHaveBeenCalled();
  });
});
