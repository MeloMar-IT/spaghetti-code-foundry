import { beforeEach, describe, expect, it } from "vitest";
import type { DecidedRound } from "../src/engine/questions.js";
import type { RunBrief, RunSummary, StepRecord } from "../src/engine/state.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { DAY_TEXT, dayWindow, shareReportFrom, sourceKeyOf, type ShareInput, type ShareSplit } from "../src/metrics-share/build.js";
import { CUSTOM, DURATION_EDGES_MS, PARTS_EDGES, ShareReportSchema, bucketOf, type SourceKey } from "../src/metrics-share/report.js";
import { shareRunOf } from "../src/metrics-share/sources.js";

const DAY = "2026-11-19";
const A = "3f1c3c8e-8a5e-4c43-9f43-0a0e2f6b9b51";
const OTHER = "9a9a9a9a-8a5e-4c43-9f43-0a0e2f6b9b51";
const T0 = Date.parse(`${DAY}T00:00:00.000Z`);
const at = (h: number, m = 0) => new Date(T0 + h * 3_600_000 + m * 60_000).toISOString();

let n = 0;
let ids = 0;
const ev = (runId: string, type: string, time: string, rest: object = {}): EvidenceEvent => ({ version: 3, id: `ev-${++n}`, seq: n, runId, time, type, ...rest }) as unknown as EvidenceEvent;
const step = (id: string, type = "claude", visit = 1) => ({ id, visit, type });
const rec = (id: string, o: Partial<StepRecord> = {}): StepRecord => ({ id, type: "claude", visit: 1, ok: true, output: "private step output", startedAt: at(1), durationMs: 30_000, logFile: "/x/log", ...o }) as StepRecord;
const pushAllowed = (runId: string, time: string) =>
  ev(runId, "policy.decided", time, { step: step("push"), decision: { policy: { id: "p", version: "1" }, boundary: "push", mode: "enforce", outcome: "allow", reasonCode: "policy.no-rule-matched", evaluatedAt: time } });

const run = (o: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: `run-${++ids}`, flow: "issue-gitflow", flowDef: { steps: [{ id: "approve_plan", type: "approval" }] }, task: "", vars: {}, repo: "", status: "succeeded", runDir: "/x",
    startedAt: at(1), finishedAt: at(2), totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, owner: A, ...o,
  }) as unknown as RunSummary;

const brief = (r: RunSummary): RunBrief => ({
  runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), ...(r.source ? { source: r.source } : {}),
  ...(r.owner ? { owner: r.owner } : {}), runDir: `/runs/${r.runId}`, dirName: r.runId, updatedAt: r.finishedAt ?? r.startedAt,
  ...(r.vars?.github_repo ? { githubRepo: r.vars.github_repo } : {}), ...(r.vars?.issue ? { issue: r.vars.issue } : {}), ...(r.localTest ? { localTest: true } : {}),
});

/** `rounds` null: decided.json unreadable; undefined: no rounds. */
type Item = { run: RunSummary; events?: EvidenceEvent[]; rounds?: DecidedRound[] | null };
function input(items: Item[], o: Partial<ShareInput> = {}): ShareInput {
  return {
    day: DAY, accountIds: [A], foundryVersion: "0.4.0", briefs: items.map((i) => brief(i.run)),
    runs: items.map((i) => shareRunOf(i.run, `/runs/${i.run.runId}`, i.events ? { events: i.events, stream: true, manifest: true, incomplete: false } : { stream: false, manifest: false, incomplete: false }, i.rounds)),
    watcherSources: new Map<string, SourceKey>([["w-issues", "issues"]]), ...o,
  };
}
const report = (items: Item[], o: Partial<ShareInput> = {}) => shareReportFrom(input(items, o));
const bucket = (ms: number) => bucketOf(ms, DURATION_EDGES_MS);

beforeEach(() => {
  n = 0;
});

describe("dayWindow", () => {
  it("is one UTC day and refuses anything that is not a real date", () => {
    const w = dayWindow(DAY);
    expect([w.from.toISOString(), w.to.toISOString()]).toEqual([`${DAY}T00:00:00.000Z`, "2026-11-20T00:00:00.000Z"]);
    for (const bad of ["2026-13-01", "2026-02-30", "19.11.2026", "", "2026-11-19T00:00Z"]) expect(() => dayWindow(bad)).toThrow(DAY_TEXT);
  });
});

describe("changes", () => {
  it("counts runs started, runs ended by outcome, work items, pull requests and releases", () => {
    const delivered = run({ vars: { github_repo: "o/r", issue: "7" } });
    const prRun = run({ vars: { github_repo: "o/r", pr: "9" } });
    const items: Item[] = [
      { run: delivered, events: [pushAllowed(delivered.runId, at(1, 30))] },
      { run: prRun, events: [ev(prRun.runId, "run.completed", at(2), { pullRequest: { repository: "o/r", number: 9, url: "https://github.com/o/r/pull/9" } })] },
      { run: run({ status: "failed" }), events: [] },
      { run: run({ status: "cancelled" }), events: [] },
      { run: run({ status: "running", finishedAt: undefined }) },
      { run: run({ startedAt: at(-5), finishedAt: at(-4) }) },
    ];
    const r = report(items);
    expect(r.changes.runsStarted).toBe(5);
    expect(r.changes.runsEnded).toEqual({ succeeded: 2, failed: 1, cancelled: 1 });
    expect(r.changes.workItemsDelivered).toBe(1);
    expect(r.changes.pullRequestsDelivered).toBe(1);
    expect(r.changes.dailyReleases).toBe(0);
  });

  it("counts a release only with evidence of one: not the no-change or the rejected path", () => {
    const rel = (ids: string[]) => {
      const r = run({ flow: "release-daily" });
      return { run: r, events: ids.map((id) => ev(r.runId, "step.completed", at(1, 30), { step: step(id, "shell") })) };
    };
    expect(report([rel(["clone", "changes"])]).changes.dailyReleases).toBe(0); // develop had nothing new
    expect(report([rel(["clone", "changes", "verify", "release_pr", "final_ask", "final_rejected"])]).changes.dailyReleases).toBe(0); // not made final
    expect(report([rel(["clone", "changes", "verify", "release_pr", "handoff"])]).changes.dailyReleases).toBe(1); // pull request develop → main
    expect(report([rel(["release_pr", "final_ask", "make_final", "final_merge"])]).changes.dailyReleases).toBe(1); // local release
    const failed = rel(["handoff"]);
    failed.run.status = "failed";
    expect(report([failed]).changes.dailyReleases).toBe(0);
    const other = rel(["handoff"]);
    other.run.flow = "my-release";
    expect(report([other]).changes.dailyReleases).toBe(0);
  });
});

describe("speed", () => {
  it("fills the histograms of run duration, queue time, issue to pull request, approval latency and step time", () => {
    const r1 = run({ vars: { github_repo: "o/r", issue: "7" }, startedAt: at(1), finishedAt: at(3), history: [rec("implement", { durationMs: 120_000 }), rec("run_tests", { type: "shell", durationMs: 5_000 })] });
    const events = [
      ev(r1.runId, "run.queued", at(0, 30)), ev(r1.runId, "run.started", at(1)),
      ev(r1.runId, "step.started", at(1, 10), { step: step("approve_plan", "approval") }), ev(r1.runId, "step.approved", at(1, 20), { step: step("approve_plan", "approval") }),
      pushAllowed(r1.runId, at(2, 50)),
    ];
    const r = report([{ run: r1, events }]);
    const one = (ms: number) => {
      const c = new Array(DURATION_EDGES_MS.length + 1).fill(0);
      c[bucket(ms)] = 1;
      return { counts: c, sum: ms };
    };
    expect(r.speed.runDuration).toEqual(one(2 * 3_600_000));
    expect(r.speed.queueTime).toEqual(one(30 * 60_000));
    expect(r.speed.issueToPullRequest).toEqual(one(2.5 * 3_600_000));
    expect(r.speed.approvalLatency).toEqual(one(10 * 60_000));
    expect(r.speed.stepTime.implement).toEqual(one(120_000));
    expect(r.speed.stepTime.run_tests).toEqual(one(5_000));
  });
});

describe("approval latency", () => {
  it("gives one observation per decision, so two waits of 1 minute and 1 hour are not averaged", () => {
    const r1 = run({ startedAt: at(1), finishedAt: at(3) });
    const started = (time: string) => ev(r1.runId, "step.started", time, { step: step("approve_plan", "approval") });
    const approved = (time: string) => ev(r1.runId, "step.approved", time, { step: step("approve_plan", "approval") });
    const events = [started(at(1)), approved(at(1, 1)), started(at(1, 2)), approved(at(2, 2))];
    const h = report([{ run: r1, events }]).speed.approvalLatency;
    const counts = new Array(DURATION_EDGES_MS.length + 1).fill(0);
    counts[bucket(60_000)] = 1;
    counts[bucket(3_600_000)] = 1;
    expect(h).toEqual({ counts, sum: 60_000 + 3_600_000 });
  });
});

describe("splits", () => {
  it("counts the splits of the day of owned runs once, with the parts per split", () => {
    const mine = run();
    const theirs = run({ owner: OTHER });
    const s = (id: string, runId: string, time: string, parts: number): ShareSplit => ({ id, runId, time, parts });
    const r = report([{ run: mine }, { run: theirs }], {
      splits: [s("a", mine.runId, at(5), 3), s("a", mine.runId, at(5), 3), s("b", mine.runId, at(6), 12), s("c", mine.runId, at(25), 2), s("d", theirs.runId, at(5), 2), s("e", "unknown-run", at(5), 2)],
    });
    expect(r.splits.issuesSplit).toBe(2);
    const counts = new Array(PARTS_EDGES.length + 1).fill(0);
    counts[bucketOf(3, PARTS_EDGES)] = 1;
    counts[PARTS_EDGES.length] = 1;
    expect(r.splits.partsPerSplit).toEqual({ counts, sum: 15 });
    expect(report([{ run: mine }]).splits).toEqual({});
  });
});

describe("rework", () => {
  it("counts rework after delivery, resumes, step retries and steps run more than once", () => {
    const first = run({ vars: { github_repo: "o/r", issue: "7" }, startedAt: at(1), finishedAt: at(2) });
    const again = run({
      vars: { github_repo: "o/r", issue: "7" }, startedAt: at(3), finishedAt: at(5), resumes: 2,
      history: [rec("implement", { retried: { blips: 1, models: 1 } }), rec("fix_tests"), rec("fix_tests", { visit: 2 }), rec("address_review_1", { visit: 2 }), rec("x", { visit: 3 })],
    });
    const r = report([
      { run: first, events: [pushAllowed(first.runId, at(1, 50))] },
      { run: again, events: [ev(again.runId, "run.resumed", at(4)), ev(again.runId, "run.resumed", at(4, 10))] },
    ]);
    expect(r.rework.reworkedAfterDelivery).toBe(1);
    expect(r.rework.resumes).toBe(2);
    expect(r.rework.stepRetries).toBe(2);
    expect(r.rework.repeatedSteps).toEqual({ fix_tests: 1, address_review_1: 1, [CUSTOM]: 1 });
  });
});

describe("quality", () => {
  it("counts first-pass tests, merge rate, evidence, policy blocks, denials and questions", () => {
    const passed = run({ vars: { github_repo: "o/r", issue: "1" }, history: [rec("implement", { denied: ["Bash: rm -rf /secret"] })] });
    const failed = run({ vars: { github_repo: "o/r", issue: "2" }, status: "failed" });
    const asked = run({ status: "stopped", finishedAt: at(4) });
    const decided: DecidedRound[] = [
      { id: "a".repeat(16), issue: 3, at: at(2), source: "planner", outcome: "went_on", questions: [{ n: 1, title: "t", text: "x", decision: "d" }, { n: 2, title: "t", text: "x", decision: "d" }] },
      { id: "b".repeat(16), issue: 3, at: at(2), source: "planner", outcome: "asked", questions: [{ n: 1, title: "t", text: "x", decision: "d" }] },
      { id: "c".repeat(16), issue: 3, at: at(-3), source: "planner", outcome: "went_on", questions: [{ n: 1, title: "t", text: "x", decision: "d" }] },
    ];
    const r = report([
      { run: passed, events: [ev(passed.runId, "step.completed", at(1, 30), { step: step("run_tests", "shell"), test: { suite: "run_tests", outcome: "passed" } }), pushAllowed(passed.runId, at(1, 40))] },
      {
        run: failed,
        events: [
          ev(failed.runId, "step.failed", at(1, 30), { step: step("run_tests", "shell"), test: { suite: "run_tests", outcome: "failed" } }), pushAllowed(failed.runId, at(1, 35)),
          ev(failed.runId, "step.denied", at(1, 40), { step: step("push", "shell"), denial: { kind: "policy", policy: { id: "p", version: "1" }, reasonCode: "x.y" } }),
        ],
      },
      { run: asked, events: [ev(asked.runId, "run.stopped", at(4), { at: "send_back" })], rounds: decided },
    ]);
    expect(r.quality.firstPassTests).toEqual({ passed: 1, counted: 2 });
    expect(r.quality.mergeRate).toEqual({ delivered: 1, counted: 2 });
    expect(r.quality.evidence).toEqual({ complete: 2, counted: 2 });
    expect(r.quality.policyBlocks).toBe(1);
    expect(r.quality.denials).toBe(1);
    expect(r.quality.stoppedWithQuestions).toBe(1);
    expect(r.quality.questionsAnsweredAutomatically).toBe(2);
  });

  it("leaves a question count out when its source is unknown, and keeps a zero when it was read", () => {
    const unreadable = run({ startedAt: at(1), finishedAt: at(2) });
    const r1 = report([{ run: unreadable }]);
    expect(r1.quality.stoppedWithQuestions).toBeUndefined();
    expect(r1.quality.questionsAnsweredAutomatically).toBe(0);
    const badRounds = run({ startedAt: at(1), finishedAt: at(2) });
    const r2 = report([{ run: badRounds, events: [ev(badRounds.runId, "run.started", at(1))], rounds: null }]);
    expect(r2.quality.stoppedWithQuestions).toBe(0);
    expect(r2.quality.questionsAnsweredAutomatically).toBeUndefined();
  });

  it("counts a question stop on its day, also when the run was resumed and finished later", () => {
    const r1 = run({ startedAt: at(20), finishedAt: at(30) });
    const events = [ev(r1.runId, "run.stopped", at(23), { at: "ask_for_info" }), ev(r1.runId, "run.resumed", at(26), { from: "ask_for_info", by: { kind: "cli" } })];
    expect(report([{ run: r1, events }]).quality.stoppedWithQuestions).toBe(1);
    expect(report([{ run: r1, events }], { day: "2026-11-20" }).quality.stoppedWithQuestions).toBe(0);
    const other = [ev(r1.runId, "run.stopped", at(23), { at: "implement" })];
    expect(report([{ run: r1, events: other }]).quality.stoppedWithQuestions).toBe(0);
  });
});

describe("cost", () => {
  it("adds up tokens per model and per step and the fallbacks, and sends no money", () => {
    const r1 = run({
      totalCostUsd: 1.5,
      history: [
        rec("implement", { agent: "claude:anthropic:opus", tokens: { input: 100, output: 10 }, costUsd: 1 }),
        rec("review_1", { agent: "claude:anthropic", tokens: { input: 50, output: 5 }, costUsd: 0.25 }),
        rec("fix_tests", { agent: "codex:openai:private-model", tokens: { input: 20, output: 2 } }),
        rec("run_tests", { type: "shell" }),
      ],
    });
    const r = report([{ run: r1, events: [ev(r1.runId, "step.routed", at(1), { step: step("implement"), model: { agent: "claude", provider: "anthropic", model: "opus" }, fallbackFrom: { agent: "claude", provider: "anthropic", model: "fable" } })] }]);
    expect(r.cost.byModel).toEqual({ opus: { tokensIn: 100, tokensOut: 10 }, default: { tokensIn: 50, tokensOut: 5 }, [CUSTOM]: { tokensIn: 20, tokensOut: 2 } });
    expect(r.cost.byStep).toEqual({ implement: { tokensIn: 100, tokensOut: 10 }, review_1: { tokensIn: 50, tokensOut: 5 }, fix_tests: { tokensIn: 20, tokensOut: 2 } });
    expect(r.cost.costUsd).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("costUsd");
    expect(r.cost.modelFallbacks).toBe(1);
  });

  it("sends no money for a step whose record has only a cost", () => {
    const r1 = run({ history: [rec("implement", { agent: "claude:anthropic:opus", costUsd: 1, earlierCostUsd: 2 })] });
    const r = report([{ run: r1 }]);
    expect(r.cost.byStep).toEqual({});
    expect(r.cost.byModel).toEqual({});
  });
});

describe("use", () => {
  it("counts runs per source and flow, and the repositories as a number", () => {
    const r = report([
      { run: run({ source: "watcher w-issues issue #7", vars: { github_repo: "o/r" } }) },
      { run: run({ source: "watcher gone-watcher issue #8", vars: { github_repo: "O/R" } }) },
      { run: run({ source: "ui", flow: "my-flow", vars: { github_repo: "o/other" } }) },
      { run: run({ source: "cli", flow: "release-daily" }) },
    ]);
    expect(r.use.bySource).toEqual({ issues: 1, unknown: 1, manual: 2 });
    expect(r.use.byFlow).toEqual({ "issue-gitflow": 2, [CUSTOM]: 1, "release-daily": 1 });
    expect(r.use.repositories).toBe(2);
    expect(sourceKeyOf(undefined, new Map())).toBe("manual");
  });
});

describe("the owner rule", () => {
  it("counts only runs of the given accounts, never runs without an owner, refinement runs or local tests", () => {
    const items: Item[] = [
      { run: run(), events: [] },
      { run: run({ owner: OTHER }), events: [] },
      { run: run({ owner: undefined }), events: [] },
      { run: run({ source: "refinement x" }), events: [] },
      { run: run({ localTest: true }), events: [] },
    ];
    const r = report(items);
    expect(r.changes.runsStarted).toBe(1);
    expect(r.changes.runsEnded.succeeded).toBe(1);
    expect(r.accountsSharing).toBe(1);
    expect(report(items, { accountIds: [] }).changes.runsStarted).toBe(0);
  });
});

describe("the custom rule", () => {
  it("counts a custom flow, its steps and an unknown model only as custom", () => {
    const r1 = run({ flow: "acme-secret-flow", history: [rec("implement", { agent: "claude:acme-proxy:acme-model-7", tokens: { input: 1, output: 1 }, visit: 2 }), rec("acme_step")] });
    const r = report([{ run: r1, events: [] }]);
    expect(r.use.byFlow).toEqual({ [CUSTOM]: 1 });
    expect(Object.keys(r.speed.stepTime)).toEqual([CUSTOM]);
    expect(Object.keys(r.cost.byStep)).toEqual([CUSTOM]);
    expect(Object.keys(r.cost.byModel)).toEqual([CUSTOM]);
    expect(r.rework.repeatedSteps).toEqual({ [CUSTOM]: 1 });
    const json = JSON.stringify(r);
    for (const s of ["acme", "implement"]) expect(json).not.toContain(s);
  });
});

describe("privacy", () => {
  it("never lets a repository, branch, issue title, task, account id or e-mail reach the report", () => {
    const secrets = ["secret-org", "secret-repo", "feature/4242-secret-branch", "Secret issue title", "Secret task text", A, "someone@example.com", "/Users/someone"];
    const r1 = run({
      vars: { github_repo: "secret-org/secret-repo", issue: "4242", branch: "feature/4242-secret-branch", email: "someone@example.com" },
      task: "Secret task text", branch: "feature/4242-secret-branch", source: "watcher secret-org-watcher issue #4242", workdir: "/Users/someone/work",
      history: [rec("implement", { output: "Secret issue title someone@example.com", agent: "claude:anthropic:opus", tokens: { input: 1, output: 1 } })],
      answers: [{ at: at(1), text: "Secret task text", by: A }],
    } as Partial<RunSummary>);
    const items: Item[] = [{ run: r1, events: [pushAllowed(r1.runId, at(1, 30)), ev(r1.runId, "run.stopped", at(1, 40), { at: "send_back" })] }];
    const i = input(items, { splits: [{ id: "x", runId: r1.runId, time: at(1), parts: 2 }] });
    i.briefs = i.briefs.map((b) => ({ ...b, issueTitle: "Secret issue title", taskLine: "Secret task text" }));
    const r = shareReportFrom(i);
    expect(ShareReportSchema.safeParse(r).success).toBe(true);
    expect(r.changes.runsStarted).toBe(1);
    const json = JSON.stringify(r);
    for (const s of secrets) expect(json).not.toContain(s);
    expect(json).not.toContain("4242");
  });
});

describe("absent versus zero", () => {
  const optional = (r: ReturnType<typeof report>) => ({
    workItemsDelivered: r.changes.workItemsDelivered, pullRequestsDelivered: r.changes.pullRequestsDelivered, dailyReleases: r.changes.dailyReleases,
    reworkedAfterDelivery: r.rework.reworkedAfterDelivery, resumes: r.rework.resumes, stepRetries: r.rework.stepRetries, firstPassTests: r.quality.firstPassTests,
    mergeRate: r.quality.mergeRate, policyBlocks: r.quality.policyBlocks, denials: r.quality.denials, costUsd: r.cost.costUsd, modelFallbacks: r.cost.modelFallbacks,
  });

  it("leaves a measure out when its source is missing", () => {
    const r = report([{ run: run({ totalCostUsd: undefined as unknown as number, history: [rec("implement")] }) }]);
    expect(Object.values(optional(r)).every((v) => v === undefined)).toBe(true);
    expect(r.quality.evidence).toEqual({ complete: 0, counted: 0 });
    expect(r.quality.stoppedWithQuestions).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("workItemsDelivered");
  });

  it("gives 0 when readable evidence recorded none", () => {
    const r1 = run({ totalCostUsd: 0, history: [rec("implement", { retried: { blips: 0, models: 0 }, denied: [] })] });
    const r = report([{ run: r1, events: [ev(r1.runId, "run.started", at(1))] }]);
    expect(optional(r)).toEqual({
      workItemsDelivered: 0, pullRequestsDelivered: 0, dailyReleases: 0, reworkedAfterDelivery: 0, resumes: 0, stepRetries: 0, firstPassTests: { passed: 0, counted: 0 },
      mergeRate: { delivered: 0, counted: 0 }, policyBlocks: 0, denials: 0, modelFallbacks: 0,
    });
  });
});
