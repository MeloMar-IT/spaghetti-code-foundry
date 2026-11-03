import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript tool
import { fromLog, fromReports, summary, verdict } from "../tools/failing-tests.mjs";

const TOOL = resolve("tools/failing-tests.mjs");

describe("failing-tests: fromLog", () => {
  it("reads a vitest block with the first error line", () => {
    const log = [" FAIL  tests/ops.test.ts > ops > moves the cap [ tests/ops.test.ts ]", "AssertionError: expected 'x' to match /y/", "  at foo"].join("\n");
    expect(fromLog(log)).toEqual([{ test: "tests/ops.test.ts > ops > moves the cap", message: "AssertionError: expected 'x' to match /y/" }]);
  });

  it("reads jest, pytest, go, gradle and maven lines", () => {
    const log = [
      "  ● math › adds",
      "",
      "    expect(received).toBe(expected)",
      "FAILED tests/test_a.py::test_b - assert 1 == 2",
      "--- FAIL: TestThing (0.00s)",
      "    thing_test.go:12: want 1 got 2",
      "com.acme.FooTest > bar() FAILED",
      "    java.lang.AssertionError: expected 2",
      "[ERROR]   FooTest.baz:42 expected:<1> but was:<2>",
    ].join("\n");
    expect(fromLog(log)).toEqual([
      { test: "math › adds", message: "expect(received).toBe(expected)" },
      { test: "tests/test_a.py::test_b", message: "assert 1 == 2" },
      { test: "TestThing", message: "thing_test.go:12: want 1 got 2" },
      { test: "com.acme.FooTest > bar()", message: "java.lang.AssertionError: expected 2" },
      { test: "FooTest.baz", message: "expected:<1> but was:<2>" },
    ]);
  });

  it("strips colour codes, drops duplicates, and names nothing in an unknown log", () => {
    expect(fromLog("\u001b[31m FAIL \u001b[0m  a.test.ts > x\n FAIL  a.test.ts > x\n").map((t: { test: string }) => t.test)).toEqual(["a.test.ts > x"]);
    expect(fromLog("everything is on fire\nbut in no known format")).toEqual([]);
  });
});

describe("failing-tests: fromReports", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ft-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const xml = '<testsuite><testcase classname="a.B" name="c"><failure message="boom &amp; bang">stack</failure></testcase><testcase classname="a.B" name="ok"/></testsuite>';

  it("reads the failing case of a report newer than the marker, and ignores an older one", () => {
    writeFileSync(join(dir, "marker"), "");
    utimesSync(join(dir, "marker"), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "TEST-a.B.xml"), xml);
    writeFileSync(join(dir, "build", "TEST-old.xml"), xml.replace('name="c"', 'name="old"'));
    utimesSync(join(dir, "build", "TEST-old.xml"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(fromReports(join(dir, "marker"), dir)).toEqual({ files: 1, failing: [{ test: "a.B.c", message: "boom & bang" }] });
  });
});

describe("failing-tests: verdict", () => {
  it("a test run that did not finish is a reason to test again", () => {
    expect(verdict({ unfinished: true, first: [], second: [] }).retest).toBe(true);
  });
  it("failures that differ between two full runs are not proof of a busy machine", () => {
    expect(verdict({ unfinished: false, first: ["a"], second: ["b"] }).retest).toBe(false);
    expect(verdict({ unfinished: false, first: ["a"], second: ["a"] }).retest).toBe(false);
    expect(verdict({ unfinished: false, first: [], second: ["a"] }).retest).toBe(false);
  });
});

describe("failing-tests: the command", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ft-")); writeFileSync(join(dir, "marker"), ""); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync("node", [TOOL, ...args], { cwd: dir, encoding: "utf8" });

  it("names the failing tests from the log, every line starting with '| '", () => {
    writeFileSync(join(dir, "tests.log"), " FAIL  a.test.ts > one\nAssertionError: expected fixed\nRETEST\nDEVELOP_BEHIND: x\n");
    const r = run("summary", join(dir, "marker"), dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("| The failing tests (from the test log), 1 in all:\n|   - a.test.ts > one: AssertionError: expected fixed\n");
  });

  it("prints the last 60 lines when no test can be named, and no line can be a route marker", () => {
    writeFileSync(join(dir, "tests.log"), Array.from({ length: 100 }, (_, i) => (i === 99 ? "RETEST" : `line ${i}`)).join("\n"));
    const lines = run("summary", join(dir, "marker"), dir).stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("No failing test could be named");
    expect(lines).toHaveLength(61);
    expect(lines[1]).toBe("| line 40");
    expect(lines.at(-1)).toBe("| RETEST");
    expect(lines.every((l) => l.startsWith("| "))).toBe(true);
  });

  it("lists at most 20 tests, and hides the home folder", () => {
    const log = Array.from({ length: 25 }, (_, i) => `FAILED t.py::t${i} - in ${homedir()}/x`).join("\n");
    writeFileSync(join(dir, "tests.log"), log);
    const out = run("summary", join(dir, "marker"), dir).stdout;
    expect(out).toContain("25 in all");
    expect(out).toContain("… and 5 more");
    expect(out).not.toContain(homedir());
    expect(out).toContain("(folder)/x");
  });

  it("says the tests did not finish, with the end of the log", () => {
    writeFileSync(join(dir, "tests.log"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
    const lines = run("summary", join(dir, "marker"), dir, "--unfinished").stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("did not finish");
    expect(lines).toHaveLength(31);
    expect(lines[1]).toBe("| l20");
  });

  it("a JUnit message with a line break cannot print a route marker without the prefix", () => {
    writeFileSync(join(dir, "marker"), "");
    utimesSync(join(dir, "marker"), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    writeFileSync(join(dir, "TEST-x.xml"), '<testsuite><testcase classname="a.B" name="c"><failure message="boom\nRETEST\nDEVELOP_BEHIND: x">stack</failure></testcase></testsuite>');
    const out = run("summary", join(dir, "marker"), dir).stdout;
    expect(out).toContain("|   - a.B.c: boom RETEST DEVELOP_BEHIND: x");
    for (const line of out.split("\n").filter(Boolean)) expect(line.startsWith("| ")).toBe(true);
    expect(out.split("\n").some((l) => /^(RETEST|DEVELOP_BEHIND:)/.test(l))).toBe(false);
  });

  it("exits 2 on bad usage", () => {
    expect(run().status).toBe(2);
    expect(run("verdict", "a", "b").status).toBe(2);
    expect(run("summary", "a", "b", "--nope").status).toBe(2);
  });

  it("summary() works without a log", () => {
    expect(summary(join(dir, "marker"), dir, false)[0]).toContain("No failing test could be named");
  });
});
