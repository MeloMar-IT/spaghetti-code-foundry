import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// tools/test-env docker and check, with a fake docker and a fake `open`: no real Docker is used.
const TOOL = resolve("tools/test-env");
// the signs the tool looks for, put together here so that this file's own text never counts as one in a log
const NO_ENV = ["Could not find", "a valid Docker environment"].join(" ");
const REFUSED = ["client version 1.32 is too old.", "Minimum supported API version is 1.44, please upgrade"].join(" ");

let tmp: string;
let work: string;
let runDir: string;
let marker: string;

const script = (name: string, body: string) => {
  const file = join(tmp, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "test-env-"));
  work = join(tmp, "work");
  runDir = join(tmp, "run");
  mkdirSync(work);
  mkdirSync(runDir);
  marker = join(runDir, "tests.marker");
  writeFileSync(marker, "");
  utimesSync(marker, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  script("docker", `echo "docker $*" >> "${tmp}/calls"\n[ -f "${tmp}/on" ] || { echo "cannot connect" >&2; exit 1; }\necho 29.0.1`);
  script("open", `echo "open $*" >> "${tmp}/calls"\ntouch "${tmp}/on"`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const file = (path: string, text: string) => {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), text);
};
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [TOOL, ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      FACTORY_DOCKER_BIN: join(tmp, "docker"),
      FACTORY_OPEN_BIN: join(tmp, "open"),
      FACTORY_DOCKER_PLATFORM: "darwin",
      FACTORY_DOCKER_WAIT_SEC: "5",
      FACTORY_DOCKER_POLL_MS: "50",
      ...env,
    },
  });
const docker = (cmd = "mvn test", env: Record<string, string> = {}) => run(["docker", runDir, cmd], env);
const check = () => run(["check", marker, runDir]);
const calls = () => (existsSync(join(tmp, "calls")) ? readFileSync(join(tmp, "calls"), "utf8") : "");
const stopped = () => (existsSync(join(runDir, "env-stop.txt")) ? readFileSync(join(runDir, "env-stop.txt"), "utf8") : "");
const POM = "<project><dependency><groupId>org.testcontainers</groupId></dependency></project>";

describe("test-env docker", () => {
  it("asks nothing when the tests do not need Docker", () => {
    file("pom.xml", "<project/>");
    file("a/b/c/d/pom.xml", POM); // deeper than three folders
    file("node_modules/x/package.json", '{"d":"testcontainers"}');
    const r = docker("mvn test -DskipDocker");
    expect(r.status).toBe(0);
    expect(calls()).toBe("");
  });

  it.each([
    ["pom.xml", POM, "mvn test"],
    ["sub/build.gradle.kts", 'testImplementation("org.testcontainers:junit-jupiter")', "./gradlew test"],
    ["gradle/libs.versions.toml", 'testcontainers = "1.19.3"', "./gradlew test"],
    ["package.json", '{"scripts":{"pretest":"docker-compose up"}}', "npm test"],
    ["README", "nothing", "docker compose up -d && mvn test"],
  ])("finds the need in %s", (path, text, cmd) => {
    file(path, text);
    writeFileSync(join(tmp, "on"), "");
    const r = docker(cmd);
    expect(r.stdout).toContain("Docker answers");
    expect(calls()).not.toContain("open");
  });

  it("starts Docker Desktop on macOS, waits and goes on", () => {
    file("pom.xml", POM);
    const r = docker();
    expect(r.status).toBe(0);
    expect(calls()).toContain("open -a Docker");
    expect(r.stdout).toMatch(/Docker answered after \d+ s/);
    expect(stopped()).toBe("");
  });

  it("fails with 'Docker did not start' when it stays off", () => {
    file("pom.xml", POM);
    script("open", "exit 0");
    const r = docker("mvn test", { FACTORY_DOCKER_WAIT_SEC: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Docker did not start");
    expect(stopped()).toContain("Docker did not start");
  });

  it("writes the reason where the engine asks for it", () => {
    file("pom.xml", POM);
    script("open", "exit 1");
    const where = join(tmp, "stop-here.txt");
    expect(docker("mvn test", { FACTORY_ENV_STOP_FILE: where }).status).toBe(1);
    expect(readFileSync(where, "utf8")).toContain("could not be opened");
  });

  it("starts nothing on another system; a missing docker program does not answer", () => {
    file("pom.xml", POM);
    const r = docker("mvn test", { FACTORY_DOCKER_PLATFORM: "linux", FACTORY_DOCKER_BIN: join(tmp, "missing") });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Docker did not start");
    expect(calls()).not.toContain("open");
  });
});

const log = (text: string) => writeFileSync(join(runDir, "tests.log"), `${text}\n`);
const report = (xml: string) => file("build/test-results/TEST-a.xml", `<testsuite tests="1">${xml}</testsuite>`);
const fact = () => JSON.parse(readFileSync(join(runDir, "docker-api.json"), "utf8"));

describe("test-env check", () => {
  it("is not green when Maven skipped the container tests", () => {
    log(`[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: 4\n[ERROR] ${NO_ENV}\nBUILD SUCCESS`);
    report('<testcase name="a"><skipped/></testcase>');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not tested: the container tests did not run");
    expect(stopped()).toContain("not tested");
    expect(existsSync(join(runDir, "docker-api.json"))).toBe(false);
  });

  it("reads the output in a Gradle report", () => {
    log("BUILD SUCCESSFUL");
    report(`<testcase name="a"><skipped/></testcase><system-out><![CDATA[${NO_ENV}]]></system-out>`);
    expect(check().status).toBe(1);
  });

  it("counts a skip because Docker is not available", () => {
    log("BUILD SUCCESSFUL");
    report('<testcase name="a"><skipped message="disabledWithoutDocker is true and Docker is not available"/></testcase>');
    expect(check().stdout).toContain("skipped because Docker is not available");
  });

  it("keeps ordinary skips green, and ignores old reports", () => {
    log("BUILD SUCCESSFUL");
    report('<testcase name="a"><skipped message="switched off until the next release"/></testcase><testcase name="b"><skipped/></testcase>');
    file("old/TEST-old.xml", `<testsuite><system-out>${NO_ENV}</system-out></testsuite>`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(work, "old/TEST-old.xml"), old, old);
    expect(check().status).toBe(0);
    expect(stopped()).toBe("");
  });

  it("notes the version facts when the Engine refuses the API version", () => {
    file("pom.xml", "<properties><testcontainers.version>1.19.3</testcontainers.version></properties>");
    writeFileSync(join(tmp, "on"), "");
    log(`${NO_ENV}\n${REFUSED}`);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the Engine needs 1.44 or newer");
    expect(fact()).toMatchObject({ version: 1, testcontainers: "1.19.3", buildFile: "pom.xml", clientApi: "1.32", minApi: "1.44", engine: "29.0.1", firstWorking: { "1.x": "1.21.4", "2.x": "2.0.2" } });
  });

  it("reads a Gradle version", () => {
    file("build.gradle", "testImplementation platform('org.testcontainers:testcontainers-bom:1.18.0')");
    log(REFUSED);
    check();
    expect(fact()).toMatchObject({ testcontainers: "1.18.0", buildFile: "build.gradle" });
  });

  it("leaves out a version that is none, and advice it has no row for", () => {
    file("pom.xml", "<testcontainers.version>$(rm-rf)</testcontainers.version>");
    log(REFUSED.replace("1.44", "1.99"));
    check();
    expect(fact().testcontainers).toBeUndefined();
    expect(fact().firstWorking).toBeUndefined();
  });

  it("finds a sign far beyond the first and last megabytes of the log", () => {
    // the sign sits 22 MB in: more than any window of the output that was read before
    const filler = Buffer.alloc(1024 * 1024, "x\n");
    const head = Buffer.from(`${NO_ENV}\n`);
    writeFileSync(join(runDir, "tests.log"), Buffer.concat([filler.subarray(0, 0), head, ...Array.from({ length: 22 }, () => filler)]));
    expect(check().stdout).toContain("not tested");
    expect(stopped()).toContain("not tested");
  });

  it("finds a sign that a piece boundary cuts in two", () => {
    const piece = 256 * 1024;
    writeFileSync(join(runDir, "tests.log"), `${"x".repeat(piece - 10)}${NO_ENV}\nBUILD SUCCESS\n`);
    expect(check().stdout).toContain("not tested");
  });

  it("finds a skip in a report that a piece boundary cuts", () => {
    log("BUILD SUCCESS");
    const piece = 256 * 1024;
    file("build/test-results/TEST-a.xml", `${"x".repeat(piece - 20)}<testcase name="a"><skipped message="Docker is not available"/></testcase>`);
    expect(check().stdout).toContain("skipped because Docker is not available");
  });

  it("stops when the test output cannot be read, instead of counting it as tested", () => {
    log("BUILD SUCCESS");
    rmSync(join(runDir, "tests.log"));
    mkdirSync(join(runDir, "tests.log"));
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("the test output could not be read");
  });

  it("names a test run that hung twice", () => {
    log("test-silence: no output for 20 min — the tests were stopped and run once more\n\ntest-silence: stopped — no output for 20 min, twice");
    const r = check();
    expect(r.status).toBe(1);
    expect(stopped()).toBe("the tests hung: no output for 20 minutes, twice\n");
  });
});
