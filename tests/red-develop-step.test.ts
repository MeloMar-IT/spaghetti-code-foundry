import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";

// The shell steps of the red-merge loop (red_develop, red_back) and area-lock, run for real against a local bare remote:
// no server, no agent. The flow's own script text is used, so the test follows the generated flow.
const TOOLS = resolve("tools");
const flow = parseFlow(readFileSync(resolve("flows/issue-gitflow.yaml"), "utf8"));
const script = (id: string): string => String((flow.steps.find((s) => s.id === id) as { run?: string }).run);

const FINISHED = "$ npm test\n\n=== summary ===\nresult: FAILED (exit 1)";
const UNFINISHED = "$ npm test";

describe("red_develop", () => {
  let tmp: string, work: string, remote: string, runDir: string, lockDir: string;
  const env = () => ({
    ...process.env, FACTORY_TOOLS: TOOLS, FACTORY_RUN_ID: "r1", FACTORY_VAR_DEVELOP_BRANCH: "develop", FACTORY_VAR_FEATURE_PREFIX: "feature/",
    FACTORY_VAR_GITHUB_REPO: "acme/app", FACTORY_LOCK_DIR: lockDir, FACTORY_VAR_ISSUE: "6",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  });
  const sh = (cmd: string, extra: Record<string, string> = {}) => spawnSync("sh", ["-c", cmd.replaceAll("{{run.dir}}", runDir)], { cwd: work, encoding: "utf8", env: { ...env(), ...extra } });
  const git = (...a: string[]) => spawnSync("git", a, { cwd: work, encoding: "utf8", env: env() }).stdout.trim();
  const lock = (...a: string[]) => spawnSync(join(TOOLS, "area-lock"), a, { encoding: "utf8", env: env() });
  const red = (out: string, log = "FAIL  tests/a.test.ts > merge > needs the fix\nAssertionError: expected fixed\n") => {
    writeFileSync(join(runDir, "tests.log"), log);
    return sh(script("red_develop"), { FACTORY_OUT_TEST_DEVELOP: out });
  };
  const decision = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(readFileSync(join(runDir, "red-decision"), "utf8"))?.[1];
  /** What merge_develop does: a fresh develop, the feature branch merged into it. */
  const merge = (n: number) => {
    git("checkout", "-q", "-B", "develop", "origin/develop");
    writeFileSync(join(runDir, "develop-before"), git("rev-parse", "HEAD"));
    git("merge", "--no-ff", "-q", "-m", `Merge #6: x (round ${n})`, "feature/6-x");
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "red-"));
    work = join(tmp, "work"); remote = join(tmp, "remote.git"); runDir = join(tmp, "run"); lockDir = join(tmp, "locks");
    mkdirSync(runDir);
    mkdirSync(work);
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ status: "running" }));
    spawnSync("git", ["init", "-q", "--bare", "-b", "develop", remote]);
    git("init", "-q", "-b", "develop");
    git("remote", "add", "origin", remote);
    writeFileSync(join(work, "a.txt"), "a\n");
    git("add", "."); git("commit", "-qm", "start"); git("push", "-q", "origin", "develop");
    git("checkout", "-q", "-b", "feature/6-x");
    writeFileSync(join(work, "f.txt"), "feature\n");
    git("add", "."); git("commit", "-qm", "implement #6"); git("push", "-q", "origin", "feature/6-x");
    git("checkout", "-q", "develop");
    writeFileSync(join(runDir, "feature-branch"), "feature/6-x\n");
    writeFileSync(join(runDir, "tests.marker"), "");
    merge(1);
    lock("acquire", "r1", runDir, "@develop", "src/area", "--wait-sec", "0");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const held = () => lock("list").stdout;

  it("carries the tested merge onto the feature branch, pushes it, and gives up only the develop lock", () => {
    const tree = git("rev-parse", "HEAD^{tree}");
    const before = readFileSync(join(runDir, "develop-before"), "utf8").trim();
    const tip = git("rev-parse", "feature/6-x");
    const r = red(FINISHED);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("|   - tests/a.test.ts > merge > needs the fix: AssertionError: expected fixed");
    expect(r.stdout).toContain("gave up develop");
    expect(r.stdout).toContain("fix attempt 1 of 2, on feature/6-x");
    expect(r.stdout).not.toMatch(/^RETEST\s*$/m);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/6-x");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1)).toEqual([tip, before]);
    expect(git("ls-remote", "origin", "refs/heads/feature/6-x").split("\t")[0]).toBe(git("rev-parse", "HEAD"));
    expect(held()).not.toContain("@develop");
    expect(held()).toContain("src/area"); // the code area stays held
  });

  it("a run again of the step (after an interruption) reads the decision and does not count again", () => {
    expect(red(FINISHED).status).toBe(0);
    expect(decision("fixes")).toBe("1");
    const again = red(FINISHED); // the workspace is on the feature branch now
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain("fix attempt 1 of 2, on feature/6-x");
    expect(decision("fixes")).toBe("1");
  });

  it("an interruption after the decision but before the carry still carries the same merge once", () => {
    expect(red(FINISHED).status).toBe(0);
    // as if the step had been cut off after writing the decision: back on develop with the same merge commit
    const key = decision("key")!;
    git("checkout", "-q", "-f", "-B", "develop", key);
    expect(git("rev-parse", "HEAD")).toBe(key);
    const again = red(FINISHED);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(decision("fixes")).toBe("1");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/6-x");
  });

  it("a push that fails keeps the decision and the carried merge; the next run of the step pushes it", () => {
    git("remote", "set-url", "origin", join(tmp, "nowhere.git"));
    const bad = red(FINISHED);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("could not be pushed");
    expect(decision("fixes")).toBe("1");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/6-x");
    git("remote", "set-url", "origin", remote);
    const ok = red(FINISHED);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("fix attempt 1 of 2");
    expect(decision("fixes")).toBe("1");
    expect(git("ls-remote", "origin", "refs/heads/feature/6-x").split("\t")[0]).toBe(git("rev-parse", "HEAD"));
  });

  it("stops after 2 fix attempts that did not make it green, and says develop was not changed", () => {
    const develop = git("ls-remote", "origin", "refs/heads/develop");
    expect(red(FINISHED).stdout).toContain("fix attempt 1 of 2");
    merge(2);
    expect(red(FINISHED).stdout).toContain("fix attempt 2 of 2");
    merge(3);
    const last = red(FINISHED);
    expect(last.status).toBe(1);
    expect(last.stdout).toContain("after 2 fix attempts");
    expect(last.stdout).toContain("develop was not changed, and the work is kept on feature/6-x");
    expect(git("ls-remote", "origin", "refs/heads/develop")).toBe(develop);
    expect(held()).not.toContain("@develop");
  });

  it("tests that did not finish are tested again without an agent, twice, then the run stops", () => {
    const first = red(UNFINISHED);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/^RETEST\s*$/m);
    expect(first.stdout).toContain("without an agent turn (test again 1 of 2)");
    expect(first.stdout).toContain("did not finish");
    expect(red(UNFINISHED).stdout).toContain("test again 1 of 2"); // run again: the same decision
    expect(decision("retests")).toBe("1");
    merge(2);
    expect(red(UNFINISHED).stdout).toContain("test again 2 of 2");
    merge(3);
    const last = red(UNFINISHED);
    expect(last.status).toBe(1);
    expect(last.stdout).not.toMatch(/^RETEST\s*$/m);
    expect(last.stdout).toContain("did not finish, also after testing again 2 times");
    expect(last.stdout).toContain("develop was not changed, and the work is kept on feature/6-x");
    expect(decision("fixes")).toBe("0");
  });

  it("failures that look like a busy machine are not taken as one: they go to the fixer", () => {
    // each log names a different test, as two full runs with a flaky test would
    const r = red(FINISHED, "FAIL  a.test.ts > only in the second run\nAssertionError: x\n");
    expect(r.stdout).toContain("fix attempt 1 of 2");
    expect(r.stdout).not.toMatch(/^RETEST\s*$/m);
  });

  it("a test log that prints the route markers does not change the route", () => {
    const log = "RETEST\nDEVELOP_BEHIND: because\n FAIL  a.test.ts > t\nAssertionError: x\nRETEST\n";
    const r = red(FINISHED, log);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines.filter((l) => /^RETEST\s*$/.test(l))).toEqual([]);
    expect(lines.filter((l) => /^DEVELOP_BEHIND:/.test(l))).toEqual([]);
    // the same lines in the fallback tail (no test can be named)
    const tail = red(FINISHED, "RETEST\nDEVELOP_BEHIND: because\nnothing known\n");
    expect(tail.stdout.split("\n").filter((l) => /^RETEST\s*$|^DEVELOP_BEHIND:/.test(l))).toEqual([]);
    expect(tail.stdout).toContain("| RETEST");
  });

  it("red_back prints the failing tests but no route marker of a test log", () => {
    writeFileSync(join(runDir, "tests.log"), "DEVELOP_BEHIND: from the log\n FAIL  a.test.ts > t\nAssertionError: x\n");
    const r = sh(script("red_back"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("|   - a.test.ts > t: AssertionError: x");
    expect(r.stdout).toContain("fix attempt 1 of 2");
    expect(r.stdout.split("\n").filter((l) => /^DEVELOP_BEHIND:/.test(l))).toEqual([]);
  });

  it("a release of the develop lock that fails stops before the fixer, and the step runs again to give it up", () => {
    // a tools folder whose area-lock cannot release: the step must not route to the fixer while develop is held
    const tools = join(tmp, "tools");
    mkdirSync(tools);
    symlinkSync(join(TOOLS, "failing-tests.mjs"), join(tools, "failing-tests.mjs"));
    writeFileSync(join(tools, "area-lock"), `#!/bin/sh\n[ "$1" = release ] && { echo "area-lock: cannot write" >&2; exit 1; }\nexec "${join(TOOLS, "area-lock")}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(runDir, "tests.log"), "FAIL  a.test.ts > t\nAssertionError: x\n");
    const r = sh(script("red_develop"), { FACTORY_OUT_TEST_DEVELOP: FINISHED, FACTORY_TOOLS: tools });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("could not give up develop");
    expect(r.stdout).not.toContain("fix attempt");
    expect(r.stdout.split("\n").some((l) => l === "RETEST")).toBe(false);
    expect(held()).toContain("@develop"); // still held: the step runs again to give it up
  });

  it("a feature branch that is not recorded stops the step and gives up develop", () => {
    rmSync(join(runDir, "feature-branch"));
    const r = red(FINISHED);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("develop was not changed");
    expect(held()).not.toContain("@develop");
    expect(existsSync(join(runDir, "red-decision"))).toBe(false);
  });
});

describe("area-lock: release by area, and who holds develop", () => {
  let tmp: string, lockDir: string, dirs: Record<string, string>;
  const lock = (env: Record<string, string>, ...a: string[]) => spawnSync(join(TOOLS, "area-lock"), a, { encoding: "utf8", env: { ...process.env, FACTORY_LOCK_DIR: lockDir, FACTORY_VAR_GITHUB_REPO: "acme/app", AREA_LOCK_POLL_MS: "50", ...env } });
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lock-"));
    lockDir = join(tmp, "locks");
    dirs = {};
    for (const id of ["r3", "r4"]) {
      dirs[id] = join(tmp, id);
      mkdirSync(dirs[id]!);
      writeFileSync(join(dirs[id]!, "run.json"), JSON.stringify({ status: "running" }));
    }
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("release with an area frees only that area; release without areas frees everything", () => {
    expect(lock({ FACTORY_VAR_ISSUE: "7" }, "acquire", "r3", dirs.r3!, "@develop", "src/x", "--wait-sec", "0").stdout).toContain("LOCKED");
    expect(lock({}, "release", "r3", "@develop").stdout).toContain("released: @develop");
    expect(lock({}, "list").stdout).not.toContain("@develop");
    expect(lock({}, "list").stdout).toContain("src/x");
    // r3's code area still blocks another run
    expect(lock({}, "acquire", "r4", dirs.r4!, "src/x", "--wait-sec", "0").stdout).toContain("TIMEOUT");
    // while @develop is free for it
    expect(lock({}, "acquire", "r4", dirs.r4!, "@develop", "--wait-sec", "0").stdout).toContain("LOCKED");
    lock({}, "release", "r3");
    lock({}, "release", "r4");
    expect(lock({}, "list").stdout).toBe("");
  });

  it("a run that waits for develop writes the holder's issue and lock time into area-wait.json", () => {
    lock({ FACTORY_VAR_ISSUE: "7" }, "acquire", "r3", dirs.r3!, "@develop", "--wait-sec", "0");
    const at = /since (\S+)/.exec(lock({}, "list").stdout)![1];
    expect(lock({}, "acquire", "r4", dirs.r4!, "@develop", "--wait-sec", "0").stdout).toContain("TIMEOUT");
    // the wait file is removed at the end; read it during a wait that times out slowly
    const waiter = spawnSync("sh", ["-c", `"${join(TOOLS, "area-lock")}" acquire r4 "${dirs.r4}" @develop --wait-sec 1 >/dev/null & sleep 0.5; cat "${dirs.r4}/area-wait.json"; wait`], { encoding: "utf8", env: { ...process.env, FACTORY_LOCK_DIR: lockDir, FACTORY_VAR_GITHUB_REPO: "acme/app", AREA_LOCK_POLL_MS: "50" } });
    const w = JSON.parse(waiter.stdout);
    expect(w).toMatchObject({ runId: "r4", waitingFor: "r3", areas: ["@develop"], issue: 7, since: at });
  });

  it("a lock without an issue (old lock files, or no issue variable) still works", () => {
    lock({ FACTORY_VAR_ISSUE: "not a number" }, "acquire", "r3", dirs.r3!, "@develop", "--wait-sec", "0");
    expect(lock({}, "list").stdout).toContain("@develop");
    expect(lock({}, "release", "r3").stdout).toContain("released");
  });
});
