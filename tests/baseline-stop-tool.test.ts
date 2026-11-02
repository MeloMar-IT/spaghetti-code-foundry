import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixStory } from "../src/red-base.js";

// The stop file, the green line and the known-red gate of tools/baseline-tests.
const TOOL = resolve("tools/baseline-tests");
const SHA = "a".repeat(40);
const facts = { FACTORY_BASE_BRANCH: "develop", FACTORY_BASE_SHA: SHA, FACTORY_BASE_CLEAN: "yes" };
let tmp: string;
let work: string;
let runDir: string;
let marker: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "baseline-stop-"));
  work = join(tmp, "work");
  runDir = join(tmp, "run");
  mkdirSync(work);
  mkdirSync(runDir);
  marker = join(runDir, "tests.marker");
  writeFileSync(marker, "");
  utimesSync(marker, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const report = (names: string[]) =>
  writeFileSync(join(work, "TEST-x.xml"), `<testsuite tests="${names.length}">${names.map((n) => `<testcase classname="a.B" name="${n}"><failure message="x">boom</failure></testcase>`).join("")}</testsuite>`);
const body = (text: string) => writeFileSync(join(runDir, "issue-body.md"), text);
const runWith = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [TOOL, ...args], { cwd: work, encoding: "utf8", env: { ...process.env, ...env } });
const stop = () => JSON.parse(readFileSync(join(runDir, "baseline-stop.json"), "utf8"));

describe("baseline-tests: the base branch facts", () => {
  it("writes a stop file with the complete list and the assertion, only with the base facts", () => {
    report(Array.from({ length: 25 }, (_, i) => `t${i}`));
    body("no names here");
    expect(runWith({}, "red", marker, runDir).status).toBe(1);
    expect(existsSync(join(runDir, "baseline-stop.json"))).toBe(false);
    expect(runWith(facts, "red", marker, runDir).status).toBe(1);
    const s = stop();
    expect(s).toMatchObject({ version: 1, branch: "develop", commit: SHA });
    expect(s.failing).toHaveLength(25);
    expect(s.assertions[0]).toEqual({ test: "a.B.t0", message: "x" });
  });

  it("is not clean when the flow did not say so, or the worktree cannot be shown clean", () => {
    report(["c"]);
    runWith({ ...facts, FACTORY_BASE_CLEAN: "" }, "red", marker, runDir);
    expect(stop().clean).toBe(false);
    runWith(facts, "red", marker, runDir); // work is no git repository: git status fails
    expect(stop().clean).toBe(false);
  });

  it("is not clean when the tests left changes in the tree", () => {
    spawnSync("git", ["init", "-q"], { cwd: work });
    spawnSync("git", ["add", "-A"], { cwd: work });
    report(["c"]); // an untracked report file is a change
    runWith(facts, "red", marker, runDir);
    expect(stop().clean).toBe(false);
  });

  it("writes no stop file when the run goes on", () => {
    report(["c"]);
    body("## Failing tests to fix\n- a.B.c");
    expect(runWith(facts, "red", marker, runDir).status).toBe(0);
    expect(existsSync(join(runDir, "baseline-stop.json"))).toBe(false);
  });

  it("a story made by fixStory passes the real tool with going on", () => {
    const f = fixStory({ repo: "o/r", state: { branch: "develop", commit: SHA, failing: ["a.B.c", "a.B.d"], assertions: [], since: "2026-01-01T00:00:00.000Z", held: true } });
    if ("unusable" in f) throw new Error(f.unusable);
    report(["c", "d"]);
    body(f.body);
    expect(runWith(facts, "red", marker, runDir).stdout).toContain("BASELINE: going on");
  });
});

describe("baseline-tests known-red", () => {
  const red = (over = {}) => JSON.stringify({ branch: "develop", commit: SHA, fix: 9, failing: ["a.B.c"], ...over });

  it("passes without the server's facts, on another commit, for the fix story and for named tests", () => {
    expect(runWith(facts, "known-red", runDir).status).toBe(0);
    expect(runWith({ ...facts, FACTORY_RED_BASE: "not json" }, "known-red", runDir).status).toBe(0);
    expect(runWith({ ...facts, FACTORY_RED_BASE: red({ commit: "b".repeat(40) }) }, "known-red", runDir).status).toBe(0);
    expect(runWith({ ...facts, FACTORY_RED_BASE: red(), FACTORY_VAR_ISSUE: "9" }, "known-red", runDir).status).toBe(0);
    body("## Failing tests to fix\n- a.B");
    expect(runWith({ ...facts, FACTORY_RED_BASE: red() }, "known-red", runDir).status).toBe(0);
  });

  it("stops and writes a gate stop file otherwise", () => {
    body("nothing named");
    const r = runWith({ ...facts, FACTORY_RED_BASE: red({ fix: undefined }) }, "known-red", runDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BASELINE: stopped — develop has failing tests at aaaaaaa");
    expect(r.stdout).toContain("  - a.B.c");
    expect(stop()).toMatchObject({ gate: true, clean: false, failing: ["a.B.c"] });
  });
});

describe("baseline-tests green", () => {
  it("prints BASE_GREEN last only for a clean tree", () => {
    expect(runWith(facts, "green", runDir).stdout).not.toContain("BASE_GREEN");
    spawnSync("git", ["init", "-q"], { cwd: work });
    const r = runWith(facts, "green", runDir);
    expect(r.stdout.trim().split("\n").at(-1)).toMatch(new RegExp(`^BASE_GREEN: develop ${SHA} \\d{4}-`));
  });
});
