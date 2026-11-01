import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The time a step spends waiting for a test slot (tools/test-slot) does not count against its time limit.
// test-slot writes one file per wait into a folder of the step (FACTORY_TEST_SLOT_WAIT_DIR): `<startMs>-<pid>.wait`
// while it waits (touched at least every 5 s), renamed to `.done` when the wait ends. The engine reads only names and mtimes.
// This module imports nothing from engine/ (short-env.ts reaches it).

/** The folder of a run that holds one folder of waits per step visit. */
export const SLOT_WAITS_DIR = "slot-waits";
/** A `.wait` file not touched for this long belongs to a process that is gone: it counts up to its last touch. */
export const WAIT_STALE_MS = 15_000;
/** Newest wait files read per step. */
const MAX_FILES = 1000;
/** While a wait is open the time left does not shrink, so the next look is at least this far away. */
const OPEN_FLOOR_MS = 1000;

const NAME = /^(\d+)-\d+\.(wait|done)$/;

export interface SlotWaitWatch {
  dir: string;
  /** The most time that can be left out of the limit. */
  maxExtraMs: number;
}

export interface SlotWait {
  from: number;
  to: number;
  /** Still waiting as far as can be told (a fresh `.wait` file). */
  open: boolean;
}

/** `nextCheckMs` 0 = the time is up. */
export interface SlotClock {
  nextCheckMs: number;
  waitedMs: number;
  countedMs: number;
}

/** The longest time that is left out of a step's limit: FACTORY_TEST_SLOT_WAIT_SEC (digits only), default 5400 s. */
export function slotWaitLimitMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.FACTORY_TEST_SLOT_WAIT_SEC;
  return (/^\d+$/.test(v ?? "") ? Number(v) : 5400) * 1000;
}

/**
 * The waits recorded in `dir`: plain files named `<startMs>-<pid>.wait|done`, the newest 1000. Never throws.
 * A `.wait` file that is renamed to `.done` between the listing and the look at it is found under its new name,
 * so the interval is never lost. `afterList` is called between the two (for tests).
 */
export function readSlotWaits(dir: string, now: number, afterList?: () => void): SlotWait[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  afterList?.();
  const ids = new Map<string, { start: number; listed: Set<string> }>();
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m) continue;
    const id = n.slice(0, n.lastIndexOf("."));
    const hit = ids.get(id) ?? { start: Number(m[1]), listed: new Set<string>() };
    hit.listed.add(m[2]!);
    ids.set(id, hit);
  }
  const newest = [...ids.entries()].sort((a, b) => b[1].start - a[1].start).slice(0, MAX_FILES);
  const out: SlotWait[] = [];
  for (const [id, { start, listed }] of newest) {
    // done first: it is the final name; a listed `.wait` may have become `.done` by now
    const tries = listed.has("done") ? ["done"] : ["wait", "done"];
    for (const ext of tries) {
      let mtime: number;
      try {
        const st = lstatSync(join(dir, `${id}.${ext}`));
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      const open = ext === "wait" && now - mtime <= WAIT_STALE_MS;
      out.push({ from: start, to: open ? now : mtime, open });
      break;
    }
  }
  return out;
}

/**
 * Pure. How much of the waits counts and when the step must be looked at again.
 * The time left is `began + limit + counted − now`, counted being the union of the waits (clipped to the life of the
 * process and to now) up to `maxExtraMs`. The next look is never later than the hard end `began + limit + maxExtra`.
 */
export function slotClock(waits: SlotWait[], o: { began: number; limitMs: number; maxExtraMs: number; now: number }): SlotClock {
  const spans = waits
    .map((w) => [Math.max(w.from, o.began), Math.min(w.to, o.now)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let waitedMs = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    waitedMs += b - Math.max(a, end);
    end = b;
  }
  const countedMs = Math.max(0, Math.min(waitedMs, o.maxExtraMs));
  const left = o.began + o.limitMs + countedMs - o.now;
  const hardLeft = o.began + o.limitMs + o.maxExtraMs - o.now;
  if (left <= 0 || hardLeft <= 0) return { nextCheckMs: 0, waitedMs, countedMs };
  const next = waits.some((w) => w.open) ? Math.max(left, OPEN_FLOOR_MS) : left;
  return { nextCheckMs: Math.min(next, hardLeft), waitedMs, countedMs };
}

/** "40 s", "18 min". */
export function slotWaitText(ms: number): string {
  return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
}

/** The error of a step that ended on its time limit. Without a wait it is exactly `timed out`. */
export function timedOutError(w?: { waitedMs: number; countedMs: number; capped?: boolean }): string {
  if (!w || w.waitedMs <= 0) return "timed out";
  const tail = w.capped ? `more than the ${slotWaitText(w.countedMs)} that can be left out` : "which did not count";
  return `timed out (waited ${slotWaitText(w.waitedMs)} for a test slot, ${tail})`;
}

/** The text the step log and the run page show. */
export function waitedLine(ms: number): string {
  return `waited ${slotWaitText(ms)} for a test slot`;
}

/** The newest time any wait file under `<runDir>/slot-waits` was touched (ms), 0 when there is none. Never throws. */
export function newestSlotWait(runDir: string): number {
  let newest = 0;
  let seen = 0;
  const root = join(runDir, SLOT_WAITS_DIR);
  try {
    for (const d of readdirSync(root)) {
      let files: string[];
      try {
        files = readdirSync(join(root, d));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!NAME.test(f) || ++seen > 5000) continue;
        try {
          const st = lstatSync(join(root, d, f));
          if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
        } catch {
          // renamed or removed meanwhile
        }
      }
    }
  } catch {
    return 0;
  }
  return newest;
}
