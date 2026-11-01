import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { isStoryRun, isTimeLimitNote, markRetryStart, pendingRetry, retriesOf, retryComment, retryEntry, retryOutcome, timeLimitAction, timeLimitReason, timeLimitsUsed } from "../src/engine/auto-retry.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { isTimeLimitStop, type RunSummary, type StepRecord } from "../src/engine/state.js";
import { isCovered } from "../src/settings/describe.js";
import { runNextStep } from "../src/next-step.js";
import { isPaused, openQuestion } from "../src/queue/waiting-issues.js";
import { parseFlow } from "../src/flow/load.js";
import type { Comment } from "../src/github.js";

const base = { top: true, stepType: "shell" as const, error: "timed out", storyRun: true, limit: 2, used: () => 0 };

describe("timeLimitAction", () => {
  it("retries a time-out and the test-slot forms", () => {
    expect(timeLimitAction(base)).toEqual({ attempt: 1, of: 2 });
    expect(timeLimitAction({ ...base, error: "timed out (waited 18 min for a test slot, which did not count)" })).toEqual({ attempt: 1, of: 2 });
    expect(timeLimitAction({ ...base, stepType: "claude", used: () => 1 })).toEqual({ attempt: 2, of: 2 });
  });
  it("does not retry anything else", () => {
    for (const o of [
      { error: "exit code 1" }, { error: "the step timed out" }, { top: false }, { stepType: "flow" as const }, { stepType: "parallel" as const },
      { accessFailed: true }, { storyRun: false }, { limit: 0 }, { used: () => 2 }, { ownFailurePath: true },
    ]) expect(timeLimitAction({ ...base, ...o }), JSON.stringify(o)).toBeUndefined();
  });
  it("does not count when it is off or not a story", () => {
    let asked = 0;
    const used = () => (asked++, 0);
    timeLimitAction({ ...base, limit: 0, used });
    timeLimitAction({ ...base, storyRun: false, used });
    expect(asked).toBe(0);
  });
});

describe("isStoryRun", () => {
  const vars = { issue: "7" };
  it("is a watcher run of an issue", () => {
    expect(isStoryRun({ source: "watcher go issue #7", vars })).toBe(true);
  });
  it("is nothing else", () => {
    expect(isStoryRun({ source: "ui", vars })).toBe(false);
    expect(isStoryRun({ source: "cli", vars })).toBe(false);
    expect(isStoryRun({ source: "watcher go pr #7", vars })).toBe(false);
    expect(isStoryRun({ source: "watcher go schedule", vars })).toBe(false);
    expect(isStoryRun({ source: "watcher go issue #7", vars: {} })).toBe(false);
    expect(isStoryRun({ source: "watcher go issue #7", vars, localTest: true })).toBe(false);
    expect(isStoryRun({ vars })).toBe(false);
  });
});

describe("timeLimitsUsed", () => {
  const ev = (startedAt?: string) => ({ at: "t", step: "x", attempt: 1, of: 2, ...(startedAt ? { startedAt } : {}) });
  const own = { runId: "a", vars: { github_repo: "o/r", issue: "7" }, timeLimits: [ev("s"), ev()] };
  it("counts started events of this run and of the other runs of the issue", () => {
    const briefs = [
      { runId: "a", githubRepo: "o/r", issue: "7", timeLimits: [ev("s")] },
      { runId: "b", githubRepo: "o/r", issue: "7", timeLimits: [ev("s"), ev()] },
      { runId: "c", githubRepo: "o/r", issue: "8", timeLimits: [ev("s")] },
      { runId: "d", githubRepo: "o/other", issue: "7", timeLimits: [ev("s")] },
      { runId: "e", githubRepo: "o/r", issue: "7", timeLimits: ["junk", null, { startedAt: 5 }] as never },
      { runId: "f", githubRepo: "o/r", issue: "7" },
    ];
    expect(timeLimitsUsed(own, briefs)).toBe(2);
  });
  it("counts only its own events when it has no issue", () => {
    expect(timeLimitsUsed({ ...own, vars: {} }, [{ runId: "b", githubRepo: "o/r", issue: "7", timeLimits: [ev("s")] }])).toBe(1);
  });
});

describe("retryEntry", () => {
  const flow = (...ids: string[]) => ({ steps: ids.map((id) => ({ id, type: "shell", run: "true" })) as never });
  const rec = (id: string, o: Partial<StepRecord> = {}): StepRecord => ({ id, type: "shell", visit: 1, ok: true, output: "", ...o });
  it("goes through the claim when the step ran after a successful claim", () => {
    expect(retryEntry(flow("plan", "claim_areas", "implement"), [rec("plan"), rec("claim_areas"), rec("implement", { ok: false })], "implement")).toEqual({ next: "claim_areas", retryStep: "implement" });
  });
  it("follows what ran, not the order of the steps: a handler declared before the claim", () => {
    expect(retryEntry(flow("fix", "claim_areas", "implement"), [rec("claim_areas"), rec("implement"), rec("fix", { ok: false })], "fix")).toEqual({ next: "claim_areas", retryStep: "fix" });
  });
  it("stays at the step before any claim", () => {
    expect(retryEntry(flow("plan", "claim_areas", "implement"), [rec("plan", { ok: false })], "plan")).toEqual({ next: "plan" });
  });
  it("stays at the step when the claim only waited, or has no flow step, or is the step", () => {
    expect(retryEntry(flow("claim_areas", "implement"), [rec("claim_areas", { output: "waiting for run x (a)\nWAIT_AREA\n" }), rec("implement", { ok: false })], "implement")).toEqual({ next: "implement" });
    expect(retryEntry(flow("implement"), [rec("claim_areas"), rec("implement", { ok: false })], "implement")).toEqual({ next: "implement" });
    expect(retryEntry(flow("claim_areas"), [rec("claim_areas", { ok: false })], "claim_areas")).toEqual({ next: "claim_areas" });
  });
  it("does not read a claim of a sub-flow", () => {
    expect(retryEntry(flow("claim_areas", "implement"), [rec("sub/claim_areas", { parent: "sub" }), rec("implement", { ok: false })], "implement")).toEqual({ next: "implement" });
  });
});

describe("markRetryStart and pendingRetry", () => {
  const run = (o: Partial<RunSummary> = {}) => ({ state: { next: "implement" }, reason: timeLimitReason("implement", 1, 2), timeLimits: [{ at: "t", step: "implement", attempt: 1, of: 2 }], retryStep: "implement", ...o }) as unknown as RunSummary;
  it("stamps once on a time-limit stop", () => {
    const s = run();
    expect(pendingRetry(s, "implement", "implement")).toBeDefined();
    markRetryStart(s, "implement", "T1");
    markRetryStart(s, "implement", "T2");
    expect(s.timeLimits![0]!.startedAt).toBe("T1");
    expect(pendingRetry(s, "implement", "implement")).toBeUndefined();
  });
  it("drops retryStep and does not stamp when it resumes somewhere else", () => {
    const s = run();
    markRetryStart(s, "plan", "T1");
    expect(s.retryStep).toBeUndefined();
    expect(s.timeLimits![0]!.startedAt).toBeUndefined();
  });
  it("ignores another stop reason", () => {
    const s = run({ reason: "usage limit reached" });
    markRetryStart(s, "implement", "T1");
    expect(s.timeLimits![0]!.startedAt).toBeUndefined();
  });
});

describe("the comment", () => {
  const run = { runId: "r1", timeLimits: [{ at: "t", step: "implement", attempt: 1, of: 2 }] };
  it("has the exact text and the marker of its retry", () => {
    expect(retryComment(run)).toBe("**Nothing needed from you** — ran out of time in `implement`; trying again (1 of 2).\n\n<!-- claude-factory run=r1 retry=1 -->");
  });
  it("is nothing without an event or with an odd step id", () => {
    expect(retryComment({ runId: "r1" })).toBeUndefined();
    expect(retryComment({ runId: "r1", timeLimits: [{ at: "t", step: "a`b\n", attempt: 1, of: 2 }] })).toBeUndefined();
  });
  it("is a note only when the Foundry wrote it, and openQuestion skips it", () => {
    const body = retryComment(run)!;
    const note: Comment = { author: { login: "bot" }, body, createdAt: "2", viewerDidAuthor: true };
    expect(isTimeLimitNote(note)).toBe(true);
    expect(isTimeLimitNote({ ...note, viewerDidAuthor: false })).toBe(false);
    const question: Comment = { author: { login: "bot" }, body: "Which one?\n\n<!-- claude-factory run=r0 -->", createdAt: "1", viewerDidAuthor: true };
    expect(openQuestion([question, note])).toMatchObject({ since: "1" });
  });
});

describe("the stop in the rest of the Foundry", () => {
  const stopped = { status: "stopped", reason: timeLimitReason("implement", 1, 2), vars: { github_repo: "o/r", issue: "7" }, history: [], state: { next: "implement" }, runId: "r", task: "t", repo: "." } as unknown as RunSummary;
  it("is a pause that clears itself", () => {
    expect(isTimeLimitStop(stopped.reason)).toBe(true);
    expect(isTimeLimitStop("the step timed out")).toBe(false);
    expect(isPaused(stopped)).toBe(true);
  });
  it("says it is queued (watched), a release (open pull request) or stopped (not watched, retired)", () => {
    expect(runNextStep(stopped, { watched: true }).kind).toBe("queued");
    expect(runNextStep(stopped, { watched: true, pr: { number: 1 } }).kind).toBe("release");
    expect(runNextStep(stopped, {}).kind).toBe("stopped");
    expect(runNextStep(stopped, { watched: true, retired: true }).kind).toBe("stopped");
  });
});

describe("the setting", () => {
  it("defaults to 2, accepts 0 and refuses a negative number", () => {
    expect(ConfigSchema.parse({}).auto_retry.timeouts).toBe(2);
    expect(ConfigSchema.parse({ auto_retry: { timeouts: 0 } }).auto_retry.timeouts).toBe(0);
    expect(() => ConfigSchema.parse({ auto_retry: { timeouts: -1 } })).toThrow();
    expect(isCovered("auto_retry.timeouts")).toBe(true);
  });
});

describe("the engine", () => {
  let tmp: string;
  let repo: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "auto-retry-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const runsDir = () => join(tmp, "runs");
  const cfg = (timeouts?: number) => ConfigSchema.parse({ isolate_agents: false, protected_branches: [], ...(timeouts === undefined ? {} : { auto_retry: { timeouts } }) });
  const story = { source: "watcher go issue #7", vars: { issue: "7", github_repo: "o/r" } };
  const sleeper = (extra = "") => parseFlow(`
name: t
workspace: inplace
steps:
  - {id: x, type: shell, timeout_sec: 0.2, run: "sleep 5"${extra}}
  - {id: h, type: shell, jump_only: true, run: "echo handled"}
`);
  const go = (flow = sleeper(), o: Record<string, unknown> = {}, timeouts?: number) => runFlow(flow, { task: "t", repo, runsDir: runsDir(), config: cfg(timeouts), ...story, ...o });
  const again = (runId: string, timeouts?: number) => resumeRun({ runId, runsDir: runsDir(), config: cfg(timeouts) });

  it("stops at a time limit, twice, and then fails as before", async () => {
    const s1 = await go();
    expect(s1.status).toBe("stopped");
    expect(s1.reason).toBe(timeLimitReason("x", 1, 2));
    expect(s1.timeLimits).toEqual([{ at: expect.any(String), step: "x", attempt: 1, of: 2 }]);
    expect(s1.failureNote).toBeUndefined();
    expect(s1.state.next).toBe("x");

    const s2 = await again(s1.runId);
    expect(s2.status).toBe("stopped");
    expect(s2.timeLimits![0]!.startedAt).toEqual(expect.any(String));
    expect(s2.timeLimits![1]).toMatchObject({ attempt: 2, of: 2 });
    expect(s2.timeLimits![1]!.startedAt).toBeUndefined();

    const s3 = await again(s1.runId);
    expect(s3.status).toBe("failed");
    expect(s3.reason).toBe('step "x" failed: timed out');
    expect(s3.timeLimits).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(s3.runDir, "run.json"), "utf8")).timeLimits).toHaveLength(2);
  }, 30_000);

  it("fails at once when it is off", async () => {
    const s = await go(sleeper(), {}, 0);
    expect(s.status).toBe("failed");
    expect(s.timeLimits).toBeUndefined();
  }, 15_000);

  it("fails for a run of a person, a step with its own failure path, and a step with on_failure: fail", async () => {
    expect((await go(sleeper(), { source: "ui" })).status).toBe("failed");
    expect((await go(sleeper(", on_failure: fail"))).status).toBe("failed");
    const handled = await go(sleeper(", on_failure: h"));
    expect(handled.status).not.toBe("stopped");
    expect(handled.history.some((h) => h.id === "h")).toBe(true);
  }, 30_000);

  it("fails on another error", async () => {
    const flow = parseFlow(`
name: t
workspace: inplace
steps:
  - {id: x, type: shell, run: "exit 3"}
`);
    expect((await go(flow)).status).toBe("failed");
  }, 15_000);

  it("counts the retries that began in earlier runs of the same issue", async () => {
    const first = await go();
    const file = join(first.runDir, "run.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.timeLimits[0].startedAt = "2026-01-01T00:00:00.000Z";
    saved.status = "failed";
    writeFileSync(file, JSON.stringify(saved));
    const second = await go();
    expect(second.status).toBe("stopped");
    expect(second.timeLimits).toEqual([expect.objectContaining({ attempt: 2, of: 2 })]);
  }, 30_000);

  it("fails a resume when another run of the story used the last retry", async () => {
    const first = await go(sleeper(), {}, 1);
    const second = await go(sleeper(), {}, 1); // counts nothing yet: the first retry did not begin
    expect(second.status).toBe("stopped");
    const done = await again(first.runId, 1);
    expect(done.timeLimits![0]!.startedAt).toEqual(expect.any(String));
    const late = await again(second.runId, 1);
    expect(late.status).toBe("failed");
    expect(late.timeLimits![0]!.startedAt).toBeUndefined();
  }, 40_000);

  it("claims the areas again before it goes on", async () => {
    const flow = parseFlow(`
name: t
workspace: inplace
steps:
  - {id: claim_areas, type: shell, run: "echo claimed"}
  - {id: x, type: shell, timeout_sec: 0.2, run: "if [ -f ok ]; then echo fine; else sleep 5; fi"}
  - {id: after, type: shell, run: "echo after"}
`);
    const s1 = await go(flow);
    expect(s1.status).toBe("stopped");
    expect(s1.state.next).toBe("claim_areas");
    expect(s1.retryStep).toBe("x");
    writeFileSync(join(s1.workdir!, "ok"), "");
    const s2 = await again(s1.runId);
    expect(s2.status, s2.reason).toBe("succeeded");
    expect(s2.history.map((h) => h.id)).toEqual(["claim_areas", "x", "claim_areas", "x", "after"]);
    expect(s2.retryStep).toBeUndefined();
  }, 30_000);
});

describe("retriesOf and retryOutcome", () => {
  const ev = (startedAt?: string) => ({ at: "2026-01-01T00:00:00Z", step: "x", attempt: 1, of: 2, ...(startedAt ? { startedAt } : {}) });
  const stop = "ran out of time in `x`; trying again (1 of 2)";
  const r = (o: Record<string, unknown>) => ({ status: "stopped", reason: undefined, history: [], timeLimits: undefined, ...o }) as never;

  it("names each outcome", () => {
    expect(retryOutcome(r({ status: "succeeded" }))).toBe("finished");
    expect(retryOutcome(r({ status: "succeeded", history: [{ id: "create_split" }] }))).toBe("split");
    expect(retryOutcome(r({ status: "failed" }))).toBe("failed");
    expect(retryOutcome(r({ status: "cancelled" }))).toBe("cancelled");
    for (const status of ["running", "waiting", "stopped"]) expect(retryOutcome(r({ status }))).toBe("open");
  });

  it("counts only retries that began", () => {
    expect(retriesOf(r({}))).toBeUndefined();
    expect(retriesOf(r({ timeLimits: [] }))).toBeUndefined();
    expect(retriesOf(r({ timeLimits: [null, 3, "x"] }))).toBeUndefined();
    expect(retriesOf(r({ status: "succeeded", timeLimits: [ev("2026-01-01T00:01:00Z"), null] }))).toEqual({ started: 1, waiting: false, outcome: "finished" });
  });

  it("a retry cancelled before it began gives nothing; after one began, it is cancelled", () => {
    expect(retriesOf(r({ status: "cancelled", reason: "cancelled", timeLimits: [ev()] }))).toBeUndefined();
    expect(retriesOf(r({ status: "cancelled", timeLimits: [ev("2026-01-01T00:01:00Z"), ev()] }))).toEqual({ started: 1, waiting: false, outcome: "cancelled" });
  });

  it("a waiting retry is waiting only on a time-limit stop", () => {
    expect(retriesOf(r({ reason: stop, timeLimits: [ev()] }))).toEqual({ started: 0, waiting: true, outcome: "open" });
    expect(retriesOf(r({ reason: "your daily limit is reached", timeLimits: [ev()] }))).toBeUndefined();
    expect(retriesOf(r({ status: "failed", reason: "x", timeLimits: [ev()] }))).toBeUndefined();
  });
});
