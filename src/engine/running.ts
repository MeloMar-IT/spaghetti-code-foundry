import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";
import { DEFAULT_WORKSPACE, validWorkspaceId } from "../workspaces/list.js";
import { pidAlive, runDirOf, workspaceFolderIn, workspaceFoldersIn } from "./state.js";

/**
 * A small "running" marker per run in `<lock folder>/.running`, so `tools/area-lock` can tell that a run is still running
 * without reading its `run.json` (a sandboxed step may not read other runs' folders). The file holds a token of the driver
 * that made it; only that driver removes it.
 */

/**
 * The lock folder: for a workspace other than `default` it is `<data>/workspaces/<id>/locks` (#824; throws for a link that
 * leaves the data folder); otherwise the environment's, or `<data>/locks`.
 */
export const lockRoot = (ws?: string): string =>
  validWorkspaceId(ws) && ws !== DEFAULT_WORKSPACE
    ? join(workspaceFolderIn(process.env.FACTORY_HOME ?? FACTORY_HOME, ws), "locks")
    : process.env.SCF_LOCK_DIR || process.env.FACTORY_LOCK_DIR || join(process.env.FACTORY_HOME ?? FACTORY_HOME, "locks");

/** The default lock folder, then the `locks` folder of every workspace folder that has a real one. Never throws. */
export function allLockRoots(): { workspace?: string; dir: string }[] {
  const out: { workspace?: string; dir: string }[] = [{ dir: lockRoot() }];
  for (const w of workspaceFoldersIn(process.env.FACTORY_HOME ?? FACTORY_HOME)) {
    try {
      const dir = lockRoot(w.id);
      if (lstatSync(dir).isDirectory()) out.push({ workspace: w.id, dir });
    } catch {
      // no lock folder, or a link that leaves the data folder
    }
  }
  return out;
}

const markerName = (runId: string): string => runId.replace(/[^\w.-]/g, "_");
const STALE_TMP_MS = 60_000;

/** Marks the run as running. Returns the token, or undefined when the marker could not be written (the run goes on). */
export function markRunning(runId: string, ws?: string): string | undefined {
  const token = randomBytes(8).toString("hex");
  let dir = "";
  let tmp = "";
  try {
    dir = join(lockRoot(ws), ".running");
    tmp = join(dir, `.tmp-${markerName(runId)}-${token}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, token);
    renameSync(tmp, join(dir, markerName(runId)));
    return token;
  } catch {
    try {
      if (tmp) rmSync(tmp, { force: true });
    } catch {
      // nothing to clean
    }
    return undefined;
  }
}

/** Removes the marker when it still holds this token. */
export function unmarkRunning(runId: string, token: string | undefined, ws?: string): void {
  if (!token) return;
  try {
    const f = join(lockRoot(ws), ".running", markerName(runId));
    if (readFileSync(f, "utf8") === token) rmSync(f, { force: true });
  } catch {
    // already gone
  }
}

type Read = { text: string } | { missing: true } | { unreadable: true };

/** A bounded plain file, opened once without following a link or waiting for a pipe (a step may write in the lock folder). */
function safeRead(path: string, maxBytes = 65_536): Read {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return { unreadable: true };
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, n).toString("utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { missing: true } : { unreadable: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** "running" | "ended" | "unknown" by the run's own run.json; a file that cannot be read or parsed counts as unknown (kept). */
function runState(runDir: string): "running" | "ended" | "unknown" {
  const r = safeRead(join(runDir, "run.json"), 4_000_000);
  if ("missing" in r) return "ended";
  if (!("text" in r)) return "unknown";
  try {
    return JSON.parse(r.text).status === "running" ? "running" : "ended";
  } catch {
    return "unknown";
  }
}

/** Removes markers (and old temp files) of runs that ended or are gone, and lock files without the flag of ended runs. Never throws. */
export function sweepRunning(runsDir: string): void {
  for (const r of allLockRoots()) sweepRunningIn(r.dir, runsDir);
}

/** The folder of a run by its id: where its run.json is, else the (missing) default place. */
const runFolder = (runsDir: string, id: string): string => runDirOf(runsDir, id) ?? join(runsDir, id);

function sweepRunningIn(root: string, runsDir: string): void {
  try {
    for (const f of readdirSync(join(root, ".running"))) {
      const path = join(root, ".running", f);
      try {
        if (f.startsWith(".tmp-")) {
          if (Date.now() - lstatSync(path).mtimeMs > STALE_TMP_MS) rmSync(path, { force: true });
        } else if (!/^\.+$/.test(f) && runState(runFolder(runsDir, f)) === "ended") rmSync(path, { force: true });
      } catch {
        // skip
      }
    }
  } catch {
    // no marker folder yet
  }
  try {
    for (const repo of readdirSync(root, { withFileTypes: true })) {
      if (!repo.isDirectory() || repo.name.startsWith(".")) continue;
      for (const f of readdirSync(join(root, repo.name))) {
        if (!f.endsWith(".json")) continue;
        const path = join(root, repo.name, f);
        try {
          const r = safeRead(path);
          if (!("text" in r)) continue;
          const lock = JSON.parse(r.text) as { marker?: boolean; runId?: unknown };
          // the run folder comes from the runs folder and the run id, never from the lock's own `runDir`
          if (lock.marker === true || typeof lock.runId !== "string" || !/^[\w.-]+$/.test(lock.runId) || /^\.+$/.test(lock.runId)) continue;
          // only a run folder that is there and says it ended frees the lock; a run that lives elsewhere is left to area-lock itself
          const dir = runFolder(runsDir, lock.runId);
          const known = !("missing" in safeRead(join(dir, "run.json"), 4_000_000));
          if (known && runState(dir) === "ended") rmSync(path, { force: true });
        } catch {
          // half-written or not ours
        }
      }
    }
  } catch {
    // no lock folder yet
  }
}

export const RUNNING_SWEEP_MS = 60_000;
/** The abort reason the scheduler uses for a restart. */
export const RESTART_INTERRUPT = "scf:restart-interrupt";
export const RESTART_INTERRUPTED = "interrupted by a restart of the server — resume it to continue";

export interface FreedLock {
  runId: string;
  repo: string;
  areas: string[];
}
export interface StaleSweep {
  markers: string[];
  locks: FreedLock[];
}

/** Who owns a run folder: a live process of another server/CLI, nobody, or a run.json that cannot be read. */
function owner(runDir: string, bootMs: number): "live" | "dead" | "missing" | "unreadable" {
  const file = join(runDir, "run.json");
  const r = safeRead(file, 4_000_000);
  if ("missing" in r) return "missing";
  if (!("text" in r)) return "unreadable";
  try {
    const run = JSON.parse(r.text) as { status?: unknown; pid?: unknown };
    if (run.status === "running" && pidAlive(run.pid) && run.pid !== process.pid && lstatSync(file).mtimeMs >= bootMs - 60_000) return "live";
    return "dead";
  } catch {
    return "unreadable";
  }
}

/**
 * Removes markers and locks of runs that are neither active here nor live in another process (a crash leaves them behind).
 * At start an unreadable run.json counts as gone; while the server runs it is kept. Never throws.
 */
export function sweepStaleRunning(runsDir: string, isActive: (runId: string) => boolean, o: { atStart?: boolean; bootMs?: number } = {}): StaleSweep {
  const out: StaleSweep = { markers: [], locks: [] };
  const bootMs = o.bootMs ?? Date.now() - uptime() * 1000;
  for (const r of allLockRoots()) sweepStaleIn(r.dir, runsDir, isActive, o, bootMs, out);
  return out;
}

function sweepStaleIn(root: string, runsDir: string, isActive: (runId: string) => boolean, o: { atStart?: boolean }, bootMs: number, out: StaleSweep): void {
  const gone = (state: ReturnType<typeof owner>, withMissing: boolean): boolean =>
    state === "dead" || (withMissing && state === "missing") || (state === "unreadable" && o.atStart === true);
  try {
    for (const f of readdirSync(join(root, ".running"))) {
      if (f.startsWith(".")) continue;
      try {
        if (isActive(f) || !gone(owner(runFolder(runsDir, f), bootMs), true)) continue;
        rmSync(join(root, ".running", f), { force: true });
        out.markers.push(f);
      } catch {
        // skip
      }
    }
  } catch {
    // no marker folder yet
  }
  try {
    for (const repo of readdirSync(root, { withFileTypes: true })) {
      if (!repo.isDirectory() || repo.name.startsWith(".")) continue;
      for (const f of readdirSync(join(root, repo.name))) {
        if (!f.endsWith(".json")) continue;
        const path = join(root, repo.name, f);
        try {
          const r = safeRead(path);
          if (!("text" in r)) continue;
          const lock = JSON.parse(r.text) as { marker?: boolean; runId?: unknown; areas?: unknown };
          if (typeof lock.runId !== "string" || !/^[\w.-]+$/.test(lock.runId) || /^\.+$/.test(lock.runId)) continue;
          if (isActive(lock.runId)) continue;
          if (lock.marker === true) {
            if (!("missing" in safeRead(join(root, ".running", markerName(lock.runId))))) continue;
          } else if (!gone(owner(runFolder(runsDir, lock.runId), bootMs), false)) continue;
          rmSync(path, { force: true });
          const areas = Array.isArray(lock.areas) ? lock.areas.filter((a): a is string => typeof a === "string").slice(0, 5) : [];
          out.locks.push({ runId: lock.runId, repo: repo.name, areas });
        } catch {
          // half-written or not ours
        }
      }
    }
  } catch {
    // no lock folder yet
  }
}
