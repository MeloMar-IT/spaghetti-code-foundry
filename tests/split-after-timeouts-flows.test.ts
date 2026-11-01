import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// A story whose coding turn keeps timing out goes to the planner to be split (issue-gitflow and issue-code-daily).
const REPO = "acme/app";
const FAKES = ["FAKE_HANG_IMPLEMENT", "FAKE_FORCED_SPLIT", "FAKE_FORCED_SPLIT_CAPTURE", "FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_ISSUE_PLAN"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

describe("a story that keeps timing out in implement, in the shipped flows", () => {
  let gh: ReturnType<typeof fakeGithub>;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3 });
  const runsDir = () => join(gh.tmp, "runs");
  const capture = () => join(gh.tmp, "force-split.jsonl");

  beforeEach(() => {
    gh = fakeGithub();
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    for (const k of FAKES) delete process.env[k];
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 5, title: "issue 5", labels: [{ name: "Factory_go" }] }]);
    process.env.FAKE_HANG_IMPLEMENT = "1";
    process.env.FAKE_FORCED_SPLIT_CAPTURE = capture();
  });
  afterEach(() => {
    for (const k of FAKES) delete process.env[k];
    gh.restore();
  });

  const ran = (name: string) => {
    const flow = loadFlow(name, gh.tmp).flow;
    flow.steps.find((s) => s.id === "implement")!.timeout_sec = 0.5;
    return flow;
  };
  // The default limit is 2 retries: the third time-out goes to the planner.
  const story = async (name: string) => {
    const flow = ran(name);
    let run = await runFlow(flow, {
      task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, source: "watcher go issue #5",
      vars: { github_repo: REPO, issue: "5", test_cmd: "true", trigger_label: "Factory_go", docs_required: "", union_merge_files: "" },
    });
    for (let i = 0; i < 2; i++) {
      expect(run.status).toBe("stopped");
      run = await resumeRun({ runId: run.runId, runsDir: runsDir(), config, claudeBin });
    }
    return run;
  };
  const planner = () => readFileSync(capture(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; prompt: string });

  it("issue-gitflow: splits it through the split gate and leaves the unfinished work in the run's folder", async () => {
    const run = await story("issue-gitflow");
    expect(run.status).toBe("succeeded");
    const ids = run.history.map((h) => h.id);
    expect(ids.filter((id) => id === "implement")).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(["force_split", "split_gate", "create_split"]));
    expect(ids).not.toContain("report");
    const [seen] = planner();
    expect(seen!.prompt).toContain("too big for one coding turn: timed out 3 times");
    expect(seen!.args).toContain("--resume");
    expect(gh.ghLog()).toContain("created issue: issue create --repo acme/app --title Small part one");
    expect(existsSync(join(run.workdir!, "half-done.txt"))).toBe(true);
    expect(gh.remoteGit("branch", "--list", "feature/*")).not.toContain("feature/5");
  });

  it("issue-code-daily: does the same, without a session to resume, and the parts get the watcher's label", async () => {
    const run = await story("issue-code-daily");
    expect(run.status).toBe("succeeded");
    const ids = run.history.map((h) => h.id);
    expect(ids.filter((id) => id === "implement")).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(["force_split", "split_gate", "create_split"]));
    expect(ids).not.toContain("report");
    const [seen] = planner();
    expect(seen!.prompt).toContain("too big for one coding turn: timed out 3 times");
    expect(seen!.args).not.toContain("--resume");
    expect(gh.ghLog()).toMatch(/issue create[^\n]*--label Factory_go/);
    expect(existsSync(join(run.workdir!, "half-done.txt"))).toBe(true);
  });

  it("issue-code-daily: a rejected split stops the run and keeps the unfinished work (no reset)", async () => {
    process.env.FAKE_FORCED_SPLIT = "### ISSUE 1: Small part one\nDEPENDS_ON: none\nDo one.\nSPLIT_RISK: 80\nPLAN_STATUS: TOO_BIG";
    const flow = ran("issue-code-daily");
    const vars = { github_repo: REPO, issue: "5", test_cmd: "true", trigger_label: "Factory_go", docs_required: "", union_merge_files: "", auto_split_max_risk: "10" };
    const opts = { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, source: "watcher go issue #5", vars };
    let run = await runFlow(flow, opts);
    for (let i = 0; i < 2; i++) run = await resumeRun({ runId: run.runId, runsDir: runsDir(), config, claudeBin });
    expect(run.status).toBe("waiting"); // the owner decides: split risk 80 is above the limit of 10
    expect(run.waiting?.stepId).toBe("approve_split");

    run = await resumeRun({ runId: run.runId, runsDir: runsDir(), config, claudeBin, decision: { approved: false, by: "owner" } });
    expect(run.status).toBe("stopped");
    expect(run.history.find((h) => h.id === "approve_split")!.output).toContain("rejected");
    expect(run.state.next).toBe("split_gate"); // a jump-only step resumes at the gate that jumped to it: it asks the owner again
    const after = run.history.slice(run.history.findIndex((h) => h.id === "approve_split") + 1).map((h) => h.id);
    expect(after).toEqual([]); // nothing ran after the rejection: no daily_branch reset, no coding, no create_split
    expect(existsSync(join(run.workdir!, "half-done.txt"))).toBe(true);
    expect(gh.ghLog()).not.toContain("created issue");
  });

  it("both flows give force_split the two git tools and name the field", () => {
    for (const name of ["issue-gitflow", "issue-code-daily"]) {
      const fs = loadFlow(name, gh.tmp).flow.steps.find((s) => s.id === "force_split") as { prompt: string; allowed_tools: string[] };
      expect(fs.prompt).toContain("steps.implement.too_big");
      expect(fs.allowed_tools).toEqual(expect.arrayContaining(["Bash(git status*)", "Bash(git diff*)"]));
    }
  });

  it("issue-code-daily has no risk_gate", () => {
    expect(loadFlow("issue-code-daily", gh.tmp).flow.steps.some((s) => s.id === "risk_gate")).toBe(false);
  });
});
