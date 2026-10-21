import { TelemetrySchema, type Config, type OtlpConfig } from "../config.js";
import { TELEMETRY_NAMES, TELEMETRY_VERSION, TelemetryEventSchema, tmId, type TelemetryEvent, type TelemetryKind } from "./envelope.js";
import { TelemetryWriter } from "./local.js";
import { OtlpExporter, type OtlpFetch } from "./otlp.js";
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
  /** Events the OTLP collector accepted, and events it did not (or that were dropped before they were sent). */
  exported: number;
  failed: number;
  dropped: Record<DropReason, number>;
}

const defaultLog = (line: string): void => void process.stderr.write(`${line}\n`);
const zeroStats = (): TelemetryStats => ({ enabled: false, written: 0, exported: 0, failed: 0, dropped: { invalid: 0, privacy: 0, identity: 0, write: 0 } });

let local = false;
let otlp: OtlpConfig | undefined;
let exporter: OtlpExporter | undefined;
const closing = new Map<OtlpExporter, Promise<void>>();
let generation = 0;
let fetchFn: OtlpFetch = (u, i) => fetch(u, i);
let exiting: Promise<void> | undefined;
let keepDays = 30;
let patterns: readonly string[] = [];
let log: (line: string) => void = defaultLog;
let writer: TelemetryWriter | undefined;
let stats = zeroStats();
let said = new Set<DropReason>();

/** Reads the `telemetry` and `help` sections. A `log` replaces the current one; without one the earlier is kept. Never throws. */
export function configureTelemetry(config: Pick<Config, "telemetry" | "help"> | undefined, o?: { log?: (line: string) => void; fetch?: OtlpFetch }): void {
  try {
    const t = TelemetrySchema.safeParse(config?.telemetry ?? {});
    const v = t.success ? t.data : TelemetrySchema.parse({});
    local = v.local;
    otlp = v.otlp.enabled && v.otlp.endpoint ? v.otlp : undefined;
    keepDays = v.keep_days;
    patterns = config?.help?.sensitive_patterns ?? [];
    if (o?.log) log = o.log;
    if (o?.fetch) fetchFn = o.fetch;
    if (exporter && (!otlp || exporter.endpoint !== otlp.endpoint || exporter.timeoutMs !== otlp.timeout_ms)) {
      retire(exporter);
      exporter = undefined;
    }
    if (!local) closeWriter();
  } catch {
    // telemetry never stops the caller
  }
}

export function telemetryEnabled(): boolean {
  return local || otlp !== undefined;
}

/** Closes an exporter that is no longer current; it stays in `closing` until it has sent what it could. */
function retire(e: OtlpExporter, ms = 3000): void {
  if (!closing.has(e)) closing.set(e, e.close(ms).finally(() => closing.delete(e)));
}

function newExporter(o: OtlpConfig): OtlpExporter {
  const gen = generation;
  return new OtlpExporter({
    endpoint: o.endpoint as string,
    timeoutMs: o.timeout_ms,
    fetch: (u, i) => (gen === generation ? fetchFn(u, i) : Promise.reject(new Error("telemetry was reset"))),
    log: (l) => {
      if (gen !== generation) return;
      try {
        log(l);
      } catch {
        // a broken log is not a reason to fail
      }
    },
    count: (w, n) => {
      if (gen === generation) stats[w] += n;
    },
  });
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

type LiveFields = Omit<Partial<TelemetryEvent>, "version" | "id" | "time" | "kind" | "name" | "evidence">;

/** One event without an evidence line (a push, a tool call, a watcher fact): a new tm: id and the time now. Never throws. */
export function emitLiveTelemetry<K extends TelemetryKind>(kind: K, name: (typeof TELEMETRY_NAMES)[K][number], fields: LiveFields): void {
  if (!telemetryEnabled()) return;
  try {
    emitTelemetry({ ...fields, version: TELEMETRY_VERSION, id: tmId(), time: new Date().toISOString(), kind, name } as TelemetryEvent);
  } catch {
    // never throws
  }
}

/** Writes the events that are valid and private. Never throws. */
export function emitTelemetry(events: TelemetryEvent | readonly TelemetryEvent[]): void {
  try {
    if (!telemetryEnabled()) return;
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
        if (otlp) {
          try {
            exporter ??= newExporter(otlp);
            exporter.push(clean.event);
          } catch {
            // the export never stops the local file
          }
        }
        if (!local) continue;
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

function closeWriter(): void {
  writer?.close();
  writer = undefined;
}

/**
 * Closes the local file and sends what the OTLP exporter still holds, within `ms`. Waits for every exporter that is
 * closing, also when called again; events that arrive meanwhile are sent if time is left. Never rejects.
 */
export async function closeTelemetry(ms = 3000): Promise<void> {
  try {
    closeWriter();
    const end = Date.now() + ms;
    while (exporter || closing.size) {
      if (exporter) {
        retire(exporter, Math.max(0, end - Date.now()));
        exporter = undefined;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([...closing.values()]),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, end - Date.now())).unref())),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (Date.now() >= end && (exporter || closing.size)) {
        for (const x of [...closing.keys()]) void x.close(0);
        if (exporter) void (exporter as OtlpExporter).close(0);
        break;
      }
    }
  } catch {
    // never rejects
  }
}

/** Sends the queue within the time limit and then exits. Runs once per process: later calls share the first. */
export function exitAfterTelemetry(code: number, o?: { exit?: (code: number) => void; ms?: number }): Promise<void> {
  return (exiting ??= (async () => {
    process.exitCode = code;
    await closeTelemetry(o?.ms);
    (o?.exit ?? process.exit)(code);
  })());
}

/** Tests: closes the file, turns telemetry off, restores the default log and clears the counts. */
export function resetTelemetry(): void {
  generation++;
  closeWriter();
  for (const x of [...closing.keys(), ...(exporter ? [exporter] : [])]) void x.close(0);
  closing.clear();
  exporter = undefined;
  otlp = undefined;
  fetchFn = (u, i) => fetch(u, i);
  exiting = undefined;
  local = false;
  keepDays = 30;
  patterns = [];
  log = defaultLog;
  stats = zeroStats();
  said = new Set();
}

export function telemetryStats(): TelemetryStats {
  return { enabled: telemetryEnabled(), written: stats.written, exported: stats.exported, failed: stats.failed, dropped: { ...stats.dropped } };
}
