import type { RunSummary } from "../engine/state.js";

export type Family = "claude" | "codex";
export const FAMILIES: Family[] = ["claude", "codex"];
const WEEK = 7 * 86_400_000;
const HOUR = 3_600_000;

/** What a person read in the tool itself: the share of the weekly limit used at a moment, and when the week resets. */
export interface Calibration { percent: number; at: string; resetAt: string }
export interface LimitsState { auto: boolean; calibrations: Partial<Record<Family, Calibration>> }
export const EMPTY_LIMITS: LimitsState = { auto: false, calibrations: {} };

/** Tokens (input + output) the agent steps of one tool used between two moments. */
export function tokensUsed(runs: RunSummary[], family: Family, from: number, to: number): number {
  let n = 0;
  for (const r of runs)
    for (const h of r.history ?? []) {
      if (!h.agent?.startsWith(family) || !h.tokens) continue;
      const at = Date.parse(h.startedAt);
      if (at >= from && at < to) n += h.tokens.input + h.tokens.output;
    }
  return n;
}

export interface Forecast {
  family: Family;
  /** Tokens per hour over the last 24 hours. */
  perHour: number;
  /** Steps stopped by a usage limit in the last 24 hours. */
  limitHits: number;
  /** Set only with a usable calibration. */
  percentNow?: number;
  resetAt?: string;
  /** When the limit is reached at the current pace; absent when that is after the reset. */
  emptyAt?: string;
  /** Runs at once that would make the limit last until the reset; absent when no slowing is needed. */
  runs?: number;
  note?: string;
}

/**
 * The weekly limit is not published, so it is worked out from one reading by a person: tokens used
 * since the reset ÷ the share they saw. That holds only while the mix of work stays about the same,
 * so it is an estimate. Below 5% a reading is too coarse to use.
 */
export function forecast(runs: RunSummary[], family: Family, cal: Calibration | undefined, now: Date, configured: number): Forecast {
  const t = now.getTime();
  const perHour = tokensUsed(runs, family, t - 24 * HOUR, t) / 24;
  const limitHits = runs.reduce((n, r) => n + (r.history ?? []).filter((h) => h.limited && h.agent?.startsWith(family) && Date.parse(h.startedAt) >= t - 24 * HOUR).length, 0);
  const base: Forecast = { family, perHour, limitHits };
  if (!cal) return { ...base, note: `no reading yet: scf limits set ${family} <percent used> <next reset>` };
  const calAt = Date.parse(cal.at);
  const calReset = Date.parse(cal.resetAt);
  const usedAtCal = tokensUsed(runs, family, calReset - WEEK, calAt);
  if (cal.percent < 5 || usedAtCal <= 0) return { ...base, note: "the reading is too early in the week to work out the limit; set it again above 5%" };
  const capacity = usedAtCal / (cal.percent / 100);
  let reset = calReset;
  while (reset <= t) reset += WEEK;
  const usedNow = tokensUsed(runs, family, reset - WEEK, t);
  const left = Math.max(0, capacity - usedNow);
  const out: Forecast = { ...base, percentNow: Math.round((100 * usedNow) / capacity), resetAt: new Date(reset).toISOString() };
  if (perHour <= 0) return out;
  const hoursLeft = left / perHour;
  const hoursToReset = (reset - t) / HOUR;
  if (hoursLeft >= hoursToReset) return out;
  const runsAtOnce = Math.max(1, Math.min(configured - 1, Math.floor((configured * hoursLeft) / hoursToReset)));
  return { ...out, emptyAt: new Date(t + hoursLeft * HOUR).toISOString(), ...(configured > 1 ? { runs: runsAtOnce } : {}) };
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

export function limitsReport(fs: Forecast[], auto: boolean): string {
  const out = ["# Usage limits", ""];
  for (const f of fs) {
    out.push(`## ${f.family === "claude" ? "Claude" : "Codex"}`, "");
    out.push(`- Pace: ${Math.round(f.perHour / 1000).toLocaleString("en-US")}k tokens per hour over the last 24 hours.`);
    if (f.limitHits) out.push(`- ${f.limitHits} step${f.limitHits === 1 ? " was" : "s were"} stopped by a usage limit in the last 24 hours.`);
    if (f.note) out.push(`- ${f.note}`);
    if (f.percentNow !== undefined) out.push(`- About ${f.percentNow}% of the week is used (estimate); the week resets ${when(f.resetAt!)}.`);
    if (f.emptyAt) out.push(`- At this pace the limit is reached ${when(f.emptyAt)}, before the reset.${f.runs ? ` ${f.runs} run${f.runs === 1 ? "" : "s"} at once would make it last.` : ""}`);
    else if (f.percentNow !== undefined) out.push("- At this pace the limit lasts until the reset.");
    out.push("");
  }
  out.push(auto ? "Slowing down is on: when a limit would be reached before its reset, the number of runs at once is lowered." : "Slowing down is off (`scf limits auto on`): this is a forecast only.", "");
  return out.join("\n");
}
