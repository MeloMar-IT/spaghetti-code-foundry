import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TOOL = resolve("tools/baseline-tests");
let tmp: string;
let work: string;
let runDir: string;
let marker: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "baseline-tests-"));
  work = join(tmp, "work");
  runDir = join(tmp, "run");
  mkdirSync(work);
  mkdirSync(runDir);
  marker = join(runDir, "tests.marker");
  writeFileSync(marker, "");
  // Reports are written after the marker: give the marker an older time than anything written next.
  utimesSync(marker, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

type Case = { cls?: string; name: string; fail?: boolean; skip?: boolean };
const xml = (cases: Case[]) =>
  `<testsuite tests="${cases.length}">${cases
    .map((c) => {
      const attrs = `${c.cls === undefined ? "" : ` classname="${c.cls}"`} name="${c.name}"`;
      return c.fail ? `<testcase${attrs}><failure message="x">boom</failure></testcase>` : c.skip ? `<testcase${attrs}><skipped/></testcase>` : `<testcase${attrs}/>`;
    })
    .join("")}</testsuite>`;
const report = (cases: Case[], file = "TEST-x.xml") => writeFileSync(join(work, file), xml(cases));
const body = (text: string) => writeFileSync(join(runDir, "issue-body.md"), text);
const run = (...args: string[]) => spawnSync(process.execPath, [TOOL, ...args], { cwd: work, encoding: "utf8" });
const red = () => run("red", marker, runDir);
const verify = () => run("verify", marker, runDir);
const state = () => JSON.parse(readFileSync(join(runDir, "baseline-red.json"), "utf8"));

const BASE = [{ cls: "a.B", name: "c", fail: true }, { cls: "a.B", name: "d" }, { cls: "a.C", name: "e" }];

describe("baseline-tests red", () => {
  it("goes on when only named tests fail (an exact name and a class)", () => {
    report([...BASE, { cls: "x.Y", name: "z", fail: true }]);
    body("Intro\n\n## Failing tests to fix\n\n- `a.B.c`\n* x.Y\n```\n```\n\n## Other\nnot a name");
    const r = red();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("BASELINE: going on");
    expect(r.stdout).toContain("  - a.B.c");
    expect(r.stdout).toContain("  - x.Y.z");
    const s = state();
    expect(s.named).toEqual(["a.B.c", "x.Y"]);
    expect(s.failing).toEqual(["a.B.c", "x.Y.z"]);
    expect(s.passed).toEqual(["a.B.d", "a.C.e"]);
    expect(readFileSync(join(runDir, "baseline-note.md"), "utf8")).toMatch(/### Tests before the change[\s\S]*a\.B\.c/);
    expect(readFileSync(join(runDir, "baseline-verdict.txt"), "utf8")).toContain("BASELINE: going on");
  });

  it("stops when an unnamed test fails as well, and names it", () => {
    report([{ cls: "a.B", name: "c", fail: true }, { cls: "a.B", name: "d", fail: true }]);
    body("## Failing tests to fix\na.B.c\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BASELINE: stopped — some failing tests are not named in the issue");
    expect(r.stdout).toMatch(/not named in the issue:\n {2}- a\.B\.d$/m);
    expect(existsSync(join(runDir, "baseline-red.json"))).toBe(false);
  });

  it("matches a class only at a dot boundary", () => {
    report([{ cls: "a", name: "BTestOther.x", fail: true }]);
    body("## Failing tests to fix\na.BTest\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("  - a.BTestOther.x");
  });

  it("accepts the heading at other levels and cases, and stops at the next heading", () => {
    report([{ cls: "a.B", name: "c", fail: true }]);
    body("### FAILING TESTS TO FIX:\r\n1. a.B.c\r\n\r\n# Next\r\nq.R.s\r\n");
    expect(red().status).toBe(0);
    expect(state().named).toEqual(["a.B.c"]);
  });

  it("stops with no heading, and says how to name the tests", () => {
    report([{ cls: "a.B", name: "c", fail: true }]);
    body("Please fix a.B.c");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the issue names no failing tests to fix");
    expect(r.stdout).toContain("## Failing tests to fix");
    expect(r.stdout).toContain("  - a.B.c");
  });

  it("stops without JUnit reports and says to turn on a reporter", () => {
    body("## Failing tests to fix\na.B.c\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("JUnit XML reporter");
  });

  it("stops when the reports name no failing test", () => {
    report(BASE.map((c) => ({ ...c, fail: false })));
    body("## Failing tests to fix\na.B.c\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the reports name no failing test");
  });

  it("stops when the issue text is missing", () => {
    report([{ cls: "a.B", name: "c", fail: true }]);
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the issue text could not be read");
  });

  it("does not count a report from before the marker (an earlier attempt)", () => {
    report([{ cls: "a.B", name: "c", fail: true }]);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(work, "TEST-x.xml"), old, old);
    body("## Failing tests to fix\na.B.c\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("JUnit XML reporter");
  });

  it("keeps names without a class, and decodes entities", () => {
    report([{ name: "does &amp; works", fail: true }]);
    body("## Failing tests to fix\ndoes & works\n");
    expect(red().status).toBe(0);
    expect(state().failing).toEqual(["does & works"]);
  });

  it("prints a name cleaned but keeps the full identity for the comparison", () => {
    const long = `a.${"x".repeat(250)}`;
    report([{ name: `${long}1`, fail: true }, { name: `${long}2`, fail: true }, { name: "bad`tick", fail: true }]);
    body(`## Failing tests to fix\n${long}1\n`);
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("`");
    expect(r.stdout).toContain("badtick");
    // two distinct tests that share their first 200 characters are still two tests
    expect(r.stdout).toMatch(/not named in the issue:\n( {2}- .*\n){2}/);
  });
});

describe("baseline-tests green", () => {
  it("notes the named tests that already pass", () => {
    body("## Failing tests to fix\na.B.c\n");
    const r = run("green", runDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already pass");
    expect(readFileSync(join(runDir, "baseline-note.md"), "utf8")).toContain("a.B.c");
  });

  it("says nothing without names", () => {
    body("Nothing here");
    const r = run("green", runDir);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(existsSync(join(runDir, "baseline-note.md"))).toBe(false);
  });
});

describe("baseline-tests verify", () => {
  const goOn = (named = "a.B.c") => {
    report(BASE);
    body(`## Failing tests to fix\n${named}\n`);
    expect(red().status).toBe(0);
  };
  const after = (cases: Case[]) => {
    utimesSync(marker, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    report(cases);
  };

  it("is ok when the named tests pass and nothing else broke", () => {
    goOn();
    after(BASE.map((c) => ({ ...c, fail: false })));
    const r = verify();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIXED TESTS: ok");
    expect(readFileSync(join(runDir, "baseline-note.md"), "utf8")).toContain("After the change the named tests pass");
  });

  it("fails when the named tests still fail", () => {
    goOn();
    after(BASE);
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/named tests that do not pass yet:\n {2}- a\.B\.c/);
  });

  it("fails when a test that passed before fails now", () => {
    goOn();
    after([{ cls: "a.B", name: "c" }, { cls: "a.B", name: "d", fail: true }, { cls: "a.C", name: "e" }]);
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/passed before the change and fail now:\n {2}- a\.B\.d/);
  });

  it("fails when a test that passed before did not run now", () => {
    goOn();
    after([{ cls: "a.B", name: "c" }, { cls: "a.B", name: "d" }]);
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/passed before the change and did not run now:\n {2}- a\.C\.e/);
  });

  it("fails when a named test did not run", () => {
    goOn();
    after([{ cls: "a.B", name: "d" }, { cls: "a.C", name: "e" }]);
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/named tests that did not run:\n {2}- a\.B\.c/);
  });

  it("does not let a class name hide a deleted, renamed or skipped failing test", () => {
    goOn("a.B");
    for (const cases of [
      [{ cls: "a.B", name: "d" }, { cls: "a.C", name: "e" }], // c deleted
      [{ cls: "a.B", name: "c2" }, { cls: "a.B", name: "d" }, { cls: "a.C", name: "e" }], // c renamed
      [{ cls: "a.B", name: "c", skip: true }, { cls: "a.B", name: "d" }, { cls: "a.C", name: "e" }], // c skipped
    ] as Case[][]) {
      after(cases);
      const r = verify();
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/named tests that did not run:\n {2}- a\.B\.c/);
    }
  });

  it("fails without fresh reports, and has nothing to check without a red baseline", () => {
    goOn();
    // a retry that leaves the earlier reports untouched: they are older than the marker
    const later = new Date(Date.now() + 10_000);
    utimesSync(marker, later, later);
    expect(verify().stdout).toContain("FIXED TESTS: not yet — no JUnit XML reports");
    rmSync(join(runDir, "baseline-red.json"));
    const r = verify();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to check");
  });
});

describe("baseline-tests: report formats", () => {
  it("reads single-quoted attributes", () => {
    writeFileSync(join(work, "TEST-q.xml"), "<testsuite failures='1'><testcase classname='a.B' name='c'><failure/></testcase></testsuite>");
    body("## Failing tests to fix\na.B.c\n");
    expect(red().status).toBe(0);
    expect(state().failing).toEqual(["a.B.c"]);
  });

  it("refuses the exception when another report has a failure that no test case names", () => {
    report([{ cls: "a.B", name: "c", fail: true }]);
    writeFileSync(join(work, "TEST-other.xml"), "<testsuite failures=\"1\"><testcase><failure/></testcase></testsuite>");
    body("## Failing tests to fix\na.B.c\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("no test case names");
    expect(existsSync(join(runDir, "baseline-red.json"))).toBe(false);
  });

  it("refuses when a suite counts more failures than its cases show", () => {
    writeFileSync(join(work, "TEST-s.xml"), '<testsuite failures="2"><testcase classname="a.B" name="c"><failure/></testcase></testsuite>');
    body("## Failing tests to fix\na.B\n");
    expect(red().status).toBe(1);
  });

  it("a check after the change also refuses an unreadable failure", () => {
    report([{ cls: "a.B", name: "c", fail: true }, { cls: "a.B", name: "d" }]);
    body("## Failing tests to fix\na.B.c\n");
    expect(red().status).toBe(0);
    writeFileSync(join(work, "TEST-x.xml"), '<testsuite errors="1"><testcase classname="a.B" name="c"/></testsuite>');
    expect(verify().stdout).toContain("no test case names");
  });
});

describe("baseline-tests purge", () => {
  it("removes old reports only for a run with a red baseline, so an incremental runner must write new ones", () => {
    report([{ cls: "a.B", name: "c" }]);
    run("purge", runDir);
    expect(existsSync(join(work, "TEST-x.xml"))).toBe(true);
    writeFileSync(join(runDir, "baseline-red.json"), "{}");
    run("purge", runDir);
    expect(existsSync(join(work, "TEST-x.xml"))).toBe(false);
  });
});

describe("baseline-tests red: ## Build to fix", () => {
  const BUILD_STATE = { version: 1, named: [], failing: [], passed: [], build: true };
  const GOING_ON = "BASELINE: going on — this issue fixes the build";

  it("goes on with no reports", () => {
    body("## Build to fix\nIt does not compile.");
    const r = red();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(GOING_ON);
    expect(state()).toEqual(BUILD_STATE);
    expect(readFileSync(join(runDir, "baseline-note.md"), "utf8")).toMatch(/### Tests before the change[\s\S]*fixes the build/);
    expect(readFileSync(join(runDir, "baseline-verdict.txt"), "utf8")).toContain(GOING_ON);
  });

  it("goes on with failures that no test case names", () => {
    writeFileSync(join(work, "TEST-u.xml"), '<testsuite failures="1"><testcase><failure/></testcase></testsuite>');
    body("## Build to fix\n");
    expect(red().status).toBe(0);
    expect(state()).toEqual(BUILD_STATE);
  });

  it("goes on when named and unnamed failures are mixed (the build exception comes first)", () => {
    writeFileSync(join(work, "TEST-m.xml"), '<testsuite failures="2"><testcase classname="a.B" name="c"><failure/></testcase></testsuite>');
    body("## Build to fix\n");
    expect(red().status).toBe(0);
    expect(state()).toEqual(BUILD_STATE);
  });

  it("goes on when the reports name no failing test", () => {
    report(BASE.map((c) => ({ ...c, fail: false })));
    body("## Build to fix\n");
    expect(red().status).toBe(0);
    expect(state()).toEqual(BUILD_STATE);
  });

  it("accepts other levels, cases, a colon and CRLF, and rejects other text", () => {
    body("### BUILD TO FIX:\r\n");
    expect(red().status).toBe(0);
    rmSync(join(runDir, "baseline-red.json"));
    body("Please fix the build to fix it");
    const a = red();
    expect(a.status).toBe(1);
    expect(a.stdout).toContain("JUnit XML reporter");
    body("## Build to fix later");
    expect(red().status).toBe(1);
    expect(existsSync(join(runDir, "baseline-red.json"))).toBe(false);
  });

  it("still stops for named failing tests that the issue does not list", () => {
    report(BASE);
    body("## Build to fix\n");
    const r = red();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the issue names no failing tests to fix");
    expect(existsSync(join(runDir, "baseline-red.json"))).toBe(false);
  });

  it("keeps the usual state when the failing tests are listed too", () => {
    report(BASE);
    body("## Build to fix\n\n## Failing tests to fix\na.B.c\n");
    expect(red().status).toBe(0);
    const s = state();
    expect(s.named).toEqual(["a.B.c"]);
    expect(s.build).toBeUndefined();
  });

  it("without the heading and no reports leaves no state", () => {
    body("Nothing here");
    expect(red().status).toBe(1);
    expect(existsSync(join(runDir, "baseline-red.json"))).toBe(false);
  });
});

describe("baseline-tests verify: build fix", () => {
  beforeEach(() => {
    body("## Build to fix\n");
    expect(red().status).toBe(0);
  });

  it("passes with green fresh reports", () => {
    report(BASE.map((c) => ({ ...c, fail: false })));
    const r = verify();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("FIXED TESTS: ok — this issue fixes the build");
    expect(readFileSync(join(runDir, "baseline-note.md"), "utf8")).toContain("After the change the build and the tests pass");
  });

  it("passes with no reports at all", () => {
    expect(verify().status).toBe(0);
  });

  it("fails when a fresh report shows a failing test", () => {
    report([{ cls: "a.B", name: "c", fail: true }]);
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/tests that fail now:\n {2}- a\.B\.c/);
  });

  it("fails with failures that no test case names", () => {
    writeFileSync(join(work, "TEST-u.xml"), '<testsuite failures="1"><testcase><failure/></testcase></testsuite>');
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("no test case names");
  });

  it("leaves an old state without build on its old path", () => {
    writeFileSync(join(runDir, "baseline-red.json"), JSON.stringify({ version: 1, named: ["a.B.c"], failing: ["a.B.c"], passed: [] }));
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not yet — no JUnit XML reports");
  });
});
