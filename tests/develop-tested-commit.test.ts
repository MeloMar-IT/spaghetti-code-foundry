import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitflowRefusal, HISTORICAL_GITFLOW_DIGEST, upgradeGitflowSteps } from "../src/engine/gitflow-upgrade.js";
import { parseFlow } from "../src/flow/load.js";
import type { Flow } from "../src/flow/schema.js";

// test_develop records the commit it tested (develop-tested); push_develop pushes only that commit. The flow's own shell
// text runs for real against a local bare remote: no server, no agent.
const TOOLS = resolve("tools");
const flow = parseFlow(readFileSync(resolve("flows/issue-gitflow.yaml"), "utf8"));
const step = (id: string) => flow.steps.find((s) => s.id === id) as { run?: string; routes?: { if: string; goto: string }[] };
const script = (id: string): string => String(step(id).run);

describe("test_develop and push_develop: only the tested commit is pushed", () => {
  let tmp: string, work: string, remote: string, runDir: string, lockDir: string, sentinel: string;
  const env = () => ({
    ...process.env, FACTORY_TOOLS: TOOLS, FACTORY_RUN_ID: "r1", FACTORY_VAR_DEVELOP_BRANCH: "develop", FACTORY_VAR_FEATURE_PREFIX: "feature/",
    FACTORY_VAR_GITHUB_REPO: "acme/app", FACTORY_LOCK_DIR: lockDir, FACTORY_VAR_ISSUE: "6", FACTORY_VAR_REUSE_TEST_RESULTS: "no",
    FACTORY_VAR_DELETE_MERGED_BRANCHES: "no", FACTORY_VAR_TEST_CMD: 'touch "$SENTINEL"', SENTINEL: sentinel, FACTORY_PUSH_RETRY_SEC: "0",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  });
  const sh = (id: string, extra: Record<string, string> = {}) =>
    spawnSync("sh", ["-c", script(id).replaceAll("{{run.dir}}", runDir)], { cwd: work, encoding: "utf8", env: { ...env(), ...extra } });
  const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
  const git = (...a: string[]) => spawnSync("git", a, { cwd: work, encoding: "utf8", env: env() }).stdout.trim();
  const remoteDevelop = () => spawnSync("git", ["--git-dir", remote, "rev-parse", "develop"], { encoding: "utf8" }).stdout.trim();
  const tested = () => (existsSync(join(runDir, "develop-tested")) ? readFileSync(join(runDir, "develop-tested"), "utf8").trim() : undefined);
  const commit = (file: string, text: string, msg: string) => { writeFileSync(join(work, file), text); git("add", "."); git("commit", "-qm", msg); };
  /** What merge_develop does: a fresh develop, the feature branch merged into it. */
  const merge = () => {
    git("checkout", "-q", "-B", "develop", "origin/develop");
    git("merge", "--no-ff", "-q", "-m", "Merge #6: x", "feature/6-x");
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "dtc-"));
    work = join(tmp, "work"); remote = join(tmp, "remote.git"); runDir = join(tmp, "runs", "r1"); lockDir = join(tmp, "locks"); sentinel = join(tmp, "ran");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(work);
    spawnSync("git", ["init", "-q", "--bare", "-b", "develop", remote]);
    git("init", "-q", "-b", "develop");
    git("remote", "add", "origin", remote);
    commit("a.txt", "a\n", "start"); git("push", "-q", "origin", "develop");
    git("checkout", "-q", "-b", "feature/6-x");
    commit("f.txt", "feature\n", "implement #6");
    git("checkout", "-q", "develop");
    writeFileSync(join(runDir, "feature-branch"), "feature/6-x\n");
    merge();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  describe("test_develop", () => {
    it("tests the merge on develop and records its commit", () => {
      const r = sh("test_develop");
      expect(r.status).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(tested()).toBe(git("rev-parse", "HEAD"));
      expect(out(r)).not.toMatch(/^NOT_ON_DEVELOP\s*$/m);
    });

    it("on the feature branch (as after red_develop): runs no tests, removes an older record, names merge_develop", () => {
      writeFileSync(join(runDir, "develop-tested"), "old\n");
      git("checkout", "-q", "feature/6-x");
      commit("f.txt", "fixed\n", "fix");
      const r = sh("test_develop");
      expect(r.status).toBe(0);
      expect(out(r)).toMatch(/^NOT_ON_DEVELOP\s*$/m);
      expect(out(r)).toContain("merge_develop");
      expect(existsSync(sentinel)).toBe(false);
      expect(tested()).toBeUndefined();
    });

    it("on develop, but the feature branch has a commit the merge does not have", () => {
      git("checkout", "-q", "feature/6-x");
      commit("f.txt", "fixed\n", "fix");
      git("checkout", "-q", "develop");
      const r = sh("test_develop");
      expect(out(r)).toMatch(/^NOT_ON_DEVELOP\s*$/m);
      expect(out(r)).toContain("has commits that are not in develop");
      expect(existsSync(sentinel)).toBe(false);
      expect(tested()).toBeUndefined();
    });

    it("with an uncommitted change to a tracked file: runs no tests, keeps the change", () => {
      writeFileSync(join(work, "a.txt"), "changed\n");
      const r = sh("test_develop");
      expect(out(r)).toMatch(/^NOT_ON_DEVELOP\s*$/m);
      expect(out(r)).toContain("not committed");
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("changed\n");
    });

    it("records nothing when the tests fail", () => {
      const r = sh("test_develop", { FACTORY_VAR_TEST_CMD: "false" });
      expect(r.status).not.toBe(0);
      expect(tested()).toBeUndefined();
    });

    it("records nothing when the tests change a tracked file", () => {
      const r = sh("test_develop", { FACTORY_VAR_TEST_CMD: 'echo more >> a.txt' });
      expect(r.status).toBe(0);
      expect(tested()).toBeUndefined();
    });

    it("local projects publish the tested commit by its id, not by the branch name", () => {
      expect(script("push_develop")).toContain('update "$dev" --sha "$tested"');
      expect(script("push_develop")).toContain('push "$dev" --sha "$tested"');
    });

    it("is wired to fail the run on the guard, and merge_develop forgets the record", () => {
      expect(step("test_develop").routes).toContainEqual({ if: "^NOT_ON_DEVELOP\\s*$", goto: "fail" });
      expect(script("merge_develop")).toContain('rm -f "{{run.dir}}/develop-tested"');
    });
  });

  describe("push_develop", () => {
    const record = (sha = git("rev-parse", "HEAD")) => writeFileSync(join(runDir, "develop-tested"), sha + "\n");

    it("pushes the tested commit", () => {
      record();
      const r = sh("push_develop");
      expect(r.status).toBe(0);
      expect(out(r)).toContain(`COMMIT: ${git("rev-parse", "HEAD")}`);
      expect(remoteDevelop()).toBe(git("rev-parse", "HEAD"));
    });

    it("refuses without a record", () => {
      const before = remoteDevelop();
      const r = sh("push_develop");
      expect(r.status).toBe(1);
      expect(out(r)).toContain("merge_develop");
      expect(remoteDevelop()).toBe(before);
    });

    it("refuses when develop is not the tested commit", () => {
      record();
      const before = remoteDevelop();
      commit("b.txt", "b\n", "untested");
      const r = sh("push_develop");
      expect(r.status).toBe(1);
      expect(out(r)).toContain("not the commit that test_develop tested");
      expect(remoteDevelop()).toBe(before);
    });

    it("refuses a fix committed on the feature branch after the merge was tested", () => {
      record();
      const before = remoteDevelop();
      git("checkout", "-q", "feature/6-x");
      commit("f.txt", "fixed\n", "fix");
      const r = sh("push_develop");
      expect(r.status).toBe(1);
      expect(out(r)).toContain("not on develop");
      expect(out(r)).toContain("merge_develop");
      expect(remoteDevelop()).toBe(before);
    });

    it("refuses when the feature branch has a commit the tested merge lacks", () => {
      record();
      const before = remoteDevelop();
      git("checkout", "-q", "feature/6-x");
      commit("f.txt", "fixed\n", "fix");
      git("checkout", "-q", "develop");
      const r = sh("push_develop");
      expect(r.status).toBe(1);
      expect(out(r)).toContain("has commits that are not in develop");
      expect(remoteDevelop()).toBe(before);
    });

    it("refuses an uncommitted change to a tracked file and keeps it", () => {
      record();
      const before = remoteDevelop();
      writeFileSync(join(work, "a.txt"), "changed\n");
      const r = sh("push_develop");
      expect(r.status).toBe(1);
      expect(out(r)).toContain("not committed");
      expect(remoteDevelop()).toBe(before);
      expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("changed\n");
    });

    it("pushes the tested commit even when develop moves between the check and a retried push", () => {
      record();
      const tip = git("rev-parse", "HEAD");
      // The first push fails like a GitHub outage, and develop moves in the workspace meanwhile.
      const hook = join(work, ".git", "hooks", "pre-push");
      writeFileSync(hook, `#!/bin/sh\nif [ ! -f "${tmp}/once" ]; then touch "${tmp}/once"; git commit -q --allow-empty -m late; echo "Internal Server Error" >&2; exit 1; fi\n`);
      chmodSync(hook, 0o755);
      const r = sh("push_develop");
      expect(r.status).toBe(0);
      expect(git("rev-parse", "HEAD")).not.toBe(tip);
      expect(remoteDevelop()).toBe(tip);
      expect(out(r)).toContain(`COMMIT: ${tip}`);
    });
  });

  describe("runs saved before this change", () => {
    // The three step scripts as the shipped flow had them before the tested-commit check (the fixture is that copy).
    const historical: string[] = JSON.parse(readFileSync(resolve("tests/fixtures/gitflow-before-tested-commit.json"), "utf8"));
    const withScripts = (base: Flow, runs: string[]): Flow => {
      const f = structuredClone(base);
      ["merge_develop", "test_develop", "push_develop"].forEach((id, i) => {
        (f.steps.find((x) => x.id === id) as { run: string }).run = runs[i];
      });
      return f;
    };
    const runsOf = (f: Flow) => ["merge_develop", "test_develop", "push_develop"].map((id) => (f.steps.find((x) => x.id === id) as { run: string }).run);

    it("the fingerprint is the one of the shipped flow before the change", () => {
      expect(createHash("sha256").update(JSON.stringify(historical)).digest("hex")).toBe(HISTORICAL_GITFLOW_DIGEST);
    });

    it("a shipped run saved before the change gets the current merge, test and push steps", () => {
      const saved = withScripts(flow, historical);
      expect(upgradeGitflowSteps(saved)).toBe(true); // the runner upgrades before it checks for a refusal
      for (const id of ["merge_develop", "test_develop", "push_develop"]) {
        expect(saved.steps.find((s) => s.id === id)).toEqual(flow.steps.find((s) => s.id === id));
      }
      expect(saved.steps.map((s) => s.id)).toEqual(flow.steps.map((s) => s.id));
      expect(gitflowRefusal(saved)).toBeUndefined();
    });

    it("a same-name override that pushes develop unchecked is not rewritten, and is refused", () => {
      const override = withScripts(flow, [runsOf(flow)[0], historical[1], historical[2]]);
      const before = structuredClone(override);
      expect(upgradeGitflowSteps(override)).toBe(false);
      expect(override.steps).toEqual(before.steps);
      expect(gitflowRefusal(override)).toContain("without checking the tested commit");
    });

    it("a same-name override that keeps its own check is kept as it is", () => {
      const custom = withScripts(flow, [...historical.slice(0, 2), historical[2].replace('"$dev"', '"$dev" # custom\n# develop-tested')]);
      const before = structuredClone(custom);
      expect(upgradeGitflowSteps(custom)).toBe(false);
      expect(custom.steps).toEqual(before.steps);
      expect(gitflowRefusal(custom)).toBeUndefined();
    });

    it("the shipped flow and other flows are left alone", () => {
      const current = structuredClone(flow);
      expect(upgradeGitflowSteps(current)).toBe(false);
      expect(gitflowRefusal(current)).toBeUndefined();
      const other = withScripts(flow, historical);
      other.name = "my-own-flow";
      expect(upgradeGitflowSteps(other)).toBe(false);
      expect(gitflowRefusal(other)).toBeUndefined();
    });
  });
});
