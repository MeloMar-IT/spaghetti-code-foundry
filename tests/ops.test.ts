import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { blockers, cycles, dependencyWaits, fileWaits, watcherRepos } from "../src/ops/blockage.js";
import { capsPath, loadCaps, runLimit, setCap } from "../src/ops/caps.js";
import { limitsSet, logTail, opsCommand, runBlockage, runDigest, runFlaky, runLimits } from "../src/ops/cli.js";
import { digestFacts, localDay } from "../src/ops/digest.js";
import { collectHits, parsePassed, parseTestLog, stories, suspects } from "../src/ops/flaky.js";
import { clearGovernor, loadState, runGovernor, type Sample } from "../src/ops/governor.js";
import { forecast, parseReset } from "../src/ops/limits.js";
import { installJob, jobInstalled, jobPlist, jobState, labelOf, uninstallJob } from "../src/ops/schedule.js";
import type { ServiceHost } from "../src/service.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const tmp = () => mkdtempSync(join(tmpdir(), "scf-ops-"));
const calm: Sample = { load1: 0.5, load5: 0.5, load15: 0.5, pressure: 1 };
const hot: Sample = { load1: 3, load5: 3, load15: 3, pressure: 1 };

type Shape = Partial<StepRecord> & { id: string };
function run(id: string, o: Partial<RunSummary> & { issue?: string; steps?: Shape[]; at?: number } = {}): RunSummary {
  const at = new Date(o.at ?? NOW.getTime() - HOUR).toISOString();
  const history = (o.steps ?? []).map((s) => ({ type: "claude", visit: 1, ok: true, output: "", startedAt: at, durationMs: 1000, logFile: "", ...s }));
  const { issue, steps: _s, at: _a, ...rest } = o;
  return { runId: id, flow: "issue-gitflow", status: "succeeded", startedAt: at, vars: issue ? { issue, github_repo: "acme/app" } : {}, history, state: { steps: {} }, ...rest } as unknown as RunSummary;
}

describe("the cap on runs at once", () => {
  it("lowers the configured number while it holds, down to 0, and ends by itself", () => {
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
    writeFileSync(join(file, "..", "caps", "limits.json"), "{broken");
    expect(runLimit(6, NOW, file)).toBe(6);
  });

  it("holds a cap of 0 until it ends, and ignores a cap that is not a whole number of at least 0", () => {
    const file = join(tmp(), "governor", "caps.json");
    const until = new Date(NOW.getTime() + 60_000).toISOString();
    setCap("load", { runs: 0, until, why: "x" }, file);
    expect(loadCaps(file).load?.runs).toBe(0);
    expect(runLimit(6, NOW, file)).toBe(0);
    expect(runLimit(0, NOW, file)).toBe(0);
    expect(runLimit(6, new Date(NOW.getTime() + 120_000), file)).toBe(6);
    for (const runs of [-1, 1.5]) {
      setCap("load", { runs, until, why: "x" }, file);
      expect(loadCaps(file)).toEqual({});
      expect(runLimit(6, NOW, file)).toBe(6);
    }
  });

  it("keeps one file per helper, so two helpers never write the same file, and leaves no temp file", () => {
    const file = join(tmp(), "governor", "caps.json");
    const until = new Date(NOW.getTime() + 60_000).toISOString();
    setCap("load", { runs: 4, until, why: "x" }, file);
    setCap("limits", { runs: 2, until, why: "y" }, file);
    expect(readdirSync(join(file, "..", "caps")).sort()).toEqual(["limits.json", "load.json"]);
    expect(existsSync(file)).toBe(false);
    // a write of one helper cannot undo what the other wrote meanwhile: each file holds its own cap only
    expect(JSON.parse(readFileSync(join(file, "..", "caps", "load.json"), "utf8"))).toEqual({ runs: 4, until, why: "x" });
    setCap("load", undefined, file);
    expect(loadCaps(file)).toEqual({ limits: { runs: 2, until, why: "y" } });
    expect(() => setCap("../x", undefined, file)).toThrow(/helper name/);
  });

  it("still reads the one shared file of an older install, until each helper writes its own", () => {
    const file = join(tmp(), "governor", "caps.json");
    const until = new Date(NOW.getTime() + 60_000).toISOString();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ load: { runs: 3, until, why: "old" }, limits: { runs: 2, until, why: "old" } }));
    expect(runLimit(6, NOW, file)).toBe(2);
    // the helper's own file wins, and lifting its cap takes it out of the old file too
    setCap("limits", { runs: 5, until, why: "new" }, file);
    expect(runLimit(6, NOW, file)).toBe(3);
    setCap("limits", undefined, file);
    expect(loadCaps(file)).toEqual({ load: { runs: 3, until, why: "old" } });
    setCap("load", undefined, file);
    expect([runLimit(6, NOW, file), existsSync(file)]).toEqual([6, false]);
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
  const band: Sample = { load1: 2, load5: 2, load15: 2, pressure: 1 };

  it("writes the caps and a log line, and takes everything away on reset", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 6, now: NOW };
    runGovernor({ ...o, sample: { load1: 5, load5: 5, load15: 5, pressure: 1 } });
    expect(runLimit(6, NOW, o.capsFile)).toBe(5);
    expect(readFileSync(join(o.slotsDir, "cap"), "utf8")).toBe("1");
    expect(readFileSync(join(o.dir, "changes.log"), "utf8")).toContain("2026-10-12T12:00:00.000Z runs at once 6 → 5");
    // a governor that stops checking does not hold the Foundry down
    expect(runLimit(6, new Date(NOW.getTime() + 5 * 60_000), o.capsFile)).toBe(6);
    clearGovernor(o.dir, o.slotsDir, o.capsFile);
    expect([runLimit(6, NOW, o.capsFile), existsSync(join(o.slotsDir, "cap"))]).toEqual([6, false]);
  });

  it("writes the test cap again at every check while it holds, and also when the cap on runs cannot be written", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 6, sample: { load1: 5, load5: 5, load15: 5, pressure: 1 } };
    runGovernor({ ...o, now: NOW });
    const cap = join(o.slotsDir, "cap");
    utimesSync(cap, new Date(0), new Date(0));
    runGovernor({ ...o, now: new Date(NOW.getTime() + 60_000) });
    expect(statSync(cap).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    // the folder of the caps is a file here: the cap on runs cannot be written
    const bad = tmp();
    mkdirSync(join(bad, "governor"));
    writeFileSync(join(bad, "governor", "caps"), "");
    expect(() => runGovernor({ ...o, dir: join(bad, "governor"), slotsDir: join(bad, "test-slots"), capsFile: join(bad, "governor", "caps.json"), now: NOW })).toThrow();
    expect(readFileSync(join(bad, "test-slots", "cap"), "utf8")).toBe("1");
    expect(readFileSync(join(bad, "governor", "changes.log"), "utf8")).toContain("test runs at once → 1");
  });

  it("forgets a state older than the hold time: the first check after a night does not put yesterday's cap back", () => {
    const dir = tmp();
    const o = { dir: join(dir, "governor"), slotsDir: join(dir, "test-slots"), capsFile: join(dir, "governor", "caps.json"), configured: 6 };
    for (let i = 0; i < 3; i++) runGovernor({ ...o, now: new Date(NOW.getTime() + i * 60_000), sample: hot });
    const last = new Date(NOW.getTime() + 2 * 60_000);
    // the first hot check was 6 → 5 and the others are held back by the pause; a load of 3 is no emergency
    expect(loadState(o.dir, last)).toEqual({ calm: 0, downs: [NOW.toISOString()], hot: 3, runs: 5, changedAt: NOW.toISOString() });
    const morning = new Date(NOW.getTime() + 9 * HOUR);
    expect(loadState(o.dir, morning)).toEqual({ calm: 0 });
    // neither hot nor calm in the morning: with yesterday's state the cap of 3 would be written again
    const d = runGovernor({ ...o, now: morning, sample: band });
    expect([d.state.runs, d.change, runLimit(6, morning, o.capsFile)]).toEqual([undefined, undefined, 6]);
  });

  it("scf governor status says how often the limits changed today", async () => {
    const dir = join(process.env.FACTORY_HOME!, "governor");
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    writeFileSync(join(dir, "changes.log"), `${new Date(now.getTime()).toISOString()} runs at once 4 → 3 (x)\n`.repeat(3));
    const lines: string[] = [];
    await opsCommand("governor", ["status"], "/x/cli.js", (l) => lines.push(l), { platform: "darwin", agentsDir: tmp(), domain: "gui/501", launchctl: () => "", writeFile: () => {}, removeFile: () => {} });
    rmSync(join(dir, "changes.log"));
    expect(lines).toContain("the governor changed the limits 3 times today");
  });

  it("scf governor report shows no limit that has ended", async () => {
    const dir = join(process.env.FACTORY_HOME!, "governor");
    mkdirSync(dir, { recursive: true });
    const say = async () => {
      const lines: string[] = [];
      await opsCommand("governor", ["report"], "/x/cli.js", (l) => lines.push(l));
      return lines[0];
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, runs: 3, tests: 1, at: new Date().toISOString() }));
    expect(await say()).toContain("limits now: 3 runs at once");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, runs: 3, tests: 1, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect(await say()).toBe("no limits set: the machine is calm enough");
  });

  it("scf governor report and status show a cap of 0 as nothing new starts", async () => {
    const home = process.env.FACTORY_HOME!;
    const dir = join(home, "governor");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, runs: 0, at: new Date().toISOString() }));
    await opsCommand("governor", ["report"], "/x/cli.js", (l) => lines.push(l));
    expect(lines[0]).toContain("limits now: 0 runs at once, so nothing new starts (configured:");
    expect(lines[0]).not.toContain("no limits set");
    lines.length = 0;
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, runs: 0, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await opsCommand("governor", ["report"], "/x/cli.js", (l) => lines.push(l));
    expect(lines[0]).toBe("no limits set: the machine is calm enough");
    rmSync(join(dir, "state.json"));

    lines.length = 0;
    setCap("load", { runs: 0, until: new Date(Date.now() + 60_000).toISOString(), why: "machine load" }, capsPath(home));
    try {
      await opsCommand("governor", ["status"], "/x/cli.js", (l) => lines.push(l), { platform: "darwin", agentsDir: tmp(), domain: "gui/501", launchctl: () => "", writeFile: () => {}, removeFile: () => {} });
    } finally {
      setCap("load", undefined, capsPath(home));
    }
    expect(lines).toContain("cap by load: 0 runs at once, so nothing new starts (machine load)");
  });

  it("scf governor run takes the floor from the config", async () => {
    const home = process.env.FACTORY_HOME!;
    const dir = join(home, "governor");
    const config = join(home, "config.yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(config, "concurrency: 6\ngovernor:\n  floor: 4\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ calm: 0, runs: 0, at: new Date().toISOString() }));
    try {
      await opsCommand("governor", ["run"], "/x/cli.js", () => {});
      // the cap that was stored below the floor is lifted to it, whatever the load is (the default floor would give 3)
      expect(loadState(dir).runs).toBe(4);
    } finally {
      rmSync(config, { force: true });
      clearGovernor(dir, join(home, "test-slots"), capsPath(home));
    }
  });
});

describe("unreliable tests", () => {
  const RULE = "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯";
  // What Vitest 5 prints with --reporter=verbose (taken from a real run), and a Gradle failure.
  const log = (extra = "") => [
    " \x1b[32m✓\x1b[39m tests/a.test.ts > suite > passes late 2ms (retry x1)",
    " ✓ tests/a.test.ts > suite > fine 0ms",
    " × tests/a.test.ts > suite > breaks 0ms (retry x2)",
    "   → boom",
    "",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
    "",
    "\x1b[31m FAIL \x1b[39m tests/a.test.ts > suite > breaks",
    " FAIL  tests/a.test.ts > suite > breaks",
    "Error: boom",
    " ❯ tests/a.test.ts:6:30",
    "",
    RULE,
    "",
    "FooTest > bar() FAILED",
    "    java.lang.AssertionError at FooTest.java:12",
    "",
    extra,
  ].join("\n");
  const fileOk = (repo: string, s: { title: string }, label: string) => `https://example.test/${repo}/${label}/${s.title.split(" ").at(-1)}`;
  const runDir = (home: string, id: string, vars: object, logs: Record<string, string>) => {
    mkdirSync(join(home, "runs", id), { recursive: true });
    for (const [name, text] of Object.entries(logs)) writeFileSync(join(home, "runs", id, name), text);
    writeFileSync(join(home, "runs", id, "run.json"), JSON.stringify({ vars }));
  };

  it("reads failed and retried tests from real Vitest and Gradle output", () => {
    const hits = parseTestLog(log(), "r1", "acme/app#1");
    expect(hits.map((h) => [h.repo, h.test, h.kind, h.cause])).toEqual([
      ["acme/app", "tests/a.test.ts > suite > passes late", "retried", ""],
      ["acme/app", "tests/a.test.ts > suite > breaks", "failed", ""],
      ["acme/app", "FooTest > bar()", "failed", ""],
    ]);
    expect(parsePassed(log() + "\n ✓ tests/b.test.ts (2 tests) 3ms\n ❯ tests/c.test.ts (4 tests | 1 failed) 9ms")).toEqual(["tests/a.test.ts > suite > passes late", "tests/a.test.ts > suite > fine", "tests/b.test.ts"]);
  });

  it("gives a cause only to the test whose own error block shows it", () => {
    const text = [
      " FAIL  tests/a.test.ts > suite > port",
      " FAIL  tests/a.test.ts > suite > port",
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:1",
      RULE,
      " FAIL  tests/a.test.ts > suite > wrong",
      "AssertionError: expected 1 to be 2",
      RULE,
      "FooTest > slow() FAILED",
      "    Test timed out in 5000ms",
      "",
      "BarTest > other() FAILED",
      "    java.lang.AssertionError",
      "",
      "Error: connect ECONNREFUSED 127.0.0.1:9 (a line of some other output)",
    ].join("\n");
    expect(parseTestLog(text, "r1", "acme/app#1").map((h) => [h.test, h.cause])).toEqual([
      ["tests/a.test.ts > suite > port", "a network port was already in use"],
      ["tests/a.test.ts > suite > wrong", ""],
      ["FooTest > slow()", "a test ran into its time limit"],
      ["BarTest > other()", ""],
    ]);
  });

  it("lists a test only when it went wrong in three different stories of one repository", () => {
    const hits = ["1", "2", "2", "3"].flatMap((n, i) => parseTestLog(log(), `r${i}`, `acme/app#${n}`));
    const list = suspects(hits);
    expect(list.map((s) => [s.repo, s.test, s.failedIn.length, s.retriedIn.length, s.passes])).toEqual([
      ["acme/app", "tests/a.test.ts > suite > breaks", 3, 0, false],
      ["acme/app", "FooTest > bar()", 3, 0, false],
      ["acme/app", "tests/a.test.ts > suite > passes late", 0, 3, true],
    ]);
    expect(suspects(hits.filter((h) => h.issue !== "acme/app#3"))).toEqual([]);
    // the same file name in another repository is another test: two stories here and one there are not three
    const two = ["acme/app#1", "acme/app#2", "other/lib#3"].flatMap((issue, i) => parseTestLog(log(), `r${i}`, issue));
    expect(suspects(two)).toEqual([]);
    // runs without an issue are no stories, however many there are
    expect(suspects(["a", "b", "c"].flatMap((r) => parseTestLog(log(), r, "")))).toEqual([]);
  });

  it("makes a story per repository and test file, not for a file that never passes, not for an unknown repository, not twice", () => {
    const hits = ["acme/app#1", "acme/app#2", "acme/app#3", "other/lib#1", "other/lib#2", "other/lib#3"].flatMap((issue, i) => parseTestLog(log(), `r${i}`, issue));
    const list = suspects(hits);
    // tests/a.test.ts has a test that passed on a retry; FooTest was never seen to pass
    expect(stories(list, {}).map((s) => [s.key, s.repo, s.title])).toEqual([
      ["acme/app:tests/a.test.ts", "acme/app", "Unreliable tests in tests/a.test.ts"],
      ["other/lib:tests/a.test.ts", "other/lib", "Unreliable tests in tests/a.test.ts"],
    ]);
    expect(stories(suspects(hits, new Set(["other/lib:FooTest > bar()"])), {}).map((s) => s.key)).toEqual(["acme/app:tests/a.test.ts", "other/lib:tests/a.test.ts", "other/lib:FooTest"]);
    expect(stories(list, { "acme/app:tests/a.test.ts": "url" }).map((s) => s.key)).toEqual(["other/lib:tests/a.test.ts"]);
    // what an older version filed under the bare file name stays filed
    expect(stories(list, { "tests/a.test.ts": "url" })).toEqual([]);
    const nowhere = suspects(["#1", "#2", "#3"].flatMap((issue, i) => parseTestLog(log(), `r${i}`, issue, "")));
    expect([nowhere.length, stories(nowhere, {})]).toEqual([3, []]);
  });

  it("counts a test that failed and passed when the tests were run once more as retried, from tests.first.log", () => {
    const home = tmp();
    const failed = " FAIL  tests/a.test.ts > suite > flaky\nError: listen EADDRINUSE: address already in use\n" + RULE + "\n FAIL  tests/a.test.ts > suite > broken\nError: no\n" + RULE + "\n";
    // the second run passed but for one test; a run without an issue; a first log alone (the tests after it are not this log's)
    runDir(home, "r1", { issue: "1", github_repo: "acme/app" }, { "tests.first.log": failed, "tests.log": " FAIL  tests/a.test.ts > suite > broken\nError: no\n" });
    runDir(home, "r2", {}, { "tests.first.log": failed, "tests.log": "all fine\n" });
    runDir(home, "r3", { issue: "3", github_repo: "acme/app" }, { "tests.first.log": failed });
    const { hits, logs, passed } = collectHits(join(home, "runs"), new Date());
    expect(logs).toBe(5);
    expect(hits.filter((h) => h.issue).map((h) => [h.issue, h.test, h.kind, h.cause]).sort()).toEqual([
      ["acme/app#1", "tests/a.test.ts > suite > broken", "failed", ""],
      ["acme/app#1", "tests/a.test.ts > suite > flaky", "retried", "a network port was already in use"],
      ["acme/app#3", "tests/a.test.ts > suite > broken", "retried", ""],
      ["acme/app#3", "tests/a.test.ts > suite > flaky", "retried", "a network port was already in use"],
    ]);
    expect(hits.filter((h) => !h.issue).every((h) => suspects([h, h, h]).length === 0)).toBe(true);
    expect(passed.has("acme/app:tests/a.test.ts > suite > flaky")).toBe(true);
  });

  it("runFlaky reports, and files stories only when that is switched on", () => {
    const home = tmp();
    for (const n of [1, 2, 3]) runDir(home, `r${n}`, { issue: String(n), github_repo: "acme/app" }, { "tests.log": log() });
    const dir = join(home, "flaky");
    const filed: string[] = [];
    const file = (repo: string, s: { title: string }, label: string) => (filed.push(`${repo} ${label} ${s.title}`), "https://example.test/1");
    const off = runFlaky({ runsDir: join(home, "runs"), dir, now: new Date(), file });
    expect(off.text).toContain("| acme/app | tests/a.test.ts > suite > breaks | 3 | 0 | not seen |");
    expect(filed).toEqual([]);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ auto: true }));
    const on = runFlaky({ runsDir: join(home, "runs"), dir, now: new Date(), file });
    // FooTest was never seen to pass: probably broken, so no story
    expect(filed).toEqual(["acme/app Factory_go Unreliable tests in tests/a.test.ts"]);
    expect(on.text).toContain("https://example.test/1");
    runFlaky({ runsDir: join(home, "runs"), dir, now: new Date(), file });
    expect(filed).toHaveLength(1);
  });

  it("files two stories per check; what cannot be filed does not use up the places or block the others", () => {
    const home = tmp();
    const one = (name: string) => ` ✓ tests/${name}.test.ts > s > late 2ms (retry x1)\n FAIL  tests/${name}.test.ts > s > breaks\nError: x\n`;
    // two test files without a repository come first (they fail in more stories), then four of two repositories
    for (const n of [1, 2, 3, 4]) runDir(home, `n${n}`, { issue: String(n) }, { "tests.log": one("n1") + one("n2") });
    for (const n of [1, 2, 3]) runDir(home, `a${n}`, { issue: String(n), github_repo: "acme/app" }, { "tests.log": one("a") + one("b") + one("c") });
    for (const n of [1, 2, 3]) runDir(home, `o${n}`, { issue: String(n), github_repo: "other/lib" }, { "tests.log": one("a") });
    const dir = join(home, "flaky");
    mkdirSync(dir);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ auto: true }));
    const state = () => ({ filed: {}, ...JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) }) as { filed: Record<string, string>; tried?: Record<string, string> };
    const o = { runsDir: join(home, "runs"), dir, now: new Date() };
    // GitHub refuses one story every time
    const calls: string[] = [];
    const onDisk: number[] = [];
    const file = (repo: string, s: { title: string }) => {
      calls.push(`${repo} ${s.title.split("/").at(-1)}`);
      onDisk.push(Object.keys(state().filed).length);
      if (s.title.endsWith("a.test.ts") && repo === "acme/app") throw new Error("label not found\nmore");
      return `https://example.test/${repo}/${calls.length}`;
    };
    const first = runFlaky({ ...o, file });
    expect(calls).toEqual(["acme/app a.test.ts", "acme/app b.test.ts", "acme/app c.test.ts"]);
    // each filing is saved at once: when the third is made, the second is on disk (a check stopped here files nothing twice)
    expect(onDisk).toEqual([0, 0, 1]);
    expect(first.filed).toEqual([
      "Unreliable tests in tests/a.test.ts (acme/app): could not be filed (label not found)",
      "Unreliable tests in tests/b.test.ts (acme/app): https://example.test/acme/app/2",
      "Unreliable tests in tests/c.test.ts (acme/app): https://example.test/acme/app/3",
    ]);
    expect(Object.keys(state().filed)).toEqual(["acme/app:tests/b.test.ts", "acme/app:tests/c.test.ts"]);
    // next check: the refused one is tried after the one that was not tried yet, and the same name in the other repository is its own story
    calls.length = 0;
    runFlaky({ ...o, file: (repo, s) => (calls.push(`${repo} ${s.title.split("/").at(-1)}`), fileOk(repo, s, "x")) });
    expect(calls).toEqual(["other/lib a.test.ts", "acme/app a.test.ts"]);
    expect(Object.keys(state().filed).sort()).toEqual(["acme/app:tests/a.test.ts", "acme/app:tests/b.test.ts", "acme/app:tests/c.test.ts", "other/lib:tests/a.test.ts"]);
    expect(state().tried).toEqual({});
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

  it("runLimits writes a cap of at least 1 while the governor's cap is 0", () => {
    const dir = tmp();
    const capsFile = join(dir, "caps.json");
    const cal = { percent: 50, at: new Date(NOW.getTime() - 30 * HOUR).toISOString(), resetAt: reset };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ auto: true, calibrations: { claude: cal } }));
    setCap("load", { runs: 0, until: new Date(NOW.getTime() + HOUR).toISOString(), why: "machine load" }, capsFile);
    runLimits({ runs: [step(60, 100), step(10, 48)], dir, capsFile, configured: 6, now: NOW });
    expect(loadCaps(capsFile).limits!.runs).toBeGreaterThanOrEqual(1);
  });

  it("works from the runs at once that made the pace, and lifts its own cap by one per check at most", () => {
    const cal = { percent: 50, at: new Date(NOW.getTime() - 30 * HOUR).toISOString(), resetAt: reset };
    // 52 left at 2 per hour lasts 26 of the 48 hours. That pace came from 3 runs at once (a cap), not from the configured 6:
    // 3 runs must become fewer — from the configured number the answer would be 3 again, and the limit would still be overrun
    expect(forecast([step(60, 100), step(10, 48)], "claude", cal, NOW, 6, 3).runs).toBe(1);
    expect(forecast([step(60, 100), step(10, 48)], "claude", cal, NOW, 6, 6).runs).toBe(3);
    expect(forecast([step(60, 100), step(10, 48)], "claude", cal, NOW, 6, 1).runs).toBe(1);

    const dir = tmp();
    const capsFile = join(dir, "caps.json");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ auto: true, calibrations: { claude: cal } }));
    const until = new Date(NOW.getTime() + HOUR).toISOString();
    // under its own cap of 2 with the limit still overrun: down, not back up to 3
    setCap("limits", { runs: 2, until, why: "x" }, capsFile);
    runLimits({ runs: [step(60, 100), step(10, 48)], dir, capsFile, configured: 6, now: NOW });
    expect(loadCaps(capsFile).limits!.runs).toBe(1);
    // the pace is low again: one step up per check, not straight back to 6
    const slow = [step(60, 100), step(10, 12)];
    for (const want of [2, 3, 4, 5]) {
      runLimits({ runs: slow, dir, capsFile, configured: 6, now: NOW });
      expect(loadCaps(capsFile).limits!.runs).toBe(want);
    }
    runLimits({ runs: slow, dir, capsFile, configured: 6, now: NOW });
    expect(loadCaps(capsFile).limits).toBeUndefined();
    // a cap that has ended is no reason to go slowly
    setCap("limits", { runs: 1, until: new Date(NOW.getTime() - 1).toISOString(), why: "old" }, capsFile);
    runLimits({ runs: slow, dir, capsFile, configured: 6, now: NOW });
    expect(loadCaps(capsFile).limits).toBeUndefined();
  });

  it("scf limits set reads a reset without a time zone as local time and refuses one more than 7 days ahead", () => {
    expect(parseReset("2026-10-19T23:00")).toBe(new Date(2026, 9, 19, 23, 0).getTime());
    expect(parseReset("2026-10-19 23:00")).toBe(new Date(2026, 9, 19, 23, 0).getTime());
    expect(parseReset("2026-10-19")).toBe(new Date(2026, 9, 19).getTime());
    expect(parseReset("2026-10-19T23:00:00Z")).toBe(Date.UTC(2026, 9, 19, 23));
    expect(parseReset("2026-02-31")).toBeNaN();
    expect(parseReset("soon")).toBeNaN();
    const now = new Date(2026, 9, 12, 12, 0);
    const said: string[] = [];
    expect(() => limitsSet(["claude", "40", "2026-10-20"], (l) => said.push(l), now)).toThrow(/at most 7 days ahead/);
    expect(() => limitsSet(["claude", "40", "2026-10-12T11:00"], (l) => said.push(l), now)).toThrow(/usage:/);
    limitsSet(["claude", "40", "2026-10-19T11:00"], (l) => said.push(l), now);
    expect(said).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(process.env.FACTORY_HOME!, "limits", "state.json"), "utf8"));
    expect(saved.calibrations.claude).toEqual({ percent: 40, at: now.toISOString(), resetAt: new Date(2026, 9, 19, 11, 0).toISOString() });
  });
});

describe("what holds work up", () => {
  const runs = [
    run("h1", { issue: "10", status: "running", stepStartedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(), state: { next: "merge_develop", steps: {} } as never }),
    run("w1", { issue: "11", status: "stopped", steps: [{ id: "wait_for_area", output: "waiting for run h1 (ui/app.js)" }] }),
    run("w2", { issue: "12", status: "stopped", steps: [{ id: "wait_for_area", output: "waiting for run h1 (ui/app.js)" }] }),
    run("old", { issue: "12", status: "stopped", at: NOW.getTime() - 5 * HOUR, steps: [{ id: "wait_for_area", output: "waiting for run gone (x)" }] }),
  ];
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  const log = [
    `${at(7 * 60)} [scf] #16 waits for #15 (depends on)`,
    `${at(3 * 60)} [scf] #15 waits for #14 (depends on)`,
    `${at(1)} [scf] #13 waits for #12, #99 (depends on)`,
    `${at(1)} [scf] #14 waits for #13 (depends on)`,
  ].join("\n");
  const repos = { scf: "acme/app" };
  const alive = () => true;

  it("finds the story at the root of the waiting, through files and dependencies", () => {
    // a wait of three hours counts (the watcher writes the line once), one of seven hours does not
    const waits = [...fileWaits(runs), ...dependencyWaits(log, NOW, repos)];
    expect(waits).toHaveLength(6);
    const list = blockers(waits, runs, NOW, alive);
    expect(list.map((b) => [b.story, b.holdsUp, b.state])).toEqual([
      ["acme/app#10", ["acme/app#11", "acme/app#12", "acme/app#13", "acme/app#14", "acme/app#15"], "working on merge_develop for 20 minutes"],
      ["acme/app#99", ["acme/app#13", "acme/app#14", "acme/app#15"], "not started"],
    ]);
    // a run that says "running" without a process is not working
    expect(blockers(waits, runs, NOW, () => false)[0]!.state).toBe("interrupted — resume it");
  });

  it("keeps the last line per story, and drops a wait when a later line shows the story started or ended", () => {
    const lines = [
      `${at(50)} [scf] #20 waits for #1 (depends on)`,
      `${at(40)} [scf] #20 waits for #2, #3 (depends on)`,
      `${at(50)} [scf] #21 waits for #1 (depends on)`,
      `${at(30)} [scf] #21 “Add a page” → run 20261012-abc · label → working`,
      `${at(50)} [scf] #22 waits for #1 (depends on)`,
      `${at(30)} [scf] #22 approved → resuming run 20261012-def`,
      `${at(50)} [scf] #23 waits for #1 (depends on)`,
      `${at(30)} [scf] #23 → succeeded · $1.234 · label → done`,
      `${at(50)} [scf] #24 waits for #1 (depends on)`,
      `${at(30)} [scf] #24 (closed) → cancelled · label → none`,
      `${at(50)} [scf] #25 waits for #1 (depends on)`,
      `${at(30)} [scf] #25 label → working (answered, waits for its turn)`,
      `${at(60)} [scf] #26 → failed (x: y) · $0.100 · label → failed`,
      `${at(50)} [scf] #26 waits for #1 (depends on)`,
    ].join("\n");
    expect(dependencyWaits(lines, NOW, repos).map((w) => `${w.story}<${w.on}`)).toEqual(["acme/app#20<acme/app#2", "acme/app#20<acme/app#3", "acme/app#25<acme/app#1", "acme/app#26<acme/app#1"]);
  });

  it("keeps the same number in two repositories apart", () => {
    const lines = [`${at(5)} [app] #2 waits for #1 (depends on)`, `${at(5)} [lib] #7 waits for #2 (depends on)`, `${at(5)} [new] #2 waits for #1 (depends on)`].join("\n");
    const both = [run("a1", { issue: "1", status: "failed", source: "watcher app issue #1" }), { ...run("l2", { issue: "2", status: "waiting", source: "watcher lib issue #2" }), vars: { issue: "2", github_repo: "acme/lib" } } as RunSummary];
    expect(watcherRepos(both)).toEqual({ app: "acme/app", lib: "acme/lib" });
    // a watcher nothing is known about keeps its stories under its own id
    const waits = dependencyWaits(lines, NOW, watcherRepos(both));
    expect(blockers(waits, both, NOW, alive).map((b) => [b.story, b.holdsUp, b.state])).toEqual([
      ["acme/app#1", ["acme/app#2"], "failed — needs a look"],
      ["acme/lib#2", ["acme/lib#7"], "waits for an answer from you"],
      ["[new]#1", ["[new]#2"], "not started"],
    ]);
    const text = runBlockage({ runs: both, dir: tmp(), serviceLog: lines, limit: 6, now: NOW, alive, repos: { new: "acme/new" } });
    expect(text).toContain("| acme/new#1 | 1: acme/new#2 | not started |");
  });

  it("reports stories that wait for each other as a circle, not as nothing", () => {
    const lines = [
      `${at(5)} [scf] #1 waits for #2 (depends on)`,
      `${at(5)} [scf] #2 waits for #1 (depends on)`,
      `${at(5)} [scf] #3 waits for #2 (depends on)`,
      `${at(5)} [scf] #5 waits for #6 (depends on)`,
      `${at(5)} [scf] #6 waits for #7 (depends on)`,
      `${at(5)} [scf] #7 waits for #5, #8 (depends on)`,
    ].join("\n");
    const waits = dependencyWaits(lines, NOW);
    expect(cycles(waits)).toEqual([["[scf]#1", "[scf]#2"], ["[scf]#5", "[scf]#6", "[scf]#7"]]);
    expect(blockers(waits, [], NOW).map((b) => [b.story, b.holdsUp, b.cycle])).toEqual([
      ["[scf]#1 → [scf]#2 → [scf]#1", ["[scf]#3"], true],
      ["[scf]#5 → [scf]#6 → [scf]#7 → [scf]#5", [], true],
      ["[scf]#8", ["[scf]#5", "[scf]#6", "[scf]#7"], undefined],
    ]);
    const text = runBlockage({ runs: [], dir: tmp(), serviceLog: lines.split("\n").slice(0, 2).join("\n"), limit: 6, now: NOW });
    expect(text).not.toContain("Nothing holds other work up.");
    expect(text).toContain("| [scf]#1 → [scf]#2 → [scf]#1 | each other | wait for each other — take one of the dependencies away |");
  });

  it("runBlockage says when run slots are empty while stories wait", () => {
    const text = runBlockage({ runs, dir: tmp(), serviceLog: log, limit: 6, now: NOW, alive, repos });
    expect(text).toContain("1 of 6 runs are working; 5 stories wait for another.");
    expect(text).toContain("**5 run slots are empty while stories wait.**");
    expect(text).toContain("| acme/app#10 | 5: acme/app#11, acme/app#12, acme/app#13, acme/app#14, acme/app#15 | working on merge_develop for 20 minutes |");
    expect(runBlockage({ runs: [], dir: tmp(), serviceLog: "", limit: 6, now: NOW })).toContain("Nothing holds other work up.");
  });

  it("runBlockage says no new run may start at a limit of 0, and does not count empty slots", () => {
    const text = runBlockage({ runs, dir: tmp(), serviceLog: log, limit: 0, now: NOW, alive, repos });
    expect(text).toContain("1 run is working and no new run may start; 5 stories wait for another.");
    expect(text).not.toContain("run slot");
    expect(text).not.toContain("of 0 runs");
  });

  it("reads only the end of the service log", () => {
    const file = join(tmp(), "service.log");
    expect(logTail(file)).toBe("");
    writeFileSync(file, "first line\nsecond line\nthird line\n");
    expect(logTail(file)).toBe("first line\nsecond line\nthird line\n");
    // of a larger file only the end, from the first whole line
    expect(logTail(file, 16)).toBe("third line\n");
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
    run("r1", { issue: "5", status: "running", pid: 11 }),
    run("r2", { issue: "7", status: "running", pid: 12, at: NOW.getTime() - 90 * HOUR }),
    run("long-ago", { issue: "6", at: NOW.getTime() - 30 * HOUR, steps: [{ id: "report" }] }),
    run("no-issue", { steps: [{ id: "report" }] }),
  ];
  // the process of r2 is gone: the server or the machine stopped under it
  const alive = (pid: unknown) => pid === 11;

  it("takes the newest run of each story from the last day; what waits for you stays however old", () => {
    expect(digestFacts(runs, NOW, 24, alive)).toEqual({ done: ["#1: Add a page"], split: ["#2"], failed: ["#3 — the tests still fail"], waiting: ["#4 — Approve the plan?"], working: 1, interrupted: ["#7 — its process is gone; resume it"] });
  });

  describe("automatic retries", () => {
    const ev = (started = true) => ({ at: "x", step: "s", attempt: 1, of: 2, ...(started ? { startedAt: "y" } : {}) });
    const retry = (id: string, issue: string, o: Partial<RunSummary> & { steps?: Shape[]; at?: number } = {}, n = 1) =>
      run(id, { issue, timeLimits: Array.from({ length: n }, () => ev()), ...o });
    const at = (h: number) => NOW.getTime() - h * HOUR;
    const only = (rs: RunSummary[], now = NOW) => digestFacts(rs, now, 24, () => true).retries;

    it("counts each outcome once, with the exact line", () => {
      const rs = [
        retry("a", "1", {}, 2), retry("b", "2", { steps: [{ id: "create_split" }] }), retry("c", "3", { status: "failed" }),
        retry("d", "4", { status: "running", pid: 1 }), retry("e", "5", { status: "cancelled" }),
      ];
      const t = only(rs);
      expect(t).toEqual({ stories: 5, retries: 6, finished: 1, split: 1, failed: 2, open: 1 });
      const home = tmp();
      const text = runDigest({ runs: rs, home, now: NOW, alive: () => true }).text;
      expect(text).toContain("## Automatic retries after a time limit\n\n- 5 stories, 6 retries: 1 finished, 1 split, 2 failed, 1 still open");
    });

    it("says story and retry in the singular, and has no section without retries", () => {
      const home = tmp();
      expect(runDigest({ runs: [retry("a", "1")], home, now: NOW, alive: () => true }).text).toContain("- 1 story, 1 retry: 1 finished, 0 split, 0 failed, 0 still open");
      expect(runDigest({ runs, home, now: NOW, alive }).text).not.toContain("Automatic retries");
    });

    it("leaves out a retry that was queued and cancelled, and shows a waiting one as open", () => {
      const cancelled = run("a", { issue: "1", status: "cancelled", reason: "cancelled", timeLimits: [ev(false)] });
      expect(only([cancelled])).toBeUndefined();
      expect(digestFacts([cancelled], NOW, 24, () => true)).not.toHaveProperty("retries");
      const waiting = run("w", { issue: "2", status: "stopped", reason: "ran out of time in `s`; trying again (1 of 2)", timeLimits: [ev(false)], at: at(80) });
      expect(only([waiting])).toEqual({ stories: 1, retries: 0, finished: 0, split: 0, failed: 0, open: 1 });
    });

    it("follows one story across windows: open, then its outcome, then gone", () => {
      const open = retry("a", "1", { status: "running", pid: 1 });
      const done = { ...open, status: "succeeded", finishedAt: new Date(at(-5)).toISOString() } as RunSummary;
      expect(only([open])?.open).toBe(1);
      expect(only([done], new Date(at(-6)))).toMatchObject({ finished: 1, open: 0 });
      expect(only([done], new Date(at(-40)))).toBeUndefined();
    });

    it("counts by the end of the run, not its start", () => {
      expect(only([retry("a", "1", { at: at(30), finishedAt: new Date(at(1)).toISOString() })])?.finished).toBe(1);
      expect(only([retry("a", "1", { at: at(40), finishedAt: new Date(at(30)).toISOString() })])).toBeUndefined();
    });

    it("counts an older run's retries under the newest run's outcome when the older run ended in the window", () => {
      const older = retry("a", "1", { status: "failed", at: at(3), finishedAt: new Date(at(2)).toISOString() });
      const newest = (o: Partial<RunSummary>) => run("b", { issue: "1", at: at(1), ...o });
      expect(only([older, newest({ status: "running", pid: 1 })])).toMatchObject({ stories: 1, retries: 1, open: 1 });
      expect(only([older, newest({})])).toMatchObject({ stories: 1, retries: 1, finished: 1 });
      expect(only([older, newest({ status: "failed" })])).toMatchObject({ stories: 1, retries: 1, failed: 1 });
      expect(only([older, newest({ steps: [{ id: "create_split" }] })])).toMatchObject({ stories: 1, retries: 1, split: 1 });
    });

    it("does not count an older run's retries once that run ended before the window (a new run without retries that succeeds)", () => {
      const old = retry("a", "1", { status: "failed", at: at(31), finishedAt: new Date(at(30)).toISOString() }, 2);
      const today = run("b", { issue: "1", at: at(1) });
      expect(only([old, today])).toBeUndefined();
      expect(digestFacts([old, today], NOW, 24, () => true)).not.toHaveProperty("retries");
      // while the old run is in the window, its retries are reported under the newest run's outcome
      expect(only([old, today], new Date(at(7)))).toMatchObject({ stories: 1, retries: 2, finished: 1 });
    });

    it("drops an older run's retries when that run leaves the window, even while the newer run is still open", () => {
      const older = retry("a", "1", { status: "failed", at: at(3), finishedAt: new Date(at(2)).toISOString() });
      const open = run("b", { issue: "1", at: at(1), status: "running", pid: 1 });
      expect(only([older, open], new Date(at(-30)))).toBeUndefined();
    });
  });

  it("runDigest writes the day's file with what the other helpers found", () => {
    const home = tmp();
    mkdirSync(join(home, "governor"));
    writeFileSync(join(home, "governor", "changes.log"), `${new Date(NOW.getTime() - HOUR).toISOString()} runs at once 6 → 5 (load 3.0 per core)\n2026-01-01T00:00:00.000Z old\n`);
    mkdirSync(join(home, "blockage"));
    writeFileSync(join(home, "blockage", "latest.json"), JSON.stringify({ at: new Date(NOW.getTime() - HOUR).toISOString(), blockers: [{ story: "#10", holdsUp: ["#11"], state: "failed — needs a look" }] }));
    const r = runDigest({ runs, home, now: NOW, alive });
    expect(r.line).toBe("1 done, 1 failed, 1 waits for you, 1 in progress, 1 interrupted");
    // named by the day here, not by the day in UTC
    const text = readFileSync(join(home, "digest", `${localDay(NOW)}.md`), "utf8");
    expect(text).toBe(readFileSync(join(home, "digest", "report.md"), "utf8"));
    expect(text).toContain(`# Foundry digest ${localDay(NOW)}`);
    expect(text.indexOf("## Waits for you")).toBeLessThan(text.indexOf("## Done"));
    expect(text).toContain("## Interrupted\n\n- #7 — its process is gone; resume it");
    expect(text).toContain("- #10 holds up 1 (failed — needs a look)");
    // a few changes are normal governor work: no line
    expect(text).not.toContain("the governor changed");
    const many = Array.from({ length: 21 }, (_, i) => `${new Date(NOW.getTime() - HOUR + i * 1000).toISOString()} runs at once 6 → 5 (load 3.0 per core)\n`).join("");
    writeFileSync(join(home, "governor", "changes.log"), many);
    expect(runDigest({ runs, home, now: NOW, alive }).text).toContain("the governor changed the limits 21 times in the last day (more than 20); last: runs at once 6 → 5 (load 3.0 per core)");
    expect(text).not.toContain("## Unreliable tests");
    expect(localDay(new Date(2026, 9, 12, 0, 30))).toBe("2026-10-12");
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });

  it("leaves out results of the other helpers that are older than 26 hours, and a section that cannot be read", () => {
    const home = tmp();
    const put = (name: string, hoursAgo: number, data: object) => {
      mkdirSync(join(home, name), { recursive: true });
      writeFileSync(join(home, name, "latest.json"), JSON.stringify({ at: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(), ...data }));
    };
    put("blockage", 27, { blockers: [{ story: "#10", holdsUp: ["#11"], state: "failed — needs a look" }] });
    put("limits", 25, { forecasts: [{ family: "claude", percentNow: 40 }] });
    // a record of another shape: that section is left out, the digest is still written
    put("flaky", 1, { suspects: [{ test: "tests/a.test.ts > x" }] });
    mkdirSync(join(home, "analyst"));
    writeFileSync(join(home, "analyst", "tuning.json"), JSON.stringify({ trials: [{ flow: "f", step: "s", status: "running", startedAt: NOW.toISOString() }] }));
    const text = runDigest({ runs: [], home, now: NOW }).text;
    expect(text).not.toContain("Holds work up");
    expect(text).toContain("- claude: about 40% of the week used");
    expect(text).not.toContain("## Unreliable tests");
    expect(text).not.toContain("## Models");
    // a result without a time (written by hand, or broken) is not trusted either
    writeFileSync(join(home, "blockage", "latest.json"), JSON.stringify({ blockers: [{ story: "#10", holdsUp: [], state: "x" }] }));
    expect(runDigest({ runs: [], home, now: NOW }).text).not.toContain("Holds work up");
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
    // not a background process: macOS gives those almost no processor time on a loaded machine, which is when the governor must run
    expect(every + daily).not.toContain("ProcessType");
  });

  const fakeHost = (launchctl: (a: string[]) => string, calls: string[][] = []): ServiceHost => ({ platform: "darwin", agentsDir: tmp(), domain: "gui/501", launchctl: (a) => (calls.push(a), launchctl(a)), writeFile: (p, d) => writeFileSync(p, d), removeFile: (p) => writeFileSync(p + ".removed", "") });
  /** What launchctl throws when it ran and said no: an error with its exit code. */
  const refused = (text: string, status = 113) => Object.assign(new Error(text), { status });

  it("installs and removes only its own agent", () => {
    const calls: string[][] = [];
    // launchd as it is: the job is known after bootstrap, and gone after bootout
    let loaded = false;
    const host = fakeHost((a) => {
      if (a[0] === "bootstrap") loaded = true;
      else if (a[0] === "bootout") loaded = false;
      else if (!loaded) throw refused("Could not find service");
      return "";
    }, calls);
    expect(installJob({ name: "blockage", everySec: 3600 }, "/x/cli.js", host)).toContain("runs every 1 hour");
    expect(existsSync(join(host.agentsDir, "com.spaghetti-code-foundry.blockage.plist"))).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["bootout", "print", "bootstrap"]);
    expect(calls.flat().join(" ")).not.toContain(".server");
    expect(jobInstalled("blockage", host)).toBe(true);
    expect(uninstallJob("blockage", host)).toBe("blockage removed");
    expect(uninstallJob("digest", host)).toBe("digest was not installed");
    expect(() => installJob({ name: "digest", daily: { hour: 7, minute: 30 } }, "/x/cli.js", { ...host, platform: "linux" })).toThrow(/cron/);
  });

  it("waits until the old job is gone, and tries to load the new one again when launchd is not ready", () => {
    const calls: string[][] = [];
    const pauses: number[] = [];
    let prints = 0;
    let boots = 0;
    const host = fakeHost((a) => {
      // the old job is still going down for three looks, and the first two loads fail the way launchd does then
      if (a[0] === "print" && ++prints > 3) throw refused("Could not find service");
      if (a[0] === "bootstrap" && ++boots < 3) throw refused("Bootstrap failed: 5: Input/output error", 5);
      return "";
    }, calls);
    installJob({ name: "governor", everySec: 60 }, "/x/cli.js", host, (ms) => pauses.push(ms));
    expect(calls.map((c) => c[0])).toEqual(["bootout", "print", "print", "print", "print", "bootstrap", "bootstrap", "bootstrap"]);
    expect(pauses).toEqual([200, 200, 200, 1000, 1000]);
    // a job that never goes away is waited for 5 seconds, and three failed loads are an error
    const stuck = fakeHost((a) => {
      if (a[0] === "bootstrap") throw refused("Bootstrap failed: 5: Input/output error", 5);
      return "";
    });
    const waited: number[] = [];
    expect(() => installJob({ name: "governor", everySec: 60 }, "/x/cli.js", stuck, (ms) => waited.push(ms))).toThrow(/Input\/output error/);
    expect(waited.reduce((a, b) => a + b, 0)).toBe(25 * 200 + 2 * 1000);
  });

  it("status goes by what launchd runs, not by the file: a half-failed install is not 'installed'", () => {
    const gone = fakeHost(() => {
      throw refused("Could not find service");
    });
    expect(jobState("governor", gone)).toBe("not installed");
    writeFileSync(join(gone.agentsDir, `${labelOf("governor")}.plist`), "<plist/>");
    expect([jobState("governor", gone), jobInstalled("governor", gone)]).toEqual(["not loaded", false]);
    // launchctl cannot be asked (not there, or not macOS): the file decides
    const none = fakeHost(() => {
      throw Object.assign(new Error("spawnSync launchctl ENOENT"), { code: "ENOENT" });
    });
    expect(jobState("governor", none)).toBe("not installed");
    writeFileSync(join(none.agentsDir, `${labelOf("governor")}.plist`), "<plist/>");
    expect(jobState("governor", none)).toBe("loaded");
    expect(jobState("governor", { ...gone, platform: "linux" })).toBe("loaded");
  });

  it("uninstall stops the helper first and clears its cap after; status says when nothing runs", async () => {
    const home = process.env.FACTORY_HOME!;
    const calls: string[][] = [];
    const host = fakeHost((a) => {
      if (a[0] === "print") throw refused("Could not find service");
      return "";
    }, calls);
    writeFileSync(join(host.agentsDir, `${labelOf("limits")}.plist`), "<plist/>");
    const said: string[] = [];
    await opsCommand("limits", ["status"], "/x/cli.js", (l) => said.push(l), host);
    expect(said[0]).toBe("limits is installed but not loaded: nothing runs (scf limits install)");
    setCap("limits", { runs: 2, until: new Date(Date.now() + 60_000).toISOString(), why: "x" });
    const lines: string[] = [];
    // when the job is reported as removed its cap is still there: it is cleared after the helper was stopped,
    // so a check that was still running cannot write it again
    await opsCommand("limits", ["uninstall"], "/x/cli.js", (l) => lines.push(`${l} / cap ${existsSync(join(home, "governor", "caps", "limits.json")) ? "there" : "gone"}`), host);
    expect(lines).toEqual(["limits removed / cap there"]);
    expect(calls.at(-1)![0]).toBe("bootout");
    expect(loadCaps().limits).toBeUndefined();
  });
});

describe("housekeeping", () => {
  const PS = [
    "  2097152 /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/FSEvents.framework/Versions/A/Support/fseventsd",
    "  1048576 /usr/local/bin/node /opt/scf/dist/cli.js serve --port 4777 --repo /opt/scf",
    "   524288 /usr/local/bin/node /opt/scf/dist/cli.js governor run",
    "  9999999 /Applications/Other.app/Contents/MacOS/Other --serve",
    "garbage line",
  ].join("\n");
  const at = (hour: number, day = 12) => new Date(2026, 9, day, hour, 0, 0);

  it("reads the memory of the file-change tracker and of the server only", async () => {
    const { memoryFrom, warningsOf } = await import("../src/ops/housekeeping.js");
    expect(memoryFrom(PS)).toEqual({ fseventsdGb: 2, serverGb: 1 });
    expect(memoryFrom("")).toEqual({ fseventsdGb: 0, serverGb: 0 });
    expect(warningsOf({ fseventsdGb: 7.9, serverGb: 5.9 })).toEqual([]);
    expect(warningsOf({ fseventsdGb: 56, serverGb: 6 }).map((w) => w.key)).toEqual(["fseventsd", "server"]);
  });

  it("logs every check, warns once a day, and cleans once a night after three", async () => {
    const { runHousekeeping } = await import("../src/ops/housekeeping.js");
    const dir = join(tmp(), "housekeeping");
    const cleans: number[] = [];
    const clean = ((o: { olderThanDays: number }) => (cleans.push(o.olderThanDays), { workspaces: ["a", "b"], runs: [], freedMb: 1234.4, kept: [], evidence: [] })) as never;
    const big = PS.replace("2097152", String(56 * 1_048_576));
    const run = (now: Date, ps = PS) => runHousekeeping({ dir, runsDir: join(dir, "runs"), now, ps, clean });

    // before three at night: no clean-up
    expect(run(at(1)).result.cleaned).toBeUndefined();
    const first = run(at(4), big);
    expect(first.result.cleaned).toEqual({ workspaces: 2, freedMb: 1234 });
    expect(first.notify).toHaveLength(1);
    expect(first.notify[0]).toContain("fseventsd) uses 56 GB");
    // later the same day: no second clean-up and no second notification, but the warning stays in the report
    const again = run(at(7), big);
    expect([again.result.cleaned, again.notify, again.result.warnings.length]).toEqual([undefined, [], 1]);
    // the next night it cleans again
    expect(run(at(3, 13)).result.cleaned).toEqual({ workspaces: 2, freedMb: 1234 });
    expect(cleans).toEqual([2, 2]);

    const log = readFileSync(join(dir, "memory.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
    expect(log[1]).toMatch(/ fseventsd=56GB server=1GB cleaned=2 workspaces, 1234 MB$/);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("Nothing needs you.");
    expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).memory).toEqual({ fseventsdGb: 2, serverGb: 1 });
  });

  it("a clean-up that fails is tried again at the next check and never stops the record", async () => {
    const { runHousekeeping } = await import("../src/ops/housekeeping.js");
    const dir = join(tmp(), "housekeeping");
    let calls = 0;
    const clean = (() => {
      if (++calls === 1) throw new Error("disk");
      return { workspaces: [], runs: [], freedMb: 0, kept: [], evidence: [] };
    }) as never;
    expect(runHousekeeping({ dir, runsDir: dir, now: at(4), ps: PS, clean }).result.cleaned).toBeUndefined();
    expect(runHousekeeping({ dir, runsDir: dir, now: at(7), ps: PS, clean }).result.cleaned).toEqual({ workspaces: 0, freedMb: 0 });
  });

  it("is a helper of its own that runs every three hours", async () => {
    const { JOBS } = await import("../src/ops/cli.js");
    expect(JOBS.housekeeping).toEqual({ name: "housekeeping", everySec: 10800 });
  });
});
