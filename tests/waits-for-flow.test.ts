import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { runNextStep } from "../src/next-step.js";
import { userRun } from "../src/server/user-view.js";
import { claudeBin, fakeGithub, flowPath } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

type Step = { id: string; run?: string; prompt?: string; routes?: { if: string; goto: string }[]; [k: string]: unknown };
const stepsOf = (f: string): Step[] => (parse(readFileSync(flowPath(f), "utf8")) as { steps: Step[] }).steps;
const byId = (steps: Step[], id: string) => steps.find((s) => s.id === id)!;

describe("WAITS_FOR in the planning flows (structure)", () => {
  for (const f of ["issue-plan", "issue-gitflow", "issue-deliver"]) {
    it(`${f} has the wait_for_story step and routes to it`, () => {
      const steps = stepsOf(f);
      const w = byId(steps, "wait_for_story");
      expect(w).toMatchObject({ repo_access: true, jump_only: true, resume_from: "pull_ticket", on_success: "stop" });
      expect(w.routes).toEqual([{ if: "^QUESTION\\s*$", goto: "send_back" }]);
      expect(w.run).toContain('node "$FACTORY_TOOLS/waits-for"');
      const ids = steps.map((s) => s.id);
      expect(ids.indexOf("revise_plan")).toBeLessThan(ids.indexOf("wait_for_story"));
      expect(ids.indexOf("wait_for_story")).toBeLessThan(ids.indexOf("send_back"));
      const waitsRoute = { if: "^PLAN_STATUS: WAITS_FOR\\s*$", goto: "wait_for_story" };
      expect(byId(steps, "plan").routes).toContainEqual(waitsRoute);
      const rr = byId(steps, "revise_plan").routes!;
      const waitsAt = rr.findIndex((r) => r.if === waitsRoute.if && r.goto === waitsRoute.goto);
      const genericAt = rr.findIndex((r) => r.if === "^PLAN_STATUS: [A-Z_]+\\s*$");
      expect(waitsAt).toBeGreaterThanOrEqual(0);
      expect(genericAt).toBeGreaterThanOrEqual(0);
      expect(waitsAt).toBeLessThan(genericAt);
      for (const id of ["plan", "revise_plan"]) {
        const p = byId(steps, id).prompt!;
        expect(p).toContain("| WAITS_FOR");
        expect(p).toContain("WAITS_FOR_REASON:");
        // local and cross-repository waits are told apart, with one limit for both
        expect(p).toContain("`WAITS_FOR: #<n>` for an issue of this repository whose work has not");
        expect(p).toContain("`WAITS_FOR: owner/name#<n>` for an issue in another of the owner's repositories");
        expect(p).toContain("up to 10 references in total");
        expect(p).toContain("Never ask the owner whether");
        expect(p).not.toContain("up to 10 numbers");
      }
      const sb = byId(steps, "send_back").run!;
      expect(sb).toContain("wanted this issue to wait for another story");
      expect(sb).toContain('extra="$q"');
    });
  }

  it("send_back is the same in all three flows", () => {
    const [a, b, c] = ["issue-plan", "issue-gitflow", "issue-deliver"].map((f) => byId(stepsOf(f), "send_back").run);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("the clone of the planning flows fails instead of planning on old code", () => {
    for (const f of ["issue-plan", "epic-questions"]) {
      const run = byId(stepsOf(f), "clone").run!;
      for (const part of ['git fetch -q origin || {', 'daily-branch" latest) || {', "git checkout -q --detach origin/HEAD || {", 'git checkout -q --detach "origin/$b" || {']) {
        expect(run, f).toContain(part);
      }
      expect(run, f).not.toContain("2>/dev/null || echo NONE");
    }
  });

  it("the clone of the release flows and daily-pr is unchanged", () => {
    for (const f of ["release-daily", "release-build", "daily-pr"]) {
      const run = byId(stepsOf(f), "clone").run!;
      expect(run, f).toContain("git fetch -q origin; ");
      expect(run, f).not.toContain("could not fetch origin");
    }
  });
});

const READ_ME = "README.md";
const OWNER_FAKES = ["FAKE_ISSUE_PLAN", "FAKE_ISSUE_PLAN_THEN", "FAKE_PLAN_COUNT", "FAKE_GH_FAIL", "FAKE_GH_FAIL_TEXT", "FAKE_GH_ISSUES", "FAKE_GH_COMMENTS_FROM_LOG"];
const WAITS = "Needs the API.\nWAITS_FOR: #12\nWAITS_FOR_REASON: needs the API\nPLAN_STATUS: WAITS_FOR";

describe("WAITS_FOR in the issue-plan flow", () => {
  let gh: ReturnType<typeof fakeGithub>;
  const config = ConfigSchema.parse({ protected_branches: ["main"] });
  const runsDir = () => join(gh.tmp, "runs");
  let RUN = "";
  const count = () => Number(readFileSync(join(gh.tmp, "plan-count"), "utf8"));
  const gitIn = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

  beforeAll(() => {
    process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  });
  beforeEach(() => {
    gh = fakeGithub();
    for (const k of OWNER_FAKES) delete process.env[k];
    process.env.FAKE_GH_COMMENTS_FROM_LOG = "1";
    process.env.FAKE_PLAN_COUNT = join(gh.tmp, "plan-count");
    const body = "Text\n\n### Depends on\n";
    process.env.FAKE_GH_ISSUES = JSON.stringify([7, 12].map((number) => ({ number, title: `Issue ${number}`, state: "OPEN", body })));
  });
  afterEach(() => {
    gh.restore();
    rmSync(reposPath(), { force: true });
  });

  const go = (id: string) => {
    RUN = id;
    return runFlow(loadFlow("issue-plan", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), runId: id, claudeBin, config, vars: { github_repo: "acme/app", issue: "7" } });
  };
  const resume = () => resumeRun({ runsDir: runsDir(), runId: RUN, claudeBin, config });

  it("parks, then a resume fails visibly on a broken fetch, branch lookup or checkout, and plans again once clean", async () => {
    process.env.FAKE_ISSUE_PLAN = WAITS;
    process.env.FAKE_ISSUE_PLAN_THEN = "**Q1. Who uses it?**\n**Kind:** product\nAdmins or users.\n**Recommendation:** none\nPLAN_STATUS: NEEDS_INFO";
    const s = await go("20260101-000000-wf01");
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain("wait_for_story");
    expect(s.history.slice(-2).map((h) => h.id)).toEqual(["plan", "wait_for_story"]);
    const bodies = readFileSync(join(gh.tmp, "gh.log.issue-bodies.json"), "utf8");
    expect(bodies).toContain("claude-factory depends-on");
    expect(bodies).toContain("#12");
    expect(gh.comments()).toEqual([]);
    expect(runNextStep(s)).toMatchObject({ kind: "dependency", blockers: [{ issue: 12 }] });
    expect(s.state?.next).toBe("pull_ticket");

    // A broken fetch fails the clone; the planner does not run.
    gitIn(s.workdir!, "remote", "set-url", "origin", join(gh.tmp, "missing.git"));
    let r = await resume();
    expect(r.status).toBe("failed");
    expect(r.history.at(-1)).toMatchObject({ id: "clone" });
    expect(r.history.at(-1)!.output).toContain("could not fetch origin");
    expect(count()).toBe(1);

    // A failed branch lookup fails the clone.
    gitIn(s.workdir!, "remote", "set-url", "origin", gh.remote);
    process.env.FAKE_GH_FAIL = "pr list";
    r = await resume();
    expect(r.status).toBe("failed");
    expect(r.history.at(-1)).toMatchObject({ id: "clone" });
    expect(r.history.at(-1)!.output).toContain("could not find the newest daily branch");
    expect(count()).toBe(1);
    delete process.env.FAKE_GH_FAIL;

    // A local change that conflicts with new remote work fails the checkout.
    const other = join(gh.tmp, "other");
    gitIn(gh.tmp, "clone", "-q", gh.remote, other);
    writeFileSync(join(other, READ_ME), "remote change\n");
    gitIn(other, "commit", "-qam", "new work");
    gitIn(other, "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(s.workdir!, READ_ME), "local change\n");
    r = await resume();
    expect(r.status).toBe("failed");
    expect(r.history.at(-1)).toMatchObject({ id: "clone" });
    expect(r.history.at(-1)!.output).toContain("could not check out main");
    expect(count()).toBe(1);

    // Clean again: the run plans again on the new code.
    gitIn(s.workdir!, "checkout", "--", READ_ME);
    r = await resume();
    expect(r.status).toBe("stopped");
    expect(r.reason).toContain("send_back");
    expect(count()).toBe(2);
    expect(gitIn(s.workdir!, "log", "-1", "--format=%s")).toBe("new work");
  });

  it("asks one question about an invalid wait, without the raw lines", async () => {
    process.env.FAKE_ISSUE_PLAN = WAITS.replace("#12", "#7");
    const s = await go("20260101-000000-wf02");
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain("send_back");
    const c = gh.comments();
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toContain("wanted this issue to wait for another story");
    expect(c[0]!.body).toContain("#7 is this issue itself");
    expect(c[0]!.body.split("\n").some((l) => /^\s*WAITS_FOR/.test(l))).toBe(false);
    const q = JSON.stringify(userRun(s).questions);
    expect(q).toContain("#7 is this issue itself");
    expect(q).toContain("Needs the API.");
  });

  // Last in this block: the accounts made here stay for the rest of the file.
  describe("an issue in another repository of the owner", () => {
    let OWNER = "";
    // Making an account is slow: once. The repositories file is removed after each test, so they are added each time.
    beforeAll(async () => {
      OWNER = (await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "admin" })).id;
    });
    beforeEach(() => {
      addRepo(OWNER, { url: "acme/app", method: "none" });
      addRepo(OWNER, { url: "acme/lib", method: "none" });
      process.env.FAKE_GH_REPO_ISSUES = JSON.stringify({ "acme/lib": [{ number: 3, state: "open" }] });
    });
    afterEach(() => { delete process.env.FAKE_GH_REPO_ISSUES; });
    const goAs = (id: string) =>
      runFlow(loadFlow("issue-plan", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), runId: id, claudeBin, config, owner: OWNER, vars: { github_repo: "acme/app", issue: "7" } });

    // A refused repository (another account's, or none) is covered by tests/waits-for-tool.test.ts and ownerReposEnv's unit test.
    it("records owner/name#N and parks; the engine passed the owner's repositories", async () => {
      process.env.FAKE_ISSUE_PLAN = WAITS.replace("#12", "acme/lib#3");
      const s = await goAs("20260101-000000-wf03");
      expect(s.status, s.reason).toBe("stopped");
      expect(s.reason).toContain("wait_for_story");
      const bodies = JSON.parse(readFileSync(join(gh.tmp, "gh.log.issue-bodies.json"), "utf8"));
      expect(bodies["acme/app#7"]).toContain("- acme/lib#3");
      expect(gh.comments()).toEqual([]);
      expect(runNextStep(s)).toMatchObject({ kind: "dependency", blockers: [{ issue: 3, repo: "acme/lib" }] });
    });
  });
});
