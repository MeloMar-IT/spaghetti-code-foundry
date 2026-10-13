import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanRuns, type CleanResult } from "../clean.js";

/** Memory of two processes that grew unnoticed before: the system's file-change tracker and the Foundry's own server. */
export interface Memory { fseventsdGb: number; serverGb: number }

/** Above these a line goes into the digest and a notification is sent (once a day each). */
export const FSEVENTSD_WARN_GB = 8;
export const SERVER_WARN_GB = 6;
/** Workspaces of runs that ended this many days ago are removed by the nightly clean-up. */
export const CLEAN_OLDER_THAN_DAYS = 2;
/** The clean-up runs at the first check at or after this hour (local time), once a day. */
export const CLEAN_FROM_HOUR = 3;

export interface HousekeepingState { lastCleanDay?: string; warnedDay?: Record<string, string> }
export interface Housekeeping {
  at: string;
  memory: Memory;
  warnings: string[];
  /** Set when this check did the nightly clean-up. */
  cleaned?: { workspaces: number; freedMb: number };
}

/** `ps -Ao rss=,command=` output → gigabytes of the two processes. The server is every process running `… serve` of this Foundry's CLI. */
export function memoryFrom(ps: string): Memory {
  let fseventsd = 0;
  let server = 0;
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const kb = Number(m[1]);
    const cmd = m[2]!;
    if (/(^|\/)fseventsd(\s|$)/.test(cmd)) fseventsd += kb;
    else if (/(cli|factory)\.js\s+(serve|ui)(\s|$)/.test(cmd)) server += kb;
  }
  const gb = (kb: number) => Math.round((kb / 1_048_576) * 10) / 10;
  return { fseventsdGb: gb(fseventsd), serverGb: gb(server) };
}

export const readPs = (): string => {
  try {
    return execFileSync("/bin/ps", ["-Ao", "rss=,command="], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return "";
  }
};

export function warningsOf(m: Memory): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  if (m.fseventsdGb >= FSEVENTSD_WARN_GB)
    out.push({ key: "fseventsd", text: `The system's file-change tracker (fseventsd) uses ${m.fseventsdGb} GB. It only shrinks with a restart of the machine; restart at a quiet moment.` });
  if (m.serverGb >= SERVER_WARN_GB)
    out.push({ key: "server", text: `The Foundry server uses ${m.serverGb} GB. Restart it at a quiet moment; if it grows back, that is a leak worth a bug story.` });
  return out;
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * One check, meant for every 3 hours: write the two memory figures to a log, warn when one is high, and once a
 * night remove the workspaces of runs that ended days ago (the files that feed the file-change tracker).
 * Nothing here can stop a run: the clean-up skips runs that are active, paused or newer than the limit.
 */
export function runHousekeeping(o: { dir: string; runsDir: string; now: Date; ps: string; clean?: typeof cleanRuns; isActive?: (runId: string) => boolean }): { result: Housekeeping; notify: string[] } {
  mkdirSync(o.dir, { recursive: true });
  const stateFile = join(o.dir, "state.json");
  let state: HousekeepingState = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as HousekeepingState;
  } catch {
    // first check
  }
  const memory = memoryFrom(o.ps);
  const today = localDay(o.now);
  const warned = { ...(state.warnedDay ?? {}) };
  const warnings = warningsOf(memory);
  const notify = warnings.filter((w) => warned[w.key] !== today).map((w) => w.text);
  for (const w of warnings) warned[w.key] = today;

  let cleaned: Housekeeping["cleaned"];
  let lastCleanDay = state.lastCleanDay;
  if (o.now.getHours() >= CLEAN_FROM_HOUR && lastCleanDay !== today) {
    let r: CleanResult | undefined;
    try {
      r = (o.clean ?? cleanRuns)({ runsDir: o.runsDir, olderThanDays: CLEAN_OLDER_THAN_DAYS, ...(o.isActive ? { isActive: o.isActive } : {}) });
    } catch {
      // tried again at the next check
    }
    if (r) {
      cleaned = { workspaces: r.workspaces.length, freedMb: Math.round(r.freedMb) };
      lastCleanDay = today;
    }
  }

  const result: Housekeeping = { at: o.now.toISOString(), memory, warnings: warnings.map((w) => w.text), ...(cleaned ? { cleaned } : {}) };
  appendFileSync(join(o.dir, "memory.log"), `${result.at} fseventsd=${memory.fseventsdGb}GB server=${memory.serverGb}GB${cleaned ? ` cleaned=${cleaned.workspaces} workspaces, ${cleaned.freedMb} MB` : ""}\n`);
  writeFileSync(stateFile, JSON.stringify({ ...(lastCleanDay ? { lastCleanDay } : {}), warnedDay: warned }));
  writeFileSync(join(o.dir, "latest.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(o.dir, "report.md"), housekeepingReport(result));
  return { result, notify };
}

export function housekeepingReport(r: Housekeeping): string {
  return [
    "# Housekeeping", "",
    `${r.at.slice(0, 16).replace("T", " ")} UTC`, "",
    `- File-change tracker (fseventsd): ${r.memory.fseventsdGb} GB (a line is written above ${FSEVENTSD_WARN_GB} GB).`,
    `- Foundry server: ${r.memory.serverGb} GB (a line is written above ${SERVER_WARN_GB} GB).`,
    ...(r.cleaned ? [`- Nightly clean-up: ${r.cleaned.workspaces} workspace${r.cleaned.workspaces === 1 ? "" : "s"} of runs that ended more than ${CLEAN_OLDER_THAN_DAYS} days ago removed, ${r.cleaned.freedMb} MB freed.`] : []),
    ...(r.warnings.length ? ["", "**Needs you:**", ...r.warnings.map((w) => `- ${w}`)] : ["", "Nothing needs you."]),
    "",
  ].join("\n");
}
