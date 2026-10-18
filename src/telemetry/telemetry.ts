import { TelemetrySchema, type Config } from "../config.js";
import { TelemetryEventSchema, type TelemetryEvent } from "./envelope.js";
import { TelemetryWriter } from "./local.js";
import { privateTelemetry } from "./privacy.js";

/**
 * The telemetry hub: events go in, value-free lines come out in the local daily file. Best effort: nothing here
 * throws or can fail a run. A dropped event is counted, and each reason is logged once in fixed words, never with values.
 */

export type DropReason = "invalid" | "privacy" | "identity" | "write";
export const DROP_WORDS: Record<DropReason, string> = {
  invalid: "! telemetry: an event did not match the telemetry format and was not written",
  privacy: "! telemetry: an event could not be checked for private data, or held some, and was not written",
  identity: "! telemetry: an event whose id or run id held private data was not written",
  write: "! telemetry: the telemetry file could not be written; events are dropped until it can",
};

export interface TelemetryStats {
  enabled: boolean;
  written: number;
  dropped: Record<DropReason, number>;
}

const defaultLog = (line: string): void => void process.stderr.write(`${line}\n`);
const zeroStats = (): TelemetryStats => ({ enabled: false, written: 0, dropped: { invalid: 0, privacy: 0, identity: 0, write: 0 } });

let enabled = false;
let keepDays = 30;
let patterns: readonly string[] = [];
let log: (line: string) => void = defaultLog;
let writer: TelemetryWriter | undefined;
let stats = zeroStats();
let said = new Set<DropReason>();

/** Reads the `telemetry` and `help` sections. A `log` replaces the current one; without one the earlier is kept. Never throws. */
export function configureTelemetry(config: Pick<Config, "telemetry" | "help"> | undefined, o?: { log?: (line: string) => void }): void {
  try {
    const t = TelemetrySchema.safeParse(config?.telemetry ?? {});
    const v = t.success ? t.data : TelemetrySchema.parse({});
    enabled = v.local;
    keepDays = v.keep_days;
    patterns = config?.help?.sensitive_patterns ?? [];
    if (o?.log) log = o.log;
    if (!enabled) closeTelemetry();
  } catch {
    // telemetry never stops the caller
  }
}

export function telemetryEnabled(): boolean {
  return enabled;
}

function drop(r: DropReason): void {
  stats.dropped[r]++;
  if (said.has(r)) return;
  said.add(r);
  try {
    log(DROP_WORDS[r]);
  } catch {
    // a broken log is not a reason to fail
  }
}

/** Writes the events that are valid and private. Never throws. */
export function emitTelemetry(events: TelemetryEvent | readonly TelemetryEvent[]): void {
  try {
    if (!enabled) return;
    for (const raw of Array.isArray(events) ? events : [events]) {
      try {
        const first = TelemetryEventSchema.safeParse(raw);
        if (!first.success) {
          drop("invalid");
          continue;
        }
        const clean = privateTelemetry(first.data, { patterns });
        if (!clean.ok) {
          drop(clean.reason);
          continue;
        }
        if (!TelemetryEventSchema.safeParse(clean.event).success) {
          drop("invalid");
          continue;
        }
        try {
          writer ??= new TelemetryWriter(() => keepDays);
          writer.write(clean.line);
        } catch {
          drop("write");
          continue;
        }
        stats.written++;
      } catch {
        drop("invalid");
      }
    }
  } catch {
    // never throws
  }
}

export function flushTelemetry(): void {
  writer?.flush();
}

export function closeTelemetry(): void {
  writer?.close();
  writer = undefined;
}

/** Tests: closes the file, turns telemetry off, restores the default log and clears the counts. */
export function resetTelemetry(): void {
  closeTelemetry();
  enabled = false;
  keepDays = 30;
  patterns = [];
  log = defaultLog;
  stats = zeroStats();
  said = new Set();
}

export function telemetryStats(): TelemetryStats {
  return { enabled, written: stats.written, dropped: { ...stats.dropped } };
}
