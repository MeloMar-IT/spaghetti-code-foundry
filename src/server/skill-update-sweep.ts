import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { redactText } from "../credentials/redact.js";
import { findingsFile, readFindings, saveFindings } from "../monitor/findings.js";
import { CATALOGUE_KEY, applySourceChecks, clearSourceChecks } from "../monitor/skill-source-findings.js";
import { CatalogueError, showPrefix } from "../skill-import/catalogue-git.js";
import { updateSource, type SkillUpdateOptions } from "../skill-import/update-cli.js";
import { catalogueSentence } from "../skill-import/update-common.js";
import { updateDue } from "../skill-import/update-due.js";
import type { UpdateCheckOutcome } from "../skills/update-schedule.js";

// The sweeper for scheduled skill source checks: runs the `scf skills update --due` logic in the server process, logs every
// output line and turns PROBLEM outcomes into monitor findings (detector `skill-source-check`).
//
// The git and gh calls of catalogue-git.ts are `spawnSync` (up to 120 s each). They block the event loop during a check. That
// is accepted because the check runs in-process, as asked. The sweeper never merges or approves: `updateSource` only opens or
// edits pull requests. A cleared or changed folder aborts a running check at the next tick. No folder path is put into a sentence, a summary or a log line: findings may reach bug stories.

export const SKILL_UPDATE_TICK_MS = 60_000;
export const SWEEP_LOG = "skill-sources: ";

const FOLDER_NOT_ABSOLUTE = "the skill source folder is not an absolute path; nothing was checked";
const FOLDER_MISSING = "the skill source folder does not exist or is not a folder; nothing was checked";
const FOLDER_AGENT = "the skill source folder is inside a .claude or .codex folder; use a clone of the catalogue repository elsewhere; nothing was checked";
const FOLDER_NOT_GIT = "the skill source folder is not in a git work tree; use a clone of the catalogue repository; nothing was checked";
const FAILED = "the check failed unexpectedly; nothing was proposed";
const ENDED_PROBLEM = "the check ended with PROBLEM; see the server log";
const NOT_SAVED = "the problems of the skill source checks could not be saved";
const BROKEN = "the findings file could not be read; it was left as it is";

export type SweepRun = (o: { folder: string; out: (line: string) => void; onChecked: (id: string, outcome: UpdateCheckOutcome) => void; signal: AbortSignal }) => Promise<number>;

export interface SkillUpdateSweeperDeps {
  config: () => { folder?: string; everyMs: number };
  log: (line: string) => void;
  findingsIdle: <T>(fn: () => T) => Promise<T>;
  run?: SweepRun;
  updateOptions?: Omit<SkillUpdateOptions, "cwd">;
  /** The findings file. Default: the monitor's. */
  file?: string;
  now?: () => Date;
  userHome?: string;
}

export interface SkillUpdateSweeper {
  tick(): Promise<void>;
  stop(): void;
  running(): boolean;
}

const hasAgentPart = (p: string): boolean => p.split(/[\\/]/).some((x) => /^\.(?:claude|codex)$/i.test(x));

/** `undefined` when the folder may be used, else a fixed sentence (without the path). */
export function checkUpdateFolder(folder: string, o: { userHome?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  if (!isAbsolute(folder)) return FOLDER_NOT_ABSOLUTE;
  if (hasAgentPart(folder)) return FOLDER_AGENT;
  let real: string;
  try {
    real = realpathSync(folder);
    if (!statSync(real).isDirectory()) return FOLDER_MISSING;
  } catch {
    return FOLDER_MISSING;
  }
  if (hasAgentPart(real)) return FOLDER_AGENT;
  const home = o.userHome ?? homedir();
  for (const b of [join(home, ".claude"), join(home, ".codex")]) {
    let rb: string;
    try {
      rb = realpathSync(b);
    } catch {
      rb = resolve(b);
    }
    if (real === rb || real.startsWith(rb + sep)) return FOLDER_AGENT;
  }
  try {
    showPrefix({ cwd: real, env: o.env ?? process.env });
  } catch (e) {
    if (e instanceof CatalogueError && (e.code === "no-git" || e.code === "timeout")) return catalogueSentence(e.code);
    return FOLDER_NOT_GIT;
  }
  return undefined;
}

export function skillUpdateSweeper(deps: SkillUpdateSweeperDeps): SkillUpdateSweeper {
  const file = deps.file ?? findingsFile();
  const now = deps.now ?? (() => new Date());
  const userHome = deps.userHome;
  const run: SweepRun =
    deps.run ?? (({ folder, out, onChecked, signal }) => updateDue({ all: false, onChecked }, out, { ...deps.updateOptions, cwd: folder }, signal, updateSource));
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let lastStart: number | undefined;
  /** The folder of the check in flight. */
  let runningFolder: string | undefined;
  /** The folder whose findings this process wrote last. */
  let findingsFolder: string | undefined;
  let offCleared = false;
  let brokenLogged = false;

  const log = (line: string) => {
    try {
      deps.log(SWEEP_LOG + line);
    } catch {
      // a failing log must not stop the sweeper
    }
  };

  /** Reads, changes and saves in one synchronous callback. Returns false when nothing was done because of a stop, a broken file or a failure. */
  async function persist(change: (stored: ReturnType<typeof readFindings>["findings"]) => { findings: ReturnType<typeof readFindings>["findings"]; changed: boolean }): Promise<boolean> {
    try {
      return await deps.findingsIdle(() => {
        if (stopped) return false;
        const r = readFindings(file);
        if (r.broken) {
          if (!brokenLogged) log(BROKEN);
          brokenLogged = true;
          return false;
        }
        brokenLogged = false;
        const c = change(r.findings);
        if (c.changed) saveFindings(c.findings, file);
        return true;
      });
    } catch {
      log(NOT_SAVED);
      return false;
    }
  }
  const write = (checked: Map<string, string[]>) => persist((stored) => applySourceChecks(stored, checked, now()));
  const clear = () => persist((stored) => clearSourceChecks(stored, now()));

  async function runOnce(folder: string): Promise<void> {
    const bad = checkUpdateFolder(folder, { userHome, env: deps.updateOptions?.env });
    if (bad) {
      log(`PROBLEM ${bad}`);
      await write(new Map([[CATALOGUE_KEY, [redactText(bad)]]]));
      return;
    }
    const mine = new AbortController();
    controller = mine;
    const lines: string[] = [];
    const outcomes = new Map<string, UpdateCheckOutcome>();
    const out = (line: string) => {
      lines.push(line);
      log(redactText(line));
    };
    try {
      await run({ folder, out, onChecked: (id, outcome) => void outcomes.set(id, outcome), signal: mine.signal });
    } catch {
      out(`PROBLEM ${FAILED}`);
    }
    if (mine.signal.aborted || stopped) return;
    const checked = new Map<string, string[]>();
    for (const [id, outcome] of outcomes) {
      const prefix = `${id}: PROBLEM `;
      const own = lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
      checked.set(id, own.length === 0 && outcome === "PROBLEM" ? [ENDED_PROBLEM] : own);
    }
    const bare = lines.filter((l) => l.startsWith("PROBLEM ")).map((l) => l.slice("PROBLEM ".length));
    if (bare.length > 0) checked.set(CATALOGUE_KEY, bare);
    else if (lines.some((l) => l.startsWith("CHECKED "))) checked.set(CATALOGUE_KEY, []);
    for (const [k, v] of checked) checked.set(k, v.map(redactText));
    await write(checked);
  }

  async function guardedRun(folder: string): Promise<void> {
    runningFolder = folder;
    try {
      await runOnce(folder);
    } finally {
      runningFolder = undefined;
      controller = undefined;
    }
  }

  async function body(): Promise<void> {
    let cfg: ReturnType<SkillUpdateSweeperDeps["config"]>;
    try {
      cfg = deps.config();
    } catch {
      return;
    }
    const folder = cfg.folder || undefined;
    if (folder === undefined) {
      if (!offCleared && (await clear())) {
        offCleared = true;
        findingsFolder = undefined;
        lastStart = undefined;
      }
      return;
    }
    offCleared = false;
    if (findingsFolder !== undefined && findingsFolder !== folder) {
      if (!(await clear())) return;
      findingsFolder = undefined;
      lastStart = undefined;
    }
    if (stopped) return;
    const t = now().getTime();
    if (lastStart !== undefined && t - lastStart < cfg.everyMs) return;
    lastStart = t;
    findingsFolder = folder;
    await guardedRun(folder);
  }

  return {
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (inFlight) {
        // a cleared or changed folder stops the check in flight before its next git or gh step; the next free tick clears and goes on
        let folder: string | undefined;
        try {
          folder = deps.config().folder || undefined;
        } catch {
          return Promise.resolve();
        }
        if (runningFolder !== undefined && folder !== runningFolder) controller?.abort();
        return Promise.resolve();
      }
      const p: Promise<void> = body()
        .catch(() => {})
        .finally(() => {
          if (inFlight === p) inFlight = undefined;
        });
      inFlight = p;
      return p;
    },
    stop(): void {
      stopped = true;
      controller?.abort();
    },
    running(): boolean {
      return inFlight !== undefined;
    },
  };
}
