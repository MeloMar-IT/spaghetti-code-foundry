import { join } from "node:path";
import { z } from "zod";
import { dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { FAILURE_CODES, FEEDBACK_REASONS, REFUSAL_CODES, USAGE_KEEP_DAYS, dayOf, type FailureCode, type FeedbackReason, type StoreOptions } from "./store.js";

/**
 * The quality numbers of Ask SCF: `help-stats.json` in the data folder. One row per day (UTC) of counts and latency
 * buckets and nothing else: no account, no conversation, no text. The file is apart from `help.json`, so the numbers
 * and the conversations are kept, read and deleted independently. It stays on this install and is never sent out.
 */

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const statsPath = () => join(dataHome(), "help-stats.json");
export const STATS_VERSION = 1;
/** The upper bounds of the latency buckets, in seconds; one more bucket holds everything above the last. */
export const LATENCY_BOUNDS_S = [5, 15, 30, 60, 120] as const;
/** Rows are kept this many days. */
export const STATS_KEEP_DAYS = USAGE_KEEP_DAYS;

export const COUNTERS = ["turns", "retries", "answered", "evidenceOffered", "evidenceNone", "cited", "limited", "actionsOffered", "actionsRun", "actionsFailed", "stopped", "abandoned", "resolved", "helpful", "notHelpful"] as const;
export type Counter = (typeof COUNTERS)[number];

const count = z.number().int().min(0);
const counters = Object.fromEntries(COUNTERS.map((c) => [c, count.default(0)])) as Record<Counter, z.ZodDefault<z.ZodNumber>>;

const StatsRowSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ...counters,
    failed: z.partialRecord(z.enum(FAILURE_CODES), count).default({}),
    refused: z.partialRecord(z.enum(REFUSAL_CODES), count).default({}),
    reasons: z.partialRecord(z.enum(FEEDBACK_REASONS), count).default({}),
    /** Turns that ended (answered or failed) by how long they took: one count per bucket of LATENCY_BOUNDS_S, and the last for longer. */
    latency: z.array(count).length(LATENCY_BOUNDS_S.length + 1).default(() => emptyLatency()),
  })
  .strict();
export type StatsRow = z.infer<typeof StatsRowSchema>;

const FileSchema = z.object({ version: z.literal(STATS_VERSION), days: z.array(StatsRowSchema) }).strict();
type FileData = z.infer<typeof FileSchema>;
const EMPTY: FileData = { version: STATS_VERSION, days: [] };

function emptyLatency(): number[] {
  return LATENCY_BOUNDS_S.map(() => 0).concat(0);
}

export function emptyStats(day: string): StatsRow {
  return { day, ...(Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<Counter, number>), failed: {}, refused: {}, reasons: {}, latency: emptyLatency() };
}

/** The bucket of a duration: 0 for under the first bound (exclusive), and the last for the longest. */
export function latencyBucket(ms: number): number {
  const s = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  const i = LATENCY_BOUNDS_S.findIndex((b) => s < b);
  return i < 0 ? LATENCY_BOUNDS_S.length : i;
}

export interface StatsDelta {
  counts?: Partial<Record<Counter, number>>;
  failed?: Partial<Record<FailureCode, number>>;
  refused?: Partial<Record<RefusalCode, number>>;
  reasons?: Partial<Record<FeedbackReason, number>>;
  /** The time a turn took, in ms: it adds one to its bucket. */
  latencyMs?: number;
}

const whole = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const cutOff = (now: Date) => dayOf(new Date(now.getTime() - STATS_KEEP_DAYS * 86_400_000));
const read = (): FileData => readJsonFile(statsPath(), FileSchema, EMPTY);

function merged(into: Record<string, number | undefined>, add: Record<string, number | undefined> | undefined, allowed: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(into)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(add ?? {})) if (allowed.includes(k)) out[k] = Math.max(0, (out[k] ?? 0) + whole(v));
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

/**
 * Adds to the row of a day (default: today, UTC). A number that is not finite counts as 0, a fraction is cut, and no
 * count goes below 0 (taking back a vote after its row was pruned is ignored). A day older than the keep time is ignored.
 * Takes the lock of the data folder: never call it inside another locked section.
 */
export function addStats(delta: StatsDelta, opts: StoreOptions & { day?: string } = {}): void {
  withAuthLock(() => {
    const now = (opts.now ?? (() => new Date()))();
    const day = opts.day ?? dayOf(now);
    if (day < cutOff(now)) return;
    const file = read();
    const old = file.days.find((r) => r.day === day) ?? emptyStats(day);
    const row: StatsRow = { ...old, failed: { ...old.failed }, refused: { ...old.refused }, reasons: { ...old.reasons }, latency: [...old.latency] };
    for (const [k, v] of Object.entries(delta.counts ?? {})) if ((COUNTERS as readonly string[]).includes(k)) row[k as Counter] = Math.max(0, row[k as Counter] + whole(v));
    row.failed = merged(old.failed, delta.failed, FAILURE_CODES);
    row.refused = merged(old.refused, delta.refused, REFUSAL_CODES);
    row.reasons = merged(old.reasons, delta.reasons, FEEDBACK_REASONS);
    if (delta.latencyMs !== undefined && Number.isFinite(delta.latencyMs)) {
      const b = latencyBucket(delta.latencyMs);
      row.latency[b] = (row.latency[b] ?? 0) + 1;
    }
    writeJsonFile(statsPath(), { version: STATS_VERSION, days: [...file.days.filter((r) => r.day !== day), StatsRowSchema.parse(row)].sort((a, b) => a.day.localeCompare(b.day)) });
  });
}

/** The daily rows, oldest day first. For administrators only: the routes decide who gets them. */
export function readStats(): StatsRow[] {
  return read().days.map((r) => structuredClone(r)).sort((a, b) => a.day.localeCompare(b.day));
}

/** The sum of rows under one label (in `day`), for example "last 7 days". */
export function sumStats(rows: readonly StatsRow[], label: string): StatsRow {
  const total = emptyStats(label);
  const plus = (into: Record<string, number | undefined>, from: Record<string, number | undefined>) => {
    for (const [k, v] of Object.entries(from)) if (v) into[k] = (into[k] ?? 0) + v;
  };
  for (const r of rows) {
    for (const c of COUNTERS) total[c] += r[c];
    plus(total.failed, r.failed);
    plus(total.refused, r.refused);
    plus(total.reasons, r.reasons);
    r.latency.forEach((n, i) => (total.latency[i] = (total.latency[i] ?? 0) + n));
  }
  return total;
}

/** Removes the rows older than the keep time. Returns how many went. */
export function sweepStats(opts: StoreOptions = {}): number {
  return withAuthLock(() => {
    const now = (opts.now ?? (() => new Date()))();
    const file = read();
    const days = file.days.filter((r) => r.day >= cutOff(now));
    if (days.length !== file.days.length) writeJsonFile(statsPath(), { version: STATS_VERSION, days });
    return file.days.length - days.length;
  });
}
