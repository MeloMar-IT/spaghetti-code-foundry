import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";
import type { Forecast } from "./forecast.js";

// One forecast per epic per UTC day, kept per repository. History starts on the day of the first save and is never
// back-filled. A save reads, merges and writes under a lock file, so two processes cannot lose each other's entries.

export const MAX_FORECAST_DAYS = 732; // per epic; the oldest are dropped
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export interface StoredForecast {
  day: string; at: string; kind: "range" | "too-early"; left?: number;
  earliest?: string; expected?: string; latest?: string; reason?: "little-history" | "no-stories";
}
export interface RepoForecasts { version: 1; repo: string; epics: Record<string, StoredForecast[]> } // days ascending

export const epicForecastsDir = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "epic-forecasts");
const fileOf = (repo: string) => join(epicForecastsDir(), `${encodeURIComponent(repo)}.json`);

const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const optTime = (v: unknown) => v === undefined || isTime(v);

function parse(text: string, repo: string): RepoForecasts | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown> | null;
    if (!j || typeof j !== "object" || j.version !== 1 || j.repo !== repo) return undefined;
    const epics = j.epics as Record<string, unknown> | null | undefined;
    if (!epics || typeof epics !== "object" || Array.isArray(epics)) return undefined;
    for (const [k, list] of Object.entries(epics)) {
      if (!/^(#[1-9]\d{0,9}|label:.{1,200})$/.test(k) || !Array.isArray(list)) return undefined;
      const days = new Set<string>();
      for (const e of list as Partial<StoredForecast>[]) {
        if (!e || typeof e !== "object" || typeof e.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.day) || days.has(e.day)) return undefined;
        days.add(e.day);
        if (!isTime(e.at) || (e.kind !== "range" && e.kind !== "too-early")) return undefined;
        if (!optTime(e.earliest) || !optTime(e.expected) || !optTime(e.latest)) return undefined;
        if (e.left !== undefined && (typeof e.left !== "number" || !Number.isFinite(e.left))) return undefined;
        if (e.reason !== undefined && e.reason !== "little-history" && e.reason !== "no-stories") return undefined;
      }
    }
    return j as unknown as RepoForecasts;
  } catch {
    return undefined;
  }
}

/** What is stored for a repository; undefined when there is no (valid) file. */
export function readForecasts(repo: string): RepoForecasts | undefined {
  try {
    return parse(readFileSync(fileOf(repo), "utf8"), repo);
  } catch {
    return undefined;
  }
}

/** The stored forecasts of one epic, days ascending. */
export function forecastHistory(repo: string, epicKey: string): StoredForecast[] {
  const list = readForecasts(repo)?.epics[epicKey];
  return list ? [...list] : [];
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` while holding the repository's lock file. A lock older than LOCK_STALE_MS is taken over. */
function withLock<T>(file: string, waitMs: number, fn: () => T): T {
  const lock = `${file}.lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch { /* released meanwhile */ }
      if (Date.now() >= until) throw new Error("The epic forecasts are being saved by another process; try again", { cause: e });
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Written to a temporary file and renamed, so a reader never sees half a file and a failure keeps the old file. */
function write(file: string, value: RepoForecasts) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function toStored(f: Forecast, day: string, at: string): StoredForecast | undefined {
  if (f.kind === "finished") return undefined;
  if (f.kind === "too-early") return { day, at, kind: "too-early", reason: f.reason };
  return { day, at, kind: "range", left: f.left, earliest: f.earliest, expected: f.expected, latest: f.latest };
}

/**
 * Saves today's (UTC) forecast of each epic in the map. Finished ones are skipped; other days and other epics are
 * kept; the same day is overwritten. `lockWaitMs` is how long to wait for another process.
 */
export function saveForecasts(repo: string, forecasts: ReadonlyMap<string, Forecast>, now = new Date(), lockWaitMs = LOCK_WAIT_MS): void {
  const at = now.toISOString(), day = at.slice(0, 10);
  const file = fileOf(repo);
  const entries = [...forecasts].flatMap(([key, f]) => {
    const s = toStored(f, day, at);
    return s ? [[key, s] as const] : [];
  });
  if (!entries.length) return;
  mkdirSync(epicForecastsDir(), { recursive: true });
  withLock(file, lockWaitMs, () => {
    const value: RepoForecasts = readForecasts(repo) ?? { version: 1, repo, epics: {} };
    for (const [key, s] of entries) {
      const list = (value.epics[key] ?? []).filter((e) => e.day !== day);
      list.push(s);
      list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      value.epics[key] = list.slice(-MAX_FORECAST_DAYS);
    }
    write(file, value);
  });
}

/** Removes the file of the repository. */
export function dropForecasts(repo: string): void {
  rmSync(fileOf(repo), { force: true });
}
