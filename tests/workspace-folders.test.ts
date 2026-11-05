import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptRuns } from "../src/auth/run-owner.js";
import { createUser } from "../src/auth/users.js";
import { cleanRuns } from "../src/clean.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { sandboxProfile, stepSandboxPaths } from "../src/engine/os-sandbox.js";
import { allLockRoots, lockRoot, markRunning, sweepRunning, sweepStaleRunning } from "../src/engine/running.js";
import {
  allRunsDirs, claimRunDir, ensureWorkspaceTestSlots, listAllRunIds, listRunBriefs, loadRun, loadRunAsync, runDirOf, runIdTaken,
  spentToday, spentTodayBy, spentTodayByProject, workspaceDir, workspaceDirsIn, workspaceRunsDir,
} from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { migrateDataHome, workspaceHome } from "../src/home.js";
import { readAllAreaLocks } from "../src/monitor/monitor.js";
import { pluginBlockedDirs } from "../src/server/server.js";

let data: string;
let runs: string;
let saved: string | undefined;
let savedLock: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  savedLock = process.env.FACTORY_LOCK_DIR;
  data = realpathSync(mkdtempSync(join(tmpdir(), "ws-folders-")));
  runs = join(data, "runs");
  process.env.FACTORY_HOME = data;
  process.env.FACTORY_LOCK_DIR = join(data, "locks");
  mkdirSync(runs, { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  if (savedLock === undefined) delete process.env.FACTORY_LOCK_DIR;
  else process.env.FACTORY_LOCK_DIR = savedLock;
  rmSync(data, { recursive: true, force: true });
});

const config = (text: string) => writeFileSync(join(data, "config.yaml"), text);
const TEAM_A = "workspaces:\n  - {id: team-a, name: Team A}\n";
const put = (dir: string, id: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(dir, id), { recursive: true });
  const s = { runId: id, flow: "f", status: "succeeded", startedAt: new Date().toISOString(), totalCostUsd: 1, runDir: join(dir, id), task: "", vars: {}, ...extra };
  writeFileSync(join(dir, id, "run.json"), JSON.stringify(s));
  return s;
};
const teamRuns = (ws = "team-a") => join(data, "workspaces", ws, "runs");

describe("workspace folder names", () => {
  it("refuses bad ids and accepts a good one", () => {
    for (const id of ["../x", "a/b", "Bad", "", "a".repeat(41), "default"]) {
      expect(() => workspaceDir(runs, id), id).toThrow(/WORKSPACE_FOLDER_REFUSED/);
      expect(() => workspaceHome(id), id).toThrow(/WORKSPACE_FOLDER_REFUSED/);
    }
    expect(workspaceDir(runs, "team-a")).toBe(join(data, "workspaces", "team-a"));
    expect(workspaceHome("team-a")).toBe(join(data, "workspaces", "team-a"));
    expect(workspaceRunsDir(runs, "default")).toBe(runs);
    expect(workspaceRunsDir(runs)).toBe(runs);
    expect(workspaceRunsDir(runs, "team-a")).toBe(teamRuns());
  });

  it("refuses a link that leaves the data folder, at every level, and accepts one inside it", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ws-outside-")));
    try {
      mkdirSync(join(data, "workspaces"));
      symlinkSync(outside, join(data, "workspaces", "team-a"));
      expect(() => workspaceHome("team-a")).toThrow(/leaves the data folder/);
      rmSync(join(data, "workspaces", "team-a"));
      mkdirSync(join(data, "workspaces", "team-a"));
      symlinkSync(outside, join(data, "workspaces", "team-a", "runs"));
      expect(() => workspaceDir(runs, "team-a")).toThrow(/leaves the data folder/);
      rmSync(join(data, "workspaces", "team-a", "runs"));
      symlinkSync(outside, join(data, "workspaces", "team-a", "locks"));
      expect(() => workspaceHome("team-a")).toThrow(/leaves the data folder/);
      expect(() => lockRoot("team-a")).toThrow(/leaves the data folder/);
      rmSync(join(data, "workspaces", "team-a", "locks"));
      mkdirSync(join(data, "elsewhere"));
      symlinkSync(join(data, "elsewhere"), join(data, "workspaces", "team-a", "locks"));
      expect(workspaceHome("team-a")).toBe(join(data, "workspaces", "team-a"));
      rmSync(join(data, "workspaces"), { recursive: true });
      symlinkSync(outside, join(data, "workspaces"));
      expect(() => workspaceHome("team-a")).toThrow(/leaves the data folder/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("lists only real folders with a valid name", () => {
    const w = join(data, "workspaces");
    mkdirSync(join(w, "team-b", "runs"), { recursive: true });
    mkdirSync(join(w, "Bad", "runs"), { recursive: true });
    mkdirSync(join(w, "default", "runs"), { recursive: true });
    writeFileSync(join(w, "team-x"), "file");
    mkdirSync(join(data, "other"));
    symlinkSync(join(data, "other"), join(w, "team-y"));
    expect(workspaceDirsIn(runs).map((d) => d.id)).toEqual(["team-b"]);
    expect(allRunsDirs(runs)).toEqual([runs, join(w, "team-b", "runs")]);
  });
});

describe("links are not followed when listing or finding runs", () => {
  const outsideRun = (root: string, id: string) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "run.json"), JSON.stringify({ runId: id, status: "succeeded", startedAt: new Date().toISOString(), runDir: join(root, id), totalCostUsd: 9 }));
  };
  it("ignores a workspaces container that is a link leaving the data folder", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ws-out-")));
    try {
      outsideRun(join(outside, "team-x", "runs"), "20261105-000000-evil");
      symlinkSync(outside, join(data, "workspaces"));
      expect(workspaceDirsIn(runs)).toEqual([]);
      expect(listAllRunIds(runs).map((e) => e.id)).not.toContain("20261105-000000-evil");
      expect(runDirOf(runs, "20261105-000000-evil")).toBeUndefined();
      expect(loadRun(runs, "20261105-000000-evil")).toBeUndefined();
      const res = cleanRuns({ runsDir: runs, olderThanDays: 0, purge: true });
      expect(res.runs).not.toContain("20261105-000000-evil");
      expect(existsSync(join(outside, "team-x", "runs", "20261105-000000-evil", "run.json"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("does not find a run through a workspace's runs folder that is a link", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ws-out-")));
    try {
      outsideRun(outside, "20261105-000001-evil");
      mkdirSync(join(data, "workspaces", "team-a"), { recursive: true });
      symlinkSync(outside, join(data, "workspaces", "team-a", "runs"));
      expect(runDirOf(runs, "20261105-000001-evil")).toBeUndefined();
      expect(loadRun(runs, "20261105-000001-evil")).toBeUndefined();
      expect(await loadRunAsync(runs, "20261105-000001-evil")).toBeUndefined();
      expect(listAllRunIds(runs).map((e) => e.id)).not.toContain("20261105-000001-evil");
      expect(spentTodayBy(runs, "nobody")).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("finding runs in both layouts", () => {
  it("loads, lists and sums runs of the runs folder and of workspace folders", async () => {
    const today = new Date().toISOString();
    put(runs, "20261105-100000-aaaa", { owner: "u1", startedAt: today, vars: { github_repo: "o/r" } });
    put(teamRuns(), "20261105-110000-bbbb", { workspace: "team-a", owner: "u1", startedAt: today, totalCostUsd: 2, vars: { github_repo: "o/r" } });
    put(runs, "20261105-120000-cccc", { workspace: "team-b", startedAt: today, totalCostUsd: 4 }); // team-b run in the old place
    expect(runDirOf(runs, "20261105-110000-bbbb")).toBe(join(teamRuns(), "20261105-110000-bbbb"));
    expect(runDirOf(runs, "20261105-120000-cccc")).toBe(join(runs, "20261105-120000-cccc"));
    expect(runDirOf(runs, "nope")).toBeUndefined();
    expect(runDirOf(runs, "../x")).toBeUndefined();
    expect(loadRun(runs, "20261105-110000-bbbb")?.workspace).toBe("team-a");
    expect((await loadRunAsync(runs, "20261105-110000-bbbb"))?.workspace).toBe("team-a");
    expect(await loadRunAsync(runs, "nope")).toBeUndefined();
    expect(listAllRunIds(runs).map((e) => e.id)).toEqual(["20261105-120000-cccc", "20261105-110000-bbbb", "20261105-100000-aaaa"]);
    expect(listRunBriefs(runs).map((b) => b.runId)).toEqual(["20261105-120000-cccc", "20261105-110000-bbbb", "20261105-100000-aaaa"]);
    expect(spentToday(runs)).toBe(7);
    expect(spentTodayBy(runs, "u1")).toBe(3);
    expect(spentTodayByProject(runs, { githubRepo: "o/r" })).toBe(3);
  });

  it("lists a duplicate id once and the runs folder wins", () => {
    put(runs, "dup", { flow: "old-place" });
    put(teamRuns(), "dup", { flow: "workspace" });
    expect(listAllRunIds(runs)).toEqual([{ id: "dup", runsDir: runs }]);
    expect(loadRun(runs, "dup")?.flow).toBe("old-place");
    expect(listRunBriefs(runs).map((b) => b.flow)).toEqual(["old-place"]);
  });

  it("spentTodayByProject has no 500-run window, across both layouts", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 30 * 86_400_000).toISOString(); // not today, but newer ids come first
    put(teamRuns(), "20250101-000000-mine", { startedAt: now.toISOString(), totalCostUsd: 5, vars: { github_repo: "o/r" } });
    for (let i = 0; i < 300; i++) put(runs, `29${String(i).padStart(6, "0")}-x`, { startedAt: now.toISOString(), totalCostUsd: 0, vars: { github_repo: "o/other" } });
    for (let i = 0; i < 300; i++) put(teamRuns(), `28${String(i).padStart(6, "0")}-y`, { startedAt: now.toISOString(), totalCostUsd: 0, vars: { github_repo: "o/other" } });
    put(runs, "10000000-old", { startedAt: old });
    expect(spentTodayByProject(runs, { githubRepo: "o/r" }, now)).toBe(5);
  });
});

describe("claiming a run id", () => {
  const summary = (dir: string, id: string) => ({ runDir: join(dir, id) });
  it("refuses an id that exists in another runs folder and leaves it alone", () => {
    put(runs, "r1");
    const before = readFileSync(join(runs, "r1", "run.json"), "utf8");
    expect(() => claimRunDir(runs, summary(teamRuns(), "r1"))).toThrow(/already taken/);
    expect(readFileSync(join(runs, "r1", "run.json"), "utf8")).toBe(before);
    expect(existsSync(join(teamRuns(), "r1"))).toBe(false);
  });
  it("refuses an existing folder, with or without run.json", () => {
    mkdirSync(join(runs, "r2"));
    writeFileSync(join(runs, "r2", "live.log"), "x\n");
    expect(() => claimRunDir(runs, summary(runs, "r2"))).toThrow(/already taken/);
    expect(readFileSync(join(runs, "r2", "live.log"), "utf8")).toBe("x\n");
    claimRunDir(runs, summary(teamRuns(), "r3"));
    expect(() => claimRunDir(runs, summary(runs, "r3"))).toThrow(/already taken/);
    expect(() => claimRunDir(runs, summary(teamRuns(), "r3"))).toThrow(/already taken/);
    expect(runIdTaken(runs, "r3")).toBe(true);
    expect(runIdTaken(runs, "r3", teamRuns())).toBe(false);
    expect(runIdTaken(runs, "r-none")).toBe(false);
  });
  it("refuses a bad id", () => {
    expect(() => claimRunDir(runs, { runDir: join(runs, "a.b") })).toThrow(/invalid run id/);
  });
  it("lets at most one of two interleaved claims win and removes only the loser's folder", () => {
    let second: unknown;
    claimRunDir(runs, summary(runs, "r4"), {
      afterClaim: () => {
        try {
          claimRunDir(runs, summary(teamRuns(), "r4"));
        } catch (e) {
          second = e;
        }
      },
    });
    expect((second as Error).message).toMatch(/already taken/);
    expect(existsSync(join(runs, "r4"))).toBe(true);
    expect(existsSync(join(teamRuns(), "r4"))).toBe(false);
  });
  it("shares the test slots: the workspace's test-slots resolves to the data folder's", () => {
    claimRunDir(runs, summary(teamRuns(), "r5"));
    ensureWorkspaceTestSlots(runs, "team-a");
    expect(realpathSync(join(teamRuns(), "r5", "..", "..", "test-slots"))).toBe(realpathSync(join(data, "test-slots")));
    writeFileSync(join(data, "test-slots", "f"), "1");
    expect(readdirSync(join(teamRuns(), "r5", "..", "..", "test-slots"))).toEqual(["f"]);
    ensureWorkspaceTestSlots(runs, "team-a"); // a second claim leaves the link alone
    expect(realpathSync(join(data, "workspaces", "team-a", "test-slots"))).toBe(realpathSync(join(data, "test-slots")));
  });
});

describe("runFlow", () => {
  const cfg = ConfigSchema.parse({ protected_branches: [] });
  const flow = (run: string) => parseFlow(`name: w\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: ${JSON.stringify(run)}}\n`);
  const repo = () => {
    const r = join(data, "repo");
    mkdirSync(r, { recursive: true });
    return r;
  };
  it("writes a team run in the workspace folder and a default run in the runs folder; no other folder is made", async () => {
    config(TEAM_A);
    const team = await runFlow(flow("true"), { task: "t", repo: repo(), runsDir: runs, config: cfg, workspace: "team-a" });
    const plain = await runFlow(flow("true"), { task: "t", repo: repo(), runsDir: runs, config: cfg });
    expect(existsSync(join(teamRuns(), team.runId, "run.json"))).toBe(true);
    expect(existsSync(join(runs, plain.runId, "run.json"))).toBe(true);
    expect(readdirSync(runs)).toEqual([plain.runId]);
    expect(readdirSync(teamRuns())).toEqual([team.runId]);
    expect(realpathSync(join(teamRuns(), team.runId, "..", "..", "test-slots"))).toBe(realpathSync(join(data, "test-slots")));
  });
  it("refuses a bad or taken supplied id", async () => {
    config(TEAM_A);
    await expect(runFlow(flow("true"), { task: "t", repo: repo(), runsDir: runs, config: cfg, runId: "../x" })).rejects.toThrow(/invalid run id/);
    put(runs, "taken");
    const before = readFileSync(join(runs, "taken", "run.json"), "utf8");
    await expect(runFlow(flow("true"), { task: "t", repo: repo(), runsDir: runs, config: cfg, runId: "taken", workspace: "team-a" })).rejects.toThrow(/already taken/);
    expect(readFileSync(join(runs, "taken", "run.json"), "utf8")).toBe(before);
    expect(existsSync(join(teamRuns(), "taken"))).toBe(false);
  });
  it("gives the steps of a team run its own lock folder", async () => {
    config(TEAM_A);
    const out = join(data, "env.txt");
    const team = await runFlow(flow(`echo "$SCF_LOCK_DIR|$FACTORY_LOCK_DIR" > ${out}`), { task: "t", repo: repo(), runsDir: runs, config: cfg, workspace: "team-a" });
    expect(team.status).toBe("succeeded");
    const l = join(data, "workspaces", "team-a", "locks");
    expect(readFileSync(out, "utf8").trim()).toBe(`${l}|${l}`);
  });
});

describe("the sandbox profile", () => {
  it("denies every runs folder, also a custom one, and opens the workspace's lock folder", () => {
    const lockDir = join(data, "workspaces", "team-a", "locks");
    const paths = stepSandboxPaths({ runDir: join(data, "workspaces", "team-a", "runs", "r1"), learnings: join(data, "learn", "l.md"), runsDir: "/srv/scf/runs", lockDir });
    const text = sandboxProfile(paths, (p) => p);
    for (const p of ["/srv/scf/runs", "/srv/scf/workspaces", join(data, "runs"), join(data, "workspaces")]) expect(text).toContain(`(deny file-read* (subpath "${p}"))`);
    expect(text).toContain(`(allow file-read* (subpath "${lockDir}"))`);
    expect(text).toContain(`(allow file-write* (subpath "${lockDir}"))`);
    expect(text).toContain(`(deny file-write* (subpath "${join(lockDir, ".running")}"))`);
  });
  it("keeps the workspace container out of the plugins' reach", () => {
    expect(pluginBlockedDirs("/srv/scf/runs", data, "/repo")).toContain("/srv/scf/workspaces");
    expect(pluginBlockedDirs("/srv/scf/runs", data, "/repo")).toContain(join(data, "workspaces"));
  });
});

describe("locks and markers", () => {
  const lockFile = (root: string, runId: string, repo = "acme", name = "f.json") => {
    mkdirSync(join(root, repo), { recursive: true });
    writeFileSync(join(root, repo, name), JSON.stringify({ runId, runDir: join(runs, runId), areas: ["src"], at: new Date().toISOString() }));
  };
  it("sweepRunning frees the marker and lock of an ended team run, and keeps a live one", () => {
    put(teamRuns(), "ended", { status: "succeeded" });
    put(teamRuns(), "alive", { status: "running", pid: process.pid });
    const root = lockRoot("team-a");
    markRunning("ended", "team-a");
    markRunning("alive", "team-a");
    lockFile(root, "ended");
    lockFile(root, "alive", "acme", "g.json");
    expect(allLockRoots().map((r) => r.workspace)).toEqual([undefined, "team-a"]);
    sweepRunning(runs);
    expect(readdirSync(join(root, ".running"))).toEqual(["alive"]);
    expect(readdirSync(join(root, "acme"))).toEqual(["g.json"]);
  });
  it("sweepStaleRunning frees what no process holds", () => {
    put(teamRuns(), "gone", { status: "failed", pid: 999999 });
    const root = lockRoot("team-a");
    markRunning("gone", "team-a");
    lockFile(root, "gone");
    const out = sweepStaleRunning(runs, () => false);
    expect(out.markers).toEqual(["gone"]);
    expect(out.locks.map((l) => l.runId)).toEqual(["gone"]);
  });
  it("readAllAreaLocks returns the workspace's locks with a prefixed key", () => {
    lockFile(lockRoot("team-a"), "r1");
    lockFile(lockRoot(), "r2");
    expect(readAllAreaLocks().map((l) => l.key).sort()).toEqual(["acme/f.json", "workspaces/team-a/acme/f.json"]);
  });
});

describe("clean and owner", () => {
  it("cleans a team run, also when its workspace is no longer listed", () => {
    put(teamRuns(), "old", { startedAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:00:00.000Z" });
    const res = cleanRuns({ runsDir: runs, olderThanDays: 1, purge: true });
    expect(res.runs).toEqual(["old"]);
    expect(existsSync(join(teamRuns(), "old"))).toBe(false);
  });
  it("adoptRuns gives ownerless runs in both layouts to the first admin and skips refinement runs", async () => {
    const admin = await createUser({ name: "Admin", email: "admin@example.com", password: "test-password-12345", role: "admin" });
    put(runs, "o1", { status: "failed" });
    put(teamRuns(), "o2", { status: "failed" });
    put(teamRuns(), "o3", { status: "failed", source: "refinement of x" });
    expect(adoptRuns(runs)).toBe(2);
    expect(loadRun(runs, "o1")?.owner).toBe(admin.id);
    expect(loadRun(runs, "o2")?.owner).toBe(admin.id);
    expect(loadRun(runs, "o3")?.owner).toBeUndefined();
  });
});

describe("moving the data folder", () => {
  const opts = (from: string, to: string) => ({ from, to, env: {} as NodeJS.ProcessEnv, freeBytes: () => 1e15, sizeBytes: () => 1000 });
  it("waits for a running team run and keeps a team run's checkout files as they are", () => {
    const from = join(data, "old-home");
    const to = join(data, "new-home");
    const dir = join(from, "workspaces", "team-a", "runs", "r1");
    mkdirSync(join(dir, "workspace"), { recursive: true });
    const checkout = join(dir, "workspace", "data.json");
    writeFileSync(checkout, JSON.stringify({ path: from }));
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "r1", status: "running", pid: process.pid }));
    const postponed = migrateDataHome(opts(from, to));
    expect(postponed.status).toBe("postponed");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "r1", status: "succeeded", workspace: "team-a" }));
    expect(migrateDataHome(opts(from, to)).status).toBe("migrated");
    expect(readFileSync(join(to, "workspaces", "team-a", "runs", "r1", "workspace", "data.json"), "utf8")).toBe(JSON.stringify({ path: from }));
  });
});
