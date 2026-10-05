import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WatcherSchema } from "../src/config.js";
import { resumeRun } from "../src/engine/runner.js";
import { findingsFile } from "../src/monitor/findings.js";
import { guardFile, logFile, switchStories } from "../src/monitor/guard.js";
import { scanText } from "../src/monitor/clean.js";
import { WatcherManager } from "../src/queue/watchers.js";
import { claudeBin } from "./helpers/fake-github.js";
import { expectClean, HEALTHY, makeWorld, PRIVATE, rateJson, REPO, WATCHER_ID, type World } from "./helpers/self-repair.js";

// The five rules of self-repair, each proved on the whole loop: nothing private leaves, one problem is one story,
// a flood is stopped, a feature run cannot reach main, and with the monitor off nothing happens.
const HOUR = 3_600_000;
const LOOP = "restart-loop|issue-gitflow|claim_areas";
const FILES = ["tests/helpers/self-repair.ts", "tests/self-repair-incidents.test.ts", "tests/self-repair-rules.test.ts"];

describe("self-repair rules", { timeout: 240_000 }, () => {
  let w: World | undefined;
  afterEach(() => {
    w?.close();
    w = undefined;
  });

  const world = async (...a: Parameters<typeof makeWorld>) => (w = await makeWorld(...a));
  const loop = (x: World, step: string, issue = 31) =>
    x.seedRun({
      status: "stopped", reason: 'stopped at step "wait_for_area"', vars: { github_repo: REPO, issue: String(issue) },
      resumeLog: Array.from({ length: 24 }, (_, i) => ({ at: new Date(x.now().getTime() - (24 - i) * 25_000).toISOString(), from: step })),
    });

  it("the test files hold nothing a secret scanner would stop", async () => {
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      expect(await scanText(text), f).toBe(text);
    }
  });

  it("private data never reaches GitHub: a custom flow on a private repository", async () => {
    const x = await world();
    for (const issue of [41, 42, 43]) {
      x.seedRun({
        flow: "zanzibar-flow", status: "failed", reason: 'step "build_it" failed: boom', vars: { github_repo: PRIVATE.repo, issue: String(issue) },
        history: [{
          id: "build_it", type: "shell", ok: false, output: "", startedAt: x.now().toISOString(), durationMs: 1, logFile: "",
          error: `cannot write ${PRIVATE.home}/projects/payroll with ${PRIVATE.token} for ${PRIVATE.email} (${PRIVATE.name})`,
        } as never],
      });
    }
    await x.check();
    await x.check();
    expect(x.stories()).toHaveLength(1);
    const body = x.stories()[0]!.body;
    expect(body).toContain("a custom flow");
    expect(body).toMatch(/log lines are left out/i);
    expect(x.sent().length).toBeGreaterThan(0);
    expectClean(x);
  });

  it("one problem is one open story, also when the findings file is lost", async () => {
    const x = await world();
    loop(x, "claim_areas");
    await x.check();
    await x.check();
    const [story] = x.stories();
    expect(story).toBeTruthy();
    rmSync(findingsFile(), { force: true }); // the story must be found again by its marker, not by the file
    x.restartMonitor();
    for (let i = 0; i < 3; i++) await x.check();
    expect(x.stories()).toHaveLength(1);
    expect(x.stories()[0]).toMatchObject({ number: story!.number, state: "open" });
    expect(x.findings().find((f) => f.fingerprint === LOOP)!.report!.issue).toBe(story!.number);
  });

  it("a flood of problems opens the circuit breaker, and then three stories a day at most", async () => {
    const x = await world();
    x.awayFromMidnight();
    for (const [i, step] of ["claim_areas", "plan", "implement", "run_tests", "push_feature", "report"].entries()) loop(x, step, 31 + i);
    await x.check();
    expect(x.log("breaker-open")).toHaveLength(1);
    await x.check();
    expect(x.stories()).toHaveLength(0);
    const skipped = x.log("story-skipped");
    expect(skipped).toHaveLength(6);
    expect(skipped.every((e) => e.reason === "breaker")).toBe(true);
    switchStories("on", "cli", { now: x.now() });
    for (let i = 0; i < 5; i++) await x.check();
    expect(x.stories()).toHaveLength(3);
  });

  it("a feature run cannot reach main, and the hotfix steps refuse a feature run", async () => {
    const tries = ["main", "main:00", "main:$(ls $FACTORY_HOME/hooks/allow 2>/dev/null | head -1)"]
      .map((v) => `FACTORY_PUSH_ALLOW="${v}" git push -q origin HEAD:main 2>>"$TEST_BRANCH_LOG"; `).join("");
    const x = await world({ testCmd: `${tries}! grep -q BUG feature.txt 2>/dev/null` });
    process.env.TEST_BRANCH_LOG = join(x.gh.tmp, "push.log");
    try {
      const mainBefore = x.rev("main");
      x.issues({ number: 7 });
      await x.watch();
      await x.settle();
      const run = x.runOf(7)!;
      expect(run.status, run.reason).toBe("succeeded");
      expect(x.rev("main")).toBe(mainBefore);
      expect(readFileSync(process.env.TEST_BRANCH_LOG, "utf8")).toContain("protected branch 'main' is blocked");
      expect(run.history.map((h) => h.id)).not.toContain("push_main");
      const again = await resumeRun({ runsDir: x.dirs.runs, runId: run.runId, claudeBin, config: x.config, from: "push_main" });
      expect(again.history.filter((h) => h.id === "push_main").at(-1)?.output ?? "").toContain("not a hotfix");
      expect(x.rev("main")).toBe(mainBefore);
    } finally {
      delete process.env.TEST_BRANCH_LOG;
    }
  });

  it("with no monitor watcher nothing is created", async () => {
    const x = await world({ monitorWatcher: false });
    loop(x, "claim_areas");
    const manager = new WatcherManager({ scheduler: x.scheduler, runsDir: x.dirs.runs, repo: x.gh.tmp, config: () => x.config, log: () => {}, startedAt: new Date(Date.now() - HOUR) });
    try {
      manager.sync();
      await manager.runNow(WATCHER_ID);
      await manager.runNow(WATCHER_ID);
      expect(manager.monitorRunning()).toBe(false);
      await expect(manager.runNow("monitor")).rejects.toThrow();
      for (const f of [findingsFile(), logFile(), guardFile()]) expect(existsSync(f), f).toBe(false);
      expect(x.storyCalls()).toEqual([]);
      expect(x.stories()).toEqual([]);
      expect(x.gh.ghLog()).not.toContain("gh api rate_limit");

      // The control: the same world with the monitor on finds it and makes the story.
      x.config.watchers.push(WatcherSchema.parse({ id: "monitor", source: "monitor", every: "1h" }));
      manager.sync();
      for (let i = 0; i < 100 && !manager.monitorLastCheck(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(manager.monitorRunning()).toBe(true);
      await manager.runNow("monitor");
      expect(existsSync(findingsFile())).toBe(true);
      expect(x.stories()).toHaveLength(1);
    } finally {
      manager.stopAll();
    }
  });

  it("without report_to the problems are found and no story is made", async () => {
    const x = await world({ reportTo: false });
    loop(x, "claim_areas");
    for (let i = 0; i < 3; i++) await x.check();
    expect(x.findings().map((f) => f.fingerprint)).toEqual([LOOP]);
    expect(x.storyCalls()).toEqual([]);
  });

  it("the switch stops stories, and 'on' brings them back", async () => {
    const x = await world();
    loop(x, "claim_areas");
    switchStories("off", "cli", { now: x.now() });
    for (let i = 0; i < 3; i++) await x.check();
    expect(x.findings().map((f) => f.fingerprint)).toEqual([LOOP]);
    expect(x.storyCalls()).toEqual([]);
    expect(x.log("story-skipped").filter((e) => e.reason === "off")).toHaveLength(1);
    switchStories("on", "cli", { now: x.now() });
    await x.check();
    expect(x.stories()).toHaveLength(1);
  });

  it("with GitHub's request limit used up no call is made, and the story comes after the reset", async () => {
    const x = await world();
    process.env.FAKE_GH_RATE_LIMIT = rateJson({ core: [5000, 5000], graphql: [100, 5000] });
    loop(x, "claim_areas");
    await x.check();
    await x.check();
    expect(x.storyCalls()).toEqual([]);
    expect(x.log("story-skipped").filter((e) => e.reason === "request_limit").length).toBeGreaterThan(0);
    process.env.FAKE_GH_RATE_LIMIT = HEALTHY();
    await x.check();
    expect(x.stories()).toHaveLength(1);
  });
});
