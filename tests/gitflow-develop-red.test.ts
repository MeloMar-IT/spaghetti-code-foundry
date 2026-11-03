import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// Gitflow, a red merge: the run gives up develop, fixes on its feature branch and merges again, so another run can
// merge, test and push develop while it fixes. (The shell steps alone are tested in red-develop-step.test.ts.)
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
// Red only on the merge commit of #6 until feature.txt has the fix; the output names the failing test like vitest does.
const TEST_CMD = [
  's=$(git log -1 --format=%s)',
  'case "$s" in "Merge #6:"*) grep -q fixed feature.txt || { echo "  FAIL  tests/a.test.ts > merge > needs the fix"; echo "AssertionError: expected fixed"; exit 1; };; esac',
].join("; ");
const VARS = { test_cmd: TEST_CMD, reuse_test_results: "no", docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" };
const FAKES = ["FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_GH_COMMENTS", "FAKE_ISSUE_PLAN", "FAKE_FIX_NOOP", "FAKE_FIX_WAIT_FOR"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

describe("gitflow: a red merge gives up develop", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3 });
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    gh = fakeGithub();
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => {
    for (const k of FAKES) delete process.env[k];
    gh.restore();
  });

  const watcher = () => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-gitflow", max_per_tick: 2,
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const issues = (...nums: number[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(nums.map((number) => ({ number, title: `issue ${number}`, labels: [{ name: "Factory_go" }] })));
  };
  const runOf = (issue: string) => scheduler.list().find((s) => s.flow === "issue-gitflow" && s.vars.issue === issue);
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 1200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(ok(), what).toBe(true);
  };
  const locks = () => spawnSync(resolve("tools/area-lock"), ["list"], { encoding: "utf8", env: { ...process.env, FACTORY_VAR_GITHUB_REPO: REPO } }).stdout;

  it("another run merges, tests and pushes develop while this one fixes; the fix is pushed before the second merge", async () => {
    const dir = join(gh.tmp, "gate");
    mkdirSync(dir);
    const gate = join(dir, "go");
    process.env.FAKE_FIX_WAIT_FOR = gate;
    const w = watcher();
    issues(6);
    await w.tick();
    await until(() => existsSync(`${gate}.started`), "the fixer of #6 started");
    const six = runOf("6")!;
    expect(six.history.map((h) => h.id)).toContain("red_develop");
    expect(locks()).not.toMatch(new RegExp(`^${six.runId}\\s.*@develop`, "m"));
    // the fix is not made yet, and the merge result is already on the remote feature branch
    expect(gh.remoteGit("log", "--format=%s", "feature/6-add-a-feature")).toContain("Merge develop into feature/6-add-a-feature");
    issues(6, 7);
    await w.tick();
    await until(() => runOf("7")?.status === "succeeded", "#7 merged while #6 fixes");
    expect(runOf("6")!.status).toBe("running");
    expect(gh.remoteGit("log", "--format=%s", "develop")).not.toContain("Merge #6:");
    writeFileSync(gate, "go");
    await scheduler.idle();
    const [a, b] = [runOf("6")!, runOf("7")!];
    expect([a.status, b.status, a.reason, b.reason]).toEqual(["succeeded", "succeeded", undefined, undefined]);
    const develop = gh.remoteGit("log", "--format=%s", "develop");
    expect(develop.indexOf("Merge #6:")).toBeGreaterThanOrEqual(0);
    expect(develop.indexOf("Merge #6:")).toBeLessThan(develop.indexOf("Merge #7:")); // newest first: #6 sits on top of #7
    const feature = gh.remoteGit("show", "develop:feature.txt");
    expect(feature).toContain("fixed");
    expect(feature).toContain("implemented #7");
    const ids = a.history.map((h) => h.id);
    expect(ids.filter((i) => i === "merge_develop")).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining(["red_develop", "fix_develop", "commit_develop_fix"]));
    const out = (id: string) => a.history.find((h) => h.id === id)!.output ?? "";
    expect(out("red_develop")).toContain("tests/a.test.ts > merge > needs the fix: AssertionError: expected fixed");
    expect(out("red_develop")).toContain("gave up develop");
    expect(out("commit_develop_fix")).toContain("pushed feature/6-");
    const fix = gh.remoteGit("log", "--format=%H", "--grep=Fix #6 after merging into develop", "develop").trim();
    expect(fix).not.toBe(""); // the fix commit is part of develop
    expect(locks()).toBe("");
  });

  it("gives up after 2 fix attempts that did not make it green: develop is not changed, the work stays on the feature branch", async () => {
    process.env.FAKE_FIX_NOOP = "1";
    issues(6);
    await watcher().tick();
    await scheduler.idle();
    const run = runOf("6")!;
    expect(run.status).toBe("failed");
    const red = run.history.filter((h) => h.id === "red_develop");
    expect(red.at(-1)!.ok).toBe(false);
    expect(red.at(-1)!.output).toContain("after 2 fix attempts");
    expect(red.at(-1)!.output).toContain("develop was not changed");
    expect(run.history.filter((h) => h.id === "fix_develop")).toHaveLength(2);
    expect(gh.remoteGit("log", "--format=%s", "develop")).not.toContain("Merge #6");
    expect(gh.remoteGit("branch", "--list", "feature/*")).toContain("feature/6-add-a-feature");
    expect(locks()).not.toContain("@develop");
  });
});
