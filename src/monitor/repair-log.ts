import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanLine } from "../errors.js";
import { FACTORY_HOME } from "../flow/load.js";
import { appendCapped } from "./guard.js";
import { isRepairClass, isRepairName, REPAIRS, type RepairClass, type RepairName } from "./repairs.js";

/**
 * One line for every automatic repair (what, where, the result), in monitor-repairs.jsonl. The daily digest lists them.
 * Writing never throws: a repair never fails because of its log line.
 */

export type RepairResult = "done" | "failed";

export interface RepairInput {
  repair: RepairName;
  what: string;
  where: string;
  result: RepairResult;
  /** Names one occurrence of the repair. Only a hash of it is stored. */
  key: string;
}

export interface RepairEntry extends RepairInput {
  at: string;
  class: RepairClass;
}

export interface RepairOptions {
  now?: Date;
  file?: string;
  maxBytes?: number;
  /** Called with a short text when the line could not be written (never throws). */
  onError?: (msg: string) => void;
}

/** Each of the two files stays within this many bytes. */
export const MAX_REPAIR_BYTES = 256 * 1024;
const MAX_REMEMBERED = 500;

export const repairFile = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "monitor-repairs.jsonl");
export const olderRepairFile = (file = repairFile()): string => join(dirname(file), "monitor-repairs.1.jsonl");

/** A cache of what this process wrote, so a repeat check skips the file read. The files stay the record: see alreadyWritten. */
const written = new Set<string>();
export const resetRepairMemory = (): void => written.clear();

/**
 * Is an entry with this key and result already in either file? Read on every call, so a restart, a full cache or a check
 * that repeats (while a budget holds the story) does not give a second line. Once the older file rotates the entry away,
 * the same occurrence can be written again; the cap bounds how far back this goes.
 */
function alreadyWritten(file: string, key: string, result: RepairResult): boolean {
  for (const f of [olderRepairFile(file), file]) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // a missing or unreadable file has no entries
    }
    for (const line of text.split("\n")) {
      if (!line.includes(`"key":"${key}"`)) continue;
      try {
        const e = JSON.parse(line) as RepairEntry;
        if (e.key === key && e.result === result) return true;
      } catch {
        // a broken line is not an entry
      }
    }
  }
  return false;
}

/** Writes one line. False when nothing was written (unknown name, repeated report, or the file cannot be written). Never throws. */
export function recordRepair(r: RepairInput, o: RepairOptions = {}): boolean {
  try {
    if (!isRepairName(r.repair) || (r.result !== "done" && r.result !== "failed")) return false;
    const file = o.file ?? repairFile();
    const key = createHash("sha256").update(r.key).digest("hex").slice(0, 16);
    const seen = `${file}|${key}|${r.result}`;
    if (written.has(seen) || alreadyWritten(file, key, r.result)) {
      written.add(seen);
      return false;
    }
    const entry: RepairEntry = {
      at: (o.now ?? new Date()).toISOString(),
      repair: r.repair,
      class: REPAIRS.find((x) => x.name === r.repair)!.repair,
      what: cleanLine(r.what).slice(0, 200),
      where: cleanLine(r.where).slice(0, 100),
      result: r.result,
      key,
    };
    const ok = appendCapped(file, JSON.stringify(entry) + "\n", {
      older: olderRepairFile(file), lock: join(dirname(file), "monitor-repairs.lock"),
      maxBytes: o.maxBytes ?? MAX_REPAIR_BYTES, label: "the repair log", onError: o.onError,
    });
    if (!ok) return false;
    written.add(seen);
    if (written.size > MAX_REMEMBERED) written.delete(written.values().next().value!);
    return true;
  } catch {
    try {
      o.onError?.("the repair log could not be written (error)");
    } catch {
      // the repair goes on
    }
    return false;
  }
}

function parseEntry(line: string): RepairEntry | undefined {
  try {
    const e = JSON.parse(line) as RepairEntry;
    const ok = typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) && isRepairName(e.repair) && isRepairClass(e.class)
      && typeof e.what === "string" && typeof e.where === "string" && (e.result === "done" || e.result === "failed") && typeof e.key === "string";
    return ok ? e : undefined;
  } catch {
    return undefined;
  }
}

/** The entries since `from` (milliseconds), oldest first. Broken lines are skipped; a file that cannot be read gives nothing. */
export function repairsSince(from: number, o: Pick<RepairOptions, "file"> = {}): RepairEntry[] {
  const file = o.file ?? repairFile();
  const out: RepairEntry[] = [];
  for (const f of [olderRepairFile(file), file]) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const e = parseEntry(line);
      if (e && Date.parse(e.at) >= from) out.push(e);
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export const repairLine = (e: RepairEntry): string => `${e.what} (${e.where}): ${e.result}`;

/** The digest's lines: what the Foundry fixed alone, newest first, all of them. */
export const digestRepairLines = (entries: RepairEntry[]): string[] => entries.filter((e) => e.class === "auto").reverse().map(repairLine);

// ── the entry of each repair ──

const HERE = "this server";

export function retryRepair(r: { runId: string; repo: string; issue: string; step: string; attempt: number; of: number; at: string }, started: boolean): RepairInput {
  return {
    repair: "retry-after-time-limit",
    what: started ? `retry ${r.attempt} of ${r.of} after a time limit in ${r.step} (issue #${r.issue})` : `no retry left after a time limit in ${r.step} (issue #${r.issue})`,
    where: r.repo,
    result: started ? "done" : "failed",
    key: `retry|${r.runId}|${r.attempt}|${r.at}`,
  };
}

export const bugStoryMade = (r: { detector: string; repo: string; issue: number }): RepairInput => ({
  repair: "bug-story", what: `bug story #${r.issue} made for ${r.detector}`, where: r.repo, result: "done", key: `bug-story|${r.repo}|${r.issue}`,
});

export const bugStoryFixFailed = (r: { detector: string; fingerprint: string; repo?: string; issue: number; count: number; at?: string }): RepairInput => ({
  repair: "bug-story",
  what: `the fix of bug story #${r.issue} for ${r.detector} failed (${r.count} ${r.count === 1 ? "time" : "times"})`,
  where: r.repo ?? HERE,
  result: "failed",
  key: `fix-failed|${r.repo ?? ""}|${r.issue}|${r.fingerprint}|${r.count}|${r.at ?? ""}`,
});

interface Demotion { kind: string; id: string; name: string; detector: string; fingerprint: string; at: string }
const component = (r: Demotion) => `${r.kind === "flows" ? "flow" : "repository"} ${r.name}`;
const demotionKey = (r: Demotion) => `autonomy|${r.kind}|${r.id}|${r.fingerprint}|${r.at}`;

export const autonomyLowered = (r: Demotion & { from: string; to: string }): RepairInput => ({
  repair: "lower-autonomy", what: `autonomy of the ${component(r)} lowered from ${r.from} to ${r.to} (finding: ${r.detector})`, where: r.name, result: "done", key: demotionKey(r),
});

export const autonomyRefused = (r: Demotion): RepairInput => ({
  repair: "lower-autonomy", what: `autonomy of the ${component(r)} could not be lowered (finding: ${r.detector})`, where: r.name, result: "failed", key: demotionKey(r),
});

interface ServiceStart { name: string; restarts: number; at: string }
const serviceKey = (r: ServiceStart) => `service|${r.name}|${r.restarts}|${r.at}`;

export const serviceStarted = (r: ServiceStart): RepairInput => ({
  repair: "start-service", what: `managed service ${r.name} started again after it stopped`, where: HERE, result: "done", key: serviceKey(r),
});

export const serviceNotStarted = (r: ServiceStart): RepairInput => ({
  repair: "start-service", what: `managed service ${r.name} could not be started again`, where: HERE, result: "failed", key: serviceKey(r),
});

export function safeRestartRepair(restart: { why: "new_version" | "data_folder" | "settings"; since: string } | undefined, at: string): RepairInput {
  const why = { new_version: " for a new version", data_folder: " for a moved data folder", settings: " for a changed setting" };
  return {
    repair: "safe-restart", what: `server restarted${restart ? why[restart.why] : ""} once no run was active`, where: HERE, result: "done",
    key: `restart|${restart?.why ?? ""}|${restart?.since ?? at}`,
  };
}

export const labelCorrected = (r: { repo: string; issue: number; label: string | undefined; runId: string; at: string }, result: RepairResult): RepairInput => ({
  repair: "correct-labels",
  what: `label of #${r.issue} ${result === "done" ? "set" : "could not be set"} to ${r.label ?? "no status label"} to match its newest run`,
  where: r.repo,
  result,
  key: `label|${r.repo}|${r.issue}|${r.runId}|${r.label ?? ""}|${r.at}`,
});

/** `dependency` is "#12" or "owner/name#12". One story and dependency is one occurrence. */
export const dependencyCountedDone = (r: { repo: string; issue: number; dependency: string }): RepairInput => ({
  repair: "completed-dependency", what: `dependency ${r.dependency} of #${r.issue} is closed and counted as done`, where: r.repo, result: "done",
  key: `dependency|${r.repo}|${r.issue}|${r.dependency.toLowerCase()}`,
});

/**
 * The entry for a finished step of a hotfix run, or undefined when the step merged nothing and failed nothing:
 * `push_main` that pushed is done; a failed `push_main`, `merge_main` or `red_main` is a merge that could not land.
 */
export function hotfixMergeRepair(r: { hotfix: string | undefined; stepId: string; ok: boolean; output: string; runId: string; visit: number; at: string; vars: Record<string, string> }): RepairInput | undefined {
  if (r.hotfix !== "on") return undefined;
  const pushed = r.stepId === "push_main" && /^PUSHED:/m.test(r.output);
  if (!pushed && !(!r.ok && ["push_main", "merge_main", "red_main"].includes(r.stepId))) return undefined;
  const main = r.vars.main_branch || "main";
  const issue = r.vars.issue ? ` of #${r.vars.issue}` : "";
  return {
    repair: "hotfix-merge",
    what: pushed ? `hotfix${issue} merged into ${main}` : `hotfix${issue} could not be merged into ${main} (step ${r.stepId})`,
    where: r.vars.github_repo || HERE,
    result: pushed ? "done" : "failed",
    key: `hotfix|${r.runId}|${r.stepId}|${r.visit}|${r.at}`,
  };
}
