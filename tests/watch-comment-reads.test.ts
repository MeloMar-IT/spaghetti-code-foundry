import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { mergeDependsOn } from "../src/queue/deps.js";
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
    for (const k of ["FAKE_GH_LABEL_FILTER", "FAKE_GH_ISSUES", "FAKE_GH_FAIL_API", "FAKE_GH_HOLD", "FAKE_GH_HOLD_ON"]) delete process.env[k];
    gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}) => {
    const sc = new StatusComments("acme/app", () => {});
    report = vi.spyOn(sc, "report").mockResolvedValue(undefined as never);
    return new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: {}, flow: oldFlowFor({}), ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {}, statusComments: sc,
    });
  };
  const issues = (...list: [number, string[], string?, string?][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, labels, body, state]) => ({ number, title: `issue ${number}`, state: state ?? "OPEN", labels: labels.map((name) => ({ name })), body })));
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const plant = (status: "stopped" | "waiting", over: Record<string, unknown> = {}) => {
    const runDir = join(gh.tmp, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    saveRun({
      runId: "r1", flow: oldFlowFor({}), flowDef: { name: oldFlowFor({}), steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: gh.tmp, status, runDir,
      reason: status === "stopped" ? 'stopped at step "ask_for_info"' : undefined,
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [],
      state: { next: "ask_for_info", steps: {}, visits: {} },
      ...(status === "waiting" ? { waiting: { stepId: "approve", message: "ready", since: "2026-01-01T00:01:00.000Z" } } : {}),
      ...over,
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

  describe("a resume waits for its dependencies (#674)", () => {
    const DEP = "### Depends on\n#7\n";
    const resumed = () => submit.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "resume").length;
    const asked = (dep: [number, string[], string?, string?] = [7, []]) => { issues([4, [TRIGGER, ASKS], DEP], dep); comments(question, answer); };
    beforeEach(() => { process.env.FAKE_GH_LABEL_FILTER = "1"; });

    it("answered: held, label to working, no slot used; resumes when the dependency is closed", async () => {
      plant("stopped");
      issues([4, [TRIGGER, ASKS], DEP], [5, [TRIGGER]], [7, []]); comments(question, answer);
      const w = watcher({ max_per_tick: 1 });
      await w.tick();
      expect(resumed()).toBe(0);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }), expect.anything());
      expect(hold4(w)).toMatchObject({ next: { kind: "dependency", runId: "r1" } });
      expect(w.status.holds?.find((h) => h.issue === 5)).toBeUndefined();
      expect(log()).toContain(`--add-label ${WORKING}`);
      issues([4, [TRIGGER, WORKING], DEP], [7, [], undefined, "CLOSED"]);
      await w.tick();
      expect(resumed()).toBe(1);
      expect(w.status.lastActions.join("\n")).toContain("#4 its dependencies are done → resuming run r1");
    });

    it("auto_defaults with a run: no /defaults, the needs-info label stays", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS], DEP], [7, []]); comments(question);
      const w = watcher({ auto_defaults: true });
      await w.tick();
      expect(log()).not.toContain("comment on #4");
      expect(submit).not.toHaveBeenCalled();
      expect(hold4(w)?.next.kind).toBe("dependency");
      expect(log()).not.toContain(`--remove-label ${ASKS}`);
    });

    it("auto_defaults with no run: no /defaults, no start, the label stays", async () => {
      issues([4, [TRIGGER, ASKS], DEP], [7, []]); comments(question);
      const w = watcher({ auto_defaults: true });
      await w.tick();
      expect(log()).not.toContain("comment on #4");
      expect(submit).not.toHaveBeenCalled();
      expect(hold4(w)).toMatchObject({ next: { kind: "dependency" } });
      expect(hold4(w)?.next.runId).toBeUndefined();
      expect(log()).not.toContain(`--remove-label ${ASKS}`);
    });

    it("without auto_defaults the questions need a person: the run's own hold", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS], DEP], [7, []]); comments(question);
      const w = watcher({ auto_defaults: false });
      await w.tick();
      expect(hold4(w)?.next.kind).not.toBe("dependency");
      expect(submit).not.toHaveBeenCalled();
    });

    it("usage limit with the working label: held, not resumed", async () => {
      plant("stopped", { reason: "usage limit reached", finishedAt: "2026-01-01T00:01:00.000Z" });
      issues([4, [TRIGGER, WORKING], DEP], [7, []]);
      const w = watcher();
      await w.tick();
      expect(submit).not.toHaveBeenCalled();
      expect(hold4(w)?.next.kind).toBe("dependency");
    });

    it("approved with the waiting label: held, label to working", async () => {
      plant("waiting"); issues([4, [TRIGGER, WAITING], DEP], [7, []]); comments(request, approve);
      const w = watcher();
      await w.tick();
      expect(submit).not.toHaveBeenCalled();
      expect(hold4(w)?.next.kind).toBe("dependency");
      expect(log()).toContain(`--add-label ${WORKING}`);
    });

    it("the done label counts as done only with a develop branch", async () => {
      plant("stopped"); asked([7, ["factory:done"]]);
      await watcher({ vars: { develop_branch: "develop" } }).tick();
      expect(resumed()).toBe(1);
      submit.mockClear();
      const w = watcher();
      await w.tick();
      expect(resumed()).toBe(0);
      expect(hold4(w)?.next.kind).toBe("dependency");
    });

    it("wait_for_dependencies off: resumes at once", async () => {
      plant("stopped"); asked();
      await watcher({ wait_for_dependencies: false }).tick();
      expect(resumed()).toBe(1);
    });

    describe("a check that is given up while it reads the dependencies", () => {
      const given = async (labels: string[]) => {
        const hold = join(gh.tmp, "hold");
        writeFileSync(hold, "");
        process.env.FAKE_GH_HOLD = hold;
        process.env.FAKE_GH_HOLD_ON = "--state all";
        process.env.FAKE_GH_FAIL_API = "list";
        plant("stopped");
        issues([4, labels, DEP], [7, [], undefined, "CLOSED"]); comments(question, answer);
        const w = watcher();
        w.checkTimeoutMs = 4000;
        await w.tick();
        expect(w.status.lastError).toMatch(/given up/);
        rmSync(hold);
        await vi.waitFor(() => expect(log()).toContain("--state all"), { timeout: 10_000 });
        await vi.waitFor(() => expect(existsSync(hold)).toBe(false));
        await new Promise((r) => setTimeout(r, 400));
        expect(submit).not.toHaveBeenCalled();
        expect(log()).not.toContain("issue edit 4");
        expect(log()).not.toContain("comment on #4");
      };
      it("working label, answered: nothing is resumed", async () => { await given([TRIGGER, WORKING]); });
      it("needs-info label, answered: nothing is relabelled or resumed", async () => { await given([TRIGGER, ASKS]); });
    });
  });

  describe("Foundry-marked dependencies (#675)", () => {
    const MARKED = mergeDependsOn("Text", [7], "waits for the API");
    const resumed = () => submit.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "resume").length;
    const limit = () => plant("stopped", { reason: "usage limit reached", finishedAt: "2026-01-01T00:01:00.000Z" });
    beforeEach(() => { process.env.FAKE_GH_LABEL_FILTER = "1"; });

    it.each([true, false])("wait_for_dependencies %s: a marked open dependency holds the run", async (on) => {
      limit(); issues([4, [TRIGGER, WORKING], MARKED], [7, []]);
      const w = watcher({ wait_for_dependencies: on });
      await w.tick();
      expect(submit).not.toHaveBeenCalled();
      expect(hold4(w)).toMatchObject({ next: { kind: "dependency", runId: "r1" } });
      expect(log()).not.toContain("issue edit 4");
      expect(log()).not.toContain("comment on #4");
    });

    it("setting off: resumes when the marked dependency closes", async () => {
      limit(); issues([4, [TRIGGER, WORKING], MARKED], [7, []]);
      const w = watcher({ wait_for_dependencies: false });
      await w.tick();
      expect(resumed()).toBe(0);
      issues([4, [TRIGGER, WORKING], MARKED], [7, [], undefined, "CLOSED"]);
      await w.tick();
      expect(resumed()).toBe(1);
      expect(w.status.lastActions.join("\n")).toContain("#4 its dependencies are done → resuming run r1");
    });

    it("setting off: a new issue with a marked open dependency is not started", async () => {
      issues([4, [TRIGGER], MARKED], [7, []]);
      const w = watcher({ wait_for_dependencies: false });
      await w.tick();
      expect(submit).not.toHaveBeenCalled();
      expect(hold4(w)?.next.kind).toBe("dependency");
    });

    it("setting off: a person's unmarked dependency does not hold", async () => {
      issues([4, [TRIGGER], "### Depends on\n#7\n"], [7, []]);
      const w = watcher({ wait_for_dependencies: false });
      await w.tick();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "run" }), expect.anything());
      expect(hold4(w)?.next.kind).not.toBe("dependency");
    });

    it("gitflow, setting off: the done label counts", async () => {
      limit(); issues([4, [TRIGGER, WORKING], MARKED], [7, ["factory:done"]]);
      await watcher({ wait_for_dependencies: false, vars: { develop_branch: "develop" } }).tick();
      expect(resumed()).toBe(1);
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
