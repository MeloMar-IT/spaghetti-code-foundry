import { afterEach, describe, expect, it, vi } from "vitest";
import { markerFor } from "../src/monitor/story.js";
import { expectClean, INCIDENTS, makeWorld, type World } from "./helpers/self-repair.js";

// The loop of the self-repair work, replayed on four real incidents with real parts and fake edges:
// finding → bug story → goes first → hotfix → fix commit → 24-hour watch → fixed.
const HOUR = 3_600_000;

describe.each(INCIDENTS)("incident $id", (inc) => {
  let w: World | undefined;
  afterEach(() => {
    w?.close();
    w = undefined;
  });

  it(`finds it, makes the story by the second check, repairs it and sees it fixed (${inc.realCase})`, { timeout: 240_000 }, async () => {
    w = await makeWorld({ testCmd: inc.testCmd });
    const fp = inc.fingerprint;
    await inc.stage(w);

    // 1. The first check sees the problem and says nothing to GitHub.
    await w.check();
    expect(w.findings().map((f) => f.fingerprint)).toEqual([fp]);
    expect(w.findings()[0]).toMatchObject({ severity: inc.severity });
    expect(w.storyCalls()).toEqual([]);

    // 2. The second check makes the story: the measure is "no later than the second check".
    await w.check();
    const made = w.stories();
    expect(made).toHaveLength(1);
    const story = made[0]!;
    expect(story.title).toBe(inc.title);
    expect(story.labels.map((l) => l.name)).toEqual(["bug", "Factory_go"]);
    expect(story.body).toContain(markerFor(fp));
    expect(w.storyMadeAt(fp)! - w.firstSeenAt(fp)! + 1).toBeLessThanOrEqual(2);

    // 3. The problem lasts: still one story, and the finding counts the checks.
    await inc.lasts?.(w);
    const seen = w.findings()[0]!.report!.seen;
    await w.check();
    await w.check();
    expect(w.stories()).toHaveLength(1);
    expect(w.findings()[0]!.report!.seen).toBeGreaterThan(seen);

    // 4. The story goes first: an older ordinary issue waits behind it.
    if (inc.heal?.when === "before the build") await inc.heal.run(w);
    const submit = vi.spyOn(w.scheduler, "submit");
    w.addIssue({ number: 7, createdAt: new Date(w.now().getTime() - 24 * HOUR).toISOString() });
    await w.watch();
    expect(submit.mock.calls.some(([, meta]) => (meta as { priority?: boolean; source?: string } | undefined)?.priority === true
      && (meta as { source?: string }).source === `watcher acme-stories issue #${story.number}`)).toBe(true);
    expect(w.watcher.tracked.find((t) => t.issue === story.number)?.priority).toBe(true);
    expect(w.watcher.status.holds?.find((h) => h.issue === 7)?.next.kind).toBe("bug_first");

    // 5. The hotfix: the story's run ends on main and on develop, and the story is closed.
    await w.settle();
    const run = w.runOf(story.number)!;
    expect(run.status, run.reason).toBe("succeeded");
    const ids = run.history.map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(["push_main", "merge_back", "push_back", "hotfix_done"]));
    expect(run.history.find((h) => h.id === "pull_ticket")!.output).toContain(inc.title);
    expect(w.gh.remoteGit("log", "-1", "--format=%s", "main").trim()).toMatch(new RegExp(`^Merge #${story.number}:`));
    expect(w.gh.remoteGit("merge-base", "--is-ancestor", "main", "develop").trim()).toBe("");
    const closed = w.stories()[0]!;
    expect(closed).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(w.gh.comments().some((c) => c.issue === story.number && c.body.includes("The running Foundry does not have this fix yet"))).toBe(true);

    // 6. An ordinary issue after the fix goes through develop only.
    if (inc.heal?.when === "after the fix") await inc.heal.run(w);
    const mainAfterFix = w.rev("main");
    await w.watch();
    await w.settle();
    const seven = w.runOf(7)!;
    expect(seven.status, seven.reason).toBe("succeeded");
    expect(seven.history.map((h) => h.id)).not.toContain("push_main");
    expect(w.rev("main")).toBe(mainAfterFix);

    // 7. The monitor reads the fix commit from the run; the clock waits for the running Foundry to have it.
    w.advance(6 * HOUR);
    await w.check();
    await w.check();
    const waiting = w.findings().find((f) => f.fingerprint === fp)!.report!;
    expect(waiting.closedAt).toBeTruthy();
    expect(waiting.fixCommit).toBe(mainAfterFix);
    expect(waiting.clockAt).toBeUndefined();

    // 8. The Foundry restarts on the new main: the 24-hour clock starts.
    w.takeTheFix();
    await w.check();
    expect(w.findings().find((f) => f.fingerprint === fp)!.report!.clockWhy).toBe("update");

    // 9. 24 hours of normal work without the problem: fixed.
    let n = 0;
    while (!w.findings().find((f) => f.fingerprint === fp)?.report?.fixedAt && n++ < 60) {
      w.advance(HOUR);
      await w.check();
    }
    const done = w.findings().find((f) => f.fingerprint === fp)!.report!;
    expect(done.fixedAt, `not fixed after ${n} checks`).toBeTruthy();
    expect(done.workedMs!).toBeGreaterThanOrEqual(24 * HOUR);
    expect(Date.parse(done.fixedAt!) - Date.parse(done.clockAt!)).toBeGreaterThanOrEqual(24 * HOUR);
    await w.check();
    expect(w.gh.comments().filter((c) => c.issue === story.number && c.body.startsWith("Not seen since the fix.")).length).toBe(1);

    // 10. The log tells the same story, and nothing went wrong on the way.
    expect(w.log("story-made")).toHaveLength(1);
    expect(w.log("clock-started")).toHaveLength(1);
    expect(w.log("clock-started")[0]).toMatchObject({ reason: "update" });
    expect(w.log("fixed")).toHaveLength(1);
    for (const e of ["fix-failed", "came-back", "breaker-open"]) expect(w.log(e), e).toHaveLength(0);
    expect(w.findings().map((f) => f.fingerprint)).toEqual([fp]);
    expect(w.stories()).toHaveLength(1);
    expectClean(w);
  });
});
