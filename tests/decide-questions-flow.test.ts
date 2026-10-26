import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath, setRepoSettings } from "../src/auth/repos.js";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { DECIDED_HEADING, reportFirst } from "../src/next-step.js";
import { userRun } from "../src/server/user-view.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// The planner flows decide technical questions themselves (tools/decide-questions.mjs post-plan) and plan again.
const OWNER = "11111111-1111-4111-8111-111111111111";
const FAKES = ["FAKE_ISSUE_PLAN", "FAKE_ISSUE_PLAN_THEN", "FAKE_PLAN_COUNT", "FAKE_CODEX_PLAN_VERDICT", "FAKE_REVISE", "FAKE_REVISE_COUNT", "FAKE_REVISE_THEN", "FAKE_GH_FAIL", "FAKE_GH_COMMENT_MKDIR", "FAKE_GH_COMMENTS_FROM_LOG"];

const tech = (t: string, n = 1) => `**Q${n}. ${t}**\n**Kind:** technical\nOptions: a or b.\n**Recommendation:** a — simpler`;
const product = "**Q2. Who uses it?**\n**Kind:** product\nAdmins or users.\n**Recommendation:** none";
const NEEDS = "\nPLAN_STATUS: NEEDS_INFO";
const READY = "## Goal\nAdd feature.txt\n## Tests\nfeature test\nPLAN_STATUS: READY";

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
});

describe("the planner decides technical questions itself", () => {
  let gh: ReturnType<typeof fakeGithub>;
  const config = ConfigSchema.parse({ protected_branches: ["main"] });
  const runsDir = () => join(gh.tmp, "runs");
  let RUN = "";
  const runDir = () => join(runsDir(), RUN);
  const record = () => JSON.parse(readFileSync(join(runDir(), "decided.json"), "utf8")) as { rounds: { outcome: string }[] };
  const outcomes = () => record().rounds.map((r) => r.outcome);

  beforeEach(() => {
    gh = fakeGithub();
    for (const k of FAKES) delete process.env[k];
    process.env.FAKE_GH_COMMENTS_FROM_LOG = "1";
    process.env.FAKE_PLAN_COUNT = join(gh.tmp, "plan-count");
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

  it("decides everything, posts the decisions and plans again until READY", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store?") + NEEDS;
    process.env.FAKE_ISSUE_PLAN_THEN = READY;
    const s = await go("20260101-000000-dq01");
    expect(s.status).toBe("succeeded");
    const c = gh.comments();
    expect(c).toHaveLength(2);
    expect(c[0]!.body.split("\n")[0]).toBe(reportFirst("decided"));
    expect(c[0]!.body).toContain(DECIDED_HEADING);
    expect(c[0]!.body).toContain("**Decision:** a — simpler");
    expect(c[0]!.body).toContain(`run=${RUN} decided=`);
    expect(c[1]!.body).toContain("Spaghetti Code Foundry plan");
    expect(outcomes()).toEqual(["went_on"]);
    expect(s.decidedQuestions).toHaveLength(1);
    expect(s.history.find((h) => h.id === "send_back")?.output).toContain("DECIDED: went_on");
  });

  it("asks the questions that are not technical and stops", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store?") + "\n\n" + product + NEEDS;
    const s = await go("20260101-000000-dq02");
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain('stopped at step "send_back"');
    const c = gh.comments();
    expect(c).toHaveLength(1);
    expect(c[0]!.body.indexOf("Who uses it?")).toBeGreaterThan(-1);
    expect(c[0]!.body.indexOf("Who uses it?")).toBeLessThan(c[0]!.body.indexOf(DECIDED_HEADING));
    const q = JSON.stringify(userRun(s).questions);
    expect(q).toContain("Who uses it?");
    expect(q).not.toContain("Which store?");
    expect(q).not.toContain(DECIDED_HEADING);
    expect(outcomes()).toEqual(["asked"]);
  });

  it("decides a question of a revision and plans again", async () => {
    process.env.FAKE_ISSUE_PLAN = READY;
    process.env.FAKE_CODEX_PLAN_VERDICT = "Missing a test.\nVERDICT: CHANGES";
    process.env.FAKE_REVISE = tech("Which store?") + NEEDS;
    process.env.FAKE_REVISE_COUNT = join(gh.tmp, "revise-count");
    process.env.FAKE_REVISE_THEN = "## Goal\nAdd feature.txt (revision 2)\nPLAN_STATUS: READY";
    const s = await go("20260101-000000-dq03");
    expect(s.status).toBe("succeeded");
    const c = gh.comments();
    expect(c[0]!.body).toContain(DECIDED_HEADING);
    expect(c.at(-1)!.body).toContain("(revision 2)");
    expect(outcomes()).toEqual(["went_on"]);
  });

  it("gives up when a fresh replan repeats the questions it already decided", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store?") + NEEDS;
    process.env.FAKE_ISSUE_PLAN_THEN = tech("Which store?") + NEEDS;
    const s = await go("20260101-000000-dq08");
    expect(s.status).toBe("failed");
    expect(s.history.at(-1)).toMatchObject({ id: "send_back", ok: false });
    expect(outcomes()).toEqual(["went_on", "gave_up"]);
    const c = gh.comments();
    expect(c).toHaveLength(2);
    expect(c[1]!.body).not.toContain(DECIDED_HEADING);
  });

  it("fails and commits nothing when the comment cannot be posted", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store?") + NEEDS;
    process.env.FAKE_GH_FAIL = "issue comment";
    const s = await go("20260101-000000-dq04");
    expect(s.status).toBe("failed");
    expect(s.history.at(-1)).toMatchObject({ id: "send_back", ok: false });
    expect(gh.comments()).toHaveLength(0);
    expect(existsSync(join(runDir(), "decided.json"))).toBe(false);
  });

  it("does not post twice when the commit failed after the post and the run is resumed", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store?") + NEEDS;
    process.env.FAKE_ISSUE_PLAN_THEN = READY;
    RUN = "20260101-000000-dq05";
    process.env.FAKE_GH_COMMENT_MKDIR = join(runDir(), "decided.json", "x");
    const first = await go(RUN);
    expect(first.status).toBe("failed");
    expect(first.history.at(-1)).toMatchObject({ id: "send_back", ok: false });
    expect(gh.comments().filter((c) => c.body.includes("decided="))).toHaveLength(1);
    rmSync(join(runDir(), "decided.json"), { recursive: true });
    delete process.env.FAKE_GH_COMMENT_MKDIR;
    const s = await resume();
    expect(s.status).toBe("succeeded");
    expect(gh.comments().filter((c) => c.body.includes("decided="))).toHaveLength(1);
    expect(outcomes()).toEqual(["went_on"]);
    expect(existsSync(join(runDir(), "decided-pending.json"))).toBe(false);
  });

  it("posts the plain comment when the setting is turned off after a failed post", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store?") + NEEDS;
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await go("20260101-000000-dq06")).status).toBe("failed");
    delete process.env.FAKE_GH_FAIL;
    setRepoSettings(addRepo(OWNER, { url: "acme/app" }, { ownerOk: () => true }).id, { questions: { decide_technical: false } });
    const s = await resume();
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain('stopped at step "send_back"');
    const c = gh.comments();
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toContain("needs more information before it can plan this issue");
    expect(c[0]!.body).toContain(`<!-- claude-factory run=${RUN} -->`);
    expect(c[0]!.body).not.toContain(DECIDED_HEADING);
    expect(c[0]!.body).not.toContain("decided=");
    expect(existsSync(join(runDir(), "decided.json"))).toBe(false);
    expect(existsSync(join(runDir(), "decided-pending.json"))).toBe(false);
  });

  it("gives up in the third round", async () => {
    process.env.FAKE_ISSUE_PLAN = tech("Which store for part 1?") + NEEDS;
    process.env.FAKE_ISSUE_PLAN_THEN = tech("Which store for part {n}?") + NEEDS;
    const s = await go("20260101-000000-dq07");
    expect(s.status).toBe("failed");
    expect(s.history.at(-1)).toMatchObject({ id: "send_back", ok: false });
    expect(outcomes()).toEqual(["went_on", "went_on", "gave_up"]);
    const c = gh.comments();
    expect(c).toHaveLength(3);
    expect(c[2]!.body).not.toContain(DECIDED_HEADING);
  });
});
