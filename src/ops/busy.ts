import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";
import { capsPath, loadCaps, setCap, type Cap } from "./caps.js";

/** Busy mode ("I'm using this machine"): the cap set by hand (by the server) and the cap set while a listed program runs (by the governor). */
export const BUSY_CAP = "busy";
export const BUSY_APPS_CAP = "busy-apps";
/** How long a cap holds without a renewal. The same as the governor's HOLD_MS (a test checks it); not imported, so process.ts stays free of governor.ts. */
export const BUSY_HOLD_MS = 4 * 60_000;
export const BUSY_RENEW_MS = 60_000;
export const MAX_BUSY_HOURS = 24;
export const BUSY_WHY = "someone is using this machine";

/** The switch set by hand. No `until`: on until it is switched off. */
export interface BusySwitch { since: string; until?: string }

export const busyPath = (home = process.env.FACTORY_HOME ?? FACTORY_HOME) => join(home, "governor", "busy.json");

const isDate = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

function readSwitch(path: string): BusySwitch | undefined {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<BusySwitch> | null;
    if (!s || typeof s !== "object" || !isDate(s.since)) return undefined;
    if (s.until !== undefined && !isDate(s.until)) return undefined;
    return { since: s.since, ...(s.until !== undefined ? { until: s.until } : {}) };
  } catch {
    return undefined;
  }
}

/** The switch set by hand; undefined when off, unreadable, malformed or past its `until`. */
export function loadBusy(now = new Date(), path = busyPath()): BusySwitch | undefined {
  const s = readSwitch(path);
  if (!s) return undefined;
  if (s.until !== undefined && Date.parse(s.until) <= now.getTime()) return undefined;
  return s;
}

function writeSwitch(path: string, sw: BusySwitch) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(sw, null, 2));
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Renews or removes the "busy" cap from busy.json; a busy.json past its end is removed. Returns the switch in force. */
export function syncBusyCap(busyRuns: number, now: Date, path = busyPath(), capsFile = capsPath()): BusySwitch | undefined {
  const sw = loadBusy(now, path);
  if (!sw) {
    rmSync(path, { force: true });
    setCap(BUSY_CAP, undefined, capsFile);
    return undefined;
  }
  // every cap has an end: the server renews it, so a server that is gone cannot leave one behind
  const end = Math.min(now.getTime() + BUSY_HOLD_MS, sw.until ? Date.parse(sw.until) : Infinity);
  setCap(BUSY_CAP, { runs: busyRuns, until: new Date(end).toISOString(), why: BUSY_WHY }, capsFile);
  return sw;
}

/** Switch busy mode on (or off with undefined): writes or removes busy.json, then the cap. */
export function setBusy(sw: BusySwitch | undefined, busyRuns: number, now: Date, path = busyPath(), capsFile = capsPath()): void {
  if (sw) writeSwitch(path, sw);
  else rmSync(path, { force: true });
  syncBusyCap(busyRuns, now, path, capsFile);
}

/** Listed names that run, in list order, unique. Case-insensitive; `ps` cuts names at 15/16 characters, so a running name of 15 or more characters also matches a listed name it starts. */
export function busyAppsRunning(names: Iterable<string>, listed: readonly string[]): string[] {
  const running = [...names].map((n) => n.trim().toLowerCase()).filter(Boolean);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const l of listed) {
    const want = l.trim().toLowerCase();
    if (!want || seen.has(want)) continue;
    if (running.some((n) => n === want || (n.length >= 15 && want.startsWith(n)))) {
      seen.add(want);
      found.push(l.trim());
    }
  }
  return found;
}

/** Sets "busy-apps" while a listed program runs, removes it when none does. Returns "on" or "off" when that changed, else undefined. Never touches "busy". */
export function checkBusyApps(found: string[], busyRuns: number, now: Date, capsFile = capsPath()): "on" | "off" | undefined {
  const had = loadCaps(capsFile)[BUSY_APPS_CAP];
  const live = !!had && Date.parse(had.until) > now.getTime();
  if (!found.length) {
    setCap(BUSY_APPS_CAP, undefined, capsFile);
    return had ? "off" : undefined;
  }
  setCap(BUSY_APPS_CAP, { runs: busyRuns, until: new Date(now.getTime() + BUSY_HOLD_MS).toISOString(), why: `${found.join(", ")} running` }, capsFile);
  return live ? undefined : "on";
}

/**
 * The governor's program check: looks at the process names of one reading and sets or removes the "busy-apps" cap.
 * An empty list removes the cap; a reading that failed (no table, or names that could not be read) leaves it alone, and it ends by itself.
 * Returns a line for the log when busy mode changed.
 */
export function governorBusyApps(table: { names: Map<number, string>; namesRead?: boolean } | undefined, listed: readonly string[], busyRuns: number, now: Date, capsFile = capsPath()): string | undefined {
  let found: string[] = [];
  if (listed.length) {
    if (!table || table.namesRead === false) return undefined;
    found = busyAppsRunning(table.names.values(), listed);
  }
  const change = checkBusyApps(found, busyRuns, now, capsFile);
  if (change === "on") return `busy mode on: ${found.join(", ")} running`;
  return change === "off" ? "busy mode off" : undefined;
}

/** The live busy caps. */
export function busyCaps(now = new Date(), capsFile = capsPath()): { hand?: Cap; apps?: Cap } {
  const caps = loadCaps(capsFile);
  const live = (c: Cap | undefined) => (c && Date.parse(c.until) > now.getTime() ? c : undefined);
  const hand = live(caps[BUSY_CAP]);
  const apps = live(caps[BUSY_APPS_CAP]);
  return { ...(hand ? { hand } : {}), ...(apps ? { apps } : {}) };
}

/** True while either busy cap holds; false on any read problem (never throws). */
export function busyHolds(now = new Date(), capsFile = capsPath()): boolean {
  try {
    const c = busyCaps(now, capsFile);
    return !!(c.hand || c.apps);
  } catch {
    return false;
  }
}
