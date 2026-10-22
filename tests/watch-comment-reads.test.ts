import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { StatusComments, type StatusView } from "../src/queue/status-comment.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const TRIGGER = "claude-factory";
const ASKS = "factory:needs-info";
const WORKING = "factory:working";
const WAITING = "factory:waiting-approval";

const question = { author: { login: "bot" }, body: "questions <!-- claude-factory run=r1 -->", createdAt: "2026-01-01T00:00:00Z" };
const request = { author: { login: "bot" }, body: "ready <!-- claude-factory run=r1 approval -->", createdAt: "2026-01-01T00:00:00Z" };
const answer = { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" };
const approve = { author: { login: "marcel" }, body: "/approve", createdAt: "2026-01-01T01:00:00Z" };

describe("a comment read that does not work changes nothing", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let submit: ReturnType<typeof vi.spyOn>;
  let report: ReturnType<typeof vi.spyOn>;
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
    delete process.env.FAKE_GH_FAIL;
    delete process.env.FAKE_GH_COMMENTS;
    delete process.env.FAKE_GH_PERMISSION;
    gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}) => {
    const sc = new StatusComments("acme/app", () => {});
    report = vi.spyOn(sc, "report").mockResolvedValue(undefined as never);
    return new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: {}, flow: oldFlowFor({}), ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {}, statusComments: sc,
    });
  };
  const issues = (...list: [number, string[], string?][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, labels, body]) => ({ number, title: `issue ${number}`, state: "OPEN", labels: labels.map((name) => ({ name })), body })));
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const plant = (status: "stopped" | "waiting") => {
    const runDir = join(gh.tmp, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    saveRun({
      runId: "r1", flow: oldFlowFor({}), flowDef: { name: oldFlowFor({}), steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: gh.tmp, status, runDir,
      reason: status === "stopped" ? 'stopped at step "ask_for_info"' : undefined,
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [],
      state: { next: "ask_for_info", steps: {}, visits: {} },
      ...(status === "waiting" ? { waiting: { stepId: "approve", message: "ready", since: "2026-01-01T00:01:00.000Z" } } : {}),
    } as unknown as RunSummary);
  };
  const log = () => gh.ghLog();
  const hold4 = (w: Watcher) => w.status.holds?.find((h) => h.issue === 4);
  const lastQuiet = () => (report.mock.calls.at(-1)![1] as StatusView).quiet;

  /** The check with a failed read: nothing changes. */
  const expectUntouched = (w: Watcher) => {
    expect(w.status.lastError).toBeUndefined();
    expect(log()).not.toContain("issue edit 4");
    expect(log()).not.toContain("comment on #4");
    expect(submit).not.toHaveBeenCalled();
    expect(lastQuiet()).toContain(4);
  };

  describe("(a) needs-info, no run, answered", () => {
    const setup = () => { issues([4, [TRIGGER, ASKS]]); comments(question, answer); };
    it("control: a new run starts", async () => {
      setup();
      const w = watcher();
      await w.tick();
      expect(submit).toHaveBeenCalledTimes(1);
      expect(log()).toContain(`--add-label ${WORKING}`);
      expect(lastQuiet()).toEqual([]);
      expect(hold4(w)?.byLabel).toBeUndefined();
    });
    it("failed read: a questions hold from the label, no count", async () => {
      setup();
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
      expect(hold4(w)?.next.questions).toBeUndefined();
      expect(hold4(w)?.since).toBeUndefined();
    });
  });

  describe("(b) the one_at_a_time lock branch", () => {
    const locked = () => watcher({ one_at_a_time: true });
    beforeEach(() => { vi.spyOn(scheduler, "isLocked").mockReturnValue(true); });
    it("stopped run, answered: control goes to working", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS]]); comments(question, answer);
      const w = locked();
      await w.tick();
      expect(log()).toContain(`--add-label ${WORKING}`);
      expect(hold4(w)?.next.kind).toBe("one_at_a_time");
    });
    it("stopped run, failed read: the run's own hold", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS]]); comments(question, answer);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = locked();
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { runId: "r1" } });
      expect(hold4(w)?.next.questions).toBeUndefined();
    });
    it("waiting run, approved: control goes to working", async () => {
      plant("waiting"); issues([4, [TRIGGER, WAITING]]); comments(request, approve);
      const w = locked();
      await w.tick();
      expect(log()).toContain(`--add-label ${WORKING}`);
    });
    it("waiting run, failed read: the approval hold", async () => {
      plant("waiting"); issues([4, [TRIGGER, WAITING]]); comments(request, approve);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = locked();
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "approval", runId: "r1" } });
    });
  });

  describe("(c) the label says working", () => {
    it("stopped run, answered: control resumes", async () => {
      plant("stopped"); issues([4, [TRIGGER, WORKING]]); comments(question, answer);
      await watcher().tick();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
    });
    it("stopped run, failed read: no hold, label stays", async () => {
      plant("stopped"); issues([4, [TRIGGER, WORKING]]); comments(question, answer);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toBeUndefined();
    });
    it("waiting run, approved: control resumes with a decision", async () => {
      plant("waiting"); issues([4, [TRIGGER, WORKING]]); comments(request, approve);
      await watcher().tick();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume", decision: expect.objectContaining({ approved: true }) }), expect.anything());
    });
    it("waiting run, failed read: no hold, label stays", async () => {
      plant("waiting"); issues([4, [TRIGGER, WORKING]]); comments(request, approve);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toBeUndefined();
    });
  });

  describe("(d) a stopped or waiting run with its own label", () => {
    it("auto_defaults: control writes /defaults and resumes", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS]]); comments(question);
      await watcher({ auto_defaults: true }).tick();
      expect(log()).toContain("comment on #4");
      expect(submit).toHaveBeenCalledTimes(1);
    });
    it("auto_defaults: failed read writes no /defaults and resumes nothing", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS]]); comments(question);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher({ auto_defaults: true });
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { runId: "r1" } });
      expect(hold4(w)?.next.questions).toBeUndefined();
    });
    it("waiting-approval: control resumes", async () => {
      plant("waiting"); issues([4, [TRIGGER, WAITING]]); comments(request, approve);
      await watcher().tick();
      expect(submit).toHaveBeenCalledTimes(1);
    });
    it("waiting-approval: failed read gives the approval hold", async () => {
      plant("waiting"); issues([4, [TRIGGER, WAITING]]); comments(request, approve);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      expectUntouched(w);
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "approval", runId: "r1" } });
    });
  });

  describe("a dependency", () => {
    const setup = () => {
      issues([4, [TRIGGER, ASKS], "Depends on #7"], [7, [TRIGGER]]);
      comments(question, answer);
    };
    it("control: a dependency hold, and the needs-info label goes", async () => {
      setup();
      const w = watcher();
      await w.tick();
      expect(hold4(w)?.next.kind).toBe("dependency");
      expect(log()).toContain(`--remove-label ${ASKS}`);
    });
    it("failed read: a questions hold, and the label stays", async () => {
      setup();
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      expect(hold4(w)?.next.kind).toBe("questions");
      expect(log()).not.toMatch(/issue edit 4 .*--remove-label/);
    });
  });

  describe("time limits", () => {
    const reads = (from = 0) => log().split("\n").slice(from).filter((l) => /issue view \d+ .*comments,labels/.test(l)).map((l) => Number(/issue view (\d+)/.exec(l)![1]));
    const lines = () => log().split("\n").length;

    it("one timeout: listed from the label, and not read again in the next check", async () => {
      issues([4, [TRIGGER, ASKS]]); comments(question, answer);
      const release = gh.hold("--json comments,labels");
      try {
        const w = watcher();
        w.commentReadMs = 200;
        await w.tick();
        expect(w.status.lastError).toBeUndefined();
        expect(submit).not.toHaveBeenCalled();
        expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
        expect(reads()).toEqual([4]);
        const at = lines();
        await w.tick();
        expect(reads(at)).toEqual([]);
        expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
        expect(submit).not.toHaveBeenCalled();
      } finally {
        release();
      }
    });

    it("many timeouts: the budget ends the reads, the next check reads the rest", async () => {
      issues(...[4, 5, 6, 7, 8].map((n): [number, string[]] => [n, [TRIGGER, ASKS]]));
      comments(question, answer);
      const release = gh.hold("--json comments,labels");
      try {
        const w = watcher();
        w.commentReadMs = 150;
        w.commentBudgetMs = 400;
        await w.tick();
        expect(w.status.lastError).toBeUndefined();
        expect(reads().sort()).toEqual([4, 5, 6]);
        expect(w.status.holds?.filter((h) => h.byLabel && h.next.kind === "questions").map((h) => h.issue).sort()).toEqual([4, 5, 6, 7, 8]);
        expect([...(lastQuiet() ?? [])].sort()).toEqual([4, 5, 6, 7, 8]);
        const at = lines();
        await w.tick();
        expect(reads(at).sort()).toEqual([7, 8]);
        expect(submit).not.toHaveBeenCalled();
      } finally {
        release();
      }
    });
  });
});
