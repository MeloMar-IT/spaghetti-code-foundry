import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const question = { author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=r1 -->", createdAt: "2026-01-01T00:00:00Z" };
const preQuestion = { author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=pre1 questions -->", createdAt: "2026-01-01T00:00:00Z" };
const said = (body: string, login = "marcel") => ({ author: { login }, body, createdAt: "2026-01-01T01:00:00Z" });

describe("parking an issue with /park or a do-not-build answer", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let submit: ReturnType<typeof vi.spyOn>;
  let logged: string[];
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    logged = [];
    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_LABEL_FILTER = "1";
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
    submit = vi.spyOn(scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ["FAKE_GH_FAIL", "FAKE_GH_COMMENTS", "FAKE_GH_PERMISSION", "FAKE_GH_READONLY", "FAKE_GH_LABEL_FILTER", "FAKE_GH_HOLD", "FAKE_GH_HOLD_ON"]) delete process.env[k];
    gh.restore();
  });

  /** `real` keeps the real status reporter (its comment would show on GitHub); otherwise nothing is reported. */
  const watcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: {}, flow: oldFlowFor({}), status_comment: false, ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: (m: string) => { logged.push(m); },
    });
  const issues = (labels: string[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "issue 4", state: "OPEN", labels: labels.map((name) => ({ name })) }]);
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const plant = (status: "NOT_CODE" | "NEEDS_INFO", over: Record<string, unknown> = {}) => {
    const runDir = join(gh.tmp, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    saveRun({
      runId: "r1", flow: oldFlowFor({}), flowDef: { name: oldFlowFor({}), steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: gh.tmp, status: "stopped", runDir,
      reason: 'stopped at step "send_back"', startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0,
      history: [{ id: "plan", type: "claude", visit: 1, ok: true, output: `Why.\nPLAN_STATUS: ${status}` }],
      state: { next: "send_back", steps: {}, visits: {} }, ...over,
    } as unknown as RunSummary);
  };
  const log = () => gh.ghLog();
  const parkedAt = () => scheduler.get("r1")?.parkedAt;
  const acts = (w: Watcher) => w.status.lastActions.join("\n");
  /** The run is parked and the issue lost its trigger and status labels. */
  const parked = (run: boolean) => {
    if (run) expect(parkedAt()).toBeTruthy();
    const edit = log().split("\n").filter((l) => l.includes("issue edit 4 "));
    expect(edit.at(-1)).toContain(`--remove-label ${TRIGGER}`);
    expect(edit.at(-1)).toContain(`--remove-label ${ASKS}`);
    expect(edit.at(-1)).not.toContain("--add-label");
    expect(log()).toContain(run ? "<!-- claude-factory run=r1 parked -->" : "<!-- claude-factory parked -->");
    expect(submit).not.toHaveBeenCalled();
  };
  const untouched = () => {
    expect(log()).not.toContain("issue edit 4");
    expect(log()).not.toContain("comment on #4");
    expect(submit).not.toHaveBeenCalled();
  };

  it("parks a NOT_CODE stop answered with the phrase", async () => {
    plant("NOT_CODE"); issues([TRIGGER, ASKS]); comments(question, said("Keep it open but out of the build queue."));
    const w = watcher();
    await w.tick();
    parked(true);
    expect(w.status.holds?.find((h) => h.issue === 4)).toBeUndefined();
    expect(acts(w)).toContain("#4 parked by @marcel → run r1 is parked");
    const writes = () => log().split("\n").filter((l) => /issue (edit|comment)/.test(l)).length;
    const before = writes();
    issues([]);
    await w.tick();
    expect(writes()).toBe(before);
    expect(submit).not.toHaveBeenCalled();
  });

  it("parks on /park among the up-front questions (no run), also with auto_defaults", async () => {
    issues([TRIGGER, ASKS]); comments(preQuestion, said("/park"));
    const w = watcher({ auto_defaults: true });
    await w.tick();
    parked(false);
    expect(log()).not.toContain("auto-defaults");
    expect(w.tracked.find((t) => t.issue === 4)).toBeUndefined();
  });

  it("does not park for a read-only login: the reply counts as an answer", async () => {
    process.env.FAKE_GH_READONLY = "stranger";
    plant("NOT_CODE"); issues([TRIGGER, ASKS]); comments(question, said("/park", "stranger"));
    const w = watcher();
    await w.tick();
    expect(acts(w)).toContain("ignored /park from @stranger (no write access)");
    expect(parkedAt()).toBeUndefined();
    expect(log()).toContain(`--add-label ${WORKING}`);
    expect(log()).not.toContain(`--remove-label ${TRIGGER}`);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
  });

  it("resumes a NEEDS_INFO stop answered with 'keep it open', and parks it on /park", async () => {
    plant("NEEDS_INFO"); issues([TRIGGER, ASKS]); comments(question, said("Keep it open"));
    await watcher().tick();
    expect(parkedAt()).toBeUndefined();
    expect(log()).not.toContain("parked -->");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
    submit.mockClear();
    comments(question, said("/park"));
    issues([TRIGGER, ASKS]);
    await watcher().tick();
    expect(parkedAt()).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("auto_defaults does not answer a NOT_CODE stop, but still answers NEEDS_INFO", async () => {
    plant("NOT_CODE"); issues([TRIGGER, ASKS]); comments(question);
    const w = watcher({ auto_defaults: true });
    await w.tick();
    expect(log()).not.toContain("comment on #4");
    expect(submit).not.toHaveBeenCalled();
    expect(w.status.holds?.find((h) => h.issue === 4)?.next.kind).toBe("planner_questions");
    plant("NEEDS_INFO");
    await w.tick();
    expect(log()).toContain("auto-defaults");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
  });

  describe("under a held lock", () => {
    const lock = () => {
      vi.spyOn(scheduler, "isLocked").mockReturnValue(true);
      vi.spyOn(scheduler, "queue").mockReturnValue({ pending: [], active: [{ runId: "other", lockKey: "acme/app#watcher:w" }] } as never);
    };
    for (const labels of [[TRIGGER, ASKS], [TRIGGER, WORKING]]) {
      it(`parks a NOT_CODE stop right away, labels ${labels.slice(1).join(", ")}`, async () => {
        lock();
        plant("NOT_CODE"); issues(labels); comments(question, said("/park"));
        await watcher({ one_at_a_time: true }).tick();
        expect(parkedAt()).toBeTruthy();
        expect(log()).toContain("run=r1 parked -->");
        expect(log()).toContain(`--remove-label ${TRIGGER}`);
        expect(submit).not.toHaveBeenCalled();
      });
    }
  });

  it("parks in the branch where the working label is already on (answered meanwhile)", async () => {
    plant("NOT_CODE"); issues([TRIGGER, WORKING]); comments(question, said("/park"));
    await watcher().tick();
    expect(parkedAt()).toBeTruthy();
    expect(log()).toContain("run=r1 parked -->");
    expect(submit).not.toHaveBeenCalled();
  });

  describe("when parking cannot be done", () => {
    it("a resume at the same time (setParked refuses): nothing changes on GitHub, also not by the status reporter", async () => {
      vi.spyOn(scheduler, "setParked").mockReturnValue(false);
      plant("NOT_CODE"); issues([TRIGGER, ASKS]); comments(question, said("/park"));
      const w = watcher({ status_comment: true }); // the real status reporter
      await w.tick();
      untouched();
      expect(log()).not.toContain("claude-factory status");
      expect(acts(w)).toContain("not done");
      expect(parkedAt()).toBeUndefined();
    });

    it("a queued job without a run file refuses an up-front park", async () => {
      vi.spyOn(scheduler, "queue").mockReturnValue({ pending: [{ runId: "q1", githubRepo: "acme/app", issue: "4", source: "watcher w issue #4" }], active: [] } as never);
      issues([TRIGGER, ASKS]); comments(preQuestion, said("/park"));
      const w = watcher();
      await w.tick();
      expect(log()).not.toContain("issue edit 4 ");
      expect(log()).not.toContain("parked -->");
      expect(acts(w)).toContain("not done");
    });

    it("a job queued during the permission check refuses the park", async () => {
      const hold = join(gh.tmp, "hold");
      writeFileSync(hold, "");
      process.env.FAKE_GH_HOLD = hold;
      process.env.FAKE_GH_HOLD_ON = "permission";
      let queued = false;
      vi.spyOn(scheduler, "queue").mockImplementation(() => ({ pending: queued ? [{ runId: "q1", githubRepo: "acme/app", issue: "4", source: "x" }] : [], active: [] }) as never);
      issues([TRIGGER, ASKS]); comments(preQuestion, said("/park"));
      const w = watcher();
      const t = w.tick();
      await vi.waitFor(() => expect(log()).toContain("permission"));
      queued = true;
      rmSync(hold);
      await t;
      expect(log()).not.toContain("issue edit 4 ");
      expect(log()).not.toContain("parked -->");
      expect(acts(w)).toContain("not done");
    });

    it("a check that was given up during the permission read changes nothing", async () => {
      const hold = join(gh.tmp, "hold");
      writeFileSync(hold, "");
      process.env.FAKE_GH_HOLD = hold;
      process.env.FAKE_GH_HOLD_ON = "permission";
      const setParked = vi.spyOn(scheduler, "setParked");
      plant("NOT_CODE"); issues([TRIGGER, ASKS]); comments(question, said("/park"));
      const w = watcher();
      // the permission read comes after several gh calls: on a busy machine they need more than 300 ms, and the check must reach the held call
      w.checkTimeoutMs = 3000;
      await w.tick();
      expect(w.status.lastError).toMatch(/given up/);
      rmSync(hold);
      await vi.waitFor(() => expect(logged.join("\n")).toContain("#4 not parked"), { timeout: 20_000 });
      expect(setParked).not.toHaveBeenCalled();
      untouched();
      expect(parkedAt()).toBeUndefined();
    });

    it("a check that was given up during the comment read does nothing, also without answers (no /defaults)", async () => {
      const hold = join(gh.tmp, "hold");
      writeFileSync(hold, "");
      process.env.FAKE_GH_HOLD = hold;
      process.env.FAKE_GH_HOLD_ON = "comments";
      plant("NEEDS_INFO"); issues([TRIGGER, ASKS]); comments(question);
      const w = watcher({ auto_defaults: true });
      w.checkTimeoutMs = 300;
      await w.tick();
      expect(w.status.lastError).toMatch(/given up/);
      rmSync(hold);
      await vi.waitFor(() => expect(existsSync(hold)).toBe(false));
      await new Promise((r) => setTimeout(r, 400));
      expect(log()).not.toContain("auto-defaults");
      untouched();
    });

    it("labels that cannot be removed: the park is taken back, nothing starts, and it works at a later check or after a restart", async () => {
      plant("NOT_CODE"); issues([TRIGGER, ASKS]); comments(question, said("/park"));
      process.env.FAKE_GH_FAIL = "issue edit";
      const w = watcher();
      await w.tick();
      expect(parkedAt()).toBeUndefined();
      expect(acts(w)).toContain("labels could not be removed");
      await w.tick();
      expect(parkedAt()).toBeUndefined();
      expect(log()).not.toContain("comment on #4");
      expect(submit).not.toHaveBeenCalled();
      delete process.env.FAKE_GH_FAIL;
      await watcher().tick();
      parked(true);
    });
  });

  it("with custom status labels: an answer resumes, a failed run gets the custom failed label, /park removes the custom labels", async () => {
    const status_labels = { needs_info: "Factory_needs_info", working: "Factory_working", failed: "Factory_failed" };
    plant("NOT_CODE"); issues([TRIGGER, "Factory_needs_info"]); comments(question, said("Use Postgres"));
    const wait = vi.mocked(scheduler.wait).mockResolvedValue({ runId: "r1", status: "failed", reason: "boom", history: [], totalCostUsd: 0 } as unknown as RunSummary);
    await watcher({ status_labels }).tick();
    expect(log()).toContain("--add-label Factory_working");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
    await vi.waitFor(() => expect(log()).toContain("--add-label Factory_failed"));
    expect(wait).toHaveBeenCalled();

    submit.mockClear();
    comments(question, said("/park"));
    issues([TRIGGER, "Factory_needs_info"]);
    await watcher({ status_labels }).tick();
    const edits = log().split("\n").filter((l) => l.includes("issue edit 4 "));
    const last = edits.at(-1)!;
    expect(last).toContain(`--remove-label ${TRIGGER}`);
    expect(last).toContain("--remove-label Factory_needs_info");
    expect(last).not.toContain("--remove-label factory:working");
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("a UI resume of a parked run", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_LABEL_FILTER = "1";
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
  });
  afterEach(() => { gh.restore(); for (const k of ["FAKE_PLAN", "FAKE_GH_PERMISSION", "FAKE_GH_COMMENTS", "FAKE_GH_LABEL_FILTER"]) delete process.env[k]; });

  it("clears the parked mark and runs; the watcher neither relabels the issue nor starts a new run", async () => {
    const w = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, flow: oldFlowFor({}) }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
    });
    const issue4 = (labels: string[]) => { process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "issue 4", state: "OPEN", labels: labels.map((name) => ({ name })) }]); };
    const runs = () => scheduler.list().filter((s) => s.vars.issue === "4");
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issue4([TRIGGER]);
    await w.tick();
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
    const run = runs()[0]!;
    expect(run.status).toBe("stopped");

    issue4([TRIGGER, ASKS]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "Which DB? <!-- claude-factory run=" + run.runId + " -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: "/park", createdAt: "2026-01-01T01:00:00Z" },
    ] });
    await w.tick();
    expect(scheduler.get(run.runId)?.parkedAt).toBeTruthy();

    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    const id = scheduler.submit({ kind: "resume", runId: run.runId } as never, { source: "ui resume" } as never);
    expect(id).toBe(run.runId);
    expect(scheduler.setParked(run.runId)).toBe(false);
    await scheduler.wait(run.runId);
    await scheduler.idle();
    const after = scheduler.get(run.runId)!;
    expect(after.parkedAt).toBeUndefined();
    expect(after.resumes).toBe(1);

    issue4([]);
    const at = gh.ghLog().length;
    await w.tick();
    expect(gh.ghLog().slice(at)).not.toContain("issue edit 4");
    expect(runs()).toHaveLength(1);
  });
});
