import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { blockers, dependencyWaits, fileWaits } from "../src/ops/blockage.js";
import { loadCaps, runLimit, setCap } from "../src/ops/caps.js";
import { runBlockage, runDigest, runFlaky, runLimits } from "../src/ops/cli.js";
import { digestFacts } from "../src/ops/digest.js";
import { parseTestLog, stories, suspects } from "../src/ops/flaky.js";
import { clearGovernor, decide, runGovernor, type Sample } from "../src/ops/governor.js";
import { forecast } from "../src/ops/limits.js";
import { installJob, jobPlist, labelOf, uninstallJob } from "../src/ops/schedule.js";
import type { ServiceHost } from "../src/service.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const tmp = () => mkdtempSync(join(tmpdir(), "scf-ops-"));
const calm: Sample = { load1: 0.5, load5: 0.5, pressure: 1 };
const hot: Sample = { load1: 3, load5: 3, pressure: 1 };

type Shape = Partial<StepRecord> & { id: string };
function run(id: string, o: Partial<RunSummary> & { issue?: string; steps?: Shape[]; at?: number } = {}): RunSummary {
  const at = new Date(o.at ?? NOW.getTime() - HOUR).toISOString();
  const history = (o.steps ?? []).map((s) => ({ type: "claude", visit: 1, ok: true, output: "", startedAt: at, durationMs: 1000, logFile: "", ...s }));
  const { issue, steps: _s, at: _a, ...rest } = o;
  return { runId: id, flow: "issue-gitflow", status: "succeeded", startedAt: at, vars: issue ? { issue, github_repo: "acme/app" } : {}, history, state: { steps: {} }, ...rest } as unknown as RunSummary;
}

describe("the cap on runs at once", () => {
  it("lowers the configured number while it holds, never below 1, and ends by itself", () => {
    const file = join(tmp(), "governor", "caps.json");
    expect(runLimit(6, NOW, file)).toBe(6);
    setCap("load", { runs: 4, until: new Date(NOW.getTime() + 60_000).toISOString(), why: "x" }, file);
    setCap("limits", { runs: 3, until: new Date(NOW.getTime() - 60_000).toISOString(), why: "old" }, file);
    expect(runLimit(6, NOW, file)).toBe(4);
    expect(runLimit(2, NOW, file)).toBe(2);
    expect(runLimit(0, NOW, file)).toBe(0);
    expect(runLimit(6, new Date(NOW.getTime() + 120_000), file)).toBe(6);
    setCap("load", undefined, file);
    expect(Object.keys(loadCaps(file))).toEqual(["limits"]);
    writeFileSync(file, "{broken");
    expect(runLimit(6, NOW, file)).toBe(6);
  });

  it("test-slot honours the governor's cap file", () => {
    const dir = tmp();
    mkdirSync(join(dir, "slot-1"));
    writeFileSync(join(dir, "slot-1", "pid"), String(process.pid));
    writeFileSync(join(dir, "cap"), "1");
    const out = execFileSync(process.execPath, ["tools/test-slot", dir, "echo", "ran"], { encoding: "utf8", env: { ...process.env, FACTORY_VAR_TEST_SLOTS: "2", FACTORY_TEST_SLOT_WAIT_SEC: "1", FACTORY_TEST_SLOT_POLL_MS: "100" } });
    expect(out).toContain("1 test run(s) are already working");
    writeFileSync(join(dir, "cap"), "nonsense");
    expect(execFileSync(process.execPath, ["tools/test-slot", dir, "echo", "ran"], { encoding: "utf8", env: { ...process.env, FACTORY_VAR_TEST_SLOTS: "2" } })).not.toContain("already working");
  });
});

describe("the load governor", () => {
  it("goes one run down per check under load, not below half, and one up after five calm checks", () => {
    let s = decide({ calm: 0 }, hot, 6);
    expect(s).toMatchObject({ state: { runs: 5 }, change: "runs at once 6 → 5 (load 3.0 per core)" });
    for (let i = 0; i < 5; i++) s = decide(s.state, hot, 6);
    expect(s.state.runs).toBe(3);
    expect(s.change).toBeUndefined();
    for (let i = 0; i < 4; i++) s = decide(s.state, calm, 6);
    expect(s.state).toEqual({ calm: 4, runs: 3 });
    s = decide(s.state, calm, 6);
    expect(s).toMatchObject({ state: { calm: 0, runs: 4 }, change: "runs at once 3 → 4 (calm: load 0.5 per core)" });
    // neither hot nor calm: nothing moves and the calm count starts again
    expect(decide({ calm: 3, runs: 4 }, { load1: 2, load5: 2, pressure: 1 }, 6).state).toEqual({ calm: 0, runs: 4 });
    // back at the configured number the cap is gone
    expect(decide({ calm: 4, runs: 5 }, calm, 6).state).toEqual({ calm: 0 });
  });

  it("reacts to memory pressure and limits test runs under very high load", () => {
    expect(decide({ calm: 0 }, { ...calm, pressure: 2 }, 6).change).toContain("memory pressure warning");
    const s = decide({ calm: 0 }, { load1: 5, load5: 5, pressure: 1 }, 6);
    expect(s.state).toEqual({ calm: 0, runs: 5, tests: 1 });
    expect(decide(s.state, { load1: 3, load5: 4, pressure: 1 }, 6).change).toContain("test runs at once: back to normal");
    expect(decide({ calm: 0 }, hot, 1).state).toEqual({ calm: 0 });
  });

  it("writes the caps and a log line, and takes everything away on reset", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 6, now: NOW };
    runGovernor({ ...o, sample: { load1: 5, load5: 5, pressure: 1 } });
    expect(runLimit(6, NOW, o.capsFile)).toBe(5);
    expect(readFileSync(join(o.slotsDir, "cap"), "utf8")).toBe("1");
    expect(readFileSync(join(o.dir, "changes.log"), "utf8")).toContain("2026-10-12T12:00:00.000Z runs at once 6 → 5");
    // a governor that stops checking does not hold the Foundry down
    expect(runLimit(6, new Date(NOW.getTime() + 5 * 60_000), o.capsFile)).toBe(6);
    clearGovernor(o.dir, o.slotsDir, o.capsFile);
    expect([runLimit(6, NOW, o.capsFile), existsSync(join(o.slotsDir, "cap"))]).toEqual([6, false]);
  });
});

describe("unreliable tests", () => {
  const log = (extra = "") => `\x1b[31m FAIL \x1b[39m tests/a.test.ts > suite > breaks\n FAIL  tests/a.test.ts > suite > breaks\n   ✓ passes late 120ms (retry x1)\n   ✓ fine 3ms\nFooTest > bar() FAILED\n${extra}`;

  it("reads failed and retried tests from Vitest and Gradle output, with a likely cause", () => {
    const hits = parseTestLog(log("Error: listen EADDRINUSE: address already in use 127.0.0.1:1"), "r1", "acme/app#1");
    expect(hits.map((h) => [h.test, h.kind, h.cause])).toEqual([
      ["tests/a.test.ts > suite > breaks", "failed", "a network port was already in use"],
      ["passes late", "retried", ""],
      ["FooTest > bar()", "failed", "a network port was already in use"],
    ]);
  });

  it("lists a test only when it went wrong in three different stories, and files one story per test file once", () => {
    const hits = ["1", "2", "2", "3"].flatMap((n, i) => parseTestLog(log(), `r${i}`, `acme/app#${n}`));
    const list = suspects(hits);
    expect(list.map((s) => [s.test, s.failedIn.length, s.retriedIn.length])).toEqual([["tests/a.test.ts > suite > breaks", 3, 0], ["FooTest > bar()", 3, 0], ["passes late", 0, 3]]);
    expect(suspects(hits.filter((h) => h.issue !== "acme/app#3"))).toEqual([]);
    expect(stories(list, {}).map((s) => s.key)).toEqual(["tests/a.test.ts", "FooTest"]);
    expect(stories(list, { "tests/a.test.ts": "url" }).map((s) => s.key)).toEqual(["FooTest"]);
  });

  it("runFlaky reports, and files stories only when that is switched on", () => {
    const home = tmp();
    for (const n of [1, 2, 3]) {
      mkdirSync(join(home, "runs", `r${n}`), { recursive: true });
      writeFileSync(join(home, "runs", `r${n}`, "tests.log"), log());
      writeFileSync(join(home, "runs", `r${n}`, "run.json"), JSON.stringify({ vars: { issue: String(n), github_repo: "acme/app" } }));
    }
    const dir = join(home, "flaky");
    const filed: string[] = [];
    const file = (repo: string, s: { title: string }, label: string) => (filed.push(`${repo} ${label} ${s.title}`), "https://example.test/1");
    const off = runFlaky({ runsDir: join(home, "runs"), dir, now: new Date(), file });
    expect(off.text).toContain("| tests/a.test.ts > suite > breaks | 3 | 0 |");
    expect(filed).toEqual([]);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ auto: true }));
    const on = runFlaky({ runsDir: join(home, "runs"), dir, now: new Date(), file });
    expect(filed).toEqual(["acme/app Factory_go Unreliable tests in tests/a.test.ts", "acme/app Factory_go Unreliable tests in FooTest"]);
    expect(on.text).toContain("https://example.test/1");
    runFlaky({ runsDir: join(home, "runs"), dir, now: new Date(), file });
    expect(filed).toHaveLength(2);
  });
});

describe("usage limits", () => {
  const step = (hoursAgo: number, tokens: number, agent = "claude:anthropic:x"): RunSummary => run(`r${hoursAgo}`, { at: NOW.getTime() - hoursAgo * HOUR, steps: [{ id: "implement", agent, tokens: { input: tokens, output: 0 } }] });
  const reset = new Date(NOW.getTime() + 48 * HOUR).toISOString();

  it("works out the weekly limit from one reading and says when it is reached", () => {
    // 100 tokens used when a person read 50%: the week holds 200; 120 more since, 5 per hour over the last day
    const runs = [step(60, 100), step(20, 60), step(10, 60)];
    const cal = { percent: 50, at: new Date(NOW.getTime() - 30 * HOUR).toISOString(), resetAt: reset };
    const f = forecast(runs, "claude", cal, NOW, 6);
    expect(f).toMatchObject({ percentNow: 110, perHour: 5, runs: 1 });
    expect(f.emptyAt).toBe(NOW.toISOString());
    const slow = forecast([step(60, 100), step(10, 12)], "claude", cal, NOW, 6);
    expect([slow.percentNow, slow.emptyAt, slow.runs]).toEqual([56, undefined, undefined]);
    // 52 left at 2 per hour lasts 26 hours, the reset is in 48: about half the runs make it last
    const close = forecast([step(60, 100), step(10, 48)], "claude", cal, NOW, 6);
    expect(close.runs).toBe(3);
  });

  it("gives only the pace without a usable reading, and counts steps a limit stopped", () => {
    const runs = [step(2, 2400, "codex:openai"), run("lim", { steps: [{ id: "review_1", agent: "codex:openai", limited: true, ok: false }] })];
    const f = forecast(runs, "codex", undefined, NOW, 6);
    expect([f.perHour, f.limitHits, f.percentNow]).toEqual([100, 1, undefined]);
    expect(f.note).toContain("scf limits set codex");
    expect(forecast(runs, "codex", { percent: 2, at: NOW.toISOString(), resetAt: reset }, NOW, 6).note).toContain("too early");
    expect(forecast(runs, "claude", undefined, NOW, 6).perHour).toBe(0);
  });

  it("runLimits sets a cap only when slowing down is switched on", () => {
    const dir = tmp();
    const capsFile = join(dir, "caps.json");
    const runs = [step(60, 100), step(10, 48)];
    const state = (auto: boolean) => writeFileSync(join(dir, "state.json"), JSON.stringify({ auto, calibrations: { claude: { percent: 50, at: new Date(NOW.getTime() - 30 * HOUR).toISOString(), resetAt: reset } } }));
    state(false);
    expect(runLimits({ runs, dir, capsFile, configured: 6, now: NOW })).toContain("3 runs at once would make it last");
    expect(runLimit(6, NOW, capsFile)).toBe(6);
    state(true);
    runLimits({ runs, dir, capsFile, configured: 6, now: NOW });
    expect(runLimit(6, NOW, capsFile)).toBe(3);
    state(false);
    runLimits({ runs, dir, capsFile, configured: 6, now: NOW });
    expect(runLimit(6, NOW, capsFile)).toBe(6);
  });
});

describe("what holds work up", () => {
  const runs = [
    run("h1", { issue: "10", status: "running", stepStartedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(), state: { next: "merge_develop", steps: {} } as never }),
    run("w1", { issue: "11", status: "stopped", steps: [{ id: "wait_for_area", output: "waiting for run h1 (ui/app.js)" }] }),
    run("w2", { issue: "12", status: "stopped", steps: [{ id: "wait_for_area", output: "waiting for run h1 (ui/app.js)" }] }),
    run("old", { issue: "12", status: "stopped", at: NOW.getTime() - 5 * HOUR, steps: [{ id: "wait_for_area", output: "waiting for run gone (x)" }] }),
  ];
  const log = [
    `${new Date(NOW.getTime() - 60_000).toISOString()} [scf] #13 waits for #12, #99 (depends on)`,
    `${new Date(NOW.getTime() - 60_000).toISOString()} [scf] #14 waits for #13 (depends on)`,
    `${new Date(NOW.getTime() - 3 * HOUR).toISOString()} [scf] #15 waits for #14 (depends on)`,
  ].join("\n");

  it("finds the story at the root of the waiting, through files and dependencies", () => {
    const waits = [...fileWaits(runs), ...dependencyWaits(log, NOW)];
    expect(waits).toHaveLength(5);
    const list = blockers(waits, runs, NOW);
    expect(list.map((b) => [b.story, b.holdsUp, b.state])).toEqual([
      ["#10", ["#11", "#12", "#13", "#14"], "working on merge_develop for 20 minutes"],
      ["#99", ["#13", "#14"], "not started"],
    ]);
  });

  it("runBlockage says when run slots are empty while stories wait", () => {
    const text = runBlockage({ runs, dir: tmp(), serviceLog: log, limit: 6, now: NOW, alive: () => true });
    expect(text).toContain("1 of 6 runs are working; 4 stories wait for another.");
    expect(text).toContain("**5 run slots are empty while stories wait.**");
    expect(text).toContain("| #10 | 4: #11, #12, #13, #14 | working on merge_develop for 20 minutes |");
    expect(runBlockage({ runs: [], dir: tmp(), serviceLog: "", limit: 6, now: NOW })).toContain("Nothing holds other work up.");
  });
});

describe("the digest", () => {
  const ticket = (n: string, title: string) => ({ steps: { pull_ticket: { output: `# #${n}: ${title}\n\nbody` } } }) as never;
  const runs = [
    run("d1", { issue: "1", state: ticket("1", "Add a page"), steps: [{ id: "report" }] }),
    run("d1old", { issue: "1", status: "failed", at: NOW.getTime() - 9 * HOUR }),
    run("s1", { issue: "2", steps: [{ id: "create_split" }] }),
    run("f1", { issue: "3", status: "failed", failureNote: { kind: "code", why: "the tests still fail", by: "x" } }),
    run("w1", { issue: "4", status: "waiting", at: NOW.getTime() - 50 * HOUR, waiting: { stepId: "approve_plan", message: "Approve the plan?", since: "" } }),
    run("r1", { issue: "5", status: "running" }),
    run("long-ago", { issue: "6", at: NOW.getTime() - 30 * HOUR, steps: [{ id: "report" }] }),
    run("no-issue", { steps: [{ id: "report" }] }),
  ];

  it("takes the newest run of each story from the last day; what waits for you stays however old", () => {
    expect(digestFacts(runs, NOW)).toEqual({ done: ["#1: Add a page"], split: ["#2"], failed: ["#3 — the tests still fail"], waiting: ["#4 — Approve the plan?"], working: 1 });
  });

  it("runDigest writes the day's file with what the other helpers found", () => {
    const home = tmp();
    mkdirSync(join(home, "governor"));
    writeFileSync(join(home, "governor", "changes.log"), `${new Date(NOW.getTime() - HOUR).toISOString()} runs at once 6 → 5 (load 3.0 per core)\n2026-01-01T00:00:00.000Z old\n`);
    mkdirSync(join(home, "blockage"));
    writeFileSync(join(home, "blockage", "latest.json"), JSON.stringify({ blockers: [{ story: "#10", holdsUp: ["#11"], state: "failed — needs a look" }] }));
    const r = runDigest({ runs, home, now: NOW });
    expect(r.line).toBe("1 done, 1 failed, 1 waits for you, 1 in progress");
    const text = readFileSync(join(home, "digest", "2026-10-12.md"), "utf8");
    expect(text).toBe(readFileSync(join(home, "digest", "report.md"), "utf8"));
    expect(text.indexOf("## Waits for you")).toBeLessThan(text.indexOf("## Done"));
    expect(text).toContain("- #10 holds up 1 (failed — needs a look)");
    expect(text).toContain("the governor changed the limits 1 time; last: runs at once 6 → 5 (load 3.0 per core)");
    expect(text).not.toContain("## Unreliable tests");
  });
});

describe("the login agents of the helpers", () => {
  it("run by interval or at a time of day, each under its own label", () => {
    const every = jobPlist({ name: "governor", everySec: 60 }, { cliPath: "/x/cli.js", logFile: "/x/g.log" });
    expect(every).toContain("<key>StartInterval</key><integer>60</integer>");
    expect(every).toContain("<string>governor</string>\n    <string>run</string>");
    const daily = jobPlist({ name: "digest", daily: { hour: 7, minute: 30 } }, { cliPath: "/x/cli.js", logFile: "/x/d.log" });
    expect(daily).toContain("<key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer>");
    expect(daily).not.toContain("StartInterval");
    expect(labelOf("digest")).toBe("com.spaghetti-code-foundry.digest");
  });

  it("installs and removes only its own agent", () => {
    const calls: string[][] = [];
    const host: ServiceHost = { platform: "darwin", agentsDir: tmp(), domain: "gui/501", launchctl: (a) => (calls.push(a), ""), writeFile: (p, d) => writeFileSync(p, d), removeFile: (p) => writeFileSync(p + ".removed", "") };
    expect(installJob({ name: "blockage", everySec: 3600 }, "/x/cli.js", host)).toContain("runs every 1 hour");
    expect(existsSync(join(host.agentsDir, "com.spaghetti-code-foundry.blockage.plist"))).toBe(true);
    expect(calls.flat().join(" ")).not.toContain(".server");
    expect(uninstallJob("blockage", host)).toBe("blockage removed");
    expect(uninstallJob("digest", host)).toBe("digest was not installed");
    expect(() => installJob({ name: "digest", daily: { hour: 7, minute: 30 } }, "/x/cli.js", { ...host, platform: "linux" })).toThrow(/cron/);
  });
});
