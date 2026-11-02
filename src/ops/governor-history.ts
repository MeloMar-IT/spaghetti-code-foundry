import { join } from "node:path";
import { CAP_ENDED, HOLD_MS, stateCap } from "./governor.js";
import { readBack } from "./read-back.js";

/** What the time before the first step down of a window is put down to. */
export const EARLIER = "a cap set before the last 24 hours";

const FITS = "the runs that fit next to other programs";

export interface CapStep { at: number; runs: number; why?: string }

export interface CapHistory {
  /** The runs at once at the start of the window. */
  start: number;
  /** Where the value changes, in time order. */
  steps: CapStep[];
  /** How long the runs at once were below the configured number. */
  belowMs: number;
  /** The lowest value that held for any time. */
  lowest?: number;
  /** The time below the configured number by reason, longest first. */
  reasons: { why: string; ms: number }[];
}

/** The lines of changes.log whose time is `since` or later, in file order. Reads from the end and stops at the first older line. [] when the file cannot be read. */
export function logSince(dir: string, since: number, chunkSize?: number): string[] {
  const out: string[] = [];
  try {
    readBack(join(dir, "changes.log"), (line) => {
      const at = Date.parse(line.slice(0, 24));
      if (!Number.isFinite(at)) return true;
      if (at < since) return false;
      out.push(line);
      return true;
    }, chunkSize);
  } catch {
    return [];
  }
  return out.reverse();
}

const MOVE = /runs at once (\d+) → (\d+) \((.*?)\)(?=;| — |$)/;
const ENDED = new RegExp(`${CAP_ENDED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from (\\d+)(?: \\((.*?)\\))?(?=;| — |$)`);

/** A group of reasons for the card and the digest. */
export function reasonOf(why: string): string {
  if (/memory pressure/i.test(why)) return "memory pressure";
  if (/\d+ runs? fits?\b|\bfit\b/i.test(why)) return FITS;
  if (/throttled/i.test(why)) return "throttled";
  if (/swapping|swap grew/i.test(why)) return "swapping";
  if (/^load\b|\bload \d/i.test(why)) return "high load";
  return why.trim().slice(0, 80) || "no reason given";
}

/** "less than a minute", "5 min", "2 h 10 min". */
export function durationText(ms: number): string {
  if (!(ms >= 60_000)) return "less than a minute";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
}

interface Move { at: number; from: number; to: number; why: string; ended: boolean }

function moves(lines: string[], since: number, now: number, configured: number): Move[] {
  const clamp = (n: number) => Math.max(0, Math.min(configured, n));
  const list: Move[] = [];
  for (const line of lines) {
    const at = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(at) || at < since || at > now) continue; // no readable time, or not in the window
    const end = ENDED.exec(line);
    if (end) {
      list.push({ at, from: clamp(Number(end[1])), to: configured, why: end[2] ?? "", ended: true });
      continue;
    }
    const m = MOVE.exec(line);
    if (m) list.push({ at, from: clamp(Number(m[1])), to: clamp(Number(m[2])), why: m[3]!, ended: false });
  }
  return list.sort((a, b) => a.at - b.at); // stable: lines of one time keep their order
}

/**
 * The runs at once over the window `since … now`, from the lines of changes.log. Each line names the value just before
 * it, so the value at the start comes from the first line in the window and no older line is needed. `held` is the
 * cap that holds after the last line: it holds until `until`, then the configured number is back. The time below the
 * configured number is put down to the reason of the latest step down (EARLIER for a cap that was set before the first
 * line). A line without a readable time, or later than `now`, is skipped; values are kept between 0 and `configured`.
 */
export function capHistory(lines: string[], o: { since: number; now: number; configured: number; held?: { runs: number; until: number; why?: string } }): CapHistory {
  const { since, now, configured } = o;
  const list = moves(lines, since, now, configured);
  const held = o.held && o.held.runs < configured ? { runs: Math.max(0, o.held.runs), until: o.held.until, ...(o.held.why ? { why: o.held.why } : {}) } : undefined;
  const steps: CapStep[] = [];
  const by = new Map<string, number>();
  let below = 0;
  let lowest: number | undefined;
  let value = list.length ? list[0]!.from : held && held.until > since ? held.runs : configured;
  const start = value;
  // no step down in the window: the cap was set before it, and the state keeps the reason of its last step down
  const stepDown = list.some((m) => m.to < m.from);
  let why = !stepDown && held?.why ? reasonOf(held.why) : EARLIER;
  let t = since;
  const hold = (until: number) => {
    const ms = Math.max(0, until - t);
    if (value < configured && ms > 0) {
      below += ms;
      by.set(why, (by.get(why) ?? 0) + ms);
      lowest = lowest === undefined ? value : Math.min(lowest, value);
    }
    t = Math.max(t, until);
  };
  for (const m of list) {
    hold(m.at);
    if (m.from !== value) steps.push({ at: m.at, runs: m.from }); // a change nobody logged
    value = m.from;
    if (m.to < value) why = reasonOf(m.why);
    steps.push({ at: m.at, runs: m.to, ...(m.why ? { why: m.why } : {}) });
    value = m.to;
    if (value >= configured) why = EARLIER;
  }
  if (value < configured) {
    // without a cap that is known to hold, the value is not counted past the last line
    const until = held ? Math.min(now, Math.max(held.until, t)) : t;
    hold(until);
    if (until < now) {
      steps.push({ at: until, runs: configured });
      value = configured;
    }
  }
  return { start, steps, belowMs: below, ...(lowest !== undefined ? { lowest } : {}), reasons: [...by].map(([w, ms]) => ({ why: w, ms })).sort((a, b) => b.ms - a.ms) };
}

/** The cap in state.json and how long it holds: until `now` while the state is fresh, else until the hold time after the last check. */
export function heldCap(dir: string, now: Date): { runs: number; until: number; why?: string } | undefined {
  const c = stateCap(dir);
  if (!c) return undefined;
  return { runs: c.runs, until: now.getTime() - c.at <= HOLD_MS ? now.getTime() : c.at + HOLD_MS, ...(c.why ? { why: c.why } : {}) };
}

/** The digest line; undefined when the runs at once were never below the configured number. */
export function belowLine(h: CapHistory, configured: number): string | undefined {
  if (!(h.belowMs > 0)) return undefined;
  const why = h.reasons.slice(0, 2).map((r) => `${r.why} ${durationText(r.ms)}`).join(", ");
  return `the runs at once were below ${configured} for ${durationText(h.belowMs)} in the last day (lowest ${h.lowest}): ${why}`;
}
