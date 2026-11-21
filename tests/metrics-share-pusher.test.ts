import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  METRICS_PUSH_WORDS, RETRY_BASE_MS, RETRY_MAX_MS, dueDays, metricsPusher, pruneDays, retryWaitMs, type PusherDeps, type SharingConfig,
} from "../src/metrics-share/pusher.js";
import type { ShareReport } from "../src/metrics-share/report.js";
import { MAX_DELETES, saveShareState, type ShareState } from "../src/metrics-share/state.js";
import { fakeReceiver, type FakeReceiver } from "./fixtures/fake-receiver.js";

const A = "3f1c3c8e-8a5e-4c43-9f43-0a0e2f6b9b51";
const OLD = "0123456789abcdef0123456789abcdef";
const MIN = 60_000;
let dir: string;
let file: string;
let lockFile: string;
let now: Date;
let cfg: SharingConfig;
let accounts: string[] | "broken";
let logs: string[];
let r: FakeReceiver;
let open: FakeReceiver[];

const at = (iso: string) => void (now = new Date(iso));
const later = (ms: number) => void (now = new Date(now.getTime() + ms));
const read = (): ShareState => JSON.parse(readFileSync(file, "utf8"));
const put = (s: Partial<ShareState>) => writeFileSync(file, JSON.stringify({ version: 1, install: OLD, posted: false, days: {}, deletes: [], ...s }));
const posts = (rr = r) => rr.got.filter((g) => g.method === "POST").map((g) => JSON.parse(g.body) as { day: string; install: string });
const deletes = (rr = r) => rr.got.filter((g) => g.method === "DELETE").map((g) => g.url);

function pusher(o: Partial<PusherDeps> = {}) {
  return metricsPusher({
    config: () => cfg,
    accounts: () => {
      if (accounts === "broken") throw new Error("users.json cannot be read");
      return accounts;
    },
    build: async (day, _acc, install) => ({ day, install }) as unknown as ShareReport,
    version: "0.4.0",
    log: (l) => logs.push(l),
    now: () => now,
    file,
    lockFile,
    ...o,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "metrics-push-"));
  file = join(dir, "metrics-share.json");
  lockFile = join(dir, "metrics-share.lock");
  logs = [];
  open = [];
  r = await fakeReceiver();
  open.push(r);
  cfg = { allowed: true, endpoint: r.endpoint, timeout_ms: 5000 };
  accounts = [A];
  at("2026-11-20T10:00:00.000Z");
});
afterEach(async () => {
  await Promise.all(open.map((x) => x.close()));
  rmSync(dir, { recursive: true, force: true });
});

describe("the daily push", () => {
  it("sends each ended day once, from the day sharing started, also across a restart", async () => {
    const p = pusher();
    await p.tick();
    expect(r.got).toHaveLength(0);
    const s = read();
    expect(s.activeSince).toBe("2026-11-20");
    expect(s.install).toMatch(/^[0-9a-f]{32}$/);
    expect(s.install).not.toBe("0".repeat(32));
    at("2026-11-21T00:01:00.000Z");
    await p.tick();
    expect(posts()).toEqual([{ day: "2026-11-20", install: s.install }]);
    await p.tick();
    await pusher().tick();
    expect(posts()).toHaveLength(1);
    expect(read().days["2026-11-20"]!.accepted).toBe(now.toISOString());
    expect(read().last).toEqual({ at: now.toISOString(), request: "send", day: "2026-11-20", result: "accepted", status: 200 });
    at("2026-11-22T03:00:00.000Z");
    await pusher().tick();
    expect(posts().map((x) => x.day)).toEqual(["2026-11-20", "2026-11-21"]);
  });

  it("sends nothing and writes no file without a yes or while an admin does not allow sharing", async () => {
    accounts = [];
    const p = pusher();
    for (const d of ["2026-11-20", "2026-11-21", "2026-11-22"]) {
      at(`${d}T12:00:00.000Z`);
      await p.tick();
    }
    accounts = [A];
    cfg = { ...cfg, allowed: false };
    for (const d of ["2026-11-23", "2026-11-24"]) {
      at(`${d}T12:00:00.000Z`);
      await p.tick();
    }
    expect(r.got).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });

  it("waits 15 minutes after a failure, then 30; a longer retry_after wins", async () => {
    put({ activeSince: "2026-11-19" });
    r.answer = () => ({ status: 500 });
    at("2026-11-20T00:00:00.000Z");
    const p = pusher();
    await p.tick();
    expect(posts()).toHaveLength(1);
    later(15 * MIN - 1);
    await p.tick();
    expect(posts()).toHaveLength(1);
    later(1);
    await p.tick();
    expect(posts()).toHaveLength(2);
    later(30 * MIN - 1);
    await p.tick();
    expect(posts()).toHaveLength(2);
    later(1);
    r.answer = () => ({ status: 429, body: JSON.stringify({ retry_after: 7200 }) });
    await p.tick();
    expect(posts()).toHaveLength(3);
    later(2 * 60 * MIN - 1);
    await p.tick();
    expect(posts()).toHaveLength(3);
    later(1);
    r.answer = () => ({ status: 200 });
    await p.tick();
    expect(posts()).toHaveLength(4);
    expect(read().days["2026-11-19"]).toMatchObject({ tries: 4 });
  });

  it("tries a day exactly 7 days old, never one 8 days old, and prunes its entry", async () => {
    put({ activeSince: "2026-11-01", posted: true, endpoint: r.endpoint, days: { "2026-11-12": { tries: 3 } } });
    at("2026-11-20T01:00:00.000Z");
    await pusher().tick();
    expect(posts().map((x) => x.day)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(read().days["2026-11-12"]).toBeUndefined();
  });

  it("does not follow a redirect and tries the day again later", async () => {
    const other = await fakeReceiver();
    open.push(other);
    r.answer = () => ({ status: 302, headers: { Location: other.endpoint } });
    put({ activeSince: "2026-11-19" });
    await pusher().tick();
    expect(other.got).toHaveLength(0);
    expect(read().last).toMatchObject({ request: "send", day: "2026-11-19", result: "refused", status: 302 });
    expect(read().days["2026-11-19"]).toEqual({ tries: 1, nextAt: new Date(now.getTime() + RETRY_BASE_MS).toISOString() });
  });

  it("does not send a report when sharing ends while it is built", async () => {
    put({ activeSince: "2026-11-19" });
    let started!: () => void;
    const building = new Promise<void>((res) => (started = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const p = pusher({
      build: async (day, _a, install) => {
        started();
        await gate;
        return { day, install } as unknown as ShareReport;
      },
    });
    const t = p.tick();
    await building;
    cfg = { ...cfg, allowed: false };
    release();
    await t;
    expect(r.got).toHaveLength(0);
  });

  it("logs one fixed line for failures in a row, without values", async () => {
    put({ activeSince: "2026-11-19" });
    r.answer = () => ({ status: 500 });
    const p = pusher();
    await p.tick();
    later(RETRY_BASE_MS);
    await p.tick();
    expect(posts()).toHaveLength(2);
    expect(logs).toEqual([METRICS_PUSH_WORDS.failing]);
    const port = new URL(r.endpoint).port;
    for (const bad of [port, "500", "2026-11-19", read().install]) expect(logs[0]).not.toContain(bad);
  });
});

describe("a stop", () => {
  async function postedOnce(): Promise<string> {
    put({ activeSince: "2026-11-19" });
    await pusher().tick();
    expect(posts()).toHaveLength(1);
    return read().install;
  }

  it("sends one DELETE for the old id and starts a later yes with a new id", async () => {
    const old = await postedOnce();
    cfg = { ...cfg, allowed: false };
    const p = pusher();
    await p.tick();
    await p.tick();
    expect(deletes()).toEqual([`/api/metrics/${old}`]);
    const s = read();
    expect(s.install).toMatch(/^[0-9a-f]{32}$/);
    expect(s.install).not.toBe(old);
    expect(s.install).not.toBe("0".repeat(32));
    expect(s.deletes).toEqual([]);
    expect(s.last).toMatchObject({ request: "delete", result: "accepted", status: 200 });
    cfg = { ...cfg, allowed: true };
    await p.tick();
    at("2026-11-21T00:05:00.000Z");
    await p.tick();
    expect(posts().at(-1)).toEqual({ day: "2026-11-20", install: s.install });
  });

  it("also when the last account says no; no DELETE without an earlier POST", async () => {
    await pusher().tick(); // sharing starts today: nothing posted yet
    const first = read().install;
    accounts = [];
    await pusher().tick();
    expect(r.got).toHaveLength(0);
    expect(read().install).not.toBe(first);
    expect(read().activeSince).toBeUndefined();
    accounts = [A];
    const old = await postedOnce();
    accounts = [];
    await pusher().tick();
    expect(deletes()).toEqual([`/api/metrics/${old}`]);
  });

  it("retries a failed DELETE and drops it after 7 days", async () => {
    await postedOnce();
    r.answer = (g) => (g.method === "DELETE" ? { status: 500 } : { status: 200 });
    cfg = { ...cfg, allowed: false };
    const p = pusher();
    await p.tick();
    later(RETRY_BASE_MS);
    await p.tick();
    expect(deletes()).toHaveLength(2);
    later(8 * 86_400_000);
    await p.tick();
    expect(deletes()).toHaveLength(2);
    expect(read().deletes).toEqual([]);
  });

  it("saves the stop before the DELETE: a restart sends the pending DELETE once and never reuses the old id", async () => {
    const old = await postedOnce();
    let arrived!: () => void;
    const got = new Promise<void>((res) => (arrived = res));
    r.answer = () => {
      arrived();
      return "hang";
    };
    cfg = { ...cfg, allowed: false };
    const p = pusher();
    const t = p.tick();
    await got;
    const saved = read();
    expect(saved.install).not.toBe(old);
    expect(saved.deletes).toMatchObject([{ install: old, endpoint: r.endpoint }]);
    p.stop(); // the server goes down with the DELETE in flight
    await t;
    r.answer = () => ({ status: 200 });
    const again = pusher();
    await again.tick();
    await again.tick();
    expect(deletes()).toEqual([`/api/metrics/${old}`, `/api/metrics/${old}`]);
    expect(read().install).toBe(saved.install);
    expect(read().deletes).toEqual([]);
  });

  it("sends nothing when the stop cannot be saved", async () => {
    await postedOnce();
    const before = readFileSync(file, "utf8");
    cfg = { ...cfg, allowed: false };
    await pusher({ save: () => false }).tick();
    expect(deletes()).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("sends the DELETE to the old endpoint after an endpoint change, and POSTs to the new one with a new id", async () => {
    const old = await postedOnce();
    const b = await fakeReceiver();
    open.push(b);
    cfg = { ...cfg, endpoint: b.endpoint };
    await pusher().tick();
    expect(deletes()).toEqual([`/api/metrics/${old}`]);
    expect(b.got).toHaveLength(0);
    at("2026-11-21T00:05:00.000Z");
    await pusher().tick();
    const fresh = read().install;
    expect(fresh).not.toBe(old);
    expect(posts(b)).toEqual([{ day: "2026-11-20", install: fresh }]);
    expect(posts()).toHaveLength(1);
  });

  it("waits with a stop while the delete list is full, and loses no entry", async () => {
    const queued = Array.from({ length: MAX_DELETES }, (_, i) => ({ install: i.toString(16).padStart(32, "a"), endpoint: r.endpoint, since: "2026-11-20", tries: 1, nextAt: "2026-11-30T00:00:00.000Z" }));
    put({ posted: true, endpoint: r.endpoint, activeSince: "2026-11-18", deletes: queued });
    cfg = { ...cfg, allowed: false };
    await pusher().tick();
    expect(r.got).toHaveLength(0);
    expect(read().install).toBe(OLD);
    expect(read().deletes).toHaveLength(MAX_DELETES);
  });

  it("never counts an unreadable users.json as a no", async () => {
    await postedOnce();
    accounts = "broken";
    await pusher().tick();
    expect(deletes()).toEqual([]);
  });
});

describe("the state file and the lock", () => {
  it("sends nothing for a broken state file, logs once and leaves it as it is", async () => {
    writeFileSync(file, "{broken");
    const p = pusher();
    await p.tick();
    await p.tick();
    expect(r.got).toHaveLength(0);
    expect(logs).toEqual([METRICS_PUSH_WORDS.broken]);
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });

  it("skips a tick while the lock is held, and takes over a stale lock", async () => {
    put({ activeSince: "2026-11-19" });
    writeFileSync(lockFile, "other");
    await pusher().tick();
    expect(r.got).toHaveLength(0);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockFile, old, old);
    await pusher().tick();
    expect(posts()).toHaveLength(1);
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe("failures inside the pusher", () => {
  it("keeps an accepted day in memory when its save fails: nothing more goes out until the state is saved", async () => {
    put({ activeSince: "2026-11-19" });
    let broken = true;
    const p = pusher({ save: (s, f) => (broken && s.days["2026-11-19"]?.accepted ? false : saveShareState(s, f)) });
    await p.tick();
    expect(posts()).toHaveLength(1);
    expect(logs).toEqual([METRICS_PUSH_WORDS.unsaved]);
    await p.tick();
    expect(posts()).toHaveLength(1);
    broken = false;
    await p.tick();
    expect(posts()).toHaveLength(1);
    expect(read().days["2026-11-19"]?.accepted).toBe(now.toISOString());
    expect(logs).toEqual([METRICS_PUSH_WORDS.unsaved]);
  });

  it("treats a report that cannot be built as a failed try: it logs once and waits", async () => {
    put({ activeSince: "2026-11-19" });
    const p = pusher({
      build: async () => {
        throw new Error("boom");
      },
    });
    await p.tick();
    expect(r.got).toHaveLength(0);
    expect(read().days["2026-11-19"]).toEqual({ tries: 1, nextAt: new Date(now.getTime() + RETRY_BASE_MS).toISOString() });
    expect(read().last).toMatchObject({ request: "send", day: "2026-11-19", result: "error" });
    expect(logs).toEqual([METRICS_PUSH_WORDS.failing]);
    later(RETRY_BASE_MS - 1);
    await p.tick();
    expect(read().days["2026-11-19"]?.tries).toBe(1);
  });

  it("retries a failed day from before the start of sharing once it is due", async () => {
    put({ activeSince: "2026-11-20", days: { "2026-11-19": { tries: 1 } } });
    await pusher().tick();
    expect(posts().map((x) => x.day)).toEqual(["2026-11-19"]);
  });
});

describe("the rules", () => {
  it("retryWaitMs doubles from 15 minutes up to 24 hours", () => {
    expect(retryWaitMs(1)).toBe(15 * MIN);
    expect(retryWaitMs(2)).toBe(30 * MIN);
    expect(retryWaitMs(3)).toBe(60 * MIN);
    expect(retryWaitMs(20)).toBe(RETRY_MAX_MS);
    expect(retryWaitMs(1, 7200)).toBe(7_200_000);
    expect(retryWaitMs(3, 60)).toBe(60 * MIN);
  });

  it("dueDays and pruneDays use the same 7-day boundary", () => {
    const n = new Date("2026-11-20T05:00:00.000Z");
    const s: ShareState = {
      version: 1, install: OLD, activeSince: "2026-11-10", posted: true, deletes: [],
      days: { "2026-11-12": { tries: 1 }, "2026-11-13": { tries: 1 }, "2026-11-14": { accepted: "x", tries: 1 }, "2026-11-15": { tries: 1, nextAt: "2026-11-20T06:00:00.000Z" } },
    };
    expect(dueDays(s, n)).toEqual(["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(dueDays({ ...s, activeSince: "2026-11-18" }, n)).toEqual(["2026-11-13", "2026-11-18", "2026-11-19"]);
    expect(dueDays({ ...s, activeSince: undefined }, n)).toEqual([]);
    expect(pruneDays(s, n)).toBe(true);
    expect(Object.keys(s.days)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(pruneDays(s, n)).toBe(false);
  });
});
