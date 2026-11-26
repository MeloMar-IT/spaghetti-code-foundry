import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { cleanLine } from "./errors.js";
import { FACTORY_HOME } from "./flow/load.js";
import type { SafeRestart } from "./safe-restart.js";

/**
 * Watches the server's own memory. Memory that stays above `server.memory_limit_mb` is written to `memory-growth.json` in
 * the data folder (the monitor makes a finding and a bug story of it, also after the restart) and the server restarts at
 * the next safe moment. The record holds only times and whole numbers.
 */

/** How many samples are kept in memory, and how many are saved. */
export const MEMORY_KEEP = 60;
export const MEMORY_SAVED = 12;
/** This many samples in a row above the limit count as growth, so one short spike restarts nothing. */
export const ABOVE_IN_A_ROW = 3;
export const MEMORY_EVERY_MS = 60_000;
/** The shortest time between two restarts for memory, also over restarts of the server. */
export const RESTART_GAP_MS = 6 * 3_600_000;
/** A saved time this far ahead of the clock is not believed (the clock was set back). */
export const MEMORY_FUTURE_MS = 5 * 60_000;

/**
 * The time between two restarts for memory. It is always longer than the quiet time after a start, with an hour to spare:
 * a server that restarted sooner would never leave the quiet time, and no bug story would be made.
 */
export const memoryRestartGapMs = (cooldownMinutes: number): number => Math.max(RESTART_GAP_MS, (cooldownMinutes + 60) * 60_000);

const Time = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)));
const RecordSchema = z
  .object({
    /** When the growth was seen. */
    at: Time,
    limit_mb: z.number().int().min(0),
    samples: z.array(z.object({ at: Time, mb: z.number().int().min(0) }).strict()).min(1).max(MEMORY_SAVED),
    /** When the monitor's reporter took the growth over (a story is owed or made). Until then it never gets too old. */
    handed: Time.optional(),
  })
  .strict();

export type MemoryRecord = z.infer<typeof RecordSchema>;
export type MemorySample = MemoryRecord["samples"][number];

export const memoryFile = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "memory-growth.json");

/** The saved growth. Missing or not valid: undefined. Never throws. */
export function loadMemoryRecord(file = memoryFile()): MemoryRecord | undefined {
  try {
    const res = RecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return res.success ? res.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveMemoryRecord(r: MemoryRecord, file = memoryFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Marks the growth seen at `at` as taken over. A newer growth in the file is left as it is. */
export function markMemoryHanded(at: string, now: Date, file = memoryFile()): void {
  const r = loadMemoryRecord(file);
  if (r && r.at === at && !r.handed) saveMemoryRecord({ ...r, handed: now.toISOString() }, file);
}

export interface MemoryWatchOptions {
  limitMb: () => number;
  /** Called once, after the record was saved. */
  onGrowth: (r: MemoryRecord) => void;
  log: (m: string) => void;
  /** The time between two restarts for memory. */
  gapMs?: () => number;
  /** The resident memory in bytes. */
  read?: () => number;
  now?: () => Date;
  everyMs?: number;
  file?: string;
}

export class MemoryWatch {
  private kept: MemorySample[] = [];
  private above = 0;
  /** The growth of this process: set once. */
  private seen = false;
  /** A growth that is not saved yet. */
  private unsaved?: MemoryRecord;
  private saveFailed = false;
  private waitTold = false;
  private timer?: NodeJS.Timeout;

  constructor(private o: MemoryWatchOptions) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.sample(), this.o.everyMs ?? MEMORY_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  samples(): MemorySample[] {
    return this.kept.map((s) => ({ ...s }));
  }

  /** Takes one sample. Never throws. */
  sample(): MemorySample | undefined {
    try {
      const rss = (this.o.read ?? (() => process.memoryUsage().rss))();
      const now = this.o.now?.() ?? new Date();
      const s = { at: now.toISOString(), mb: Math.round(rss / 1_048_576) };
      if (!Number.isInteger(s.mb) || s.mb < 0) return undefined;
      this.kept = [...this.kept, s].slice(-MEMORY_KEEP);
      this.judge(s, now);
      this.handOver();
      return { ...s };
    } catch (e) {
      this.say(`health: the memory check failed: ${cleanLine(String((e as Error)?.message ?? e)).slice(0, 200)}`);
      return undefined;
    }
  }

  private judge(s: MemorySample, now: Date): void {
    if (this.seen) return;
    const limit = this.o.limitMb();
    if (!(limit > 0) || s.mb <= limit) {
      this.above = 0;
      return;
    }
    if (++this.above < ABOVE_IN_A_ROW) return;
    // A restart that did not help must not repeat at once: the server stays up long enough to report the growth.
    const last = loadMemoryRecord(this.o.file);
    const since = last ? now.getTime() - Date.parse(last.at) : undefined;
    if (since !== undefined && since > -MEMORY_FUTURE_MS && since < (this.o.gapMs?.() ?? RESTART_GAP_MS)) {
      if (!this.waitTold) this.say(`health: memory ${s.mb} MB is above the limit of ${limit} MB; the server restarted for its memory not long ago, so it waits before it restarts again`);
      this.waitTold = true;
      return;
    }
    this.seen = true;
    this.unsaved = { at: s.at, limit_mb: limit, samples: this.kept.slice(-MEMORY_SAVED) };
  }

  /**
   * Saves the growth, then calls `onGrowth`. A failed save is tried again at every sample, and there is no restart until it
   * works: the restart would lose the samples, and the next server would not know that it must wait.
   */
  private handOver(): void {
    const r = this.unsaved;
    if (!r) return;
    try {
      saveMemoryRecord(r, this.o.file);
    } catch (e) {
      if (!this.saveFailed) this.say(`health: the memory samples could not be saved: ${cleanLine(String((e as Error)?.message ?? e)).slice(0, 200)}; no restart until they are saved`);
      this.saveFailed = true;
      return;
    }
    this.unsaved = undefined;
    this.o.onGrowth(r);
  }

  private say(line: string): void {
    try {
      this.o.log(line);
    } catch {
      // the sampler never throws
    }
  }
}

/** What happens at a growth: a restart at a safe moment, or a line that says this server cannot restart itself. */
export function restartOnGrowth(r: Pick<SafeRestart, "request">, log: (m: string) => void): (rec: MemoryRecord) => void {
  return (rec) => {
    const text = `memory ${rec.samples.at(-1)!.mb} MB is above the limit of ${rec.limit_mb} MB`;
    if (r.request(text) === "unsupervised") log(`health: ${text}; this server cannot restart itself: stop it and start it again`);
  };
}
