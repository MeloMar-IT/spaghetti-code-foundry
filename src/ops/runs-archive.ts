import { lstatSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { dropIndexSlot, listAllRunIds, RUN_ID_RE, runFile, runsArchiveDir, type RunSummary } from "../engine/state.js";

/** Failed and stopped runs can be looked at again, so they stay at least this long. */
export const FAILED_STOPPED_MIN_DAYS = 90;

export interface RunsArchiveOptions {
  runsDir: string;
  /** The scheduler's queue file; a file that exists but cannot be read means nothing is moved. */
  queueFile: string;
  /** Finished runs older than this many days move. */
  days: number;
  now: Date;
  isActive?: (runId: string) => boolean;
  /** Called just before the second look and the move (tests use it to change a run). */
  beforeMove?: (runId: string) => void;
}

export interface RunsArchiveResult {
  moved: string[];
  kept: { runId: string; why: string }[];
  /** Set when the pass could not run at all; nothing was moved. */
  failed?: string;
}

const DAY_MS = 86_400_000;

/** The run ids in the queue file. A missing file gives an empty set; a file that cannot be read gives undefined. */
export function queuedRunIds(queueFile: string): Set<string> | undefined {
  let text: string;
  try {
    text = readFileSync(queueFile, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : undefined;
  }
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return undefined;
    return new Set(list.map((j) => (j && typeof j === "object" && typeof (j as { runId?: unknown }).runId === "string" ? (j as { runId: string }).runId : "")).filter(Boolean));
  } catch {
    return undefined;
  }
}

/**
 * The keys the watchers look runs up by (issue, pull request, precheck, CI workflow, chore, release build). Until the
 * watchers can find archived runs, the newest run of each key is never moved.
 */
export function watcherKeysOf(s: Pick<RunSummary, "flow" | "vars">): string[] {
  const v = s.vars ?? {};
  const repo = v.github_repo ?? "";
  const keys: string[] = [];
  if (v.issue) keys.push(`issue|${repo}|${v.issue}|${s.flow}`);
  if (v.pr) keys.push(`pr|${repo}|${v.pr}|${s.flow}`);
  if (v.issues) for (const x of v.issues.split(/[\s,]+/)) if (/^\d+$/.test(x)) keys.push(`issues|${repo}|${x}|${s.flow}`);
  if (v.ci_workflow) keys.push(`ci|${repo}|${v.ci_workflow}`);
  if (v.chore_watcher) keys.push(`chore|${v.chore_watcher}`);
  if (v.release_build_watcher) keys.push(`release|${repo}|${v.release_build_watcher}`);
  return keys;
}

const lstatOrUndefined = (p: string) => {
  try {
    return lstatSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
};

const mtimeOf = (p: string): number | undefined => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Moves old runs to `<data>/runs-archive/<id>/` with one rename each; nothing is deleted and run.json is not rewritten.
 * Succeeded and cancelled runs move after `days`, failed and stopped ones after at least 90 days. Waiting, running,
 * queued and active runs never move, nor the newest run of each watcher key.
 */
export function archiveOldRuns(o: RunsArchiveOptions): RunsArchiveResult {
  const res: RunsArchiveResult = { moved: [], kept: [] };
  const queued = queuedRunIds(o.queueFile);
  if (!queued) return { ...res, failed: "the queue file cannot be read" };
  const archive = runsArchiveDir(o.runsDir);
  try {
    const st = lstatOrUndefined(archive);
    if (st && !st.isDirectory()) return { ...res, failed: "runs-archive is not a folder" };
    if (!st) mkdirSync(archive, { recursive: true });
  } catch (e) {
    return { ...res, failed: `runs-archive cannot be used: ${(e as Error).message}` };
  }
  let queueMtime = mtimeOf(o.queueFile);
  const failedDays = Math.max(o.days, FAILED_STOPPED_MIN_DAYS);

  type Entry = { id: string; dir: string; text: string; s: RunSummary; mtimeMs: number };
  const entries: Entry[] = [];
  for (const { id, runsDir: folder } of listAllRunIds(o.runsDir)) {
    const dir = join(folder, id);
    if (!RUN_ID_RE.test(id)) continue;
    try {
      const text = readFileSync(runFile(dir), "utf8");
      const s = JSON.parse(text) as RunSummary;
      if (!s || typeof s !== "object") continue;
      entries.push({ id, dir, text, s, mtimeMs: statSync(runFile(dir)).mtimeMs });
    } catch {
      res.kept.push({ runId: id, why: "run.json cannot be read" });
    }
  }

  // listAllRunIds is newest first: the first run of a key is its newest and stays
  const seen = new Set<string>();
  const anchor = new Set<string>();
  for (const e of entries) {
    const first = watcherKeysOf({ flow: String(e.s.flow), vars: e.s.vars }).some((k) => !seen.has(k));
    for (const k of watcherKeysOf({ flow: String(e.s.flow), vars: e.s.vars })) seen.add(k);
    if (first) anchor.add(e.id);
  }

  for (const e of entries) {
    const { id, dir, s } = e;
    if (s.runId !== id) {
      res.kept.push({ runId: id, why: "run id does not match its folder" });
      continue;
    }
    if (queued.has(id) || o.isActive?.(id)) {
      res.kept.push({ runId: id, why: "queued or running" });
      continue;
    }
    const limit = s.status === "succeeded" || s.status === "cancelled" ? o.days : s.status === "failed" || s.status === "stopped" ? failedDays : undefined;
    if (limit === undefined) {
      res.kept.push({ runId: id, why: `${String(s.status)} (can be resumed)` });
      continue;
    }
    const ended = Date.parse(String(s.finishedAt ?? s.startedAt));
    const last = Math.max(Number.isFinite(ended) ? ended : 0, e.mtimeMs);
    if (!(last > 0) || o.now.getTime() - last <= limit * DAY_MS) continue;
    if (anchor.has(id)) {
      res.kept.push({ runId: id, why: "newest run of its issue, pull request or chore" });
      continue;
    }
    const target = join(archive, id);
    try {
      if (lstatOrUndefined(target)) {
        res.kept.push({ runId: id, why: "runs-archive already has this id" });
        continue;
      }
      o.beforeMove?.(id);
      // second look: the run did not change and was not queued meanwhile
      if (readFileSync(runFile(dir), "utf8") !== e.text) {
        res.kept.push({ runId: id, why: "changed meanwhile" });
        continue;
      }
      const qm = mtimeOf(o.queueFile);
      if (qm !== queueMtime) {
        const again = queuedRunIds(o.queueFile);
        if (!again) {
          res.kept.push({ runId: id, why: "the queue file cannot be read" });
          continue;
        }
        queueMtime = qm;
        for (const q of again) queued.add(q);
        if (queued.has(id)) {
          res.kept.push({ runId: id, why: "queued or running" });
          continue;
        }
      }
      if (o.isActive?.(id)) {
        res.kept.push({ runId: id, why: "queued or running" });
        continue;
      }
      renameSync(dir, target);
      dropIndexSlot(runFile(dir));
      res.moved.push(id);
    } catch (err) {
      res.kept.push({ runId: id, why: `could not be moved: ${(err as Error).message}` });
    }
  }
  return res;
}
