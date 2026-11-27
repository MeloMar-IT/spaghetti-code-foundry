import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";

// The generated test steps that follow a fix, run for real with a fake `vitest`: the files that failed last time run
// first. No server, no agent.
const TOOLS = resolve("tools");
const flow = parseFlow(readFileSync(resolve("flows/issue-gitflow.yaml"), "utf8"));
const script = (id: string): string => String((flow.steps.find((s) => s.id === id) as { run?: string }).run);

// It logs its arguments. A file in $FAKE makes it fail: BUG (tests/a.test.ts fails, when it runs), OTHER (tests/b.test.ts
// fails in a full run), NOFILES (a run of chosen files finds none), HANG (a run of chosen files ends as the watchdog does).
const FAKE_VITEST = `#!/bin/sh
echo "$*" >> "$FAKE/calls.log"
if [ "$#" -gt 1 ] && [ -f "$FAKE/NOFILES" ]; then echo "No test files found, exiting with code 1"; exit 1; fi
if [ "$#" -gt 1 ] && [ -f "$FAKE/HANG" ]; then echo "test-silence: stopped — no output for 20 min, twice"; exit 125; fi
if [ -f "$FAKE/BUG" ]; then echo " FAIL  tests/a.test.ts > a > works"; echo "AssertionError: x"; exit 1; fi
if [ "$#" -eq 1 ] && [ -f "$FAKE/OTHER" ]; then echo " FAIL  tests/b.test.ts > b > works"; echo "AssertionError: y"; exit 1; fi
echo "all passed"
`;

describe("a test step after a fix", () => {
  let tmp: string, work: string, fake: string, runDir: string;
  const env = (extra: Record<string, string>) => ({
    ...process.env, PATH: `${join(fake, "bin")}${delimiter}${process.env.PATH}`, FAKE: fake, FACTORY_TOOLS: TOOLS, FACTORY_RUN_ID: "r1",
    FACTORY_VAR_TEST_CMD: "vitest run", FACTORY_VAR_QUICK_TEST_CMD: "", FACTORY_VAR_TEST_SLOTS: "0", FACTORY_VAR_REUSE_TEST_RESULTS: "no",
    FACTORY_VAR_DEVELOP_BRANCH: "develop", FACTORY_ENV_STOP_FILE: join(fake, "env-stop"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...extra,
  });
  const step = (id: string, extra: Record<string, string> = {}) => {
    rmSync(join(fake, "calls.log"), { force: true });
    const r = spawnSync("sh", ["-c", script(id).replaceAll("{{run.dir}}", runDir)], { cwd: work, encoding: "utf8", env: env(extra) });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8").trimEnd().split("\n") : []);
  const set = (name: string, on = true) => (on ? writeFileSync(join(fake, name), "") : rmSync(join(fake, name), { force: true }));
  const list = () => (existsSync(join(runDir, "failed-tests.txt")) ? readFileSync(join(runDir, "failed-tests.txt"), "utf8") : undefined);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: work, encoding: "utf8", env: env({}) }).stdout.trim();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "failed-first-step-"));
    work = join(tmp, "work"); fake = join(tmp, "fake"); runDir = join(tmp, "runs", "r1");
    mkdirSync(join(work, "tests"), { recursive: true });
    mkdirSync(join(fake, "bin"), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(fake, "bin", "vitest"), FAKE_VITEST, { mode: 0o755 });
    writeFileSync(join(work, "tests", "a.test.ts"), "a\n");
    writeFileSync(join(work, "tests", "b.test.ts"), "b\n");
    git("init", "-q", "-b", "develop");
    git("add", "."); git("commit", "-qm", "start");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** The first full run, which fails on tests/a.test.ts. */
  const firstRun = (id = "run_tests") => {
    set("BUG");
    const r = step(id);
    expect(r.status, r.out).not.toBe(0);
    return r;
  };

  it("a full run lists its failing tests", () => {
    const r = firstRun();
    expect(calls()).toEqual(["run"]);
    expect(list()).toBe("tests/a.test.ts\ta > works\n");
    expect(r.out).not.toContain("failed last time");
  });

  it("after a fix that did not work, runs only that file and fails", () => {
    firstRun();
    const r = step("run_tests");
    expect(r.status, r.out).not.toBe(0);
    expect(calls()).toEqual(["run tests/a.test.ts"]);
    expect(r.out).toContain("first the tests that failed last time");
    expect(r.out).toMatch(/^=== summary ===$/m);
    expect(r.out).toContain("the whole suite did not run");
    expect(list()).toBe("tests/a.test.ts\ta > works\n");
  });

  it("after a fix that works, runs that file and then the whole suite", () => {
    firstRun();
    set("BUG", false);
    const r = step("run_tests");
    expect(r.status, r.out).toBe(0);
    expect(calls()).toEqual(["run tests/a.test.ts", "run"]);
    expect(r.out).toContain("they pass now — running the whole suite");
    expect(r.out).toContain("result: PASSED");
    expect(list()).toBeUndefined();
  });

  it("runs the whole suite when the first run names no failing test", () => {
    firstRun();
    set("BUG", false);
    set("NOFILES");
    const r = step("run_tests");
    expect(r.status, r.out).toBe(0);
    expect(calls()).toEqual(["run tests/a.test.ts", "run"]);
    expect(r.out).toContain("named no failing test");
  });

  it("ends the run when the first run hung, without the whole suite", () => {
    firstRun();
    set("BUG", false);
    set("HANG");
    const r = step("run_tests");
    expect(r.status, r.out).not.toBe(0);
    expect(calls()).toEqual(["run tests/a.test.ts"]);
    expect(readFileSync(join(fake, "env-stop"), "utf8")).toContain("the tests hung");
    expect(readFileSync(join(runDir, "tests.log"), "utf8")).toContain("test-silence: stopped");
  });

  it("an unknown test command runs only the whole suite", () => {
    writeFileSync(join(runDir, "failed-tests.txt"), "tests/a.test.ts\ta > works\n");
    writeFileSync(join(work, "run-tests.sh"), "vitest run\n");
    const r = step("run_tests", { FACTORY_VAR_TEST_CMD: "sh ./run-tests.sh" });
    expect(r.status, r.out).toBe(0);
    expect(calls()).toEqual(["run"]);
    expect(r.out).not.toContain("failed last time");
  });

  describe("test_develop", () => {
    const tested = () => existsSync(join(runDir, "develop-tested"));
    beforeEach(() => writeFileSync(join(runDir, "failed-tests.txt"), "tests/a.test.ts\ta > works\n"));

    it("fails at once, with no second try and no record, when the file still fails", () => {
      set("BUG");
      const r = step("test_develop");
      expect(r.status, r.out).not.toBe(0);
      expect(calls()).toEqual(["run tests/a.test.ts"]);
      expect(tested()).toBe(false);
    });

    it("a pass of that file is not enough: another failure of the whole suite (run twice) fails the step", () => {
      set("OTHER");
      const r = step("test_develop");
      expect(r.status, r.out).not.toBe(0);
      expect(calls()).toEqual(["run tests/a.test.ts", "run", "run"]);
      expect(list()).toBe("tests/b.test.ts\tb > works\n");
      expect(tested()).toBe(false);
    });

    it("records the commit after the whole suite passed", () => {
      const r = step("test_develop");
      expect(r.status, r.out).toBe(0);
      expect(calls()).toEqual(["run tests/a.test.ts", "run"]);
      expect(readFileSync(join(runDir, "develop-tested"), "utf8").trim()).toBe(git("rev-parse", "HEAD"));
    });
  });

  it("only the steps that follow a fix run the failed tests first", () => {
    const has = (id: string) => script(id).includes('failed-first.mjs" command');
    for (const id of ["run_tests", "run_tests_1", "run_tests_2", "fixed_tests", "test_develop", "test_back"]) expect(has(id), id).toBe(true);
    for (const id of ["baseline_tests", "baseline_main", "pretest_tests", "test_main"]) {
      expect(has(id), id).toBe(false);
      expect(script(id), id).not.toContain("failed-first.mjs");
    }
    expect(script("test_develop")).toContain("develop-tested");
  });
});
