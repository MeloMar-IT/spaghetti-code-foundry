/** The performance budgets of the UI, checked by performance.spec.ts. Plain data: the doc test reads it too. */

export type BudgetUnit = "ms" | "score" | "count";

export interface Budget {
  /** What is measured, in a few words */
  measure: string;
  unit: BudgetUnit;
  /** A literal number: the measured median, rounded up by `timeBudget`, or a fixed target */
  limit: number;
  /** Why the limit is what it is */
  reason: string;
}

/** The time between two ticks of the refresh timers of Home and Runs (REFRESH_MS in ui/runs.js and ui/home-admin.js). */
export const POLL_TICK_MS = 30_000;
/** How many times one measure is taken; the median counts. */
export const RUNS_PER_MEASURE = 3;

/** The median of a list of numbers (the mean of the middle two for an even count). Throws on an empty list. */
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of an empty list");
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A time limit: three times the measured median, rounded up to the next 500 ms, but never above `capMs`. */
export const timeBudget = (medianMs: number, capMs: number): number => Math.min(capMs, Math.ceil((medianMs * 3) / 500) * 500);

/** "612 ms", "0.012" or "200". */
export function show(b: Budget, value: number): string {
  if (b.unit === "ms") return `${Math.round(value)} ms`;
  if (b.unit === "score") return value.toFixed(3);
  return String(value);
}

/** null when `value` is within the budget, else a sentence for the failure message. */
export function overBudget(b: Budget, value: number): string | null {
  if (value <= b.limit) return null;
  const word = b.unit === "ms" ? "" : ` ${b.unit}`;
  return `${b.measure}: ${show(b, value)}${word} is over the budget of ${show(b, b.limit)}${word}`;
}

// Time limits: timeBudget(measured median, cap), written out as numbers. Fixed targets keep their value.
export const RENDER_HOME_MS: Budget = { measure: "Home render", unit: "ms", limit: 500, reason: "Three times the measured median of 73 ms, in 500 ms steps." };
export const RENDER_RUNS_MS: Budget = { measure: "Runs render", unit: "ms", limit: 500, reason: "Three times the measured median of 72 ms, in 500 ms steps." };
export const RENDER_BOARD_MS: Budget = { measure: "Board render", unit: "ms", limit: 500, reason: "Three times the measured median of 65 ms, in 500 ms steps." };
export const INTERACTION_MS: Budget = { measure: "Board to Runs click", unit: "ms", limit: 500, reason: "Three times the measured median of 84 ms, in 500 ms steps." };
export const CLS_LOAD: Budget = { measure: "Layout shift on load", unit: "score", limit: 0.1, reason: "Fixed target: 0.1 is the \"good\" limit of the web vitals." };
export const CLS_POLL: Budget = { measure: "Layout shift across a polling tick", unit: "score", limit: 0.05, reason: "Fixed target: a redraw the user did not ask for may shift less than half of the load budget." };
export const LARGE_RUNS_MS: Budget = { measure: "Runs with 500 runs", unit: "ms", limit: 500, reason: "Three times the measured median of 110 ms, in 500 ms steps." };
export const LARGE_LOG_MS: Budget = { measure: "Run page with a 5,000 line log", unit: "ms", limit: 3000, reason: "The cap: three times the measured median of 5993 ms is above it, so the cap counts." };
export const LARGE_DIFF_MS: Budget = { measure: "Diff tab with 2,000 lines", unit: "ms", limit: 1000, reason: "Three times the measured median of 196 ms, in 500 ms steps." };
export const LARGE_RUNS_ROWS: Budget = { measure: "Rows drawn in the Runs table", unit: "count", limit: 200, reason: "Fixed target: the list shows at most 200 runs (the server limit)." };
export const POLL_HOME_MS: Budget = { measure: "Home redraw after its request", unit: "ms", limit: 500, reason: "Three times the measured median of 3 ms, in 500 ms steps." };
export const POLL_RUNS_MS: Budget = { measure: "Runs redraw after its request", unit: "ms", limit: 500, reason: "Three times the measured median of 3 ms, in 500 ms steps." };
export const POLL_REQUESTS: Budget = { measure: "Requests per polling tick", unit: "count", limit: 1, reason: "Fixed target: one tick asks the server once." };

export const BUDGETS = {
  RENDER_HOME_MS, RENDER_RUNS_MS, RENDER_BOARD_MS, INTERACTION_MS, CLS_LOAD, CLS_POLL,
  LARGE_RUNS_MS, LARGE_LOG_MS, LARGE_DIFF_MS, LARGE_RUNS_ROWS, POLL_HOME_MS, POLL_RUNS_MS, POLL_REQUESTS,
} satisfies Record<string, Budget>;
