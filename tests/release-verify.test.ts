import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFlow } from "../src/flow/load.js";
import { passedBefore, testedKey } from "../src/self-update-tests.js";

// Runs the `run` text of the release check's verify step with sh in a temporary git repository.
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "scf-rv-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "develop");
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  writeFileSync(join(repo, "a.txt"), "2\n");
  git(repo, "commit", "-q", "-am", "two");
  const runDir = join(root, "data", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  const tested = join(root, "data", "tested");
  /** A fake git first on PATH: `body` is shell text that sees "$@" and "$count" (calls so far, this one included) and can `exec` the real git. */
  const fakeGit = (body: string) => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const counter = join(root, "count");
    const file = join(bin, "git");
    writeFileSync(file, `#!/bin/sh\nreal="${realGit}"\nn=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"\n${body}\nexec "$real" "$@"\n`);
    chmodSync(file, 0o755);
    return bin;
  };
  const script = (flow: string, id: string) => {
    const step = loadFlow(flow, repo).flow.steps.find((s) => s.id === id);
    if (!step || step.type !== "shell") throw new Error(`no shell step ${id} in ${flow}`);
    return step.run.replaceAll("{{run.dir}}", runDir);
  };
  const run = (text: string, vars: { test?: string; build?: string; bin?: string }, env: Record<string, string> = {}) => {
    const r = spawnSync("sh", ["-c", text], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: `${vars.bin ? `${vars.bin}:` : ""}${process.env.PATH ?? ""}`,
        ...gitEnv,
        FACTORY_TOOLS: resolve("tools"),
        FACTORY_RUN_ID: "r1",
        FACTORY_VAR_TEST_CMD: vars.test ?? "true",
        FACTORY_VAR_BUILD_CMD: vars.build ?? "",
        FACTORY_VAR_DEVELOP_BRANCH: "develop",
        FACTORY_TEST_SLOT_WAIT_SEC: "0",
        FACTORY_TEST_SLOT_POLL_MS: "50",
        ...env,
      },
    });
    return { status: r.status, out: r.stdout, files: existsSync(tested) && statSync(tested).isDirectory() ? readdirSync(tested) : [] };
  };
  const verify = (vars: Parameters<typeof run>[1], env: Record<string, string> = {}) => run(script("release-daily", "verify"), vars, env);
  return { root, repo, runDir, tested, git: (...a: string[]) => git(repo, ...a), fakeGit, verify, run, script };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("release-daily verify: the time limit", () => {
  const read = (s: ReturnType<typeof setup>, f: string) => readFileSync(join(s.runDir, f), "utf8");

  it("stops the tests at the limit, runs no build and writes no record", () => {
    const s = setup();
    const test = `sleep 60 & echo $! > "${s.root}/child"; echo $$ > "${s.root}/pid"; wait`;
    const started = Date.now();
    const r = s.verify({ test, build: "touch built" }, { FACTORY_CHECK_LIMIT_SEC: "2" });
    expect(Date.now() - started).toBeLessThan(15000);
    expect(r.status).toBe(0);
    expect(r.out).toContain("CHECKS: no");
    const checks = read(s, "checks.md");
    expect(checks).toContain("⏱ **Checks did not finish in time**");
    expect(checks).toContain("the tests");
    expect(checks).not.toContain("⚠ **Checks failed**");
    expect(checks).toContain("not run (no time left)");
    expect(read(s, "tests.log").trim().split("\n").pop()).toMatch(/^test-slot: stopped after /);
    for (const f of ["child", "pid"]) expect(alive(Number(readFileSync(join(s.root, f), "utf8").trim())), f).toBe(false);
    expect(existsSync(join(s.repo, "built"))).toBe(false);
    expect(r.files).toEqual([]);
  });

  it("stops the build at the limit and writes no record", () => {
    const s = setup();
    const started = Date.now();
    const r = s.verify({ test: "true", build: "sleep 60" }, { FACTORY_CHECK_LIMIT_SEC: "2" });
    expect(Date.now() - started).toBeLessThan(15000);
    expect(r.out).toContain("CHECKS: no");
    const checks = read(s, "checks.md");
    expect(checks).toContain("⏱ **Checks did not finish in time**");
    expect(checks).toContain("the build");
    expect(read(s, "build.log").trim().split("\n").pop()).toMatch(/^test-slot: stopped after /);
    expect(r.files).toEqual([]);
  });

  it("does not run the build when the tests used all the time", () => {
    const s = setup();
    const r = s.verify({ test: 'echo 1000 > "$FACTORY_TEST_SLOT_STARTED_FILE"', build: "touch built" }, { FACTORY_VAR_VERIFY_TIMEOUT_MIN: "2" });
    expect(r.out).toContain("not run (no time left)");
    expect(r.out).toContain("⏱ **Checks did not finish in time**");
    expect(r.out).toContain("the build");
    expect(r.out).toContain("CHECKS: no");
    expect(existsSync(join(s.repo, "built"))).toBe(false);
    expect(r.files).toEqual([]);
  });

  it("takes the limit from verify_timeout_min", () => {
    const s = setup();
    const r = s.verify({ test: 'echo "limit=$FACTORY_TEST_SLOT_LIMIT_SEC"' }, { FACTORY_VAR_VERIFY_TIMEOUT_MIN: "2" });
    expect(read(s, "tests.log")).toContain("limit=120");
    expect(r.out).not.toContain("using 180");
    expect(r.out).toContain("CHECKS: yes");
  });

  it("uses 180 minutes for a missing or invalid value and says so", () => {
    for (const v of ["abc", "0", "721", "010", "-1", "1.5", ""]) {
      const s = setup();
      const r = s.verify({ test: 'echo "limit=$FACTORY_TEST_SLOT_LIMIT_SEC"' }, { FACTORY_VAR_VERIFY_TIMEOUT_MIN: v });
      expect(read(s, "tests.log"), v).toContain("limit=10800");
      const warning = `verify_timeout_min "${v}" is not a whole number from 1 to 720 — using 180`;
      if (v === "") expect(r.out).not.toContain("using 180");
      else expect(r.out, v).toContain(warning);
    }
  });

  it("lets FACTORY_CHECK_LIMIT_SEC replace the limit, and ignores a bad one", () => {
    let s = setup();
    s.verify({ test: 'echo "limit=$FACTORY_TEST_SLOT_LIMIT_SEC"' }, { FACTORY_VAR_VERIFY_TIMEOUT_MIN: "2", FACTORY_CHECK_LIMIT_SEC: "5" });
    expect(read(s, "tests.log")).toContain("limit=5");
    for (const v of ["0", "43201", "x"]) {
      s = setup();
      const r = s.verify({ test: 'echo "limit=$FACTORY_TEST_SLOT_LIMIT_SEC"' }, { FACTORY_VAR_VERIFY_TIMEOUT_MIN: "2", FACTORY_CHECK_LIMIT_SEC: v });
      expect(r.out, v).toContain(`FACTORY_CHECK_LIMIT_SEC "${v}" is not a whole number from 1 to 43200 — ignored`);
      expect(read(s, "tests.log"), v).toContain("limit=120");
    }
  });

  it("caps the wait for a test slot at 6 hours and keeps run-anyway", () => {
    const test = 'echo "wait=$FACTORY_TEST_SLOT_WAIT_SEC"';
    let s = setup();
    let r = s.verify({ test }, { FACTORY_TEST_SLOT_WAIT_SEC: "99999" });
    expect(read(s, "tests.log")).toContain("wait=21600");
    expect(r.out).toContain("capped at 21600");
    s = setup();
    r = s.verify({ test }, { FACTORY_TEST_SLOT_WAIT_SEC: "21600" });
    expect(read(s, "tests.log")).toContain("wait=21600");
    expect(r.out).not.toContain("capped");
    s = setup();
    s.verify({ test }, { FACTORY_TEST_SLOT_WAIT_SEC: "" });
    expect(read(s, "tests.log")).toContain("wait=300");
  });

  it("does not call a failure a time-out", () => {
    for (const test of ["exit 124", 'echo "test-slot: stopped after 1 s"; exit 1']) {
      const s = setup();
      const r = s.verify({ test });
      expect(r.out, test).toContain("⚠ **Checks failed**");
      expect(r.out, test).not.toContain("⏱");
      expect(r.out, test).toContain("CHECKS: no");
    }
  });
});

describe("release-daily verify: the record of a pass", () => {
  it("writes the checked record after a clean pass", () => {
    const s = setup();
    const tree = s.git("rev-parse", "HEAD^{tree}");
    const r = s.verify({ test: "true" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("CHECKS: yes");
    expect(r.files).toEqual([testedKey(tree, "true")]);
    expect(readFileSync(join(s.tested, testedKey(tree, "true")), "utf8")).toMatch(new RegExp(`^run r1, \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ, tree ${tree}\\n$`));
    expect(passedBefore(s.tested, tree, "true")).toMatch(/^run r1, /);
  });

  it("writes nothing when the tests fail", () => {
    const s = setup();
    const r = s.verify({ test: "false" });
    expect(r.out).toContain("CHECKS: no");
    expect(r.files).toEqual([]);
  });

  it("writes nothing when the tree was not clean before the tests", () => {
    const s = setup();
    writeFileSync(join(s.repo, "untracked.txt"), "x");
    const r = s.verify({ test: "true" });
    expect(r.out).toContain("CHECKS: yes");
    expect(r.files).toEqual([]);
  });

  it("writes nothing when the tests leave a file or move HEAD", () => {
    for (const test of ["touch x", "git checkout -q HEAD~1"]) {
      const s = setup();
      const r = s.verify({ test });
      expect(r.status, test).toBe(0);
      expect(r.files, test).toEqual([]);
    }
  });

  it("writes nothing when the build restores what the tests changed", () => {
    for (const [test, build] of [["touch x", "rm -f x"], ["git checkout -q HEAD~1", "git checkout -q -"]] as const) {
      const s = setup();
      const r = s.verify({ test, build });
      expect(r.out, test).toContain("CHECKS: yes");
      expect(r.files, test).toEqual([]);
    }
  });

  it("writes nothing when a git call fails", () => {
    const status = setup();
    let r = status.verify({ bin: status.fakeGit('[ "$1" = status ] && exit 1') });
    expect(r.out).toContain("CHECKS: yes");
    expect(r.files).toEqual([]);

    // the right tree, then a failure on the second look at it
    const second = setup();
    const tree = second.git("rev-parse", "HEAD^{tree}");
    r = second.verify({ bin: second.fakeGit(`if [ "$1" = rev-parse ] && [ "$2" = "HEAD^{tree}" ]; then c=$(cat "${second.root}/rp" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "${second.root}/rp"; if [ $c -ge 2 ]; then echo ${tree}; exit 1; fi; fi`) });
    expect(r.status).toBe(0);
    expect(r.files).toEqual([]);

    const always = setup();
    r = always.verify({ bin: always.fakeGit("exit 1") });
    expect(r.status).toBe(0);
    expect(r.out).toContain("CHECKS: yes");
    expect(r.files).toEqual([]);
  });

  it("keeps the record when the build fails, even when it dirties the checkout", () => {
    for (const build of ["false", "touch y; false"]) {
      const s = setup();
      const r = s.verify({ test: "true", build });
      expect(r.out, build).toContain("CHECKS: no");
      expect(r.files, build).toHaveLength(1);
    }
  });

  it("does not fail when the record cannot be written", () => {
    const s = setup();
    mkdirSync(join(s.root, "data"), { recursive: true });
    writeFileSync(s.tested, "a file, not a folder");
    const r = s.verify({ test: "true" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("CHECKS: yes");
  });

  it("is not accepted from the story form of baseline_tests", () => {
    const s = setup();
    const tree = s.git("rev-parse", "HEAD^{tree}");
    const r = s.run(s.script("issue-gitflow", "baseline_tests"), { test: "true" });
    expect(r.files).toEqual([testedKey(tree, "true")]);
    expect(passedBefore(s.tested, tree, "true")).toBeUndefined();
  });
});
