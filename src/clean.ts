import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataHome } from "./auth/store.js";
import { prunePlanRecords } from "./skills/plan-record.js";
import { listRunIds, loadRun, type RunSummary } from "./engine/state.js";
import { EVIDENCE_DIFF_FILE, EVIDENCE_EVENTS_FILE, EVIDENCE_INCOMPLETE_FILE, EVIDENCE_MANIFEST_FILE } from "./evidence/version.js";

export interface CleanOptions {
  runsDir: string;
  /** Only runs that finished at least this many days ago. */
  olderThanDays: number;
  /** Also delete run.json and logs (default: only workspaces). */
  purge?: boolean;
  /** Also clean stopped / waiting / interrupted runs (they can no longer be resumed). */
  includePaused?: boolean;
  dryRun?: boolean;
  /** The data folder whose plan records are cleaned with `purge`; default: the data folder when `runsDir` is its `runs` folder. */
  planRecordsHome?: string;
  isActive?: (runId: string) => boolean;
  /**
   * Also remove the evidence files of the cleaned runs that finished at least this many days ago and are kept as runs.
   * Not set: evidence stays as long as its run (the behaviour before this option).
   */
  evidenceOlderThanDays?: number;
}

export interface CleanResult {
  workspaces: string[];
  runs: string[];
  freedMb: number;
  kept: { runId: string; why: string }[];
  /** Plan records removed (or counted, on a dry run); set with `purge` when plan records are cleaned. */
  planRecords?: number;
  /** The plan records could not be cleaned (the store is locked or cannot be written). */
  planRecordsFailed?: boolean;
  /** The ids of the runs whose evidence was removed (or would be, on a dry run) while the run itself stays. */
  evidence: string[];
}

/**
 * The evidence of a run, in the order it is removed: the manifest first, so a removal that is interrupted leaves a run
 * that is "not finalized", never a manifest without its events. All of it goes or none: the logs and transcripts the
 * manifest needs stay with the run, so what is left is a run without evidence, not one that fails verification.
 */
const EVIDENCE_FILES = [EVIDENCE_MANIFEST_FILE, EVIDENCE_DIFF_FILE, EVIDENCE_EVENTS_FILE, EVIDENCE_INCOMPLETE_FILE];

function hasEvidence(runDir: string): boolean {
  return EVIDENCE_FILES.some((name) => {
    try {
      lstatSync(join(runDir, name));
      return true;
    } catch {
      return false;
    }
  });
}

/** Removes the evidence files (never following a link); false when one of them could not be removed. */
function removeEvidence(runDir: string): boolean {
  let all = true;
  for (const name of EVIDENCE_FILES) {
    try {
      rmSync(join(runDir, name), { force: true });
    } catch {
      all = false;
    }
  }
  return all;
}

/** Plan records are kept at least this long, so routine clean-up does not force a new plan. */
const PLAN_RECORD_MIN_DAYS = 90;

const PAUSED: RunSummary["status"][] = ["stopped", "waiting", "running"];

function sizeMb(path: string): number {
  try {
    return Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) / 1024;
  } catch {
    return 0;
  }
}

/** Remove a run's workspace; worktrees are unregistered from their repo (the branch is kept). */
function removeWorkspace(s: RunSummary) {
  const wd = s.workdir!;
  if (s.branch && s.repo && existsSync(s.repo)) {
    try {
      execFileSync("git", ["-C", s.repo, "worktree", "remove", "--force", wd], { stdio: "ignore" });
    } catch {
      // not registered anymore — fall through to a plain delete
    }
  }
  rmSync(wd, { recursive: true, force: true });
  if (s.branch && s.repo && existsSync(s.repo)) {
    try {
      execFileSync("git", ["-C", s.repo, "worktree", "prune"], { stdio: "ignore" });
    } catch {
      // repo gone or not a git repo
    }
  }
}

/**
 * Free disk space from old runs. Workspaces inside the run dir (worktrees and clones)
 * are removed; in-place runs never touch the repo. Branches are kept.
 */
export function cleanRuns(o: CleanOptions): CleanResult {
  const cutoff = Date.now() - o.olderThanDays * 86_400_000;
  const res: CleanResult = { workspaces: [], runs: [], freedMb: 0, kept: [], evidence: [] };
  const evidenceDays = o.evidenceOlderThanDays;
  const evidenceCutoff = evidenceDays !== undefined && evidenceDays >= 0 ? Date.now() - evidenceDays * 86_400_000 : undefined;
  for (const id of listRunIds(o.runsDir)) {
    const s = loadRun(o.runsDir, id);
    if (!s) continue;
    const when = new Date(s.finishedAt ?? s.startedAt).getTime();
    if (when > cutoff) continue;
    if (o.isActive?.(id)) {
      res.kept.push({ runId: id, why: "running" });
      continue;
    }
    if (PAUSED.includes(s.status) && !o.includePaused) {
      res.kept.push({ runId: id, why: `${s.status} (can be resumed)` });
      continue;
    }
    const ownWorkspace = !!s.workdir && s.workdir.startsWith(s.runDir) && existsSync(s.workdir);
    if (o.purge) {
      res.freedMb += sizeMb(s.runDir);
      res.runs.push(id);
      if (!o.dryRun) {
        if (ownWorkspace) removeWorkspace(s);
        rmSync(s.runDir, { recursive: true, force: true });
      }
    } else if (ownWorkspace) {
      res.freedMb += sizeMb(s.workdir!);
      res.workspaces.push(s.workdir!);
      if (!o.dryRun) removeWorkspace(s);
    }
    // The run stays: its evidence goes when it is past its own age. (A purge removed it with the run.)
    if (!o.purge && evidenceCutoff !== undefined && when <= evidenceCutoff && hasEvidence(s.runDir)) {
      if (o.dryRun || removeEvidence(s.runDir)) res.evidence.push(id);
    }
  }
  const home = o.planRecordsHome ?? (resolve(o.runsDir) === resolve(join(dataHome(), "runs")) ? dataHome() : undefined);
  if (o.purge && home) {
    try {
      res.planRecords = prunePlanRecords({ olderThanMs: Math.max(o.olderThanDays, PLAN_RECORD_MIN_DAYS) * 86_400_000, dryRun: o.dryRun, home });
    } catch {
      res.planRecordsFailed = true;
    }
  }
  res.freedMb = Math.round(res.freedMb * 10) / 10;
  return res;
}
