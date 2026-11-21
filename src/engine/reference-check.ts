import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { referenceFolderName } from "../config.js";
import { gitIn } from "../preview/checkout.js";
import { COMMIT, newestBatch, referencesDir, removeCopy, removeReferences } from "./reference-repos.js";
import { REFERENCE_DIR, type ReferenceRecord, type RunSummary } from "./state.js";

/**
 * The check before each agent step (#894): in an admin's run without the OS sandbox only file modes hold a reference copy,
 * so every usable copy of the newest preparation is checked against its commit. A changed copy is removed. Never throws.
 */

export const REF_CHANGED = "it was changed during the run";
const GIT_TIMEOUT_MS = 30_000;

export interface CheckDeps {
  head?: (dir: string, signal?: AbortSignal) => Promise<string | undefined>;
  clean?: (dir: string, signal?: AbortSignal) => Promise<boolean>;
  remove?: (dir: string) => boolean;
}

const modeOf = (mode: number): number => mode & 0o7777;

/** True only when every file is 0444 and every folder (`dir` included) is 0555, with no link or other entry. Never throws. */
export function lockedTree(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || modeOf(st.mode) !== 0o555) return false;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = lstatSync(p);
      if (s.isDirectory()) {
        if (!lockedTree(p)) return false;
      } else if (!s.isFile() || modeOf(s.mode) !== 0o444) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function defaultHead(dir: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await gitIn(dir, ["rev-parse", "HEAD"], { signal, timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function defaultClean(dir: string, signal?: AbortSignal): Promise<boolean> {
  // core.fileMode=false: locking made executable files 0444, which git would report as modified (lockedTree checks the modes)
  const r = await gitIn(dir, ["-c", "core.fileMode=false", "--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored"], { signal, timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 && r.stdout === "";
}

async function copyIsIntact(dir: string, r: ReferenceRecord, opts: { signal?: AbortSignal } & CheckDeps): Promise<boolean> {
  try {
    if (!lockedTree(dir)) return false;
    const head = await (opts.head ?? defaultHead)(dir, opts.signal);
    if (head !== r.commit) return false;
    return await (opts.clean ?? defaultClean)(dir, opts.signal);
  } catch {
    return false;
  }
}

/** True when the record is still a usable one (re-tested after each await, so parallel steps report a copy once). */
const usable = (r: ReferenceRecord): boolean => r.ok && typeof r.commit === "string" && COMMIT.test(r.commit) && typeof r.folder === "string";

function invalidate(r: ReferenceRecord, removed: boolean): void {
  r.ok = false;
  r.reason = REF_CHANGED;
  if (removed) delete r.folder;
}

/** Checks the copies of the newest preparation. Returns true when a record changed (the caller saves the run). Never throws. */
export async function checkReferences(summary: Pick<RunSummary, "runDir" | "references">, log: (line: string) => void, opts: { signal?: AbortSignal } & CheckDeps = {}): Promise<boolean> {
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // a log that fails must not stop the run
    }
  };
  let changed = false;
  try {
    const batch = newestBatch(summary).filter(usable);
    if (!batch.length) return false;
    const base = referencesDir(summary.runDir);
    let parentOk = false;
    try {
      const st = lstatSync(base);
      parentOk = st.isDirectory() && modeOf(st.mode) === 0o555;
    } catch {
      parentOk = false;
    }
    if (!parentOk) {
      // removeReferences unlocks and removes without following links: a link is removed itself, its target is not touched
      const gone = removeReferences(summary.runDir);
      for (const r of batch) {
        if (!usable(r)) continue;
        invalidate(r, gone);
        changed = true;
        say(gone ? `! reference ${r.repo}: removed — it was changed during the run` : `! reference ${r.repo}: unavailable — it was changed during the run and could not be removed`);
      }
      return changed;
    }
    const remove = opts.remove ?? removeCopy;
    for (const r of batch) {
      if (!usable(r)) continue;
      const folder = referenceFolderName(r.repo);
      if (r.folder !== `${REFERENCE_DIR}/${folder}`) continue;
      const dir = join(base, folder);
      let exists = true;
      try {
        lstatSync(dir);
      } catch {
        exists = false;
      }
      if (exists && (await copyIsIntact(dir, r, opts))) continue;
      if (!usable(r)) continue; // another step reported it while we waited
      let gone = !exists;
      if (exists) {
        try {
          chmodSync(base, 0o700);
          gone = remove(dir);
        } catch {
          gone = false;
        } finally {
          try {
            chmodSync(base, 0o555);
          } catch {
            // the end of the run removes it
          }
        }
      }
      invalidate(r, gone);
      changed = true;
      say(gone ? `! reference ${r.repo}: removed — it was changed during the run` : `! reference ${r.repo}: unavailable — it was changed during the run and could not be removed`);
    }
  } catch {
    // nothing here fails a run
  }
  return changed;
}
