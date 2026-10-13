import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDiff } from "../src/engine/diff.js";
import { listRunIds, loadRun, readLiveLog } from "../src/engine/state.js";
import { largeFromEnv, seedLarge, seedStress, startSeeded, STRESS_REPO, type Seeded } from "./browser/seed.js";
import { WIDTHS, usesDrawer } from "./browser/widths.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const savedHome = process.env.FACTORY_HOME;
const savedPath = process.env.PATH;

const get = async (s: Seeded, who: TestSession, path: string) => {
  const r = await fetch(s.url + path, { headers: who.headers() });
  return { status: r.status, json: (await r.json()) as any };
};
const list = (j: any, key: string): any[] => (Array.isArray(j) ? j : j[key]);

describe("the seeded server", () => {
  let s: Seeded;
  let admin: TestSession;
  let user: TestSession;
  let home: string;
  beforeAll(async () => {
    s = await startSeeded();
    home = process.env.FACTORY_HOME!;
    admin = await signInAs(s.url, { create: false });
    user = await signInAs(s.url, { name: "Ann", email: "ann@example.com", role: "user", create: false });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("has a run in every main status", async () => {
    const r = await get(s, admin, "/api/runs");
    const rows = list(r.json, "runs");
    for (const status of ["running", "waiting", "succeeded", "failed", "cancelled", "stopped"]) {
      const row = rows.find((x) => x.runId === s.runs[status]);
      expect(row, status).toBeTruthy();
      expect(row.status).toBe(status);
    }
  });

  it("has no large data unless asked", async () => {
    expect(s.large).toBeUndefined();
    expect(s.noteFlow).toBeUndefined();
    expect(s.stress).toBeUndefined();
    const ids = list((await get(s, admin, "/api/runs")).json, "runs").map((x) => x.runId as string);
    expect(ids.filter((id) => id.startsWith("big-") || id.startsWith("ui-big-"))).toEqual([]);
  });

  it("shows the user only their own runs", async () => {
    const r = await get(s, user, "/api/runs");
    expect(list(r.json, "runs").map((x) => x.runId).sort()).toEqual([...s.userRuns].sort());
  });

  it("has an admin and a user account", () => {
    expect(admin.user.role).toBe("admin");
    expect(user.user.role).toBe("user");
  });

  it("has a repository, a refinement session and a watcher", async () => {
    const repos = list((await get(s, user, "/api/repos")).json, "repos");
    expect(repos).toHaveLength(1);
    expect(JSON.stringify(repos[0])).toContain("acme/app");
    const sessions = list((await get(s, user, "/api/refinement")).json, "sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(s.sessionId);
    const watchers = list((await get(s, admin, "/api/watchers")).json, "watchers");
    expect(watchers.some((w) => w.id === "ui-w")).toBe(true);
  });

  it("touches nothing real", () => {
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(home).not.toBe(savedHome);
  });
});

describe("the seeded server with large data", () => {
  let s: Seeded;
  let admin: TestSession;
  let user: TestSession;
  beforeAll(async () => {
    s = await startSeeded({ large: true });
    admin = await signInAs(s.url, { create: false });
    user = await signInAs(s.url, { name: "Ann", email: "ann@example.com", role: "user", create: false });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("says what it seeded", () => {
    expect(s.large).toEqual({ runs: 500, logRun: "ui-big-log", diffRun: "ui-big-diff" });
    expect(s.noteFlow).toBe("note");
    expect(s.stress).toEqual({ statusRun: "ui-stress-status", diffRun: "ui-stress-diff", repo: STRESS_REPO });
  });

  it("lists the note flow for a user", async () => {
    const r = await get(s, user, "/api/flows?published=1");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    const note = (r.json as any[]).find((f) => f.name === "note");
    expect(note?.usesTask).toBe(true);
  });

  it("a note run waits with the task in its diff and NOTE_WAITING in its log", async () => {
    const task = "Seed note task 4711";
    const post = async (path: string, body: unknown) =>
      fetch(s.url + path, { method: "POST", headers: { "content-type": "application/json", ...user.headers("POST") }, body: JSON.stringify(body) });
    const started = await post("/api/runs", { flow: "note", task });
    expect(started.status).toBe(201);
    const { runId } = (await started.json()) as { runId: string };
    try {
      await expect.poll(async () => (await get(s, user, `/api/runs/${runId}`)).json.status, { timeout: 20_000 }).toBe("waiting");
      const diff = await get(s, user, `/api/runs/${runId}/diff`);
      expect(String(diff.json.patch)).toContain("note.txt");
      expect(String(diff.json.patch)).toContain(task);
      const runDir = (await get(s, admin, `/api/runs/${runId}`)).json.runDir as string;
      expect(readLiveLog(runDir).join("\n")).toContain("NOTE_WAITING");
    } finally {
      await post(`/api/runs/${runId}/cancel`, {});
    }
  });

  it("lists 200 runs, newest ids first", async () => {
    const rows = list((await get(s, admin, "/api/runs")).json, "runs");
    expect(rows).toHaveLength(200);
    const ids = rows.map((x) => x.runId);
    expect(ids).toContain("big-0500");
    expect(ids).toContain("ui-big-log");
  });

  it("has a diff of 1,000 added and 1,000 removed lines", async () => {
    const r = await get(s, admin, "/api/runs/ui-big-diff/diff");
    expect(r.json.truncated).toBe(false);
    const lines = String(r.json.patch).split("\n");
    expect(lines.filter((l) => /^\+(?!\+\+)/.test(l))).toHaveLength(1000);
    expect(lines.filter((l) => /^-(?!--)/.test(l))).toHaveLength(1000);
  });

  it("keeps the six statuses", () => {
    expect(Object.keys(s.runs).sort()).toEqual(["cancelled", "failed", "running", "stopped", "succeeded", "waiting"]);
  });
});

describe("the large seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-large-seed-"));
  const runsDir = join(dir, "runs");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes 500 runs, a long log and a diff run", () => {
    expect(seedLarge(runsDir, dir, "owner-1", "/repo")).toEqual({ runs: 500, logRun: "ui-big-log", diffRun: "ui-big-diff" });
    const ids = listRunIds(runsDir);
    expect(ids).toHaveLength(502);
    expect(ids.indexOf("big-0500")).toBeLessThan(ids.indexOf("big-0001"));
    const run = loadRun(runsDir, "big-0001")!;
    expect(run.owner).toBe("owner-1");
    expect(["succeeded", "failed", "cancelled"]).toContain(run.status);
    const lines = readLiveLog(join(runsDir, "ui-big-log"));
    expect(lines).toHaveLength(5000);
    expect(lines.at(-1)?.length ?? 0).toBeGreaterThan(600);
    expect(loadRun(runsDir, "ui-big-diff")!.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("writes the stress runs", () => {
    expect(seedStress(runsDir, dir, "owner-1", "/repo")).toEqual({ statusRun: "ui-stress-status", diffRun: "ui-stress-diff", repo: STRESS_REPO });
    expect(listRunIds(runsDir)).toHaveLength(504);
    expect(STRESS_REPO).toHaveLength(100);
    const failed = loadRun(runsDir, "ui-stress-status");
    if (!failed) throw new Error("the status run is missing");
    expect(failed.status).toBe("failed");
    expect(failed.reason).toHaveLength(2000);
    expect(failed.vars.github_repo).toBe(STRESS_REPO);
    const diffRun = loadRun(runsDir, "ui-stress-diff");
    if (!diffRun) throw new Error("the diff run is missing");
    expect(diffRun.workdir?.endsWith("stress-work")).toBe(true);
    const added = runDiff(diffRun).patch.split("\n").filter((l) => /^\+(?!\+\+)/.test(l));
    expect(added.length).toBeGreaterThan(0);
    for (const l of added) expect(l.length).toBeGreaterThanOrEqual(400);
  });
});

describe("the large switch", () => {
  it("is on only for UI_TEST_LARGE=1", () => {
    expect(largeFromEnv({ UI_TEST_LARGE: "1" })).toBe(true);
    expect(largeFromEnv({})).toBe(false);
    expect(largeFromEnv({ UI_TEST_LARGE: "0" })).toBe(false);
  });
});

describe("closing the seeded server", () => {
  it("stops the server, removes its folder and puts the environment back", async () => {
    const before = process.env.FACTORY_HOME;
    const s = await startSeeded();
    const home = process.env.FACTORY_HOME!;
    expect(existsSync(home)).toBe(true);
    await s.close();
    await expect(fetch(s.url)).rejects.toThrow();
    expect(existsSync(home)).toBe(false);
    expect(process.env.FACTORY_HOME).toBe(before);
    expect(process.env.PATH).toBe(savedPath);
    await s.close(); // closing twice is fine
  });
});

describe("the harness wiring", () => {
  it("defines the four widths once", () => {
    expect([...WIDTHS]).toEqual([360, 768, 1024, 1440]);
    expect(usesDrawer(360)).toBe(true);
    expect(usesDrawer(768)).toBe(false);
  });

  it("keeps the browser tests out of npm test", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["test:ui"]).toMatch(/^playwright test/);
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.devDependencies["@playwright/test"]).toBeTruthy();
    expect(readdirSync("tests/browser").filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  it("runs the performance spec last, against a second, large server", () => {
    expect(existsSync("tests/browser/performance.spec.ts")).toBe(true);
    expect(readFileSync("tests/browser/playwright.config.ts", "utf8")).toContain('dependencies: ["chromium"]');
    expect(readFileSync("tests/browser/global-setup.ts", "utf8")).toContain("UI_TEST_SEED_LARGE");
  });

  it("restores FACTORY_HOME", () => {
    expect(process.env.FACTORY_HOME).toBe(savedHome);
  });
});
