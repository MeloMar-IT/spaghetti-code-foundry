import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { effectiveLimits, resolveLimits, setDefaultLimits } from "../src/auth/limits.js";import { getRepo, projectDailyBudget } from "../src/auth/repos.js";
import { createUser, createUserWithLink, findUserByEmail, type User } from "../src/auth/users.js";
import { readAutonomy } from "../src/governance/autonomy-store.js";
import { loadFlow } from "../src/flow/load.js";
import { clearProgress } from "../src/onboarding/progress-store.js";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { startProject } from "../src/server/api-starters.js";
import { findRule } from "../src/server/permissions.js";
import type { ApiContext } from "../src/server/server.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// #823: a project made by the Get started guide has safe defaults, each proven here on a guide-made project.

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "guide-defaults-")));
const logs: string[] = [];
const ctxWith = (cfg: Record<string, unknown>) =>
  ({ config: () => ({ simple: { hidden_starters: [] }, cost_limits: true, ...cfg }), diagLog: (m: string) => logs.push(m), opts: {} }) as unknown as ApiContext;
let admin: User;
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `p${n++}`);
  mkdirSync(d);
  return d;
};
const budgetLines = (id: string) =>
  existsSync(auditPath())
    ? readFileSync(auditPath(), "utf8").split("\n").filter((l) => l.includes(id) && l.includes("repo-change") && l.includes("daily budget"))
    : [];
const guideProject = async (cfg: Record<string, unknown>, guide = true) => {
  const made = await startProject(ctxWith(cfg), admin, "website", { name: "Site", parent: fresh(), ...(guide ? { guide: true } : {}) });
  return made.repo.id as string;
};

beforeAll(async () => {
  admin = findUserByEmail("admin@example.com") ?? (await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" }));
});
beforeEach(() => {
  clearProgress(admin.id);
  logs.length = 0;
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the daily cap of a guide project", () => {
  it("is the configured Simple cap, as the project's own setting, with an audit line", async () => {
    const id = await guideProject({ simple_project_daily_budget_usd: 5 });
    expect(getRepo(id)!.dailyBudgetUsd).toBe(5);
    expect(budgetLines(id).some((l) => l.includes("daily budget: $5"))).toBe(true);
    // the owner is in the Admin view, yet the cap applies
    expect(projectDailyBudget({ repoId: id }, admin.id, 5)).toBe(5);
  });

  it("follows the configured value", async () => {
    expect(getRepo(await guideProject({ simple_project_daily_budget_usd: 12 }))!.dailyBudgetUsd).toBe(12);
  });

  it("is at most 1,000,000, and the project is still made", async () => {
    expect(getRepo(await guideProject({ simple_project_daily_budget_usd: 2_000_000 }))!.dailyBudgetUsd).toBe(1_000_000);
  });

  it("is not stored when the configured value is 0", async () => {
    expect(getRepo(await guideProject({ simple_project_daily_budget_usd: 0 }))!.dailyBudgetUsd).toBeUndefined();
  });

  it("is not stored for a project made without the guide", async () => {
    const id = await guideProject({ simple_project_daily_budget_usd: 5 }, false);
    expect(getRepo(id)!.dailyBudgetUsd).toBeUndefined();
    expect(budgetLines(id)).toEqual([]);
  });
});

describe("the other defaults of a guide project", () => {
  it("has no push remote, a local method and the guarded-write level", async () => {
    const id = await guideProject({ simple_project_daily_budget_usd: 5 });
    const repo = getRepo(id)!;
    expect(repo.settings?.pushRemote).toBeUndefined();
    expect(repo.method).toBe("local");
    expect(readAutonomy().repos[id]?.level).toBe("guarded-write");
  });

  it("Move to GitHub and publish-remote are closed to users", () => {
    expect(findRule("POST", ["repos", "x", "move-to-github"])?.user).toBe("no");
    expect(findRule("POST", ["repos", "x", "publish-remote"])?.user).toBe("no");
  });

  it("a release waits for approval before the version is made final", () => {
    const { flow } = loadFlow("release-daily", tmp);
    const step = flow.steps.find((s) => s.id === "make_final") as unknown as { type: string; on_success: string };
    expect(step.type).toBe("approval");
    expect(step.on_success).toBe("final_merge");
  });

  it("the usage limits are the admin's defaults, and an invited account has no own limits", async () => {
    setDefaultLimits({ maxConcurrent: 1, dailyBudgetUsd: 2, maxRunsPerDay: 3 }, { by: admin.id });
    expect(effectiveLimits(admin.id)).toMatchObject({ maxConcurrent: 1, dailyBudgetUsd: 2, maxRunsPerDay: 3 });
    const invited = await createUserWithLink({ name: "Ivy", email: "ivy@example.com", view: "simple" });
    const r = resolveLimits(invited.user.id);
    expect(r.overridden).toEqual([]);
    expect(r.effective).toMatchObject({ maxConcurrent: 1, dailyBudgetUsd: 2, maxRunsPerDay: 3 });
  });

  it("work on a guide project counts for the acting account and waits after maxRunsPerDay", async () => {
    setDefaultLimits({ maxConcurrent: 5, maxRunsPerDay: 3 }, { by: admin.id });
    const parent = fresh();
    const made = await startProject(ctxWith({ simple_project_daily_budget_usd: 5 }), admin, "website", { name: "Shop", parent, guide: true });
    const repo = getRepo(made.repo.id as string)!;
    const flow = parseFlow(`name: plain\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "true"}\n`);
    let runsToday = 2;
    const s = new Scheduler({
      runsDir: join(tmp, "sched-runs"),
      config: () => ({ ...ConfigSchema.parse({}), concurrency: 3 }),
      userLimits: (id) => effectiveLimits(id),
      startedToday: () => runsToday,
    });
    // under the limit: the run starts
    s.submit({ kind: "run", flow, task: "t", repo: repo.url, vars: {} }, { source: "under", owner: admin.id });
    expect(s.queue().pending.map((p) => p.source)).not.toContain("under");
    // at the limit: the run waits with the per-day reason
    runsToday = 3;
    s.submit({ kind: "run", flow, task: "t", repo: repo.url, vars: {} }, { source: "over", owner: admin.id });
    expect(s.queue().pending.map((p) => [p.source, p.limit])).toEqual([["over", "per_day"]]);
  });
});
