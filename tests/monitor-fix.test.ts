import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { RunBrief } from "../src/engine/state.js";
import type { Names } from "../src/monitor/clean.js";
import { checkFixes, cameBack, fixCommitOf, fixRunsOf, fixState, forgetFix, tryAgain } from "../src/monitor/fix.js";
import { loadFindings, saveFindings, type Finding, type FindingInput, type StoryRef } from "../src/monitor/findings.js";
import { logFile, type LogEntry, type Mute, type Verdict } from "../src/monitor/guard.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { FIXED_MARKER, markerFor } from "../src/monitor/story.js";
import type { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub, type FakeIssue } from "./helpers/fake-github.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 9, 1, 12, 0, 0);
const at = (h: number) => new Date(T0.getTime() + h * HOUR);
const iso = (h: number) => at(h).toISOString();
const TARGET = "acme/app";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

// ── pure ──

const finding = (over: Partial<Finding> = {}): Finding => ({
  detector: "restart-loop", fingerprint: "restart-loop|a", severity: "critical", summary: "s", about: "foundry", evidence: { times: [iso(0)] },
  firstSeen: iso(0), lastSeen: iso(0), count: 3, gone: false, streak: 3, ...over,
});
const story = (over: Partial<StoryRef> = {}): StoryRef => ({ repo: TARGET, issue: 101, url: `https://github.com/${TARGET}/issues/101`, at: iso(0), seen: 0, closedAt: iso(2), ...over });
const run = (id: string, issue: string, status: RunBrief["status"], finished: number, repo = TARGET): RunBrief => ({
  runId: id, dirName: id, flow: "issue-gitflow", status, startedAt: iso(finished - 1), finishedAt: iso(finished), runDir: `/x/${id}`, updatedAt: iso(finished), githubRepo: repo, issue,
});
const unseen = (f: Partial<Finding> = {}) => finding({ lastSeen: iso(5), ...f });

describe("fixCommitOf and fixRunsOf", () => {
  const step = (id: string, output: string, ok = true) => ({ id, ok, output });
  it("reads MAIN: of the hotfix path and COMMIT: of the feature path (also with a sub-flow prefix)", () => {
    expect(fixCommitOf({ history: [step("x", "MAIN: " + OTHER_SHA), step("hotfix_done", `done\nMAIN: ${SHA}\n`)] })).toBe(SHA);
    expect(fixCommitOf({ history: [step("a/b/push_develop", `PUSHED: develop abc1234\nCOMMIT: ${SHA}\n`)] })).toBe(SHA);
  });
  it("gives nothing for a failed step, a short sha, an output with only PUSHED: or a quoted line", () => {
    expect(fixCommitOf({ history: [step("hotfix_done", `MAIN: ${SHA}`, false)] })).toBeUndefined();
    expect(fixCommitOf({ history: [step("hotfix_done", "MAIN: abc1234")] })).toBeUndefined();
    expect(fixCommitOf({ history: [step("push_develop", "PUSHED: develop abc1234")] })).toBeUndefined();
    expect(fixCommitOf({ history: [step("push_develop", `see COMMIT: ${SHA}`)] })).toBeUndefined();
    expect(fixCommitOf({ history: [step("hotfix_done", `COMMIT: ${SHA}`)] })).toBeUndefined();
  });
  it("fixRunsOf keeps the succeeded runs of this story, newest first", () => {
    const runs = [run("old", "101", "succeeded", 3), run("new", "101", "succeeded", 9), run("failed", "101", "failed", 12), run("other", "102", "succeeded", 10), run("repo", "101", "succeeded", 11, "x/y"), run("case", "101", "succeeded", 5, "ACME/App")];
    expect(fixRunsOf({ repo: TARGET, issue: 101 }, runs).map((b) => b.runId)).toEqual(["new", "case", "old"]);
  });
});

describe("checkFixes: the clock", () => {
  const base = { target: TARGET, waitDays: 7, worked: 0 };
  it("update: the clock is the later of the server start and the close", () => {
    const f = finding({ report: story({ fixCommit: SHA }) });
    const a = checkFixes([f], { ...base, now: at(10), startedAt: at(1), contains: () => true });
    expect(a.findings[0]!.report).toMatchObject({ clockAt: iso(2), clockWhy: "update" });
    expect(a.events).toMatchObject([{ event: "clock-started", reason: "update", issue: 101 }]);
    const b = checkFixes([f], { ...base, now: at(10), startedAt: at(5), contains: () => true });
    expect(b.findings[0]!.report!.clockAt).toBe(iso(5));
  });
  it("with a fix commit that is not in the running build, a restart does not start it", () => {
    const f = finding({ report: story({ fixCommit: SHA }) });
    const r = checkFixes([f], { ...base, now: at(10), startedAt: at(5), contains: () => false });
    expect(r.findings[0]).toBe(f);
    expect(r.events).toEqual([]);
  });
  it("restart: only when the server started after the close, and not while the commit is still being looked for", () => {
    const f = finding({ report: story() });
    expect(checkFixes([f], { ...base, now: at(10), startedAt: at(1) }).findings[0]).toBe(f);
    expect(checkFixes([f], { ...base, now: at(10), startedAt: at(2) }).findings[0]).toBe(f);
    const r = checkFixes([f], { ...base, now: at(10), startedAt: at(5) });
    expect(r.findings[0]!.report).toMatchObject({ clockAt: iso(5), clockWhy: "restart" });
    const p = checkFixes([f], { ...base, now: at(10), startedAt: at(5), contains: () => false, pending: new Set([f.fingerprint]) });
    expect(p.findings[0]).toBe(f);
    // a story with no fix commit and a build that can be asked: the restart rule
    expect(checkFixes([f], { ...base, now: at(10), startedAt: at(5), contains: () => false }).findings[0]!.report!.clockWhy).toBe("restart");
  });
  it("waited: at exactly fix_wait_days, also for a pending story", () => {
    const f = finding({ report: story({ fixCommit: SHA }) });
    const opts = { ...base, startedAt: at(0), contains: () => false, pending: new Set([f.fingerprint]) };
    expect(checkFixes([f], { ...opts, now: new Date(at(2).getTime() + 7 * DAY - 1) }).findings[0]).toBe(f);
    const r = checkFixes([f], { ...opts, now: new Date(at(2).getTime() + 7 * DAY) });
    expect(r.findings[0]!.report).toMatchObject({ clockWhy: "waited", clockAt: new Date(at(2).getTime() + 7 * DAY).toISOString() });
    expect(r.events[0]).toMatchObject({ reason: "waited", count: 7 });
  });
  it("leaves stories of another repository, open ones and not-planned ones alone (the same objects)", () => {
    const list = [finding({ fingerprint: "1", report: story({ repo: "x/y" }) }), finding({ fingerprint: "2", report: story({ closedAt: undefined }) }), finding({ fingerprint: "3", report: story({ muted: true }) }), finding({ fingerprint: "4" })];
    const r = checkFixes(list, { ...base, now: at(500), startedAt: at(100) });
    r.findings.forEach((f, i) => expect(f).toBe(list[i]));
  });
});

describe("checkFixes: the verdict", () => {
  const base = { target: TARGET, waitDays: 7 };
  const watched = (over: Partial<StoryRef> = {}) => story({ clockAt: iso(3), clockWhy: "restart", ...over });
  it("counts normal work only when the problem is not seen, capped by the time since the clock", () => {
    const seen = finding({ lastSeen: iso(10), report: watched() });
    expect(checkFixes([seen], { ...base, now: at(10), worked: HOUR }).findings[0]).toBe(seen);
    const f = unseen({ report: watched({ workedMs: 2 * HOUR }) });
    expect(checkFixes([f], { ...base, now: at(10), worked: HOUR }).findings[0]!.report!.workedMs).toBe(3 * HOUR);
    expect(checkFixes([f], { ...base, now: at(10), worked: 50 * HOUR }).findings[0]!.report!.workedMs).toBe(7 * HOUR);
  });
  it("is fixed at 24 hours, with a comment owed", () => {
    const f = unseen({ report: watched({ workedMs: 23 * HOUR }) });
    const r = checkFixes([f], { ...base, now: at(40), worked: HOUR });
    expect(r.findings[0]!.report).toMatchObject({ fixedAt: iso(40), fixNote: "due" });
    expect(r.events).toMatchObject([{ event: "fixed", issue: 101 }]);
    expect(fixState(r.findings[0]!.report!)).toBe("fixed");
    // nothing more happens at the next check
    const again = checkFixes(r.findings, { ...base, now: at(41), worked: HOUR });
    expect(again.findings[0]).toBe(r.findings[0]);
  });
  it("owes no comment when the close is fix_wait_days or more before the clock", () => {
    const f = unseen({ report: watched({ closedAt: iso(-200), clockAt: iso(3), workedMs: 23 * HOUR }) });
    const r = checkFixes([f], { ...base, now: at(40), worked: HOUR });
    expect(r.findings[0]!.report).toMatchObject({ fixedAt: iso(40) });
    expect(r.findings[0]!.report!.fixNote).toBeUndefined();
  });
  it("a sighting with only old evidence changes nothing", () => {
    const f = finding({ lastSeen: iso(10), firstSeen: iso(0), evidence: { times: [iso(1), iso(2)] }, report: watched() });
    const r = checkFixes([f], { ...base, now: at(10), worked: HOUR });
    expect(r.findings[0]).toBe(f);
    expect(r.events).toEqual([]);
  });
  it.each([
    ["firstSeen", { firstSeen: iso(4) }],
    ["missedAt", { missedAt: iso(4) }],
    ["an evidence time", { evidence: { times: [iso(1), iso(6)] } }],
  ])("proof by %s sets seenAfter once, says came-back and takes the comment back", (_n, over) => {
    const f = finding({ lastSeen: iso(10), report: watched({ fixedAt: iso(9), fixNote: "due" }), ...(over as Partial<Finding>) });
    const r = checkFixes([f], { ...base, now: at(10), worked: HOUR });
    expect(r.findings[0]!.report).toMatchObject({ seenAfter: iso(10) });
    expect(r.findings[0]!.report!.fixNote).toBeUndefined();
    expect(r.events).toMatchObject([{ event: "came-back", issue: 101 }]);
    expect(fixState(r.findings[0]!.report!)).toBe("watched");
    expect(checkFixes(r.findings, { ...base, now: at(11), worked: HOUR }).events).toEqual([]);
  });
});

describe("cameBack", () => {
  const o = (h: number) => ({ target: TARGET, stamp: iso(h) });
  const f = (over: Partial<Finding> = {}, rep: Partial<StoryRef> = {}) => finding({ report: story({ clockAt: iso(3), seenAfter: iso(10), ...rep }), ...over });
  it("is false at the check of seenAfter, true at the next with two in a row, false after a miss until two in a row", () => {
    expect(cameBack(f({ streak: 5 }), o(10))).toBe(false);
    expect(cameBack(f({ streak: 2 }), o(11))).toBe(true);
    expect(cameBack(f({ streak: 1 }), o(12))).toBe(false);
    expect(cameBack(f({ streak: 2 }), o(13))).toBe(true);
  });
  it("is false without a clock, a sighting after it, a close or in another repository", () => {
    expect(cameBack(f({}, { clockAt: undefined }), o(11))).toBe(false);
    expect(cameBack(f({}, { seenAfter: undefined }), o(11))).toBe(false);
    expect(cameBack(f({}, { closedAt: undefined }), o(11))).toBe(false);
    expect(cameBack(f({}, { repo: "x/y" }), o(11))).toBe(false);
    expect(cameBack(f({}, { muted: true }), o(11))).toBe(false);
  });
  it("the minor rule: three different days after the clock started", () => {
    const m = (days: string[]) => f({ severity: "minor", days });
    expect(cameBack(m(["2026-09-30", "2026-10-02", "2026-10-03"]), o(11))).toBe(false);
    // the clock is on 2026-10-01 (local time): three later days count, the day of the clock does not
    expect(cameBack(m(["2026-10-01", "2026-10-02", "2026-10-03"]), o(11))).toBe(false);
    expect(cameBack(m(["2026-10-02", "2026-10-03", "2026-10-04"]), o(11))).toBe(true);
  });
});

describe("fixState and forgetFix", () => {
  it("says waiting, watched or fixed for a closed story, and nothing for others", () => {
    expect(fixState(story())).toBe("waiting");
    expect(fixState(story({ clockAt: iso(3) }))).toBe("watched");
    expect(fixState(story({ clockAt: iso(3), fixedAt: iso(30) }))).toBe("fixed");
    expect(fixState(story({ clockAt: iso(3), fixedAt: iso(30), seenAfter: iso(31) }))).toBe("watched");
    expect(fixState(story({ closedAt: undefined }))).toBeUndefined();
    expect(fixState(story({ muted: true }))).toBeUndefined();
  });
  it("forgetFix takes all eight fields out and keeps the rest", () => {
    const all = story({ fixCommit: SHA, clockAt: iso(3), clockWhy: "update", workedMs: 5, seenAfter: iso(4), fixedAt: iso(5), fixNote: "due", notedAt: iso(6), lookedAt: iso(7) });
    expect(forgetFix(all)).toEqual({ repo: TARGET, issue: 101, url: all.url, at: iso(0), seen: 0, closedAt: iso(2), lookedAt: iso(7) });
  });
});

// ── through the Monitor and the Reporter ──

describe("did the fix work? (Monitor and Reporter)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let file: string;
  let found: FindingInput[];
  let clock: Date;
  let monitor: Monitor;
  let briefs: RunBrief[];
  let runs: Record<string, unknown>;
  let getLog: string[];
  let failGets: number;
  let failChecks = false;
  let contains: boolean;
  let selfRepo: string | undefined;
  let verdict: Verdict;
  let mutes: Mute[];
  let perCheck: number;
  let waitDays: number;
  let recorded: LogEntry[] = [];

  const NAMES: Names = { target: TARGET, users: [], emails: [], repos: [], watchers: [], complete: true };
  const fi = (id: string, over: Partial<FindingInput> = {}): FindingInput => ({
    detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [iso(0)], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] }, ...over,
  });
  const cfg = () => ConfigSchema.parse({ monitor: { report_to: TARGET, cooldown_minutes: 0, fix_wait_days: waitDays, report_limits: { per_day: 50, per_check: perCheck } } }).monitor;
  const scheduler = () =>
    ({
      briefs: () => {
        if (failChecks) throw new Error("the runs cannot be listed");
        return briefs;
      },
      get: (dir: string) => {
        getLog.push(dir);
        if (failGets > 0) {
          failGets--;
          throw new Error("run.json cannot be read");
        }
        return runs[dir];
      },
      queue: () => ({ pending: [], active: [] }),
    }) as unknown as Scheduler;
  const newReporter = () =>
    new Reporter({
      config: cfg, buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }),
      guard: () => verdict, mutes: () => mutes, record: (e) => void recorded.push(e),
    });
  const newMonitor = (startedAt: Date) =>
    new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "1h" }), {
      scheduler: scheduler(), watchers: () => [], thresholds: cfg, log: () => {}, file, now: () => clock, reporter: newReporter(), detectors: [{ name: "t", description: "test", run: () => found }],
      guard: { startedAt }, ...(selfRepo ? { self: { repo: selfRepo, contains: () => contains } } : {}),
    });
  const restart = (h: number) => (monitor = newMonitor(at(h)));
  const check = async (h: number) => {
    clock = at(h);
    await monitor.tick();
  };
  const stored = (n = 0) => loadFindings(file).findings[n]!;
  const rep = (n = 0) => stored(n).report!;
  const calls = () => gh.ghLog().split("\n").filter((l) => /^gh (api|label|issue comment)/.test(l) && !l.startsWith("gh api rate_limit"));
  const fixedComments = () => gh.comments().filter((c) => c.body.startsWith("Not seen since the fix."));
  const logEvents = () => (existsSync(logFile()) ? readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const events = (name: string) => logEvents().filter((e) => e.event === name);
  const close = (n: number, h: number, reason = "completed") => gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? ({ ...i, state: "closed", state_reason: reason, closed_at: iso(h) } as FakeIssue) : i)));
  const reopen = (n: number) => gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? ({ ...i, state: "open", state_reason: "reopened", closed_at: null } as FakeIssue) : i)));
  const storyRun = (id: string, output: string | undefined, finished: number, issue = "101") => {
    // finishes "in the future" and was written long ago: only the fix-commit lookup loads it
    briefs.push({ ...run(id, issue, "succeeded", 10_000 + finished), updatedAt: iso(-10_000) });
    runs[id] = { runId: id, history: output === undefined ? [] : [{ id: "hotfix_done", type: "shell", visit: 1, ok: true, output }] };
  };
  /** The story #101 is made at hour -5 and closed (as completed) at hour -4; GitHub is asked about it again 6 hours after the check that made it, at hour 1. */
  const closedStory = async () => {
    await check(-6);
    await check(-5);
    close(101, -4);
    await check(1);
    expect(rep().closedAt).toBe(iso(-4));
  };

  beforeEach(() => {
    gh = fakeGithub();
    recorded = [];
    process.env.FACTORY_HOME = join(gh.tmp, "home");
    file = join(gh.tmp, "monitor-findings.json");
    found = [fi("a")];
    briefs = [];
    runs = {};
    getLog = [];
    failGets = 0;
    failChecks = false;
    contains = false;
    selfRepo = undefined;
    verdict = { go: true };
    mutes = [];
    perCheck = 1;
    waitDays = 7;
    restart(0);
  });
  afterEach(() => gh.restore());

  it("makes no story while the update with the fix is not running (and the fix commit is read from the run)", async () => {
    selfRepo = TARGET;
    restart(0);
    storyRun("r1", `MAIN: ${SHA}`, 0);
    await closedStory();
    for (const h of [8, 9, 10, 30, 31]) {
      found = [fi("a", { evidence: { counts: { runs: 2 }, times: [iso(h)] } })];
      await check(h);
      expect(gh.createdBodies()).toHaveLength(1);
      expect(rep()).toMatchObject({ fixCommit: SHA });
      expect(rep().clockAt).toBeUndefined();
    }
    contains = true;
    found = [fi("a", { evidence: { counts: { runs: 2 }, times: [iso(32)] } })];
    await check(32);
    expect(rep()).toMatchObject({ clockWhy: "update", clockAt: iso(0), seenAfter: iso(32) }); // the later of the server start (0) and the close (-4)
    expect(events("clock-started")).toMatchObject([{ reason: "update", issue: 101 }]);
    expect(events("came-back")).toHaveLength(1);
    expect(gh.createdBodies()).toHaveLength(1);
    found = [fi("a", { evidence: { counts: { runs: 2 }, times: [iso(33)] } })];
    await check(33);
    const bodies = gh.createdBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.body).toContain("Came back after the fix");
    expect(bodies[1]!.body).toContain("#101");
    expect(stored().earlier).toEqual([{ repo: TARGET, issue: 101, url: `https://github.com/${TARGET}/issues/101`, closedAt: iso(-4) }]);
  });

  it("starts the clock at the first server start after the close for an install without git", async () => {
    restart(-6);
    await closedStory();
    await check(8);
    expect(rep().clockAt).toBeUndefined();
    restart(9);
    await check(10);
    expect(rep()).toMatchObject({ clockAt: iso(9), clockWhy: "restart" });
    expect(events("clock-started")).toMatchObject([{ reason: "restart" }]);
  });

  it("uses the restart rule when report_to is not the Foundry's own repository, without loading the run", async () => {
    selfRepo = "other/foundry";
    restart(0);
    storyRun("r1", `MAIN: ${SHA}`, 0);
    await closedStory();
    restart(9);
    await check(10);
    expect(rep()).toMatchObject({ clockWhy: "restart" });
    expect(getLog).toEqual([]);
  });

  it("uses the restart rule when the only succeeded run has no commit line", async () => {
    selfRepo = TARGET;
    restart(0);
    storyRun("r1", "nothing here", 0);
    await closedStory();
    restart(9);
    await check(10);
    expect(rep().fixCommit).toBeUndefined();
    expect(rep()).toMatchObject({ clockWhy: "restart", clockAt: iso(9) });
  });

  it("reads one run per check: the newest has no commit line, an older one has it", async () => {
    selfRepo = TARGET;
    restart(0);
    storyRun("old", `MAIN: ${SHA}`, 1);
    storyRun("new", "no commit", 2);
    await closedStory();
    restart(9);
    await check(10);
    expect(getLog).toEqual(["new"]);
    expect(rep().clockAt).toBeUndefined(); // restarted, but the older run may still hold the commit
    await check(11);
    expect(getLog).toEqual(["new", "old"]);
    expect(rep()).toMatchObject({ fixCommit: SHA });
    expect(rep().clockAt).toBeUndefined(); // the commit is known and not in the running build
  });

  it("tries a run that cannot be read again, and gives it up after three tries", async () => {
    selfRepo = TARGET;
    restart(0);
    storyRun("r1", `MAIN: ${SHA}`, 0);
    await closedStory();
    restart(9);
    failGets = 1;
    await check(10);
    expect(rep().clockAt).toBeUndefined();
    await check(11);
    expect(rep().fixCommit).toBe(SHA);
  });

  it("applies the restart rule when a run cannot be read three times", async () => {
    selfRepo = TARGET;
    restart(0);
    storyRun("r1", `MAIN: ${SHA}`, 0);
    await closedStory();
    restart(9);
    failGets = 3;
    await check(10);
    await check(11);
    expect(rep().clockAt).toBeUndefined();
    await check(12);
    expect(rep()).toMatchObject({ clockWhy: "restart", clockAt: iso(9) });
    expect(rep().fixCommit).toBeUndefined();
  });

  it("starts the clock anyway after fix_wait_days, and the log says so", async () => {
    selfRepo = TARGET;
    restart(0);
    storyRun("r1", `MAIN: ${SHA}`, 0);
    await closedStory();
    await check(8);
    const end = -4 + 7 * 24;
    await check(end - 1);
    expect(rep().clockAt).toBeUndefined();
    await check(end);
    expect(rep()).toMatchObject({ clockWhy: "waited", clockAt: iso(end) });
    expect(events("clock-started")).toMatchObject([{ reason: "waited", count: 7 }]);
  });

  describe("a close that is noticed while the problem is not seen", () => {
    const quietStory = async () => {
      await check(0);
      await check(1);
      close(101, 2);
      found = [];
    };
    it("asks GitHub at most every 6 hours", async () => {
      await quietStory();
      const before = calls().length;
      for (const h of [2, 3, 4, 5, 6]) await check(h);
      expect(calls().length).toBe(before);
      await check(7);
      expect(calls().length).toBe(before + 1);
      expect(rep().closedAt).toBe(iso(2));
      await check(8);
      expect(calls().length).toBe(before + 1);
    });
    it("reads the story when the list does not have it", async () => {
      await quietStory();
      process.env.FAKE_GH_BUG_ISSUES = "[]";
      await check(7);
      expect(calls().filter((c) => /\/issues\/101$/.test(c))).toHaveLength(1);
      expect(rep().closedAt).toBe(iso(2));
    });
    it("waits 6 hours after a failed call", async () => {
      await quietStory();
      process.env.FAKE_GH_FAIL_API = "list";
      await check(7);
      delete process.env.FAKE_GH_FAIL_API;
      const before = calls().length;
      await check(8);
      expect(calls().length).toBe(before);
      expect(rep().closedAt).toBeUndefined();
      await check(13);
      expect(calls().length).toBe(before + 1);
      expect(rep().closedAt).toBe(iso(2));
    });
    it("reads five stories at one check and the sixth at the next", async () => {
      perCheck = 3;
      found = ["a", "b", "c", "d", "e", "f"].map((x) => fi(x));
      await check(0);
      await check(1);
      await check(2);
      expect(gh.createdBodies()).toHaveLength(6);
      found = [];
      process.env.FAKE_GH_BUG_ISSUES = "[]";
      const reads = () => calls().filter((c) => /\/issues\/10\d$/.test(c)).length;
      await check(8);
      expect(reads()).toBe(5);
      await check(9);
      expect(reads()).toBe(6);
    });
  });

  describe("a story that is open again, or closed at another time", () => {
    // the clock runs from a restart at hour 3; the problem is away from hour 5
    const watching = async () => {
      await closedStory();
      restart(3);
      await check(3);
      found = [];
      await check(4);
      await check(5);
      expect(rep()).toMatchObject({ clockAt: iso(3) });
      expect(rep().workedMs).toBeGreaterThan(0);
    };
    const nextLook = () => (Date.parse(rep().lookedAt!) - T0.getTime()) / HOUR + 6;
    it("forgets the clock and the verdict when it is reopened", async () => {
      await watching();
      reopen(101);
      await check(nextLook());
      expect(rep().closedAt).toBeUndefined();
      for (const k of ["clockAt", "clockWhy", "workedMs", "seenAfter", "fixedAt"] as const) expect(rep()[k]).toBeUndefined();
      for (let h = nextLook() + 1; h < 40; h++) await check(h);
      expect(events("fixed")).toHaveLength(0);
      expect(fixedComments()).toHaveLength(0);
    });
    it("forgets it when the close time changed", async () => {
      await watching();
      close(101, 6);
      await check(nextLook());
      expect(rep().closedAt).toBe(iso(6));
      for (const k of ["clockAt", "workedMs", "fixedAt"] as const) expect(rep()[k]).toBeUndefined();
      expect(fixState(rep())).toBe("waiting");
    });
  });

  describe("fixed after 24 hours of normal work", () => {
    // restart at 3; the problem is away from hour 4: 24 hours of work at check 27
    const away = async () => {
      await closedStory();
      restart(3);
      await check(3);
      found = [];
    };
    const upTo = async (to: number) => {
      for (let h = 4; h <= to; h++) await check(h);
    };
    it("says fixed and writes exactly one comment", async () => {
      await away();
      await upTo(26);
      expect(rep().fixedAt).toBeUndefined();
      await check(27);
      expect(rep().fixedAt).toBe(iso(27));
      expect(events("fixed")).toMatchObject([{ issue: 101 }]);
      expect(fixedComments()).toHaveLength(1);
      expect(fixedComments()[0]).toMatchObject({ issue: 101 });
      expect(fixedComments()[0]!.body).toContain(FIXED_MARKER);
      expect(rep()).toMatchObject({ notedAt: iso(27) });
      expect(rep().fixNote).toBeUndefined();
      await check(28);
      expect(fixedComments()).toHaveLength(1);
    });
    it("writes no comment when the story is open again at that moment", async () => {
      await away();
      await upTo(26);
      reopen(101);
      await check(27);
      expect(fixedComments()).toHaveLength(0);
      expect(rep().closedAt).toBeUndefined();
      expect(rep().fixedAt).toBeUndefined();
    });
    it("does not count a sleep as normal work", async () => {
      await away();
      await upTo(15); // 12 hours
      for (let h = 30; h <= 41; h++) await check(h); // the first of them follows a sleep and counts nothing: 11 hours
      expect(rep().fixedAt).toBeUndefined();
      await check(42);
      expect(rep().fixedAt).toBe(iso(42));
    });

    it("does not count the time of a check that failed", async () => {
      await away();
      await upTo(9); // 6 hours
      failChecks = true;
      await check(10);
      failChecks = false;
      await check(11); // follows a failed check: counts nothing
      for (let h = 12; h <= 28; h++) await check(h); // 17 hours: 23 in all
      expect(rep().fixedAt).toBeUndefined();
      await check(29);
      expect(rep().fixedAt).toBe(iso(29));
    });

    describe("a lost answer, and GitHub down", () => {
      const lose = async () => {
        await away();
        await upTo(26);
        process.env.FAKE_GH_FAIL = "issue comment";
        await check(27);
        delete process.env.FAKE_GH_FAIL;
        expect(fixedComments()).toHaveLength(0);
        expect(rep()).toMatchObject({ fixNote: "tried", fixedAt: iso(27) });
      };
      const ours = (over: Record<string, unknown> = {}) => ({ comments: [{ author: { login: "someone" }, body: `Not seen since the fix.\n\n${FIXED_MARKER}`, createdAt: iso(27), viewerDidAuthor: true, ...over }] });
      it("finds our comment and writes none", async () => {
        await lose();
        process.env.FAKE_GH_COMMENTS = JSON.stringify(ours());
        await check(28);
        expect(fixedComments()).toHaveLength(0);
        expect(rep()).toMatchObject({ notedAt: iso(28) });
        expect(rep().fixNote).toBeUndefined();
        await check(29);
        expect(fixedComments()).toHaveLength(0);
      });
      it("writes exactly one comment when there is none", async () => {
        await lose();
        await check(28);
        expect(fixedComments()).toHaveLength(1);
        await check(29);
        expect(fixedComments()).toHaveLength(1);
      });
      it("does not take the marker of another account", async () => {
        await lose();
        process.env.FAKE_GH_COMMENTS = JSON.stringify(ours({ viewerDidAuthor: false }));
        await check(28);
        expect(fixedComments()).toHaveLength(1);
      });
      it("does not take a comment that only quotes the marker", async () => {
        await lose();
        process.env.FAKE_GH_COMMENTS = JSON.stringify(ours({ body: `> ${FIXED_MARKER}\nthanks!` }));
        await check(28);
        expect(fixedComments()).toHaveLength(1);
      });
      it("uses the login when gh does not say who wrote it", async () => {
        await lose();
        process.env.FAKE_GH_LOGIN = "the-bot";
        const comments = ours({ viewerDidAuthor: undefined, author: { login: "the-bot" } });
        process.env.FAKE_GH_COMMENTS = JSON.stringify(comments);
        await check(28);
        expect(fixedComments()).toHaveLength(0);
        expect(calls().filter((c) => c === "gh api user --jq .login")).toHaveLength(1);
        expect(rep()).toMatchObject({ notedAt: iso(28) });
      });
      it("does not take the comment of another login", async () => {
        await lose();
        process.env.FAKE_GH_LOGIN = "the-bot";
        process.env.FAKE_GH_COMMENTS = JSON.stringify(ours({ viewerDidAuthor: undefined, author: { login: "someone-else" } }));
        await check(28);
        expect(fixedComments()).toHaveLength(1);
      });
    });

    describe("the comment waits", () => {
      const waits = (name: string, shut: () => void, open: () => void) =>
        it(`while ${name}, and is written after`, async () => {
          await away();
          await upTo(26);
          shut();
          await check(27);
          expect(rep()).toMatchObject({ fixedAt: iso(27), fixNote: "due" });
          expect(fixedComments()).toHaveLength(0);
          await check(28);
          expect(fixedComments()).toHaveLength(0);
          open();
          await check(29);
          expect(fixedComments()).toHaveLength(1);
          expect(rep().notedAt).toBe(iso(29));
        });
      waits("bug stories are off", () => (verdict = { go: false, reason: "off", note: "bug stories are off" }), () => (verdict = { go: true }));
      waits("it is quiet after a restart", () => (verdict = { go: false, reason: "cooldown", note: "quiet time after the restart" }), () => (verdict = { go: true }));
      waits("the breaker is open", () => (verdict = { go: false, reason: "breaker", note: "the circuit breaker is open" }), () => (verdict = { go: true }));
      waits(
        "the finding is muted",
        () => (mutes = [{ id: "m1", kind: "detector", detector: "restart-loop", reason: "noise", since: iso(0), by: "u" }]),
        () => (mutes = []),
      );
    });
  });

  describe("seen again after the clock started", () => {
    const away = async () => {
      await closedStory();
      restart(3);
      await check(3);
      found = [];
    };
    it("one sighting cancels 'fixed' and makes no story", async () => {
      await away();
      for (let h = 4; h <= 12; h++) await check(h);
      found = [fi("a")];
      await check(13);
      expect(rep().seenAfter).toBe(iso(13));
      expect(events("came-back")).toHaveLength(1);
      found = [];
      for (let h = 14; h <= 40; h++) await check(h);
      expect(rep().fixedAt).toBeUndefined();
      expect(fixState(rep())).toBe("watched");
      expect(gh.createdBodies()).toHaveLength(1);
      expect(fixedComments()).toHaveLength(0);
    });
    it("a fixed finding that is seen at two checks in a row gets its second story, which links the first", async () => {
      await away();
      for (let h = 4; h <= 27; h++) await check(h);
      expect(rep().fixedAt).toBe(iso(27));
      found = [fi("a")];
      await check(30);
      expect(gh.createdBodies()).toHaveLength(1);
      expect(rep().seenAfter).toBe(iso(30));
      await check(31);
      const bodies = gh.createdBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]!.body).toContain("Came back after the fix");
      expect(bodies[1]!.body).toContain("#101");
      expect(rep()).toMatchObject({ issue: 102 });
      expect(rep().clockAt).toBeUndefined();
      expect(stored().earlier).toMatchObject([{ issue: 101, closedAt: iso(-4) }]);
    });
    it("keeps the story owed when the problem goes away again", async () => {
      await away();
      for (let h = 4; h <= 12; h++) await check(h);
      found = [fi("a")];
      await check(13);
      await check(14);
      expect(gh.createdBodies()).toHaveLength(2);
    });
  });

  it("a story closed as not planned works as before (no clock, no fix state)", async () => {
    await check(-6);
    await check(-5);
    close(101, -4, "not_planned");
    await check(1);
    restart(4);
    await check(5);
    expect(rep().muted).toBe(true);
    expect(rep().clockAt).toBeUndefined();
    expect(fixState(rep())).toBeUndefined();
  });

  it("an older findings file: a story closed before the upgrade starts as waiting", async () => {
    await closedStory();
    expect(fixState(rep())).toBe("waiting");
    expect(rep().fixCommit).toBeUndefined();
  });

  describe("two tries, then a person", () => {
    const sight = async (h: number) => {
      found = [fi("a", { evidence: { counts: { runs: 2 }, times: [iso(h)] } })];
      await check(h);
    };
    /** Stories #101 and #102 are made and #102 is closed; the problem is seen again until the monitor decides. */
    const twoStories = async () => {
      await closedStory();
      restart(4);
      for (let h = 5; h <= 8; h++) await sight(h);
      expect(gh.createdBodies()).toHaveLength(2);
      expect(rep()).toMatchObject({ issue: 102 });
      expect(stored().tries).toBe(2);
      close(102, 9);
      restart(12);
      for (let h = 13; h <= 20; h++) await sight(h);
    };
    const skips = () => recorded.filter((e) => e.event === "story-skipped" && e.reason === "two_tries");
    it("makes no third story and marks the finding once", async () => {
      await twoStories();
      expect(gh.createdBodies()).toHaveLength(2);
      expect(stored().needsYou).toBeDefined();
      expect(stored().due).toBeUndefined();
      expect(skips()).toMatchObject([{ issue: 102 }]);
      await sight(21);
      expect(skips()).toHaveLength(1);
      expect(gh.createdBodies()).toHaveLength(2);
    });
    it("makes no mark while stories are off", async () => {
      verdict = { go: false, reason: "off", note: "bug stories are switched off" };
      await twoStories().catch(() => {});
      expect(stored().needsYou).toBeUndefined();
      expect(skips()).toHaveLength(0);
    });
    it("lets a third story be made after try again, and links the newest earlier story", async () => {
      await twoStories();
      const f = loadFindings(file).findings;
      saveFindings(f.map((x) => tryAgain(x)), file);
      await sight(21);
      await sight(22);
      const bodies = gh.createdBodies();
      expect(bodies).toHaveLength(3);
      expect(bodies[2]!.body).toContain("#102");
      expect(stored()).toMatchObject({ tries: 1 });
      expect(stored().needsYou).toBeUndefined();
    });
    it("counts a successor story that was made but whose save was lost, when it is adopted", async () => {
      await closedStory();
      expect(stored().tries).toBe(1);
      const first = gh.bugIssues().find((i) => i.number === 101)!;
      gh.setBugIssues([...gh.bugIssues(), { ...first, number: 102, state: "open", state_reason: null, closed_at: null, html_url: `https://github.com/${TARGET}/issues/102`, body: `lost\n\n${markerFor("restart-loop|a")}` } as FakeIssue]);
      await check(7);
      expect(rep()).toMatchObject({ issue: 102 });
      expect(stored().tries).toBe(2);
      expect(gh.createdBodies()).toHaveLength(1);
    });
    it("keeps the count of a story from before the upgrade when GitHub no longer has the story", async () => {
      await closedStory();
      const old = loadFindings(file).findings.map((x) => {
        const { tries: _tries, ...rest } = x;
        return rest as Finding;
      });
      saveFindings(old, file);
      process.env.FAKE_GH_BUG_ISSUES = "[]";
      rmSync(`${process.env.FAKE_GH_LOG}.issues.json`, { force: true });
      found = [];
      await check(7);
      expect(stored().report).toBeUndefined();
      expect(stored().tries).toBe(1);
    });
  });
});
