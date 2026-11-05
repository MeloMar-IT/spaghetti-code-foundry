import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, checkRepoBudget, getRepo, listAllRepos, listRepos, projectDailyBudget, projectRecord, reposPath, setRepoBudget, setRepoAuth } from "../src/auth/repos.js";
import { RepoError } from "../src/auth/repo-url.js";
import { createUser, setView } from "../src/auth/users.js";
import { PROJECT_BUDGET_REASON, USER_BUDGET_REASON, isProjectBudgetStop, isUserBudgetStop, projectOfVars, spentTodayByProject } from "../src/engine/state.js";
import { nextStep, runNextStep } from "../src/next-step.js";
import { projectBudgetLeft } from "../src/queue/watcher.js";
import { statusHelp, statusName } from "../src/words.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const NOW = new Date(2026, 9, 7, 12, 0, 0);
const today = new Date(2026, 9, 7, 8, 0, 0).toISOString();

describe("the state helpers of the project cap", () => {
  let dir: string;
  const put = (id: string, over: Record<string, unknown>) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "run.json"), JSON.stringify({ runId: id, startedAt: today, totalCostUsd: 1, owner: "ann", vars: {}, ...over }));
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-project-spent-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("projectOfVars: GitHub first, then the local id, else none", () => {
    expect(projectOfVars({ github_repo: "acme/a", repo_id: "x" })).toEqual({ githubRepo: "acme/a" });
    expect(projectOfVars({ repo_id: "x" })).toEqual({ repoId: "x" });
    expect(projectOfVars({})).toBeUndefined();
    expect(projectOfVars(undefined)).toBeUndefined();
  });

  it("counts only today's runs of the project, by repository (any case) or by id, and skips bad costs", () => {
    put("20261007-080000-0001", { vars: { github_repo: "acme/a" } });
    put("20261007-080000-0002", { vars: { github_repo: "ACME/A" }, totalCostUsd: 0.5 });
    put("20261007-080000-0003", { vars: { github_repo: "acme/b" }, totalCostUsd: 7 });
    put("20261007-080000-0004", { vars: { github_repo: "acme/a" }, totalCostUsd: "NaN" });
    put("20261007-080000-0005", { vars: { repo_id: "r1" }, totalCostUsd: 2 });
    put("20261007-080000-0006", { vars: { repo_id: "r2" }, totalCostUsd: 7 });
    put("20261005-080000-0007", { startedAt: new Date(2026, 9, 5, 8, 0, 0).toISOString(), vars: { github_repo: "acme/a" }, totalCostUsd: 7 });
    expect(spentTodayByProject(dir, { githubRepo: "acme/a" }, NOW)).toBeCloseTo(1.5);
    expect(spentTodayByProject(dir, { githubRepo: "Acme/A" }, NOW)).toBeCloseTo(1.5);
    expect(spentTodayByProject(dir, { repoId: "r1" }, NOW)).toBe(2);
    expect(spentTodayByProject(dir, { githubRepo: "acme/none" }, NOW)).toBe(0);
  });

  it("does not forget the project's spend when more than 500 newer runs of others exist", () => {
    put("20261007-080000-0000", { vars: { github_repo: "acme/a" }, totalCostUsd: 3 });
    for (let i = 1; i <= 520; i++) put(`20261007-090000-${String(i).padStart(4, "0")}`, { vars: { github_repo: "acme/other" }, totalCostUsd: 0 });
    expect(spentTodayByProject(dir, { githubRepo: "acme/a" }, NOW)).toBe(3);
  });

  it("the stop reasons: no amount, and both belong to the daily-limit family", () => {
    expect(PROJECT_BUDGET_REASON).not.toContain("$");
    expect(isProjectBudgetStop(PROJECT_BUDGET_REASON)).toBe(true);
    expect(isProjectBudgetStop(USER_BUDGET_REASON)).toBe(false);
    expect(isUserBudgetStop(PROJECT_BUDGET_REASON)).toBe(true);
    expect(isUserBudgetStop(USER_BUDGET_REASON)).toBe(true);
    expect(isUserBudgetStop("daily budget of $5 reached")).toBe(false);
  });
});

describe("the daily cap on the repository record", () => {
  let ann = "";
  let bob = "";
  beforeAll(async () => {
    ann = (await createUser({ name: "Ann", email: "ann-pb@example.com", password: TEST_PASSWORD, role: "user" })).id;
    bob = (await createUser({ name: "Bob", email: "bob-pb@example.com", password: TEST_PASSWORD, role: "user" })).id;
    setView(ann, "simple");
    setView(bob, "advanced");
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof RepoError ? e.code : e;
    }
    return undefined;
  };

  it("an old repos.json without the field loads; a stored cap loads and is hidden from the user's list", () => {
    const rec = addRepo(ann, { url: "acme/old", method: "none" });
    const file = JSON.parse(readFileSync(reposPath(), "utf8"));
    expect(file.repos.find((r: { id: string }) => r.id === rec.id)).not.toHaveProperty("dailyBudgetUsd");
    setRepoBudget(rec.id, 7.5);
    expect(getRepo(rec.id)?.dailyBudgetUsd).toBe(7.5);
    expect(listAllRepos().find((r) => r.id === rec.id)?.dailyBudgetUsd).toBe(7.5);
    expect(listRepos(ann).find((r) => r.id === rec.id)).not.toHaveProperty("dailyBudgetUsd");
  });

  it("setRepoBudget sets, keeps, clears and refuses an unknown id", () => {
    const rec = addRepo(ann, { url: "acme/set", method: "none" });
    expect(setRepoBudget(rec.id, 3)).toMatchObject({ changed: true, repo: { dailyBudgetUsd: 3 } });
    expect(setRepoBudget(rec.id, 3).changed).toBe(false);
    expect(setRepoBudget(rec.id, null).changed).toBe(true);
    expect(getRepo(rec.id)).not.toHaveProperty("dailyBudgetUsd");
    expect(setRepoBudget(rec.id, null).changed).toBe(false);
    expect(code(() => setRepoBudget("00000000-0000-4000-8000-000000000000", 1))).toBe("not-found");
  });

  it("checkRepoBudget accepts a number above 0 or null only, in a body with that one key", () => {
    expect(checkRepoBudget({ dailyBudgetUsd: 5 })).toBe(5);
    expect(checkRepoBudget({ dailyBudgetUsd: 0.25 })).toBe(0.25);
    expect(checkRepoBudget({ dailyBudgetUsd: null })).toBeNull();
    for (const bad of [{ dailyBudgetUsd: 0 }, { dailyBudgetUsd: -1 }, { dailyBudgetUsd: "5" }, { dailyBudgetUsd: Number.NaN }, { dailyBudgetUsd: 2_000_000 }, { dailyBudgetUsd: 1, x: 1 }, {}, null, 5, [], "x"]) {
      expect(code(() => checkRepoBudget(bad))).toBe("bad-settings");
    }
  });

  it("a change of the sign-in keeps the cap, also an otherwise unchanged submission", () => {
    const rec = addRepo(ann, { url: "acme/auth", method: "none" });
    setRepoBudget(rec.id, 4);
    setRepoAuth(ann, rec.id, { method: "none" });
    expect(getRepo(rec.id)?.dailyBudgetUsd).toBe(4);
    setRepoAuth(ann, rec.id, { method: "none", url: "acme/auth" });
    expect(getRepo(rec.id)?.dailyBudgetUsd).toBe(4);
  });

  it("projectDailyBudget: the own cap wins; the default is for a Simple owner only; errors mean no cap", () => {
    const a = addRepo(ann, { url: "acme/simple", method: "none" });
    const b = addRepo(bob, { url: "acme/advanced", method: "none" });
    expect(projectDailyBudget({ githubRepo: "acme/simple" }, ann, 5)).toBe(5);
    expect(projectDailyBudget({ githubRepo: "ACME/Simple" }, ann, 5)).toBe(5);
    expect(projectDailyBudget({ repoId: a.id }, undefined, 5)).toBe(5);
    expect(projectDailyBudget({ githubRepo: "acme/simple" }, ann, undefined)).toBeUndefined();
    expect(projectDailyBudget({ githubRepo: "acme/simple" }, ann, 0)).toBeUndefined();
    expect(projectDailyBudget({ githubRepo: "acme/advanced" }, bob, 5)).toBeUndefined();
    setRepoBudget(b.id, 2);
    expect(projectDailyBudget({ githubRepo: "acme/advanced" }, bob, 5)).toBe(2);
    setRepoBudget(a.id, 9);
    expect(projectDailyBudget({ githubRepo: "acme/simple" }, ann, 5)).toBe(9);
    // an unknown repository, another owner's repository and a run without an owner
    expect(projectDailyBudget({ githubRepo: "acme/nothing" }, ann, 5)).toBeUndefined();
    expect(projectDailyBudget({ githubRepo: "acme/advanced" }, ann, 5)).toBeUndefined();
    expect(projectDailyBudget({ githubRepo: "acme/simple" }, undefined, 5)).toBeUndefined();
    expect(projectRecord({ githubRepo: "not a repo" }, ann)).toBeUndefined();
    expect(projectDailyBudget({ githubRepo: "!!" }, ann, 5)).toBeUndefined();
  });

  it("projectBudgetLeft compares today's spend with the cap; no project or no cap means left", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-project-left-"));
    try {
      const id = "20990101-080000-0001";
      const now = new Date();
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, "run.json"), JSON.stringify({ runId: id, startedAt: now.toISOString(), totalCostUsd: 2, vars: { github_repo: "acme/a" } }));
      const sched = (cap?: number) => ({ projectDailyBudget: () => cap });
      expect(projectBudgetLeft(sched(2), dir, { githubRepo: "acme/a" })).toBe(false);
      expect(projectBudgetLeft(sched(3), dir, { githubRepo: "acme/a" })).toBe(true);
      expect(projectBudgetLeft(sched(undefined), dir, { githubRepo: "acme/a" })).toBe(true);
      expect(projectBudgetLeft(sched(1), dir, undefined)).toBe(true);
      expect(projectBudgetLeft(sched(1), dir, { githubRepo: "acme/b" })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the next step of a project at its cap", () => {
  it("a queued job held by the project cap reads project_limit, with no amount", () => {
    const n = nextStep("user_limit", {}, { userLimit: "project" });
    expect(n.kind).toBe("project_limit");
    for (const t of [n.text, n.why, n.status, n.help]) expect(t ?? "").not.toMatch(/[$\d]/);
  });

  it("a run stopped with the reason reads project_limit", () => {
    const run = { status: "stopped", reason: PROJECT_BUDGET_REASON, state: { next: "b" }, history: [], flowDef: { steps: [] } } as never;
    expect(runNextStep(run).kind).toBe("project_limit");
  });

  it("the glossary words hold no amount", () => {
    for (const user of [false, true]) {
      expect(statusName("project_limit", { user })).toBe("paused — the project's limit for today is reached");
      expect(statusHelp("project_limit", { user })).not.toMatch(/[$\d]/);
    }
  });
});
