import { createHash } from "node:crypto";
import { TELEMETRY_VERSION, type TelemetryEvent } from "./envelope.js";

/**
 * The optional OTLP/HTTP logs exporter. It only ever gets events that passed the schema and the privacy check.
 * Best effort: nothing here throws, a failed request is not retried, and a slow collector only costs a bounded queue.
 * There are no process listeners: the caller awaits `close` before it exits.
 */

export const OTLP_BATCH = 50;
export const OTLP_QUEUE_MAX = 1000;
export const OTLP_INTERVAL_MS = 2000;
export const OTLP_WORDS = {
  failing: "! telemetry: the OTLP collector could not be reached or did not accept events; they are dropped until it does",
  recovered: "· telemetry: the OTLP collector accepts events again",
} as const;

export type OtlpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OtlpExporterOptions {
  endpoint: string;
  timeoutMs: number;
  fetch: OtlpFetch;
  log: (line: string) => void;
  count: (what: "exported" | "failed", n: number) => void;
}

/** 32 hex characters, the same for every event of a run. */
export function otlpTraceId(runId: string): string {
  return createHash("sha256").update(`scf-run:${runId}`).digest("hex").slice(0, 32);
}

function unixNano(time: string): string {
  const m = /^(.*?)(?:\.(\d+))?Z$/.exec(time);
  if (!m) return "0";
  const ms = Date.parse(`${m[1]}Z`);
  if (Number.isNaN(ms)) return "0";
  return String(BigInt(ms) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0").slice(0, 9)));
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: { stringValue: string }[] } };
interface KeyValue {
  key: string;
  value: AnyValue;
}

function flatten(value: unknown, path: string, out: KeyValue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string") out.push({ key: path, value: { stringValue: value } });
  else if (typeof value === "number") out.push({ key: path, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } });
  else if (typeof value === "boolean") out.push({ key: path, value: { boolValue: value } });
  else if (Array.isArray(value)) out.push({ key: path, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } });
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(v, `${path}.${k}`, out);
}

export function otlpLogsRequest(events: readonly TelemetryEvent[]): object {
  const logRecords = events.map((e) => {
    const attributes: KeyValue[] = [];
    for (const [k, v] of Object.entries(e)) flatten(v, `scf.${k}`, attributes);
    const bad = e.outcome === "failed" || e.outcome === "denied";
    return {
      timeUnixNano: unixNano(e.time),
      severityNumber: bad ? 13 : 9,
      severityText: bad ? "WARN" : "INFO",
      body: { stringValue: e.name },
      ...(e.runId ? { traceId: otlpTraceId(e.runId) } : {}),
      attributes,
    };
  });
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "spaghetti-code-foundry" } }] },
        scopeLogs: [{ scope: { name: "spaghetti-code-foundry/telemetry", version: String(TELEMETRY_VERSION) }, logRecords }],
      },
    ],
  };
}

export class OtlpExporter {
  private queue: TelemetryEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private inflight: AbortController | undefined;
  private failing = false;
  private closed = false;
  private aborted = false;

  constructor(private readonly o: OtlpExporterOptions) {}

  get endpoint(): string {
    return this.o.endpoint;
  }

  get timeoutMs(): number {
    return this.o.timeoutMs;
  }

  /** Queues one event. Never throws. */
  push(event: TelemetryEvent): void {
    try {
      if (this.closed) {
        this.o.count("failed", 1);
        return;
      }
      if (this.queue.length >= OTLP_QUEUE_MAX) {
        this.queue.shift();
        this.o.count("failed", 1);
      }
      this.queue.push(event);
      if (this.queue.length >= OTLP_BATCH) void this.flush();
      else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, OTLP_INTERVAL_MS);
        this.timer.unref();
      }
    } catch {
      // never throws
    }
  }

  /** Sends what is queued, one request at a time. Never rejects. */
  flush(): Promise<void> {
    return (this.running ??= this.drain().finally(() => {
      this.running = undefined;
    }));
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length && !this.aborted) await this.send(this.queue.splice(0, OTLP_BATCH));
    } catch {
      // never rejects
    }
  }

  private async send(batch: TelemetryEvent[]): Promise<void> {
    const ctl = new AbortController();
    const t = AbortSignal.timeout(this.o.timeoutMs);
    const onTimeout = (): void => ctl.abort(t.reason);
    t.addEventListener("abort", onTimeout, { once: true });
    this.inflight = ctl;
    let ok = false;
    try {
      const res = await this.o.fetch(this.o.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpLogsRequest(batch)),
        redirect: "error",
        signal: ctl.signal,
      });
      try {
        void res.body?.cancel().catch(() => {});
      } catch {
        // a body that cannot be released is not a failure
      }
      ok = res.ok;
    } catch {
      ok = false;
    } finally {
      t.removeEventListener("abort", onTimeout);
      this.inflight = undefined;
    }
    try {
      if (ok) {
        this.o.count("exported", batch.length);
        if (this.failing) {
          this.failing = false;
          this.o.log(OTLP_WORDS.recovered);
        }
      } else {
        this.o.count("failed", batch.length);
        if (!this.failing) {
          this.failing = true;
          this.o.log(OTLP_WORDS.failing);
        }
      }
    } catch {
      // a broken log or counter is not a reason to fail
    }
  }

  /** Sends what is left within `ms`, then drops the rest and aborts a request in flight. Never rejects; safe to call again. */
  async close(ms = 3000): Promise<void> {
    try {
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (ms > 0) {
        let limit: NodeJS.Timeout | undefined;
        try {
          await Promise.race([this.flush(), new Promise<void>((resolve) => (limit = setTimeout(resolve, ms).unref()))]);
        } finally {
          if (limit) clearTimeout(limit);
        }
      }
      this.aborted = true;
      this.inflight?.abort();
      const left = this.queue.length;
      this.queue = [];
      if (left) this.o.count("failed", left);
    } catch {
      // never rejects
    }
  }
}
