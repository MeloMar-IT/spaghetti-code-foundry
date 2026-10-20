import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { addCredential } from "../src/credentials/store.js";
import type { TelemetryEvent } from "../src/telemetry/envelope.js";
import { telemetryDir, telemetryFile } from "../src/telemetry/local.js";
import { OTLP_BATCH, OTLP_INTERVAL_MS, OTLP_QUEUE_MAX, OTLP_WORDS, otlpLogsRequest, otlpTraceId, type OtlpFetch } from "../src/telemetry/otlp.js";
import { closeTelemetry, configureTelemetry, emitTelemetry, exitAfterTelemetry, resetTelemetry, telemetryEnabled, telemetryStats } from "../src/telemetry/telemetry.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const STORED = ["tok", "Zq7wLm3xPv9sKd2f"].join("-");
const TOKEN = `ghp_${"a1B2".repeat(9)}`;
const ENDPOINT = "http://127.0.0.1:4318/v1/logs";

let home: string;
let saved: string | undefined;
let savedCode: typeof process.exitCode;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  savedCode = process.exitCode;
  home = mkdtempSync(join(tmpdir(), "telemetry-otlp-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  vi.useRealTimers();
  resetTelemetry();
  process.exitCode = savedCode;
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const ev = (n = 1, more: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  version: 2, id: `ev:r1:ev-${String(n).padStart(6, "0")}`, time: "2026-03-10T12:00:00.000Z", kind: "run", name: "run.queued", runId: "r1",
  evidence: { id: `ev-${String(n).padStart(6, "0")}`, seq: n }, ...more,
});
const failedStep = (n = 1): TelemetryEvent => ev(n, { kind: "step", name: "step.failed", step: { id: "build", visit: 1, type: "shell" }, outcome: "failed", durationMs: 12 });
const cfg = (otlp: object = {}, telemetry: object = {}) => ConfigSchema.parse({ protected_branches: [], telemetry: { ...telemetry, otlp: { enabled: true, endpoint: ENDPOINT, ...otlp } } });
const emitN = (n: number, from = 1) => emitTelemetry(Array.from({ length: n }, (_, i) => ev(from + i)));
const records = (init: RequestInit): { body: { stringValue: string }; attributes: { key: string; value: unknown }[] }[] =>
  JSON.parse(init.body as string).resourceLogs[0].scopeLogs[0].logRecords;
const idsOf = (init: RequestInit) => records(init).map((r) => r.attributes.find((a) => a.key === "scf.evidence.seq")?.value);

interface Call { url: string; init: RequestInit; ok(status?: number, body?: BodyInit | null): void; fail(e?: unknown): void }
/** A fetch whose calls the test settles by hand. A call also fails when its signal is aborted. */
function stub() {
  const calls: Call[] = [];
  const waiters: [number, () => void][] = [];
  const fn: OtlpFetch = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      calls.push({ url, init, ok: (status = 200, body = null) => resolve(new Response(body, { status })), fail: (e = new Error("x")) => reject(e) });
      for (const w of waiters.splice(0)) w[1]();
    });
  const called = async (n: number) => {
    while (calls.length < n) await new Promise<void>((r) => waiters.push([n, r]));
  };
  return { fn, calls, called };
}
function lines() {
  const out: string[] = [];
  const waiters: (() => void)[] = [];
  return {
    out,
    log: (l: string) => {
      out.push(l);
      for (const w of waiters.splice(0)) w();
    },
    got: async (n: number) => {
      while (out.length < n) await new Promise<void>((r) => waiters.push(r));
    },
  };
}
const localLines = () => readFileSync(telemetryFile(new Date().toISOString().slice(0, 10)), "utf8").trim().split("\n");

describe("otlpLogsRequest", () => {
  it("flattens the measures of run.measured", () => {
    const m = ev(1, { id: `tm:${"0f".repeat(16)}`, evidence: undefined, name: "run.measured", measures: { toolCalls: 3, costUsd: 0.25 } });
    const req = otlpLogsRequest([m]) as any;
    const attrs = req.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as { key: string; value: unknown }[];
    const at = (k: string) => attrs.find((a) => a.key === k)?.value;
    expect(at("scf.measures.toolCalls")).toEqual({ intValue: "3" });
    expect(at("scf.measures.costUsd")).toEqual({ doubleValue: 0.25 });
  });

  it("builds one resource with flattened attributes", () => {
    const req = otlpLogsRequest([failedStep(1), ev(2)]) as any;
    expect(req.resourceLogs).toHaveLength(1);
    const rl = req.resourceLogs[0];
    expect(rl.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "spaghetti-code-foundry" } }]);
    expect(rl.scopeLogs[0].scope).toEqual({ name: "spaghetti-code-foundry/telemetry", version: "2" });
    const [a, b] = rl.scopeLogs[0].logRecords;
    expect(a.timeUnixNano).toBe("1773144000000000000");
    expect([a.severityNumber, a.severityText, b.severityNumber, b.severityText]).toEqual([13, "WARN", 9, "INFO"]);
    expect(a.body).toEqual({ stringValue: "step.failed" });
    const at = (k: string) => a.attributes.find((x: any) => x.key === k)?.value;
    expect(at("scf.name")).toEqual({ stringValue: "step.failed" });
    expect(at("scf.step.id")).toEqual({ stringValue: "build" });
    expect(at("scf.step.visit")).toEqual({ intValue: "1" });
    expect(at("scf.durationMs")).toEqual({ intValue: "12" });
  });

  it("keeps nanoseconds, the arrays and denied as WARN", () => {
    const [r] = (otlpLogsRequest([ev(1, { time: "2026-03-10T12:00:00.123456789Z", outcome: "denied", redacted: ["branch", "step"] })]) as any).resourceLogs[0].scopeLogs[0].logRecords;
    expect(r.timeUnixNano).toBe("1773144000123456789");
    expect(r.severityText).toBe("WARN");
    expect(r.attributes.find((x: any) => x.key === "scf.redacted").value).toEqual({ arrayValue: { values: [{ stringValue: "branch" }, { stringValue: "step" }] } });
  });

  it("gives a stable trace id per run", () => {
    const [a, b, c] = (otlpLogsRequest([ev(1), ev(2), ev(3, { runId: "r2", id: "ev:r2:ev-000003" })]) as any).resourceLogs[0].scopeLogs[0].logRecords;
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.traceId).toBe(b.traceId);
    expect(a.traceId).not.toBe(c.traceId);
    expect(otlpTraceId("r1")).toBe(a.traceId);
    const [none] = (otlpLogsRequest([{ ...ev(1), id: `tm:${"a".repeat(32)}`, runId: undefined, evidence: undefined }]) as any).resourceLogs[0].scopeLogs[0].logRecords;
    expect("traceId" in none).toBe(false);
  });
});

describe("disabled", () => {
  it("never calls fetch, writes the local lines and adds no listener", async () => {
    const s = stub();
    const names = ["exit", "beforeExit", "SIGINT", "SIGTERM"];
    const before = names.map((n) => process.listenerCount(n));
    configureTelemetry(ConfigSchema.parse({ protected_branches: [] }), { fetch: s.fn });
    emitN(60);
    await closeTelemetry();
    expect(s.calls).toHaveLength(0);
    expect(localLines()).toHaveLength(60);
    expect(telemetryStats()).toMatchObject({ written: 60, exported: 0, failed: 0 });
    expect(names.map((n) => process.listenerCount(n))).toEqual(before);
  });

  it("adds no listener when enabled either", async () => {
    const s = stub();
    const names = ["exit", "beforeExit", "SIGINT", "SIGTERM"];
    const before = names.map((n) => process.listenerCount(n));
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(1);
    const p = closeTelemetry();
    await s.called(1);
    s.calls[0].ok();
    await p;
    expect(names.map((n) => process.listenerCount(n))).toEqual(before);
  });
});

describe("sending", () => {
  it("sends a batch at OTLP_BATCH, not before", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(OTLP_BATCH - 1);
    expect(s.calls).toHaveLength(0);
    emitN(1, OTLP_BATCH);
    await s.called(1);
    expect(records(s.calls[0].init)).toHaveLength(OTLP_BATCH);
    s.calls[0].ok();
    await closeTelemetry();
    expect(telemetryStats().exported).toBe(OTLP_BATCH);
  });

  it("sends on the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(1);
    expect(s.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(OTLP_INTERVAL_MS);
    expect(s.calls).toHaveLength(1);
    s.calls[0].ok();
  });

  it("uses the fetch options and works without AbortSignal.any", async () => {
    const any = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;
    try {
      const s = stub();
      configureTelemetry(cfg(), { fetch: s.fn });
      emitN(1);
      const p = closeTelemetry();
      await s.called(1);
      const { url, init } = s.calls[0];
      expect(url).toBe(ENDPOINT);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(() => JSON.parse(init.body as string)).not.toThrow();
      s.calls[0].ok();
      await p;
      expect(telemetryStats().exported).toBe(1);
    } finally {
      (AbortSignal as any).any = any;
    }
  });

  it("sends one request at a time", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(OTLP_BATCH);
    await s.called(1);
    emitN(OTLP_BATCH, 100);
    await Promise.resolve();
    expect(s.calls).toHaveLength(1);
    s.calls[0].ok();
    await s.called(2);
    expect(records(s.calls[1].init)).toHaveLength(OTLP_BATCH);
    s.calls[1].ok();
    await closeTelemetry();
    expect(s.calls).toHaveLength(2);
  });

  it("drops the oldest when the queue is full", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(OTLP_BATCH);
    await s.called(1);
    emitN(OTLP_QUEUE_MAX + 10, 1000);
    expect(telemetryStats().failed).toBe(10);
    s.calls[0].ok();
    await s.called(2);
    expect(idsOf(s.calls[1].init)[0]).toEqual({ intValue: "1010" });
    resetTelemetry();
  });

  it("can send with local off", async () => {
    const s = stub();
    configureTelemetry(cfg({}, { local: false }), { fetch: s.fn });
    expect(telemetryEnabled()).toBe(true);
    emitN(2);
    const p = closeTelemetry();
    await s.called(1);
    s.calls[0].ok();
    await p;
    expect(telemetryStats().exported).toBe(2);
    expect(existsSync(telemetryDir())).toBe(false);
  });
});

describe("failures", () => {
  const cases: [string, (c: Call) => void, object][] = [
    ["a rejected fetch", (c) => c.fail(new Error("x")), {}],
    ["a 503", (c) => c.ok(503), {}],
    ["a hang", () => undefined, { timeout_ms: 100 }],
  ];
  it.each(cases)("%s: one failing line, one recovered line, no retry", async (_n, fail, extra) => {
    const s = stub();
    const l = lines();
    configureTelemetry(cfg(extra), { fetch: s.fn, log: l.log });
    for (let i = 0; i < 2; i++) {
      emitN(OTLP_BATCH, 1 + i * 100);
      await s.called(i + 1);
      fail(s.calls[i]);
      await vi.waitFor(() => expect(telemetryStats().failed).toBe(OTLP_BATCH * (i + 1)));
    }
    expect(l.out).toEqual([OTLP_WORDS.failing]);
    emitN(OTLP_BATCH, 300);
    await s.called(3);
    s.calls[2].ok();
    await l.got(2);
    expect(l.out).toEqual([OTLP_WORDS.failing, OTLP_WORDS.recovered]);
    emitN(OTLP_BATCH, 400);
    await s.called(4);
    s.calls[3].fail();
    await l.got(3);
    expect(l.out[2]).toBe(OTLP_WORDS.failing);
    expect(s.calls).toHaveLength(4);
    expect(telemetryStats()).toMatchObject({ exported: OTLP_BATCH, failed: OTLP_BATCH * 3, written: OTLP_BATCH * 4 });
    expect(localLines()).toHaveLength(OTLP_BATCH * 4);
  });

  it.each([200, 503])("releases the body of a %i response", async (status) => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    let cancelled!: () => void;
    const seen = new Promise<void>((r) => (cancelled = r));
    emitN(1);
    const p = closeTelemetry();
    await s.called(1);
    s.calls[0].ok(status, new ReadableStream({ cancel: () => cancelled() }));
    await seen;
    await p;
  });

  it("is not hurt by a body that cannot be cancelled", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(1);
    const p = closeTelemetry();
    await s.called(1);
    s.calls[0].ok(200, new ReadableStream({ cancel: () => Promise.reject(new Error("no")) }));
    await p;
    expect(telemetryStats().exported).toBe(1);
  });
});

describe("shutdown", () => {
  it("sends what is pending", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(3);
    const p = closeTelemetry();
    await s.called(1);
    expect(records(s.calls[0].init)).toHaveLength(3);
    s.calls[0].ok();
    await p;
    expect(telemetryStats().exported).toBe(3);
  });

  it("waits for a request in flight and sends what came after", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(OTLP_BATCH);
    await s.called(1);
    emitN(2, 100);
    const p = closeTelemetry();
    s.calls[0].ok();
    await s.called(2);
    expect(records(s.calls[1].init)).toHaveLength(2);
    s.calls[1].ok();
    await p;
    expect(telemetryStats().exported).toBe(OTLP_BATCH + 2);
  });

  it("gives up on a hanging fetch at the time limit", async () => {
    const s = stub();
    configureTelemetry(cfg({ timeout_ms: 60000 }), { fetch: s.fn });
    emitN(3);
    await closeTelemetry(50);
    expect((s.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    expect(telemetryStats().failed).toBeGreaterThan(0);
  });

  it("makes overlapping closes wait for the same work", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(OTLP_BATCH);
    await s.called(1);
    emitN(2, 100);
    let a = false;
    let b = false;
    const pa = closeTelemetry().then(() => (a = true));
    const pb = closeTelemetry().then(() => (b = true));
    await Promise.resolve();
    await Promise.resolve();
    expect([a, b]).toEqual([false, false]);
    s.calls[0].ok();
    await s.called(2);
    expect([a, b]).toEqual([false, false]);
    s.calls[1].ok();
    await Promise.all([pa, pb]);
    expect(telemetryStats().exported).toBe(OTLP_BATCH + 2);
  });

  it("sends events that arrive during the close, and works again afterwards", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(OTLP_BATCH);
    await s.called(1);
    let done = false;
    const p = closeTelemetry().then(() => (done = true));
    emitN(1, 100);
    s.calls[0].ok();
    await s.called(2);
    expect(records(s.calls[1].init)).toHaveLength(1);
    expect(done).toBe(false);
    s.calls[1].ok();
    await p;
    expect(telemetryStats().exported).toBe(OTLP_BATCH + 1);
    emitN(1, 200);
    const q = closeTelemetry();
    await s.called(3);
    s.calls[2].ok();
    await q;
    expect(telemetryStats().exported).toBe(OTLP_BATCH + 2);
    expect(localLines()).toHaveLength(OTLP_BATCH + 2);
  });

  it("exits once, with the first code, after the queue is sent", async () => {
    const s = stub();
    const exit = vi.fn();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(2);
    const a = exitAfterTelemetry(143, { exit });
    const b = exitAfterTelemetry(130, { exit });
    expect(a).toBe(b);
    await s.called(1);
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(143);
    s.calls[0].ok();
    await a;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });
});

describe("reset", () => {
  it.each([["a failure", (c: Call) => c.fail()], ["a success", (c: Call) => c.ok()]] as const)("does not let %s of an old request touch the new state", async (_n, settle) => {
    const old = stub();
    configureTelemetry(cfg(), { fetch: old.fn });
    emitN(OTLP_BATCH);
    await old.called(1);
    resetTelemetry();
    const fresh = stub();
    const l = lines();
    configureTelemetry(cfg(), { fetch: fresh.fn, log: l.log });
    settle(old.calls[0]);
    await new Promise((r) => setImmediate(r));
    expect(telemetryStats()).toMatchObject({ exported: 0, failed: 0 });
    expect(l.out).toEqual([]);
  });
});

describe("reconfiguring", () => {
  it("keeps the exporter when the config is unchanged", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(1);
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(1, 2);
    const p = closeTelemetry();
    await s.called(1);
    expect(records(s.calls[0].init)).toHaveLength(2);
    s.calls[0].ok();
    await p;
    expect(s.calls).toHaveLength(1);
  });

  it("sends the pending events to the old endpoint when it changes", async () => {
    const s = stub();
    configureTelemetry(cfg({ endpoint: "http://127.0.0.1:1/a" }), { fetch: s.fn });
    emitN(1);
    configureTelemetry(cfg({ endpoint: "http://127.0.0.1:1/b" }), { fetch: s.fn });
    await s.called(1);
    expect(s.calls[0].url).toBe("http://127.0.0.1:1/a");
    s.calls[0].ok();
    emitN(1, 2);
    const p = closeTelemetry();
    await s.called(2);
    expect(s.calls[1].url).toBe("http://127.0.0.1:1/b");
    s.calls[1].ok();
    await p;
  });

  it("keeps its own deadline for an exporter that a reconfigure already retired", async () => {
    const s = stub();
    configureTelemetry(cfg({ endpoint: "http://127.0.0.1:1/a", timeout_ms: 60000 }), { fetch: s.fn });
    emitN(1);
    configureTelemetry(cfg({ endpoint: "http://127.0.0.1:1/b", timeout_ms: 60000 }), { fetch: s.fn });
    await s.called(1);
    await closeTelemetry(50);
    expect((s.calls[0].init.signal as AbortSignal).aborted).toBe(true);
  });

  it("sends the pending events when it is turned off, and closeTelemetry waits for that", async () => {
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitN(1);
    configureTelemetry(ConfigSchema.parse({ protected_branches: [] }), { fetch: s.fn });
    await s.called(1);
    let done = false;
    const p = closeTelemetry(1000).then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    s.calls[0].ok();
    await p;
    emitN(1, 2);
    await closeTelemetry();
    expect(s.calls).toHaveLength(1);
  });
});

describe("secrets", () => {
  let kc: FakeKeychain;
  beforeEach(() => {
    kc = fakeKeychain();
    resetRedactCache();
  });
  afterEach(() => {
    kc.remove();
    resetRedactCache();
  });

  it("never reach the request body", async () => {
    addCredential({ userId: randomUUID(), type: "token", name: "t", secret: STORED }, { ownerOk: () => true });
    const s = stub();
    configureTelemetry(cfg(), { fetch: s.fn });
    emitTelemetry([ev(1, { step: { id: STORED, visit: 1, type: "shell" } }), ev(2, { branch: TOKEN })]);
    const p = closeTelemetry();
    await s.called(1);
    const body = s.calls[0].init.body as string;
    expect(body).not.toContain(STORED);
    expect(body).not.toContain(TOKEN);
    expect(body).toContain("scf.redacted");
    expect(body).toContain('"step"');
    expect(body).toContain('"branch"');
    s.calls[0].ok();
    await p;
  });
});
