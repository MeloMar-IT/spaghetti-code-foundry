import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { waitForFile } from "./helpers/gate-wait.js";

// A test environment that cannot be used ends the run at the step: the engine side, and the real generated steps.
const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const config = ConfigSchema.parse({ protected_branches: [] });
let tmp: string;
let repo: string;
let runsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "test-env-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const start = (steps: string) => runFlow(parseFlow(`name: t\nworkspace: inplace\nsteps:\n${steps}`), { task: "t", repo, runsDir, claudeBin, config });
const NOTE = 'echo "Docker did not start" > "$FACTORY_ENV_STOP_FILE"';
const FIX = "  - {id: fix, type: shell, jump_only: true, run: 'echo fixed', on_success: end}";

describe("a step whose test environment cannot be used", () => {
  it("ends the run there without the fix step, and a resume runs it again", async () => {
    const s = await start(`  - {id: a, type: shell, run: '${NOTE}; exit 1', on_failure: fix}\n${FIX}`);
    expect(s.status).toBe("failed");
    expect(s.reason).toContain("Docker did not start");
    expect(s.history.map((h) => h.id)).toEqual(["a"]);
    expect(s.history[0]).toMatchObject({ envFailed: true, error: "Docker did not start" });
    const again = await resumeRun({ runId: s.runId, runsDir, claudeBin, config });
    expect(again.history.map((h) => h.id)).toEqual(["a", "a"]);
  });

  it("goes on when the step succeeds, and an earlier step's note does not end a later plain failure", async () => {
    const s = await start(`  - {id: a, type: shell, run: '${NOTE}'}\n  - {id: b, type: shell, run: 'exit 1', on_failure: fix}\n${FIX}`);
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual(["a", "b", "fix"]);
    expect(s.history.some((h) => h.envFailed)).toBe(false);
  });

  it("is kept by its own step among parallel steps", async () => {
    const s = await start(
      [
        "  - {id: both, type: parallel, steps: [a, b], on_failure: fix}",
        // b starts after a has noted its reason, and ends before a does: neither removes or takes over the other's note
        `  - {id: a, type: shell, jump_only: true, run: '${NOTE}; touch noted; ${waitForFile(repo, "b-done")}; exit 1'}`,
        `  - {id: b, type: shell, jump_only: true, run: '${waitForFile(repo, "noted")}; touch b-done; exit 1', timeout_sec: 30}`,
        FIX,
      ].join("\n"),
    );
    const of = (id: string) => s.history.find((h) => h.id === id)!;
    expect(of("a")).toMatchObject({ envFailed: true, error: "Docker did not start" });
    expect(of("b").envFailed).toBeUndefined();
    expect(of("b").error).toBe("exit code 1");
    expect(of("both")).toMatchObject({ envFailed: true });
    expect(s.status).toBe("failed");
    expect(s.history.some((h) => h.id === "fix")).toBe(false);
  });
});

describe("the generated test steps", () => {
  const flow = parseFlow(readFileSync(resolve("flows/issue-gitflow.yaml"), "utf8"));
  const step = (id: string) => flow.steps.find((s) => s.id === id) as { run: string; resume_from?: string };

  const sh = (id: string, testCmd: string) => {
    const runDir = join(tmp, "data", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    const env = {
      PATH: process.env.PATH ?? "", FACTORY_TOOLS: resolve("tools"), FACTORY_RUN_ID: "r1", FACTORY_VAR_TEST_CMD: testCmd,
      FACTORY_VAR_DEVELOP_BRANCH: "develop", FACTORY_VAR_REUSE_TEST_RESULTS: "yes", FACTORY_VAR_TEST_SLOTS: "0", FACTORY_TEST_NICE: "0",
      FACTORY_ENV_STOP_FILE: join(runDir, "stop.txt"), FACTORY_DOCKER_BIN: "/nonexistent-docker", FACTORY_DOCKER_PLATFORM: "linux",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", env }).stdout.trim();
    return { runDir, git, run: () => spawnSync("sh", ["-c", step(id).run.replaceAll("{{run.dir}}", runDir)], { cwd: repo, encoding: "utf8", env }) };
  };

  it("pretest_tests goes back to the feature branch and then fails when the container tests did not run", () => {
    const s = sh("pretest_tests", "echo 'Could not find a valid Docker environment'");
    s.git("init", "-q", "-b", "feature/1-x");
    writeFileSync(join(repo, "a.txt"), "a\n");
    s.git("add", "."); s.git("commit", "-qm", "one");
    writeFileSync(join(s.runDir, "feature-branch"), "feature/1-x\n");
    writeFileSync(join(s.runDir, "trial-merge"), "abc\n");
    s.git("checkout", "-q", "--detach");
    const r = s.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("not tested");
    expect(r.stdout).not.toContain("tested ahead:");
    expect(s.git("branch", "--show-current")).toBe("feature/1-x");
    expect(readFileSync(join(s.runDir, "stop.txt"), "utf8")).toContain("not tested");
    expect(step("pretest_tests").resume_from).toBe("pretest_merge");
  });

  it("a test step does not run the tests when Docker is needed and does not start", () => {
    writeFileSync(join(repo, "pom.xml"), "<artifactId>testcontainers</artifactId>");
    const s = sh("run_tests", "touch ran");
    const r = s.run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Docker did not start");
    expect(spawnSync("ls", [join(repo, "ran")]).status).not.toBe(0);
  });

  it("the run-tests block still reads the reports when node or the tools are missing (a sandbox without them)", () => {
    const block = parse(readFileSync(resolve("blocks/run-tests.yaml"), "utf8")) as { steps: { run: string }[] };
    const text = block.steps[0]!.run;
    const sandbox = (cmd: string) => {
      const work = join(tmp, "work");
      const runDir = join(tmp, "run");
      mkdirSync(work, { recursive: true });
      mkdirSync(runDir, { recursive: true });
      const r = spawnSync("sh", ["-c", text.replaceAll("{{run.dir}}", runDir)], {
        cwd: work,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", FACTORY_TOOLS: join(tmp, "no-tools"), FACTORY_VAR_TEST_CMD: cmd },
      });
      return r.stdout + r.stderr;
    };
    const report = (xml: string) => `sleep 1; mkdir -p reports; printf '%s' '${xml}' > reports/TEST-a.xml`;
    const skip = `<testsuite><testcase name="a"><skipped message="Docker is not available"/></testcase></testsuite>`;
    const ordinary = `<testsuite><testcase name="a"><skipped message="switched off until the next release"/></testcase></testsuite>`;
    expect(sandbox(report(skip))).toContain("not tested: a container test was skipped");
    expect(sandbox(report(ordinary))).not.toContain("not tested");
    expect(sandbox(`echo 'Could not find a valid Docker environment'`)).toContain("not tested: the container tests did not run");
  });

  it("gives the run-tests block a time limit that fits two silent attempts of the watchdog", () => {
    const block = parse(readFileSync(resolve("blocks/run-tests.yaml"), "utf8")) as { steps: { timeout_sec?: number }[] };
    const twoAttempts = 2 * 20 * 60;
    expect(block.steps[0]!.timeout_sec).toBeGreaterThanOrEqual(twoAttempts + 600);
  });

  it("every flow that runs the block's tests keeps that limit", () => {
    for (const dir of ["flows", "tests/fixtures/flows"]) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
        const flow = parseFlow(readFileSync(join(dir, f), "utf8"), f);
        for (const s of flow.steps) {
          // the steps that run tests under the watchdog: their limit must hold two silent attempts
          const run = s.type === "shell" ? s.run : "";
          if (!run.includes('test-env" silence')) continue;
          expect(s.timeout_sec ?? flow.defaults?.timeout_sec ?? 0, `${f} ${s.id}`).toBeGreaterThanOrEqual(3600);
        }
      }
    }
  });

  it("a cached pass does not ask for Docker; every test step checks that the tests really ran", () => {
    for (const s of flow.steps) {
      const text = (s as { run?: string }).run ?? "";
      if (!text.includes('sh -c "$cmd"')) continue;
      expect(text, s.id).toContain('test-env" silence');
      expect(text, s.id).toContain('test-env" check');
      expect(text, s.id).toContain('test-env" docker');
    }
    const reuse = step("baseline_tests").run;
    expect(reuse.indexOf('test-env" docker')).toBeGreaterThan(reuse.indexOf('-f "$passed_dir/$key"'));
  });
});
