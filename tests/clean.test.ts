import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanRuns } from "../src/clean.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { prunePlanRecords, readPlanRecords, writePlanRecord, type PlanRecord } from "../src/skills/plan-record.js";

let tmp: string;
let repo: string;
const runsDir = () => join(tmp, "runs");
const config = ConfigSchema.parse({ protected_branches: [] });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-clean-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "f"), "x");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const age = (runId: string, days: number) => {
  const s = loadRun(runsDir(), runId)!;
  s.finishedAt = new Date(Date.now() - days * 86_400_000).toISOString();
  saveRun(s);
};
const run = (yaml: string) => runFlow(parseFlow(yaml), { task: "", repo, runsDir: runsDir(), config });

describe("clean", () => {
  it("removes old worktrees (keeping branches), skips paused and recent runs, previews with dryRun", async () => {
    const old = await run("name: a\nsteps:\n  - {id: a, type: shell, run: 'true'}");
    const paused = await run("name: b\nsteps:\n  - {id: a, type: shell, run: 'true', on_success: stop}");
    const recent = await run("name: c\nsteps:\n  - {id: a, type: shell, run: 'true'}");
    age(old.runId, 10);
    age(paused.runId, 10);

    const preview = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, dryRun: true });
    expect(preview.workspaces).toEqual([old.workdir]);
    expect(existsSync(old.workdir!)).toBe(true);

    const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 7 });
    expect(r.workspaces).toEqual([old.workdir]);
    expect(r.kept).toEqual([{ runId: paused.runId, why: "stopped (can be resumed)" }]);
    expect(existsSync(old.workdir!)).toBe(false);
    expect(existsSync(join(old.runDir, "run.json"))).toBe(true);
    expect(existsSync(recent.workdir!)).toBe(true);
    const worktrees = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
    expect(worktrees).not.toContain(old.runId);
    expect(execFileSync("git", ["-C", repo, "branch", "--list", `factory/${old.runId}`], { encoding: "utf8" })).toContain(old.runId);

    const purged = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, purge: true, includePaused: true });
    expect(purged.runs.sort()).toEqual([old.runId, paused.runId].sort());
    expect(existsSync(paused.runDir)).toBe(false);
  });

  describe("plan records", () => {
    const DAY = 86_400_000;
    const rec = (days: number, id: string): PlanRecord => ({
      version: 1, repo: "acme/app", issue: "5", runId: `run-${id}`, planHash: "sha256:" + id.repeat(64), commentId: id === "a" ? "1" : "2",
      commentSha256: "sha256:" + "c".repeat(64), request: { version: 1, skills: [] }, createdAt: new Date(Date.now() - days * DAY).toISOString(),
    });
    const count = (home: string) => {
      const r = readPlanRecords("acme/app", "5", { home });
      return r === "invalid" ? -1 : r.records.length;
    };
    const seed = (home: string) => {
      writePlanRecord(rec(100, "a"), { home });
      writePlanRecord(rec(10, "b"), { home });
    };

    it("purge removes records older than 90 days, even with a shorter cut-off", () => {
      seed(tmp);
      const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, purge: true, planRecordsHome: tmp });
      expect(r.planRecords).toBe(1);
      expect(count(tmp)).toBe(1);
    });

    it("keeps records younger than a longer cut-off", () => {
      seed(tmp);
      const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 120, purge: true, planRecordsHome: tmp });
      expect(r.planRecords).toBe(0);
      expect(count(tmp)).toBe(2);
    });

    it("a dry run only counts", () => {
      seed(tmp);
      const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, purge: true, dryRun: true, planRecordsHome: tmp });
      expect(r.planRecords).toBe(1);
      expect(count(tmp)).toBe(2);
    });

    it("does nothing without purge", () => {
      seed(tmp);
      const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, planRecordsHome: tmp });
      expect(r.planRecords).toBeUndefined();
      expect(count(tmp)).toBe(2);
    });

    it("leaves the records of the data folder alone for a foreign runs folder", () => {
      const home = process.env.FACTORY_HOME!;
      writePlanRecord(rec(100, "a"), { home });
      try {
        const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, purge: true });
        expect(r.planRecords).toBeUndefined();
        expect(count(home)).toBe(1);
      } finally {
        prunePlanRecords({ olderThanMs: 0, home });
      }
    });

    it("cleans the data folder by default when the runs folder is its own", () => {
      const home = process.env.FACTORY_HOME!;
      writePlanRecord(rec(100, "a"), { home });
      const r = cleanRuns({ runsDir: join(home, "runs"), olderThanDays: 7, purge: true });
      expect(r.planRecords).toBe(1);
      expect(count(home)).toBe(0);
    });


    it("reports when the store cannot be written, and does not fail the clean-up", () => {
      const notAFolder = join(tmp, "home-file");
      writeFileSync(notAFolder, "x");
      const r = cleanRuns({ runsDir: runsDir(), olderThanDays: 7, purge: true, planRecordsHome: notAFolder });
      expect(r.planRecordsFailed).toBe(true);
      expect(r.planRecords).toBeUndefined();
    });
  });

  it("never touches in-place workspaces", async () => {
    const s = await run("name: d\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}");
    age(s.runId, 30);
    cleanRuns({ runsDir: runsDir(), olderThanDays: 7, purge: true });
    expect(existsSync(join(repo, "f"))).toBe(true);
  });
});
