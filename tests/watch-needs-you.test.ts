import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { StatusComments, type StatusView } from "../src/queue/status-comment.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const T = "claude-factory";
const ASKS = "factory:needs-info";
const WAITING = "factory:waiting-approval";

const question = { author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=r2 -->", createdAt: "2026-01-01T00:00:00Z" };
const answer = { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" };

describe("Needs you lists every issue with a waiting label (#653)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let submit: ReturnType<typeof vi.spyOn>;
  let report: ReturnType<typeof vi.spyOn>;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_LABEL_FILTER = "1";
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
    submit = vi.spyOn(scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ["FAKE_GH_FAIL", "FAKE_GH_FAIL_API", "FAKE_GH_COMMENTS", "FAKE_GH_PERMISSION", "FAKE_GH_LABEL_FILTER", "FAKE_GH_LIST_LIMIT", "FAKE_GH_ISSUES"]) delete process.env[k];
    gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}) => {
    if (over.flow === "gone") {
      mkdirSync(join(gh.tmp, ".claude-factory", "flows"), { recursive: true });
      writeFileSync(join(gh.tmp, ".claude-factory", "flows", "gone.yaml"), "name: gone\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    }
    const sc = new StatusComments("acme/app", () => {});
    report = vi.spyOn(sc, "report").mockResolvedValue(undefined as never);
    return new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: {}, flow: oldFlowFor({}), ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {}, statusComments: sc,
    });
  };
  type Spec = [number, string[], string?];
  const issues = (...list: Spec[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, labels, state]) => ({ number, title: `issue ${number}`, state: state ?? "OPEN", labels: labels.map((name) => ({ name })) })));
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const plant = (n: number, status: RunSummary["status"], over: Record<string, unknown> = {}, retired = false) => {
    const runDir = join(gh.tmp, "runs", `r${n}`);
    mkdirSync(runDir, { recursive: true });
    const flow = retired ? "gone" : oldFlowFor({});
    saveRun({
      runId: `r${n}`, flow, flowDef: { name: flow, steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: String(n) }, repo: retired ? "/x" : gh.tmp, status, runDir,
      reason: status === "stopped" ? 'stopped at step "ask_for_info"' : undefined,
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [],
      state: { next: "ask_for_info", steps: {}, visits: {} },
      ...(status === "waiting" ? { waiting: { stepId: "approve", message: "ready", since: "2026-01-01T00:01:00.000Z" } } : {}),
      ...over,
    } as unknown as RunSummary);
  };
  const log = () => gh.ghLog();
  const holdOf = (w: Watcher, n: number) => w.status.holds?.find((h) => h.issue === n);
  const extras = (w: Watcher) => w.tracked.filter((t) => t.extra).map((t) => t.issue);
  const lastQuiet = () => (report.mock.calls.at(-1)![1] as StatusView).quiet;
  const viewReads = (from: number) => log().slice(from).split("\n").filter((l) => /^gh issue view \d+ .*--json comments/.test(l)).map((l) => Number(l.split(" ")[3]));

  it("lists extras from the whole saved list, once each, and changes nothing", async () => {
    issues([1, [T]], [2, [ASKS]], [3, [WAITING]], [4, [ASKS, WAITING]], [5, [ASKS, "skip"]], [6, [ASKS], "CLOSED"], [7, [T, ASKS]]);
    comments(question);
    const w = watcher({ exclude_labels: ["skip"] });
    await w.tick();
    expect(w.tracked.filter((t) => t.extra)).toEqual([2, 3, 4].map((issue) => ({ issue, title: `issue ${issue}`, extra: true })));
    for (const n of [2, 3, 4]) expect(holdOf(w, n)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
    expect(holdOf(w, 2)?.next.runId).toBeUndefined();
    expect(w.status.holds?.filter((h) => h.issue === 4)).toHaveLength(1);
    expect(lastQuiet()).toEqual(expect.arrayContaining([2, 3, 4]));
    expect(log()).not.toMatch(/issue edit [234] /);
    expect(log()).not.toMatch(/comment on #[234]\b/);
    expect(log()).not.toContain("labels=factory%3A");
    expect(JSON.stringify(submit.mock.calls)).not.toMatch(/"issue":"?[234]"?[,}]/);
    expect(w.status.lastError).toBeUndefined();
  });

  it("lists an issue past the trigger list", async () => {
    process.env.FAKE_GH_LIST_LIMIT = "2";
    issues([1, [T]], [2, [T]], [3, [T, ASKS]]);
    const w = watcher();
    await w.tick();
    expect(extras(w)).toEqual([3]);
    expect(holdOf(w, 3)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
  });

  describe("linking a run", () => {
    it("links a run of any flow that waits as the label says", async () => {
      plant(2, "stopped", { flow: "feature", vars: { github_repo: "acme/app", issue: "2", trigger_label: "gone" } });
      plant(3, "waiting");
      issues([2, [ASKS]], [3, [WAITING]]);
      comments(question);
      const w = watcher();
      await w.tick();
      expect(holdOf(w, 2)).toMatchObject({ byLabel: true, next: { kind: "planner_questions", runId: "r2" } });
      expect(holdOf(w, 3)).toMatchObject({ byLabel: true, next: { kind: "approval", runId: "r3" } });
      expect(w.tracked.find((t) => t.issue === 2)?.runId).toBe("r2");
      expect(submit).not.toHaveBeenCalled();
    });
    it("does not link a retired, daily-budget or wait_for_area run", async () => {
      plant(2, "stopped", {}, true);
      // Runs of another flow: the watcher's own flow would park them (no trigger label), which is tested below.
      plant(3, "stopped", { flow: "feature", reason: 'stopped at step "ask_for_info": daily budget' });
      plant(4, "stopped", { flow: "feature", reason: 'stopped at step "wait_for_area"', history: [{ id: "claim_areas", output: "waiting for run x (" }] });
      issues([2, [ASKS]], [3, [ASKS]], [4, [ASKS]]);
      comments(question);
      const w = watcher();
      await w.tick();
      for (const n of [2, 3, 4]) {
        expect(holdOf(w, n)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
        expect(holdOf(w, n)?.next.runId).toBeUndefined();
        expect(w.tracked.find((t) => t.issue === n)?.runId).toBeUndefined();
      }
    });
  });

  it("walks the label query over checks and forgets closed issues within a sweep", async () => {
    issues(...Array.from({ length: 150 }, (_, i): Spec => [i + 1, [WAITING]]));
    const w = watcher();
    w.issueListPages = 1;
    w.waitingListPages = 1;
    await w.tick();
    expect(extras(w)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(log()).toMatch(/labels=factory%3Awaiting-approval&[^\n]*page=1/);
    await w.tick();
    expect(extras(w)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(log()).toMatch(/labels=factory%3Awaiting-approval&[^\n]*page=2/);
    issues(...Array.from({ length: 150 }, (_, i): Spec => [i + 1, [WAITING], i + 1 === 10 ? "CLOSED" : "OPEN"]));
    await w.tick();
    expect(extras(w)).toHaveLength(149);
    expect(extras(w)).not.toContain(10);
    expect(log()).not.toContain("issue view");
    process.env.FAKE_GH_FAIL_API = "list";
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
  });

  describe("question counts", () => {
    const many = () => issues(...Array.from({ length: 25 }, (_, i): Spec => [i + 1, [ASKS]]), [26, [WAITING]]);

    it("reads 20 per check, remembers 10 minutes, never reads waiting-approval", async () => {
      many(); comments(question);
      const w = watcher();
      let at = log().length;
      await w.tick();
      expect(viewReads(at)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(JSON.stringify(holdOf(w, 1)?.next)).toContain("Answer 1 question");
      expect(holdOf(w, 21)?.next.questions).toBeUndefined();
      at = log().length;
      await w.tick();
      expect(viewReads(at)).toEqual([21, 22, 23, 24, 25]);
      expect(JSON.stringify(holdOf(w, 25)?.next)).toContain("Answer 1 question");
      at = log().length;
      await w.tick();
      expect(viewReads(at)).toEqual([]);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
      at = log().length;
      await w.tick();
      expect(viewReads(at)).toHaveLength(20);
      expect(log()).not.toMatch(/issue view 26 /);
    });
    it("lists a failed read without a count and without an error, and moves on", async () => {
      issues(...Array.from({ length: 25 }, (_, i): Spec => [i + 1, [ASKS]]));
      comments(question);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      expect(holdOf(w, 1)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
      expect(holdOf(w, 1)?.next.questions).toBeUndefined();
      expect(w.status.lastError).toBeUndefined();
      delete process.env.FAKE_GH_FAIL;
      const at = log().length;
      await w.tick();
      expect(viewReads(at)).toEqual([21, 22, 23, 24, 25, ...Array.from({ length: 15 }, (_, i) => i + 1)]);
    });
    it("keeps an answered extra listed, without a count", async () => {
      issues([1, [ASKS]]);
      comments(question, answer);
      const w = watcher();
      await w.tick();
      expect(holdOf(w, 1)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
      expect(holdOf(w, 1)?.next.questions).toBeUndefined();
    });
  });

  it("does not list a parked run without the trigger label, but does with it", async () => {
    process.env.FAKE_GH_LIST_LIMIT = "1";
    plant(109, "stopped", { parkedAt: "2026-01-02T00:00:00.000Z" });
    plant(110, "stopped", { parkedAt: "2026-01-02T00:00:00.000Z" });
    issues([1, [T]], [109, [ASKS]], [110, [T, ASKS]]);
    comments(question);
    const w = watcher();
    await w.tick();
    expect(extras(w)).toEqual([110]);
    expect(holdOf(w, 110)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
    expect(holdOf(w, 110)?.next.runId).toBeUndefined();
    expect(w.tracked.find((t) => t.issue === 110)?.runId).toBeUndefined();
    expect(holdOf(w, 109)).toBeUndefined();
  });
});
