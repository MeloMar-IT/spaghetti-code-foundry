import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector, type Collector, type CollectorOptions } from "../collector/server.js";
import { ReportStore } from "../collector/store.js";
import { shareReportFrom } from "../src/metrics-share/build.js";
import type { ShareReport } from "../src/metrics-share/report.js";
import { randomInstall, report } from "./collector-report.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const DAY = "2026-11-20";

interface Reply { status: number; body: any; headers: Record<string, string | string[] | undefined> }

let dir: string;
let c: Collector;
let base: { host: string; port: number };
let logs: { info: string[]; error: string[] };

function send(method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined && !("content-type" in h)) h["content-type"] = "application/json";
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    const req = request({ ...base, method, path, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
const post = (r: unknown, headers?: Record<string, string>) => send("POST", "/api/metrics", typeof r === "string" ? r : JSON.stringify(r), headers);
const del = (id: string) => send("DELETE", `/api/metrics/${id}`);

async function open(o: Partial<CollectorOptions> = {}): Promise<Collector> {
  logs = { info: [], error: [] };
  const col = createCollector({
    dataDir: dir,
    now: () => NOW,
    log: { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) },
    ...o,
  });
  await new Promise<void>((r) => col.server.listen(0, "127.0.0.1", () => r()));
  base = { host: "127.0.0.1", port: (col.server.address() as AddressInfo).port };
  return col;
}

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { arrived, release, wait: async () => { reached(); await opened; } };
}

/** Every file under the data folder (relative paths). */
function files(root = dir): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name).slice(root.length + 1));
  };
  if (existsSync(root)) walk(root);
  return out;
}

const day = (c: Collector, d = DAY) => c.metrics()?.days.find((x) => x.day === d);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collector-"));
  for (const k of ["log", "info", "warn", "error"] as const) vi.spyOn(console, k);
});
afterEach(async () => {
  for (const k of ["log", "info", "warn", "error"] as const) expect(console[k]).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await c?.close();
});

describe("collector server (#890)", () => {
  it("stores a valid report as a compact private file, and a second one replaces it", async () => {
    c = await open();
    const id = randomInstall();
    const r = report({ install: id });
    const res = await post(JSON.stringify(r, null, 2));
    expect(res).toMatchObject({ status: 200, body: { stored: true } });
    const file = join(dir, "reports", id, `${DAY}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(r));
    expect((await post(report({ install: id, changes: { runsStarted: 7, runsEnded: { succeeded: 0, failed: 0, cancelled: 0 } } }))).status).toBe(200);
    expect(files()).toEqual([join("reports", id, `${DAY}.json`)]);
    await post(report({ install: randomInstall() }));
    await post(report({ install: randomInstall() }));
    await c.recompute();
    expect(day(c)!.changes.runsStarted).toBe(9);
    expect(logs.error).toEqual([]);
  });

  it("refuses bad requests with fixed reasons and keeps nothing of them", async () => {
    c = await open();
    const big = JSON.stringify({ ...report({ install: randomInstall() }), pad: "x".repeat(70 * 1024) });
    expect(await post(big)).toMatchObject({ status: 413, body: { error: "too_large" } });
    expect(await post(JSON.stringify(report()), { "content-type": "text/plain" })).toMatchObject({ status: 415, body: { error: "bad_content_type" } });
    expect(await post("{bad")).toMatchObject({ status: 400, body: { error: "bad_json" } });
    const marker = "MARKER-7f3a";
    expect(await post({ ...report({ install: randomInstall() }), [marker]: marker })).toMatchObject({ status: 400, body: { error: "bad_schema" } });
    expect(await post(report({ install: randomInstall(), day: "2026-11-21" }))).toMatchObject({ status: 400, body: { error: "future_day" } });
    expect(await post(report({ install: randomInstall(), day: "2026-11-01" }))).toMatchObject({ status: 400, body: { error: "old_day" } });
    expect(await post(report({ install: "0".repeat(32) }))).toMatchObject({ status: 400, body: { error: "bad_install" } });
    expect(files()).toEqual([]);
  });

  it("refuses a chunked body over 64 KB", async () => {
    c = await open();
    const res = await new Promise<Reply>((resolve, reject) => {
      const req = request({ ...base, method: "POST", path: "/api/metrics", headers: { "content-type": "application/json" } }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (d: Buffer) => chunks.push(d));
        r.on("end", () => resolve({ status: r.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: r.headers }));
      });
      req.on("error", reject);
      for (let i = 0; i < 10; i++) req.write("x".repeat(8 * 1024));
      req.end();
    });
    expect(res).toMatchObject({ status: 413, body: { error: "too_large" } });
    expect(files()).toEqual([]);
  });

  it("limits each install to 20 requests an hour", async () => {
    c = await open();
    const id = randomInstall();
    for (let i = 0; i < 20; i++) expect((await post(report({ install: id }))).status).toBe(200);
    const res = await post(report({ install: id }));
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "rate_limited", retry_after: 3600 });
    expect(res.headers["retry-after"]).toBe("3600");
    expect((await post(report({ install: randomInstall() }))).status).toBe(200);
  });

  it("counts early refusals against the total limit, but not requests refused per install", async () => {
    c = await open({ limits: { perInstallPerHour: 20, totalPerHour: 3 } });
    expect((await post("{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await del("nope")).status).toBe(400);
    expect((await post("{}", { "content-type": "text/plain" })).status).toBe(415);
    const res = await del(randomInstall());
    expect(res).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(res.headers["retry-after"]).toBeDefined();
    await c.close();

    c = await open({ limits: { perInstallPerHour: 1, totalPerHour: 3 } });
    const busy = randomInstall();
    expect((await post(report({ install: busy }))).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post(report({ install: busy }))).status).toBe(429);
    expect((await post(report({ install: randomInstall() }))).status).toBe(200);
    expect((await post(report({ install: randomInstall() }))).status).toBe(200);
  });

  it("deletes an install, and the next totals leave it out", async () => {
    c = await open();
    const ids = [0, 1, 2, 3].map(() => randomInstall());
    for (const id of ids) await post(report({ install: id }));
    await c.recompute();
    expect(day(c)!.installs).toBe(4);
    expect(await del(ids[0]!)).toMatchObject({ status: 200, body: { deleted: true } });
    expect(existsSync(join(dir, "reports", ids[0]!))).toBe(false);
    expect(await del(ids[0]!)).toMatchObject({ status: 200, body: { deleted: true } });
    await c.recompute();
    expect(day(c)!.installs).toBe(3);
    expect(await send("DELETE", "/api/metrics/../x")).toMatchObject({ status: 400, body: { error: "bad_install" } });
    expect(await del("ABC")).toMatchObject({ status: 400, body: { error: "bad_install" } });
  });

  for (const n of [4, 3]) {
    it(`leaves out an install deleted while the totals are worked out (${n} installs)`, async () => {
      const g = gate();
      let pause = false;
      c = await open({ hooks: { afterList: async () => { if (pause) await g.wait(); } } });
      const ids = Array.from({ length: n }, () => randomInstall());
      for (const id of ids) await post(report({ install: id }));
      pause = true;
      const run = c.recompute();
      await g.arrived;
      expect((await del(ids[0]!)).status).toBe(200);
      g.release();
      await run;
      // every install left is counted (there is no minimum number of installs)
      expect(day(c)!.installs).toBe(n - 1);
      expect(logs.info.at(-1)).toBe(`totals: ${n - 1} reports, ${n - 1} installs`);
    });
  }

  it("runs a save and a delete of the same install one after the other", async () => {
    const g = gate();
    c = await open({ hooks: { store: { afterTmpWrite: () => g.wait() } } });
    const id = randomInstall();
    const saving = post(report({ install: id }));
    await g.arrived;
    let deleted = false;
    const deleting = del(id).then((r) => ((deleted = true), r));
    await new Promise((r) => setImmediate(r));
    expect(deleted).toBe(false);
    g.release();
    expect((await saving).status).toBe(200);
    expect((await deleting).status).toBe(200);
    expect(files()).toEqual([]);
  });

  it("removes reports older than 400 days and leftover temporary files", async () => {
    c = await open();
    const id = randomInstall();
    const folder = join(dir, "reports", id);
    mkdirSync(folder, { recursive: true });
    const back = (n: number) => new Date(Date.parse(`${DAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    for (const d of [back(401), back(399)]) writeFileSync(join(folder, `${d}.json`), JSON.stringify(report({ install: id, day: d })));
    writeFileSync(join(folder, "x.tmp"), "half");
    await c.recompute();
    expect(readdirSync(folder)).toEqual([`${back(399)}.json`]);
  });

  it("answers 500 with no detail when the store fails, and keeps no temporary file", async () => {
    class Broken extends ReportStore {
      override async save(): Promise<void> {
        throw Object.assign(new Error(`EACCES ${dir}/secret`), { code: "EACCES" });
      }
    }
    c = await open({ store: new Broken(dir) });
    expect(await post(report({ install: randomInstall() }))).toEqual(expect.objectContaining({ status: 500, body: { error: "internal_error" } }));
    expect(logs.error).toEqual(["request failed: EACCES"]);
    expect(files()).toEqual([]);
  });

  it("keeps the old totals when a run fails, and the next run works", async () => {
    let fail = false;
    class Flaky extends ReportStore {
      override async list(): Promise<ShareReport[]> {
        if (fail) throw Object.assign(new Error(dir), { code: "EIO" });
        return super.list();
      }
    }
    c = await open({ store: new Flaky(dir) });
    for (let i = 0; i < 3; i++) await post(report({ install: randomInstall() }));
    await c.recompute();
    const before = c.metrics();
    await post(report({ install: randomInstall() }));
    fail = true;
    await c.recompute();
    expect(c.metrics()).toBe(before);
    expect(logs.error).toEqual(["totals failed: EIO"]);
    fail = false;
    await c.recompute();
    expect(day(c)!.installs).toBe(4);
  });

  it("drops an upload the client aborts and keeps working", async () => {
    c = await open();
    await new Promise<void>((resolve) => {
      const req = request({ ...base, method: "POST", path: "/api/metrics", headers: { "content-type": "application/json", "content-length": "5000" } });
      req.on("error", () => resolve());
      req.write("{\"install\":", () => req.destroy());
      req.on("close", () => resolve());
    });
    expect((await post(report({ install: randomInstall() }))).status).toBe(200);
    expect(files()).toHaveLength(1);
    expect(logs.error).toEqual([]);
  });

  it("lets an upload still arriving finish when shutdown starts", async () => {
    let arrived!: () => void;
    const started = new Promise<void>((r) => (arrived = r));
    c = await open({ hooks: { requestStarted: () => arrived() } });
    const id = randomInstall();
    const body = JSON.stringify(report({ install: id }));
    const half = Math.floor(body.length / 2);
    const req = request({ ...base, method: "POST", path: "/api/metrics", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
    const reply = new Promise<number>((resolve, reject) => {
      req.on("response", (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode!));
      });
      req.on("error", reject);
    });
    req.write(body.slice(0, half));
    await started;
    const closed = c.close();
    req.end(body.slice(half));
    expect(await reply).toBe(200);
    await closed;
    expect(files()).toEqual([join("reports", id, `${DAY}.json`)]);
  });

  it("does not start when the data folder cannot be read", async () => {
    logs = { info: [], error: [] };
    class Unreadable extends ReportStore {
      override async list(): Promise<ShareReport[]> {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
    }
    const col = createCollector({ dataDir: dir, now: () => NOW, store: new Unreadable(dir), log: { info: () => {}, error: (m) => logs.error.push(m) } });
    await expect(col.start()).rejects.toThrow("denied");
    expect(col.metrics()).toBeUndefined();
    await col.close();
  });

  it("serves metrics.json once the first run is done, and refuses other routes", async () => {
    c = await open();
    expect(await send("GET", "/metrics.json")).toMatchObject({ status: 503, body: { error: "not_ready" } });
    await c.start();
    const res = await send("GET", "/metrics.json?x=1");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toMatchObject({ version: 1, days: [], weeks: [] });
    expect((await send("HEAD", "/metrics.json")).status).toBe(200);
    expect(await send("GET", "/api/metrics")).toMatchObject({ status: 405, body: { error: "method_not_allowed" } });
    expect(await send("POST", "/metrics.json", "{}")).toMatchObject({ status: 405 });
    expect(await send("GET", "/other")).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("stops its timer on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      c = createCollector({ dataDir: dir, now: () => NOW, unrefTimer: false, log: { info: () => {}, error: () => {} } });
      await c.start();
      expect(vi.getTimerCount()).toBe(1);
      await c.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes reports built by #893 end to end", async () => {
    c = await open();
    for (let i = 0; i < 3; i++) {
      const r = shareReportFrom({ day: "2026-11-19", accountIds: ["A"], install: randomInstall(), foundryVersion: "0.4.0", briefs: [], runs: [], watcherSources: new Map() });
      expect(await post(r)).toMatchObject({ status: 200, body: { stored: true } });
    }
    await c.recompute();
    const res = await send("GET", "/metrics.json");
    const d = res.body.days.find((x: { day: string }) => x.day === "2026-11-19");
    expect(d).toMatchObject({ installs: 3, accounts: 3, changes: { runsStarted: 0 } });
    expect(res.body.sharing).toEqual({ since: "2026-11-13", installs: 3, accounts: 3 });
  });
});
