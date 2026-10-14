import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { failureSummary } from "../src/failure.js";
import { loadFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// A story that fixes failing tests: the issue names them, the red baseline does not stop the run,
// and the run is merged only when they pass and nothing else broke.
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
// Fails (with JUnit reports) until the change adds feature.txt; a.B.d passes both before and after.
const TEST_CMD = [
  "mkdir -p target; grep -qx 'target/' .git/info/exclude 2>/dev/null || echo 'target/' >> .git/info/exclude",
  "if [ -f feature.txt ]; then",
  "  printf '<testsuite tests=\"2\"><testcase classname=\"a.B\" name=\"c\"/><testcase classname=\"a.B\" name=\"d\"/></testsuite>' > target/TEST-a.xml; exit 0",
  "fi",
  "printf '<testsuite tests=\"2\"><testcase classname=\"a.B\" name=\"c\"><failure message=\"x\">boom</failure></testcase><testcase classname=\"a.B\" name=\"d\"/></testsuite>' > target/TEST-a.xml",
  "exit 1",
].join("\n");
const VARS = { test_cmd: TEST_CMD, docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" };

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

describe("a story that fixes failing tests (gitflow)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    gh = fakeGithub();
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
  });
  afterEach(() => {
    delete process.env.FAKE_GH_ISSUE_BODIES;
    gh.restore();
  });

  const watcher = () => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-gitflow", max_per_tick: 1,
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const go = async (body: string) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 5, title: "issue 5", labels: [{ name: "Factory_go" }] }]);
    process.env.FAKE_GH_ISSUE_BODIES = JSON.stringify({ "5": body });
    await watcher().tick();
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
    return scheduler.list().find((s) => s.flow === "issue-gitflow" && s.vars.issue === "5")!;
  };

  it("goes on when every failing test is named, checks the fix and merges it", async () => {
    const run = await go("Please add feature.txt\n\n## Failing tests to fix\n- a.B.c\n");
    expect(run.reason).toBeUndefined();
    expect(run.status).toBe("succeeded");
    const out = (id: string) => run.history.find((h) => h.id === id)!.output;
    expect(out("baseline_tests")).toContain("BASELINE: going on");
    expect(out("baseline_tests")).toContain("a.B.c");
    expect(out("fixed_tests")).toContain("FIXED TESTS: ok");
    expect(run.history.map((h) => h.id)).not.toContain("baseline_failed");
    const report = gh.comments().find((c) => c.issue === 5 && c.body.includes("merged it into"))!.body;
    expect(report).toContain("### Tests before the change");
    expect(report).toContain("a.B.c");
    expect(gh.remoteGit("show", "develop:feature.txt")).toBe("implemented #5\n");
  });

  it("stops at baseline_failed when the issue names no failing test, and says why", async () => {
    const run = await go("Please add feature.txt");
    expect(run.status).toBe("failed");
    expect(run.history.at(-1)!.id).toBe("baseline_failed");
    expect(run.history.map((h) => h.id)).not.toContain("implement");
    const s = failureSummary(run);
    expect(s.cause).toBe("code");
    expect(s.why).toContain("The tests failed before any change");
    expect(s.why).toContain("a.B.c");
  });
});

describe("the flows of a story that fixes failing tests", () => {
  const steps = (name: string) => loadFlow(name, process.cwd()).flow.steps as unknown as Record<string, unknown>[];
  it.each(["issue-gitflow", "issue-code-daily"])("%s: checks the fix before the commit and resumes from the issue", (name) => {
    const s = steps(name);
    const by = (id: string) => s.find((x) => x.id === id)!;
    expect(by("final_guard").routes).toEqual([{ if: "^BASELINE: red\\b", goto: "fixed_tests" }]);
    expect(by("fixed_tests")).toMatchObject({ jump_only: true, on_success: "commit", on_failure: "fix_fixed_tests" });
    expect(by("fix_fixed_tests")).toMatchObject({ resume: "implement", on_success: "final_guard" });
    expect(by("baseline_failed").resume_from).toBe("pull_ticket");
    expect(by("pull_ticket").run).toContain("issue-body.md");
    expect(by("report").run).toContain("baseline-note.md");
    expect(by("baseline_tests").run).toContain("baseline-tests");
  });

  it("issue-gitflow: the hotfix baseline asks the tool before it writes baseline-sha", () => {
    const run = String(steps("issue-gitflow").find((x) => x.id === "baseline_main")!.run);
    expect(run.indexOf("baseline-tests\" red")).toBeGreaterThan(-1);
    expect(run.indexOf("baseline-tests\" red")).toBeLessThan(run.indexOf('mv "{{run.dir}}/baseline-sha.new"'));
  });

  it("issue-gitflow: the merged develop and main are compared again, from fresh reports", () => {
    const s = steps("issue-gitflow");
    expect(String(s.find((x) => x.id === "test_develop")!.run)).toContain("baseline-tests\" verify");
    expect(String(s.find((x) => x.id === "test_main")!.run)).toContain("baseline-tests\" verify");
  });
});
