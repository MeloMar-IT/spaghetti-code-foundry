import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript tool, no types
import { focusedCommand, readList, record, targetsFromLog, targetsFromReports, writeList } from "../tools/failed-first.mjs";

type Target = { target: string; test: string };
const fromLog = (text: string) => targetsFromLog(text) as Target[];
const targets = (...names: string[]) => names.map((target) => ({ target, test: "t" }));

describe("targetsFromLog", () => {
  it.each([
    ["vitest, a test", " FAIL  tests/a.test.ts > s > t", "tests/a.test.ts", "s > t"],
    ["vitest, a file that does not load", " FAIL  tests/a.test.ts [ tests/a.test.ts ]", "tests/a.test.ts", ""],
    ["vitest with a project name", " FAIL  |unit| tests/a.test.ts > t", "tests/a.test.ts", "t"],
    ["jest", "FAIL src/x.test.js (1.2 s)", "src/x.test.js", ""],
    ["pytest", "FAILED tests/test_a.py::test_b - assert 1 == 2", "tests/test_a.py", "test_b"],
    ["go", "--- FAIL: TestX (0.00s)\n    x_test.go:3: no\nFAIL\nFAIL\texample.com/m/pkg\t0.1s", "example.com/m/pkg", "TestX"],
    ["gradle", "com.acme.FooTest > bar() FAILED", "com.acme.FooTest", "bar()"],
    ["maven", "[ERROR]   FooTest.baz:42 expected: <1>", "FooTest", "baz"],
    ["maven, full class name", "[ERROR] com.acme.FooTest.baz -- Time elapsed: 0.1 s <<< FAILURE!", "com.acme.FooTest", "baz"],
  ])("reads %s", (_name, log, target, test) => {
    expect(fromLog(log)).toEqual([{ target, test }]);
  });

  it("removes colour codes and duplicates", () => {
    expect(fromLog("\u001b[31m FAIL \u001b[0m tests/a.test.ts > t\n FAIL  tests/a.test.ts > t\n")).toEqual([{ target: "tests/a.test.ts", test: "t" }]);
  });

  it("names nothing in a log it does not know", () => {
    expect(fromLog("No test files found, exiting with code 1\nFAIL\n[ERROR] Failed to execute goal org.apache.maven.plugins:x\n[ERROR] /src/Foo.java:[3,4] error")).toEqual([]);
  });
});

describe("with files", () => {
  let tmp: string, runDir: string, marker: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "failed-first-"));
    runDir = join(tmp, "run");
    mkdirSync(runDir);
    marker = join(runDir, "tests.marker");
    writeFileSync(marker, "");
    utimesSync(marker, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const report = (name: string, cases: string) => writeFileSync(join(tmp, name), `<testsuite>${cases}</testsuite>`);
  const failing = (attrs: string) => `<testcase ${attrs}><failure message="no"/></testcase>`;

  it("targetsFromReports takes the file, else the class name, of the failing cases of new reports", () => {
    report("junit.xml", failing(`name="one" classname="A" file="${join(tmp, "tests/a.test.ts")}"`) + failing('name="two" classname="com.acme.B"') + '<testcase name="ok" classname="C"/>');
    report("TEST-old.xml", failing('name="old" classname="Old"'));
    utimesSync(join(tmp, "TEST-old.xml"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(targetsFromReports(marker, tmp)).toEqual([{ target: "tests/a.test.ts", test: "one" }, { target: "com.acme.B", test: "two" }]);
  });

  it("record keeps the file the log names when a report only has a dotted class name (pytest)", () => {
    report("junit.xml", failing('name="test_b" classname="tests.test_a"'));
    writeFileSync(join(runDir, "tests.log"), "FAILED tests/test_a.py::test_b - assert\n");
    expect(record(marker, runDir, 1, tmp)).toBe(0);
    expect(focusedCommand("pytest -q", readList(runDir), { exists: (f: string) => f === "tests/test_a.py" })).toBe("pytest -q 'tests/test_a.py'");
  });

  it("record writes the list on a named failure, keeps it when nothing is named, and removes it on a pass", () => {
    const list = join(runDir, "failed-tests.txt");
    writeFileSync(join(runDir, "tests.log"), " FAIL  tests/a.test.ts > a > works\n");
    expect(record(marker, runDir, 1, tmp)).toBe(0);
    expect(readFileSync(list, "utf8")).toBe("tests/a.test.ts\ta > works\n");
    writeFileSync(join(runDir, "tests.log"), "boom\n");
    expect(record(marker, runDir, 1, tmp)).toBe(1);
    expect(readFileSync(list, "utf8")).toBe("tests/a.test.ts\ta > works\n");
    expect(record(marker, runDir, 0, tmp)).toBe(0);
    expect(existsSync(list)).toBe(false);
  });

  it("writeList keeps one line per test, at most 500", () => {
    writeList(runDir, [{ target: "a", test: "x\ny\tz" }, { target: "bad\ttarget", test: "t" }, ...targets(...Array.from({ length: 600 }, (_, i) => `f${i}`))]);
    const lines = readFileSync(join(runDir, "failed-tests.txt"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe("a\tx y z");
    expect(lines[1]).toBe("f0\tt");
  });

  it("the command line: bad usage exits 2, and without a list there is no command", () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("tools/failed-first.mjs"), ...args], { cwd: tmp, encoding: "utf8" });
    expect(cli().status).toBe(2);
    expect(cli("record", marker, runDir, "x").status).toBe(2);
    const none = cli("command", runDir, "vitest run");
    expect([none.status, none.stdout]).toEqual([0, ""]);
  });
});

describe("focusedCommand", () => {
  const files = new Set(["tests/a.test.ts", "tests/test_a.py"]);
  const run = (cmd: string, list: string[], script?: string) =>
    focusedCommand(cmd, targets(...list), { packageJson: script ? { scripts: { test: script } } : null, exists: (f: string) => files.has(f) || f.includes("..") || f.startsWith("/") || f.includes("'") }) as string;
  const JS = ["tests/a.test.ts"], PY = ["tests/test_a.py"], JAVA = ["com.acme.A", "B"];

  it.each([
    ["vitest run", JS, "vitest run 'tests/a.test.ts'"],
    ["npx vitest run", JS, "npx vitest run 'tests/a.test.ts'"],
    ["jest --ci", JS, "jest --ci 'tests/a.test.ts'"],
    // Paths that select tests are replaced: appending would still run everything under them.
    ["vitest run tests/ --coverage", JS, "vitest run --coverage 'tests/a.test.ts'"],
    ["jest -c jest.config.js src", JS, "jest -c jest.config.js 'tests/a.test.ts'"],
    ["pytest tests/", PY, "pytest 'tests/test_a.py'"],
    ["pytest -k fast -q tests other/test_x.py::test_y", PY, "pytest -k fast -q 'tests/test_a.py'"],
    ["python3 -m pytest -q", PY, "python3 -m pytest -q 'tests/test_a.py'"],
    ["go test -count=1 ./...", ["example.com/m/pkg"], "go test -count=1 'example.com/m/pkg'"],
    // A path given to a flag is its value, not a package: it stays, and only the package selector is replaced.
    ["go test -coverprofile ./coverage.out ./...", ["example.com/m/pkg"], "go test -coverprofile ./coverage.out 'example.com/m/pkg'"],
    ["go test -run TestX -timeout 5m ./pkg/...", ["example.com/m/pkg"], "go test -run TestX -timeout 5m 'example.com/m/pkg'"],
    ["./gradlew test", JAVA, "./gradlew test --tests 'com.acme.A' --tests 'B'"],
    ["mvn -q test", JAVA, "mvn -q test -Dtest='com.acme.A,B' -Dsurefire.failIfNoSpecifiedTests=false"],
  ])("%s", (cmd, list, expected) => {
    expect(run(cmd, list)).toBe(expected);
  });

  it.each([
    ["npm test", "npm test -- 'tests/a.test.ts'"],
    ["pnpm test", "pnpm test 'tests/a.test.ts'"],
    ["yarn test", "yarn test 'tests/a.test.ts'"],
    ["bun run test", "bun run test 'tests/a.test.ts'"],
    ["npm ci && npm test", "npm ci && npm test -- 'tests/a.test.ts'"],
  ])("a package script: %s", (cmd, expected) => {
    expect(run(cmd, JS, "vitest run")).toBe(expected);
  });

  it.each(["tsc && vitest run", "vitest run tests/", "jest; echo", "vitest run --changed", "node --test"])("npm test has no focused run when the script is %s", (script) => {
    expect(run("npm test", JS, script)).toBe("");
  });

  it.each([
    "make check", "cargo test", "sh ./run-tests.sh", "bun test", "vitest run | tee x", "vitest run; true", "vitest run $(pwd)", "vitest run 'a b'",
    "vitest bench", "vitest run --changed", "vitest run --unknown tests/", "jest --testPathPattern=unit", "jest --reporters default",
  ])("no focused run for %s", (cmd) => {
    expect(run(cmd, JS, "vitest run")).toBe("");
  });

  it.each([
    ["pytest --cov src", PY], ["go test -tags x ./...", ["m/pkg"]], ["go test example.com/m", ["m/pkg"]], ["go test ./... -args -x", ["m/pkg"]],
    ["./gradlew build test", JAVA], ["./gradlew test --tests Foo", JAVA], ["mvn test -Dtest=Foo", JAVA], ["mvn -q verify", JAVA], ["vitest run", JAVA],
  ])("no focused run for %s", (cmd, list) => {
    expect(run(cmd, list)).toBe("");
  });

  it("leaves out targets that are not safe or not there", () => {
    expect(run("vitest run", ["tests/gone.test.ts", "/etc/x.test.ts", "../x.test.ts", "a'b.test.ts", "-x.test.ts"])).toBe("");
    expect(run("vitest run", ["tests/gone.test.ts", "tests/a.test.ts", "tests/a.test.ts"])).toBe("vitest run 'tests/a.test.ts'");
    expect(run("go test ./...", ["a b", "$(x)", "../x", "-run"])).toBe("");
    expect(run("mvn test", ["a;b", "x'y", "a.b c"])).toBe("");
  });

  it("has no focused run for more than 50 targets", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`);
    expect(run("./gradlew test", many(50))).toContain("--tests 'C49'");
    expect(run("./gradlew test", many(51))).toBe("");
  });
});
