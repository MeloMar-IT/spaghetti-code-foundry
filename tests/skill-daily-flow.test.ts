import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { dataHome } from "../src/auth/store.js";
import { ConfigSchema, WatcherSchema, type Config } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { discoverSkills, pinSkill } from "../src/skills/registry.js";
import { RUN_SKILL_LOCK_FILE } from "../src/skills/run-lock.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// issue-plan + issue-code-daily on one issue lock what issue-gitflow locks; the coding run checks the plan record again.
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const VARS = { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" };
const FAKES = ["FAKE_IMPL_BUG", "FAKE_FIX_NOOP", "FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_ISSUE_PLAN", "FAKE_SKILL_REQUEST", "FAKE_GH_ISSUE_BODIES", "FAKE_GH_COMMENTS", "FAKE_GH_COMMENTS_BY_ISSUE"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

let n = 0;
const uid = () => `daily-${++n}-x${process.pid}`.toLowerCase().replace(/[^a-z0-9-]/g, "");

describe("the shipped issue-code-daily flow", () => {
  const flow = parse(readFileSync("flows/issue-code-daily.yaml", "utf8")) as { steps: { id: string; run?: string; skill_role?: string }[] };
  const ids = flow.steps.map((s) => s.id);
  it("checks the plan record before it tests and codes, and reviews as a reviewer", () => {
    expect(ids.slice(ids.indexOf("daily_branch"), ids.indexOf("implement") + 1)).toEqual(["daily_branch", "plan_check", "baseline_tests", "implement"]);
    expect(flow.steps.find((s) => s.id === "plan_check")!.run).toContain("/plan-comment");
    for (const id of ["review_1", "review_2"]) expect(flow.steps.find((s) => s.id === id)!.skill_role).toBe("reviewer");
  });
});

describe("plan, then code, with skills", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let root: string;
  let config: Config;
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    rmSync(join(dataHome(), "skill-plans"), { recursive: true, force: true });
    gh = fakeGithub();
    root = mkdtempSync(join(tmpdir(), "daily-skills-"));
    config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3, skills: { builtin: false, roots: [root] } });
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    process.env.FAKE_GH_COMMENTS_FROM_LOG = "1";
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => {
    gh.restore();
    delete process.env.FAKE_GH_COMMENTS_FROM_LOG;
    rmSync(root, { recursive: true, force: true });
  });

  const install = (id: string) => {
    const d = join(root, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\n${"Do it. ".repeat(60)}\n`); // longer than REVIEW.md, so the review block is given
    writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
    writeFileSync(join(d, "REVIEW.md"), `Check that ${id} was followed.\n`);
  };
  const pin = (id: string) => {
    const reg = discoverSkills(config.skills);
    pinSkill(reg, `${id}@1.0.0`, reg.byKey.get(`${id}@1.0.0`)!.digest);
  };
  const issues = (flowLabel: string[], ...nums: number[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(nums.map((number) => ({ number, title: `issue ${number}`, labels: flowLabel.map((name) => ({ name })) })));
  };
  const settle = async () => {
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  };
  const watcher = (id: string, label: string, flow: string, extra: object = {}) => new Watcher(WatcherSchema.parse({
    id, github_repo: REPO, label, flow, status_labels: LABELS, remove_on_done: [label], vars: VARS, ...extra,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const planner = () => watcher("plan", "Factory_ready", "issue-plan", { status_labels: { ...LABELS, working: "Factory_planning", done: "Factory_planned" } });
  const coder = () => watcher("code", "Factory_code", "issue-code-daily", { remove_on_done: ["Factory_code", "Factory_planned"], pause_while_pr_open: "factory/daily-", one_at_a_time: true });
  const gitflow = () => watcher("go", "Factory_go", "issue-gitflow", { max_per_tick: 2, dependency_done_labels: ["Factory_done"] });
  const runOf = (flow: string, issue: string) => scheduler.list().find((s) => s.flow === flow && s.vars.issue === issue)!;
  const lockFile = (run: { runDir: string }) => JSON.parse(readFileSync(join(run.runDir, RUN_SKILL_LOCK_FILE), "utf8")) as { skills: Record<string, unknown>[] };
  const picks = (run: { runDir: string }) => lockFile(run).skills.map(({ id, version, digest, selection, requiredBy }) => ({ id, version, digest, selection, requiredBy }));

  async function plan(issue: number): Promise<void> {
    issues(["Factory_ready"], issue);
    await planner().tick();
    await settle();
    expect(runOf("issue-plan", String(issue)).status).toBe("succeeded");
  }

  it("locks what issue-gitflow locks and loads it for the coder and the reviewer", async () => {
    const id = uid();
    install(id);
    pin(id);
    process.env.FAKE_GH_ISSUE_BODIES = JSON.stringify({ 6: "Please add feature.txt\nREQUEST_CATALOGUE_SKILLS", 7: "Please add feature.txt\nREQUEST_CATALOGUE_SKILLS" });
    await plan(7);
    issues(["Factory_code", "Factory_planned"], 7);
    await coder().tick();
    await settle();
    issues(["Factory_go"], 6);
    await gitflow().tick();
    await settle();

    const daily = runOf("issue-code-daily", "7");
    const flowRun = runOf("issue-gitflow", "6");
    expect([daily.status, flowRun.status, daily.reason, flowRun.reason]).toEqual(["succeeded", "succeeded", undefined, undefined]);
    expect(daily.planCheck).toMatchObject({ outcome: "record", stopped: false });
    expect(picks(daily)).toHaveLength(1);
    expect(picks(daily)).toEqual(picks(flowRun));
    const implDaily = daily.history.find((h) => h.id === "implement")!;
    expect(implDaily.skills).toMatchObject({ loaded: [`${id}@1.0.0`], state: "loaded" });
    expect(flowRun.history.find((h) => h.id === "implement")!.skills?.loaded).toEqual(implDaily.skills?.loaded);
    expect(daily.history.find((h) => h.id === "review_1")!.skills).toMatchObject({ role: "reviewer", loaded: [`${id}@1.0.0`] });
    const order = daily.history.map((h) => h.id);
    expect(order.indexOf("plan_check")).toBeLessThan(order.indexOf("implement"));
  });

  it("an edited plan comment stops; a missing skill stops under skills.unresolved; a resume checks again", async () => {
    const id = uid();
    install(id);
    pin(id);
    process.env.FAKE_GH_ISSUE_BODIES = JSON.stringify({ 7: "Please add feature.txt\nREQUEST_CATALOGUE_SKILLS" });
    await plan(7);
    const posted = readFileSync(join(gh.tmp, "gh.log"), "utf8");
    const body = posted.split("--- comment on #7:\n").find((b) => b.includes("Foundry plan**"))!.split("\n--- end comment")[0]!;
    const url = runOf("issue-plan", "7").history.find((h) => h.id === "post_plan")!.output.split("\n").find((l) => /#issuecomment-\d+$/.test(l.trim()))!.trim();
    const edited = JSON.stringify({ "acme/app#7": { comments: [{ body: body.trimEnd().replace(/\n([^\n]*)$/, "\n\nOne word changed.\n$1"), url, viewerDidAuthor: true }] } });

    process.env.FAKE_GH_COMMENTS_BY_ISSUE = edited;
    issues(["Factory_code", "Factory_planned"], 7);
    await coder().tick();
    await settle();
    const stopped = runOf("issue-code-daily", "7");
    expect(stopped.status).toBe("stopped");
    expect(stopped.reason).toBe("skills not resolved: the plan comment was edited — plan the issue again");
    expect(stopped.state.next).toBe("plan_check");
    expect(stopped.history.some((h) => h.id === "implement")).toBe(false);
    expect(stopped.planCheck).toMatchObject({ outcome: "comment-changed", stopped: true });

    // the comment is as posted again, but the skill is gone
    delete process.env.FAKE_GH_COMMENTS_BY_ISSUE;
    rmSync(join(root, id), { recursive: true, force: true });
    scheduler.submit({ kind: "resume", runId: stopped.runId });
    await settle();
    const gone = runOf("issue-code-daily", "7");
    expect(gone.status).toBe("stopped");
    expect(gone.skillPlan).toMatchObject({ action: "stop", gate: "plan_check" });
    expect(gone.history.some((h) => h.id === "implement")).toBe(false);

    // the skill is back and pinned
    install(id);
    pin(id);
    scheduler.submit({ kind: "resume", runId: gone.runId });
    await settle();
    const done = runOf("issue-code-daily", "7");
    expect(done.reason).toBeUndefined();
    expect(done.status).toBe("succeeded");
    expect(done.history.find((h) => h.id === "implement")!.skills?.loaded).toEqual([`${id}@1.0.0`]);
  });
});
