import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanRuns } from "../src/clean.js";
import { ConfigSchema } from "../src/config.js";
import { resumeRun } from "../src/engine/runner.js";
import {
  allRunsDirs, isInRunsArchive, listAllRunIds, listRunBriefs, loadRun, loadRunAsync, runDirOf, runIdTaken, runsArchiveDir, spentThisMonth,
} from "../src/engine/state.js";
import { RunIndex } from "../src/engine/run-index.js";
import { archiveOldRuns, queuedRunIds, watcherKeysOf } from "../src/ops/runs-archive.js";
import { Scheduler, AnswerRefused } from "../src/queue/scheduler.js";
import { hidePaths } from "../src/server/user-view.js";
import { isCovered } from "../src/settings/describe.js";

const NOW = new Date("2026-06-15T12:00:00Z");
const DAY = 86_400_000;
let data: string;
let runs: string;
let queueFile: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  data = realpathSync(mkdtempSync(join(tmpdir(), "runs-archive-")));
  process.env.FACTORY_HOME = data;
  runs = join(data, "runs");
  queueFile = join(data, "queue.json");
  mkdirSync(runs, { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(data, { recursive: true, force: true });
});

/** A run folder whose run.json (and mtime) say it ended `ageDays` before NOW. */
function put(dir: string, id: string, ageDays: number, extra: Record<string, unknown> = {}) {
  const runDir = join(dir, id);
  mkdirSync(runDir, { recursive: true });
  const at = new Date(NOW.getTime() - ageDays * DAY);
  const s = { runId: id, flow: "f", status: "succeeded", startedAt: at.toISOString(), finishedAt: at.toISOString(), totalCostUsd: 1, runDir, task: "", vars: {}, history: [], ...extra };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(s));
  utimesSync(join(runDir, "run.json"), at, at);
  return s;
}
const go = (o: { days?: number; isActive?: (id: string) => boolean; beforeMove?: (id: string) => void } = {}) => archiveOldRuns({ runsDir: runs, queueFile, days: 30, now: NOW, ...o });
const archived = (id: string) => existsSync(join(runsArchiveDir(runs), id, "run.json"));

describe("which runs move", () => {
  it("moves by status and age", () => {
    put(runs, "20260101-s31", 31);
    put(runs, "20260101-s29", 29);
    put(runs, "20260101-c31", 31, { status: "cancelled" });
    put(runs, "20260101-f31", 31, { status: "failed" });
    put(runs, "20260101-f91", 91, { status: "failed" });
    put(runs, "20260101-t31", 31, { status: "stopped" });
    put(runs, "20260101-t91", 91, { status: "stopped" });
    put(runs, "20260101-w400", 400, { status: "waiting" });
    put(runs, "20260101-r400", 400, { status: "running" });
    const r = go();
    expect(r.failed).toBeUndefined();
    expect(r.moved.sort()).toEqual(["20260101-c31", "20260101-f91", "20260101-s31", "20260101-t91"]);
    for (const id of ["20260101-s29", "20260101-f31", "20260101-t31", "20260101-w400", "20260101-r400"]) expect(existsSync(join(runs, id, "run.json")), id).toBe(true);
  });

  it("keeps a failed run longer when days is above 90", () => {
    put(runs, "20260101-f100", 100, { status: "failed" });
    expect(go({ days: 120 }).moved).toEqual([]);
  });

  it("counts the age from the run.json mtime when that is newer", () => {
    put(runs, "20260101-new", 100);
    utimesSync(join(runs, "20260101-new", "run.json"), NOW, NOW);
    expect(go().moved).toEqual([]);
  });

  it("keeps queued and active runs, and moves nothing when the queue cannot be read", () => {
    put(runs, "20260101-q", 100);
    put(runs, "20260101-a", 100);
    put(runs, "20260101-m", 100);
    writeFileSync(queueFile, JSON.stringify([{ runId: "20260101-q", job: { kind: "resume", runId: "20260101-q" } }]));
    expect(go({ isActive: (id) => id === "20260101-a" }).moved).toEqual(["20260101-m"]);
    writeFileSync(queueFile, "{nope");
    expect(queuedRunIds(queueFile)).toBeUndefined();
    const r = go();
    expect(r.failed).toBeTruthy();
    expect(r.moved).toEqual([]);
    rmSync(queueFile);
    expect(queuedRunIds(queueFile)?.size).toBe(0);
  });

  it("keeps the newest run of each watcher key", () => {
    const v = { github_repo: "o/r", issue: "5" };
    put(runs, "20260101-b", 400, { vars: v });
    put(runs, "20260102-a", 400, { vars: v });
    put(runs, "20260103-o", 400, { vars: v, flow: "other" });
    put(runs, "20260104-chore", 400, { vars: { chore_watcher: "w" } });
    put(runs, "20260105-ci", 400, { vars: { github_repo: "o/r", ci_workflow: "build" } });
    put(runs, "20260106-pre", 400, { vars: { github_repo: "o/r", issues: "7,8" } });
    put(runs, "20260107-rel", 400, { vars: { github_repo: "o/r", release_build_watcher: "rb" } });
    expect(go().moved).toEqual(["20260101-b"]);
  });

  it("has unit cases for watcherKeysOf", () => {
    expect(watcherKeysOf({ flow: "f", vars: { github_repo: "o/r", issue: "5" } })).toEqual(["issue|o/r|5|f"]);
    expect(watcherKeysOf({ flow: "f", vars: { github_repo: "o/r", pr: "6" } })).toEqual(["pr|o/r|6|f"]);
    expect(watcherKeysOf({ flow: "f", vars: { github_repo: "o/r", issues: "1, 2,x" } })).toEqual(["issues|o/r|1|f", "issues|o/r|2|f"]);
    expect(watcherKeysOf({ flow: "f", vars: {} })).toEqual([]);
  });
});

describe("the move", () => {
  it("is one rename: run.json is unchanged, the source is gone, workspace runs move too", () => {
    const team = join(data, "workspaces", "team-a", "runs");
    mkdirSync(team, { recursive: true });
    put(runs, "20260101-main", 40);
    put(team, "20260102-team", 40);
    const before = readFileSync(join(runs, "20260101-main", "run.json"));
    expect(go().moved.sort()).toEqual(["20260101-main", "20260102-team"]);
    expect(readFileSync(join(runsArchiveDir(runs), "20260101-main", "run.json")).equals(before)).toBe(true);
    expect(existsSync(join(runs, "20260101-main"))).toBe(false);
    expect(archived("20260102-team")).toBe(true);
    expect(existsSync(join(team, "20260102-team"))).toBe(false);
  });

  it("keeps a run whose destination exists, and one that changed before the move", () => {
    put(runs, "20260101-dup", 40);
    put(runsArchiveDir(runs), "20260101-dup", 40);
    put(runs, "20260102-chg", 40);
    const r = go({ beforeMove: (id) => id === "20260102-chg" && writeFileSync(join(runs, id, "run.json"), "{}") });
    expect(r.moved).toEqual([]);
    expect(r.kept.map((k) => k.runId).sort()).toEqual(["20260101-dup", "20260102-chg"]);
    expect(existsSync(join(runs, "20260101-dup", "run.json"))).toBe(true);
  });

  it("keeps a run that was queued after the first look", () => {
    put(runs, "20260101-late", 40);
    const r = go({ beforeMove: () => writeFileSync(queueFile, JSON.stringify([{ runId: "20260101-late", job: { kind: "resume" } }])) });
    expect(r.moved).toEqual([]);
    expect(existsSync(join(runs, "20260101-late", "run.json"))).toBe(true);
  });

  it("does not use a runs-archive that is a link", () => {
    const outside = join(data, "outside");
    mkdirSync(outside);
    symlinkSync(outside, runsArchiveDir(runs));
    put(runs, "20260101-x", 40);
    const r = go();
    expect(r.failed).toBeTruthy();
    expect(r.moved).toEqual([]);
    expect(existsSync(join(runs, "20260101-x", "run.json"))).toBe(true);
    expect(runDirOf(runs, "20260101-x")).toBe(join(runs, "20260101-x"));
  });
});

describe("reading archived runs", () => {
  const hist = (dir: string) => [{ step: "a", logFile: join(dir, "a.log") }, { step: "b", logFile: "/elsewhere/b.log" }];

  it("finds them by id, also a hand-moved one, and re-bases the paths in memory", async () => {
    const old = join(data, "workspaces", "x", "runs", "20260101-hand");
    put(runsArchiveDir(runs), "20260101-hand", 40, { runDir: old, workdir: join(old, "ws"), history: hist(old) });
    const dir = join(runsArchiveDir(runs), "20260101-hand");
    expect(runDirOf(runs, "20260101-hand")).toBe(dir);
    expect(isInRunsArchive(runs, "20260101-hand")).toBe(true);
    for (const s of [loadRun(runs, "20260101-hand")!, (await loadRunAsync(runs, "20260101-hand"))!]) {
      expect(s.runDir).toBe(dir);
      expect(s.movedFrom).toBe(old);
      expect(s.workdir).toBe(join(dir, "ws"));
      expect(s.history[0]!.logFile).toBe(join(dir, "a.log"));
      expect(s.history[1]!.logFile).toBe("/elsewhere/b.log");
    }
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).runDir).toBe(old);
  });

  it("prefers runs/, and refuses a bad id", () => {
    put(runsArchiveDir(runs), "20260101-same", 40);
    put(runs, "20260101-same", 1);
    expect(runDirOf(runs, "20260101-same")).toBe(join(runs, "20260101-same"));
    expect(loadRun(runs, "20260101-same")!.movedFrom).toBeUndefined();
    expect(isInRunsArchive(runs, "20260101-same")).toBe(false);
    expect(runDirOf(runs, "../x")).toBeUndefined();
  });

  it("is in no list and not in the run index", async () => {
    put(runs, "20260101-old", 40);
    const index = new RunIndex(runs);
    await index.build();
    expect(index.briefs().map((b) => b.dirName)).toContain("20260101-old");
    expect(go().moved).toEqual(["20260101-old"]);
    await index.refresh();
    expect(index.briefs().map((b) => b.dirName)).not.toContain("20260101-old");
    expect(allRunsDirs(runs)).not.toContain(runsArchiveDir(runs));
    expect(listAllRunIds(runs).map((r) => r.id)).toEqual([]);
    expect(listRunBriefs(runs).map((b) => b.dirName)).toEqual([]);
    expect(loadRun(runs, "20260101-old")?.status).toBe("succeeded");
  });

  it("still counts for spending and for taken ids", () => {
    put(runsArchiveDir(runs), "20260610-spent", 5, { totalCostUsd: 2.5 });
    expect(spentThisMonth(runs, NOW)).toBe(2.5);
    expect(runIdTaken(runs, "20260610-spent")).toBe(true);
    expect(runIdTaken(runs, "20260610-none")).toBe(false);
  });

  it("does not break clean", () => {
    put(runs, "20260101-old", 40);
    put(runs, "20260102-other", 40);
    go();
    expect(() => cleanRuns({ runsDir: runs, olderThanDays: 1 })).not.toThrow();
    expect(archived("20260101-old")).toBe(true);
  });

  it("hides the old folder from a user", () => {
    expect(hidePaths("see /old/x/run.json", { movedFrom: "/old/x" })).not.toContain("/old/x");
  });
});

describe("an archived run is read-only", () => {
  const stopped = () => ({ ...ConfigSchema.parse({}), concurrency: 0 });

  it("is refused by the scheduler and by resumeRun", async () => {
    put(runsArchiveDir(runs), "20260101-ro", 40, { status: "waiting" });
    put(runs, "20260102-live", 1, { status: "waiting" });
    const s = new Scheduler({ runsDir: runs, queueFile, config: stopped });
    expect(s.inRunsArchive("20260101-ro")).toBe(true);
    expect(s.inRunsArchive("20260102-live")).toBe(false);
    expect(() => s.submit({ kind: "resume", runId: "20260101-ro" })).toThrow(/RUN_IN_ARCHIVE/);
    expect(() => s.answer("20260101-ro", "yes", "me")).toThrow(AnswerRefused);
    expect(s.setArchived("20260101-ro", true, "me")).toBe("stored");
    expect(s.setParked("20260101-ro")).toBe(false);
    expect(s.clearParked("20260101-ro")).toBe(false);
    expect(s.cancel("20260101-ro")).toBe(false);
    await expect(resumeRun({ runsDir: runs, runId: "20260101-ro", config: stopped() } as never)).rejects.toThrow(/RUN_IN_ARCHIVE/);
    expect(JSON.parse(readFileSync(join(runsArchiveDir(runs), "20260101-ro", "run.json"), "utf8")).status).toBe("waiting");
  });
});

describe("the setting", () => {
  it("defaults to 30 and takes 1 to 3650 whole days", () => {
    expect(ConfigSchema.parse({}).runs_archive_days).toBe(30);
    for (const v of [0, 3651, 1.5]) expect(() => ConfigSchema.parse({ runs_archive_days: v }), String(v)).toThrow();
    expect(isCovered("runs_archive_days")).toBe(true);
  });
});
