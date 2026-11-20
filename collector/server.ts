import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ShareReport } from "../src/metrics-share/report.js";
import { MAX_BODY_BYTES, REASONS, checkReport, installOf, isInstallId, isJsonContentType, type Reason } from "./check.js";
import { DEFAULT_LIMITS, RateLimiter, type LimitOptions, type Take } from "./limits.js";
import { ReportStore, type StoreHooks } from "./store.js";
import { computeTotals, type PublicMetrics } from "./totals.js";

// The HTTP side of the receiver (#890). It reads only the method, the path, the content type and the body: never the
// socket address or any other header. It logs nothing per request; only a failure name (never a path, body or header).
// Every change to the data folder, and the read of a recompute, runs through one lock, one after the other.

const HOUR_MS = 3_600_000;
const METRICS_PATH = "/metrics.json";
const POST_PATH = "/api/metrics";
const DELETE_PREFIX = "/api/metrics/";

export interface CollectorLog { info(msg: string): void; error(msg: string): void }

export interface CollectorOptions {
  dataDir: string;
  now?: () => Date;
  limits?: LimitOptions;
  /** How often the totals are worked out again (default one hour). */
  everyMs?: number;
  /** Set false to keep the timer from being unref'd (tests). */
  unrefTimer?: boolean;
  log?: CollectorLog;
  /** A replacement store (tests). */
  store?: ReportStore;
  /** Points where a test can pause the collector. */
  hooks?: { store?: StoreHooks; afterList?: () => Promise<void>; requestStarted?: () => void };
}

export interface Collector {
  server: Server;
  start(): Promise<void>;
  recompute(): Promise<void>;
  metrics(): PublicMetrics | undefined;
  close(): Promise<void>;
}

class BodyTooLarge extends Error {}
class Aborted extends Error {}

const errName = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z_0-9]{1,40}$/.test(code)) return code;
  const name = (e as { name?: unknown })?.name;
  return typeof name === "string" && /^\w{1,40}$/.test(name) ? name : "Error";
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", ...headers });
  res.end(bytes);
}

const refuse = (res: ServerResponse, status: number, reason: Reason, headers?: Record<string, string>) => send(res, status, { error: reason }, headers);

function limited(res: ServerResponse, take: Take & { ok: false }): void {
  send(res, 429, { error: REASONS.rateLimited, retry_after: take.retryAfter }, { "Retry-After": String(take.retryAfter) });
}

/** Reads the body up to MAX_BODY_BYTES. Rejects with BodyTooLarge (and drops the rest) or Aborted. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        finish(() => reject(new BodyTooLarge()));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
    req.on("error", () => finish(() => reject(new Aborted())));
    req.on("close", () => {
      if (!req.complete) finish(() => reject(new Aborted()));
    });
  });
}

export function createCollector(opts: CollectorOptions): Collector {
  const now = opts.now ?? (() => new Date());
  const log: CollectorLog = opts.log ?? { info: (m) => console.log(m), error: (m) => console.error(m) };
  const store = opts.store ?? new ReportStore(opts.dataDir, opts.hooks?.store);
  const limiter = new RateLimiter(opts.limits ?? DEFAULT_LIMITS, () => now().getTime());
  const everyMs = opts.everyMs ?? HOUR_MS;

  let chain: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  }

  let published: { metrics: PublicMetrics; bytes: Buffer } | undefined;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closing = false;
  /** Requests still being answered (their body may still be arriving); shutdown waits for them. */
  const inFlight = new Set<Promise<void>>();
  /** The installs deleted while a recompute runs: one set per running recompute. */
  const deletedSince = new Set<Set<string>>();

  /** Works out the totals; rejects on failure and keeps the previous ones. */
  async function runTotals(): Promise<void> {
    const deleted = new Set<string>();
    deletedSince.add(deleted);
    try {
      const reports = await locked(async () => {
        await store.prune(now());
        return store.list();
      });
      await opts.hooks?.afterList?.();
      // an install deleted after the read is left out before anything is summed, so a group that fell below 3 is left out too
      const kept = reports.filter((r) => !deleted.has(r.install));
      const metrics = computeTotals(kept, now());
      published = { metrics, bytes: Buffer.from(JSON.stringify(metrics)) };
      log.info(`totals: ${kept.length} reports, ${new Set(kept.map((r) => r.install)).size} installs`);
    } finally {
      deletedSince.delete(deleted);
    }
  }

  function run(): Promise<void> {
    if (!running) running = runTotals().finally(() => (running = undefined));
    return running;
  }

  /** The hourly run: never rejects; a failure is logged as one line and the next run tries again. */
  function recompute(): Promise<void> {
    return run().catch((e: unknown) => log.error(`totals failed: ${errName(e)}`));
  }

  async function postReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req.headers["content-type"])) return refuse(res, 415, REASONS.badContentType);
    const length = Number(req.headers["content-length"]);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      req.resume();
      return refuse(res, 413, REASONS.tooLarge, { Connection: "close" });
    }
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        req.resume();
        return refuse(res, 413, REASONS.tooLarge, { Connection: "close" });
      }
      if (e instanceof Aborted) return void res.destroy();
      throw e;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return refuse(res, 400, REASONS.badJson);
    }
    const install = installOf(body);
    if (install) {
      const take = limiter.takeInstall(install);
      if (!take.ok) {
        limiter.giveBackTotal();
        return limited(res, take);
      }
    }
    const checked = checkReport(body, now());
    if (!checked.ok) return refuse(res, 400, checked.reason);
    const report: ShareReport = checked.report;
    await locked(() => store.save(report));
    send(res, 200, { stored: true });
  }

  async function deleteInstall(id: string, res: ServerResponse): Promise<void> {
    if (!isInstallId(id)) return refuse(res, 400, REASONS.badInstall);
    const take = limiter.takeInstall(id);
    if (!take.ok) {
      limiter.giveBackTotal();
      return limited(res, take);
    }
    await locked(() => store.deleteInstall(id));
    for (const set of deletedSince) set.add(id);
    send(res, 200, { deleted: true });
  }

  function getMetrics(req: IncomingMessage, res: ServerResponse): void {
    if (!published) return refuse(res, 503, REASONS.notReady);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(published.bytes.length),
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : published.bytes);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "";
    if (path === METRICS_PATH) {
      if (method !== "GET" && method !== "HEAD") return refuse(res, 405, REASONS.methodNotAllowed, { Allow: "GET, HEAD" });
      return getMetrics(req, res);
    }
    const isPost = path === POST_PATH;
    const isDelete = path.startsWith(DELETE_PREFIX);
    if (!isPost && !isDelete) return refuse(res, 404, REASONS.notFound);
    if (isPost && method !== "POST") return refuse(res, 405, REASONS.methodNotAllowed, { Allow: "POST" });
    if (isDelete && method !== "DELETE") return refuse(res, 405, REASONS.methodNotAllowed, { Allow: "DELETE" });
    const total = limiter.takeTotal();
    if (!total.ok) return limited(res, total);
    opts.hooks?.requestStarted?.();
    if (isPost) return postReport(req, res);
    return deleteInstall(path.slice(DELETE_PREFIX.length), res);
  }

  const server = createServer((req, res) => {
    const work = handle(req, res).catch((e: unknown) => {
      log.error(`request failed: ${errName(e)}`);
      refuse(res, 500, REASONS.internal);
    });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  return {
    server,
    async start() {
      // a data folder that cannot be used or read stops start-up here, before anything listens
      await store.ready();
      await run();
      if (closing) return;
      timer = setInterval(() => void recompute(), everyMs);
      if (opts.unrefTimer !== false) timer.unref();
    },
    recompute,
    metrics: () => published?.metrics,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      // requests still arriving (or waiting for the storage lock) finish first; the caller's deadline ends the wait
      await Promise.allSettled([...inFlight]);
      await chain;
      await running?.catch(() => undefined);
      server.closeAllConnections();
      await stopped;
    },
  };
}
