import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { explainError } from "../src/errors.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { StatusComments, type StatusView } from "../src/queue/status-comment.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

const TRIGGER = "claude-factory";
const ASKS = "factory:needs-info";
const WORKING = "factory:working";
const WAITING = "factory:waiting-approval";
const DONE = "factory:done";
const FAILED = "factory:failed";

const question = { author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=r1 -->", createdAt: "2026-01-01T00:00:00Z" };
const request = { author: { login: "bot" }, body: "ready <!-- claude-factory run=r1 approval -->", createdAt: "2026-01-01T00:00:00Z" };
const answer = { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" };
const approve = { author: { login: "marcel" }, body: "/approve", createdAt: "2026-01-01T01:00:00Z" };

describe("a waiting label decides for the issue", () => {
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

  /** `flow: "gone"` follows runs of a flow that the planted runs' repository does not have (retired); the watcher's own repository has it. */
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
  const issues = (...list: [number, string[]][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, labels]) => ({ number, title: `issue ${number}`, state: "OPEN", labels: labels.map((name) => ({ name })) })));
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  /** A run of issue 4; `retired` points it at a flow that exists nowhere. */
  const plant = (status: RunSummary["status"], over: Record<string, unknown> = {}, retired = false) => {
    const runDir = join(gh.tmp, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    const flow = retired ? "gone" : oldFlowFor({});
    saveRun({
      runId: "r1", flow, flowDef: { name: flow, steps: [] }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: retired ? "/x" : gh.tmp, status, runDir,
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
  const labelHold = (w: Watcher) => {
    expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "questions" } });
    expect(hold4(w)?.next.runId).toBeUndefined();
  };
  /** Nothing changed on GitHub or in the queue. */
  const untouched = () => {
    expect(log()).not.toContain("issue edit 4");
    expect(log()).not.toContain("comment on #4");
    expect(submit).not.toHaveBeenCalled();
    expect(lastQuiet()).toContain(4);
  };

  describe("mixed labels, no run", () => {
    for (const labels of [[TRIGGER, "factory:done", ASKS], [TRIGGER, ASKS, "factory:done"]]) {
      it(`${labels.slice(1).join(", ")}: answer 1 question, no /defaults`, async () => {
        issues([4, labels]); comments(question);
        const w = watcher({ auto_defaults: true });
        await w.tick();
        labelHold(w);
        expect(JSON.stringify(hold4(w)?.next)).toContain("Answer 1 question");
        untouched();
      });
    }
    for (const status of [WORKING, FAILED]) {
      it(`${status} next to needs-info gives a questions hold`, async () => {
        issues([4, [TRIGGER, status, ASKS]]); comments(question);
        const w = watcher();
        await w.tick();
        labelHold(w);
        untouched();
      });
    }
    it("a failed read still lists it, without a count", async () => {
      issues([4, [TRIGGER, "factory:done", ASKS]]); comments(question);
      process.env.FAKE_GH_FAIL = "issue view";
      const w = watcher();
      await w.tick();
      labelHold(w);
      expect(hold4(w)?.next.questions).toBeUndefined();
      untouched();
    });
  });

  describe("mixed labels, with a run", () => {
    it("[T, needs-info, failed] with an asking run and an answer: the run's hold, nothing submitted", async () => {
      plant("stopped"); issues([4, [TRIGGER, ASKS, FAILED]]); comments(question, answer);
      const w = watcher();
      await w.tick();
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "planner_questions", runId: "r1" } });
      untouched();
    });
    it("a waiting run with /approve next to done: the approval hold, no resume", async () => {
      plant("waiting"); issues([4, [TRIGGER, "factory:done", WAITING]]); comments(request, approve);
      const w = watcher();
      await w.tick();
      expect(hold4(w)).toMatchObject({ byLabel: true, next: { kind: "approval", runId: "r1" } });
      untouched();
    });
    for (const labels of [[TRIGGER, FAILED, ASKS], [TRIGGER, ASKS, FAILED], [TRIGGER, WORKING, ASKS], [TRIGGER, ASKS, WORKING]]) {
      it(`an active run, ${labels.slice(1).join(", ")}: the label goes to working`, async () => {
        plant("running"); issues([4, labels]); comments(question);
        vi.spyOn(scheduler, "isActive").mockReturnValue(true);
        const w = watcher();
        await w.tick();
        expect(log()).toContain(`issue edit 4 `);
        expect(log()).toContain(`--add-label ${WORKING}`);
        expect(hold4(w)).toBeUndefined();
      });
    }
    for (const labels of [[TRIGGER, DONE, ASKS], [TRIGGER, ASKS, DONE], [TRIGGER, WORKING, ASKS], [TRIGGER, ASKS, WORKING]]) {
      it(`a queued job without a run file, ${labels.slice(1).join(", ")}: the label goes to working`, async () => {
        issues([4, labels]); comments(question);
        vi.spyOn(scheduler, "queue").mockReturnValue({ pending: [{ runId: "q1", githubRepo: "acme/app", issue: "4", source: "watcher w issue #4" }], active: [] } as never);
        const w = watcher();
        await w.tick();
        expect(log()).toContain(`--add-label ${WORKING}`);
        expect(hold4(w)).toBeUndefined();
      });
    }
    it("a lone waiting-approval label next to a parked asking run: a label hold on every tick, no edit, no new run", async () => {
      plant("stopped", { parkedAt: "2026-01-01T00:02:00.000Z" }); issues([4, [TRIGGER, WAITING]]); comments(question);
      const w = watcher();
      await w.tick();
      labelHold(w);
      untouched();
      await w.tick();
      labelHold(w);
      untouched();
      expect(log()).not.toContain("--remove-label");
    });
    it("a lone needs-info label with a succeeded run is still changed to done", async () => {
      plant("succeeded"); issues([4, [TRIGGER, ASKS]]); comments(question);
      await watcher().tick();
      expect(log()).toContain(`--add-label ${DONE}`);
    });
  });

  describe("a lone waiting-approval label", () => {
    it("no run: a label hold, no edit", async () => {
      issues([4, [TRIGGER, WAITING]]); comments(request);
      const w = watcher();
      await w.tick();
      labelHold(w);
      untouched();
    });
    for (const status of ["failed", "succeeded"] as const) {
      it(`a ${status} run: a label hold, no relabel`, async () => {
        plant(status, { reason: status === "failed" ? "boom" : undefined }); issues([4, [TRIGGER, WAITING]]); comments(request);
        const w = watcher();
        await w.tick();
        labelHold(w);
        untouched();
      });
    }
    it("a waiting run with /approve is resumed", async () => {
      plant("waiting"); issues([4, [TRIGGER, WAITING]]); comments(request, approve);
      await watcher().tick();
      expect(log()).toContain(`--add-label ${WORKING}`);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ kind: "resume" }), expect.anything());
    });
  });

  describe("a lone needs-info label on a stopped run that does not ask", () => {
    it("is not resumed by an answer or by auto_defaults", async () => {
      plant("stopped", { reason: 'stopped at step "ask"' }); issues([4, [TRIGGER, ASKS]]); comments(question, answer);
      const w = watcher({ auto_defaults: true });
      await w.tick();
      labelHold(w);
      untouched();
    });
  });

  describe("a run of a retired flow is never linked", () => {
    const cases: [string, string, unknown[], () => void][] = [
      ["needs-info with an answer", ASKS, [question, answer], () => plant("stopped", {}, true)],
      ["waiting-approval with /approve", WAITING, [request, approve], () => plant("waiting", {}, true)],
      ["a parked asking run", ASKS, [question, answer], () => plant("stopped", { parkedAt: "2026-01-01T00:02:00.000Z" }, true)],
    ];
    for (const locked of [false, true]) {
      for (const fail of [false, true]) {
        for (const [name, label, c, make] of cases) {
          it(`${name}${locked ? ", lock held" : ""}${fail ? ", read fails" : ""}: a label hold`, async () => {
            make(); issues([4, [TRIGGER, label]]); comments(...c);
            if (fail) process.env.FAKE_GH_FAIL = "issue view";
            if (locked) vi.spyOn(scheduler, "isLocked").mockReturnValue(true);
            const w = watcher({ flow: "gone", one_at_a_time: locked });
            await w.tick();
            labelHold(w);
            expect(hold4(w)?.next.kind).not.toBe("one_at_a_time");
            untouched();
          });
        }
      }
    }
    it("mixed with done: a label hold", async () => {
      plant("stopped", {}, true); issues([4, [TRIGGER, "factory:done", ASKS]]); comments(question, answer);
      const w = watcher({ flow: "gone" });
      await w.tick();
      labelHold(w);
      untouched();
    });
    it("a working label with a retired asking run and an answer, lock held: no label edit", async () => {
      plant("stopped", {}, true); issues([4, [TRIGGER, WORKING]]); comments(question, answer);
      vi.spyOn(scheduler, "isLocked").mockReturnValue(true);
      await watcher({ flow: "gone", one_at_a_time: true }).tick();
      expect(log()).not.toContain("--add-label");
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe("the activity line of a run that ends", () => {
    it("a run that stops with questions says so, without the error text", async () => {
      issues([4, [TRIGGER]]);
      const reason = 'stopped at step "ask_for_info"';
      vi.spyOn(scheduler, "wait").mockResolvedValue({ status: "stopped", reason, totalCostUsd: 0, history: [] } as never);
      const w = watcher();
      await w.tick();
      await vi.waitFor(() => expect(w.status.lastActions.some((a) => a.includes("#4 → stopped (asks questions) · $0.000 · label → factory:needs-info"))).toBe(true));
      expect(w.status.lastActions.join("\n")).not.toContain(explainError(reason).what);
    });
    it("a failed run keeps its explanation", async () => {
      issues([4, [TRIGGER]]);
      vi.spyOn(scheduler, "wait").mockResolvedValue({ status: "failed", reason: "boom", totalCostUsd: 0, history: [] } as never);
      const w = watcher();
      await w.tick();
      await vi.waitFor(() => expect(w.status.lastActions.some((a) => a.includes(`#4 → failed (${explainError("boom").what}`))).toBe(true));
    });
  });
});
