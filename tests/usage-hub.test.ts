import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "../src/usage/events.js";
import { disposeUsage, emitUsage, QUEUE_MAX, REASON_FULL, REASON_SKIPPED, REASON_THREW, REASON_TIMEOUT, resetUsage, subscribeUsage, usageDir, usageIdle } from "../src/usage/hub.js";

let home: string;
let before: string | undefined;
beforeEach(() => {
  before = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "factory-usage-"));
  chmodSync(home, 0o700);
  process.env.FACTORY_HOME = home;
  resetUsage();
});
afterEach(() => {
  resetUsage();
  process.env.FACTORY_HOME = before;
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
const ev = (over: Partial<UsageEvent> = {}, time = "2026-11-04T10:00:00.000Z"): UsageEvent => ({ id: `r:step:${++n}`, time, runId: "r", workspace: "", name: "run.started", ...over }) as UsageEvent;
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
const monthFile = (m = "2026-11") => join(usageDir(), `usage-${m}.jsonl`);

describe("the usage file", () => {
  it("appends one JSON object per line, in the file of the UTC month", () => {
    const a = ev();
    const b = ev({}, "2026-12-01T00:00:00.000Z");
    emitUsage([a, b]);
    expect(lines(monthFile())).toEqual([a]);
    expect(lines(monthFile("2026-12"))).toEqual([b]);
  });
  it("repairs the modes of the folder and the file", () => {
    emitUsage(ev());
    chmodSync(usageDir(), 0o755);
    chmodSync(monthFile(), 0o644);
    emitUsage(ev());
    expect(lstatSync(usageDir()).mode & 0o777).toBe(0o700);
    expect(lstatSync(monthFile()).mode & 0o777).toBe(0o600);
    expect(lines(monthFile())).toHaveLength(2);
  });
  it("writes nothing through a symlinked folder", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    symlinkSync(elsewhere, usageDir());
    emitUsage(ev());
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });
  it("writes nothing through a symlinked file", () => {
    mkdirSync(usageDir(), { mode: 0o700 });
    const target = join(home, "target.txt");
    writeFileSync(target, "");
    symlinkSync(target, monthFile());
    emitUsage(ev());
    expect(readFileSync(target, "utf8")).toBe("");
  });
  it("does not block on a FIFO", () => {
    mkdirSync(usageDir(), { mode: 0o700 });
    try {
      execFileSync("mkfifo", [monthFile()]);
    } catch {
      return; // no mkfifo here (Windows)
    }
    emitUsage(ev());
    expect(existsSync(monthFile())).toBe(true);
  });
  it("puts a newline after a torn last line", () => {
    mkdirSync(usageDir(), { mode: 0o700 });
    writeFileSync(monthFile(), '{"torn":', { mode: 0o600 });
    const a = ev();
    emitUsage(a);
    const raw = readFileSync(monthFile(), "utf8").split("\n");
    expect(raw[0]).toBe('{"torn":');
    expect(JSON.parse(raw[1]!)).toEqual(a);
  });
  it("does not write into a data folder that others can write to", () => {
    chmodSync(home, 0o777);
    emitUsage(ev());
    expect(existsSync(usageDir())).toBe(false);
  });
});

describe("delivery", () => {
  const sub = (handler: (e: Readonly<UsageEvent>) => unknown, extra: { timeoutMs?: number; owner?: string; plugin?: string } = {}) => {
    const problems: string[] = [];
    const off = subscribeUsage({ owner: extra.owner ?? "o", plugin: extra.plugin ?? "p", handler: handler as never, report: (r) => problems.push(r), timeoutMs: extra.timeoutMs });
    return { problems, off };
  };

  it("returns before the handler runs, and gives it a frozen copy", async () => {
    const got: Readonly<UsageEvent>[] = [];
    sub((e) => void got.push(e));
    const a = ev();
    emitUsage(a);
    expect(got).toEqual([]);
    await usageIdle();
    expect(got).toEqual([a]);
    expect(got[0]).not.toBe(a);
    expect(Object.isFrozen(got[0])).toBe(true);
  });
  it("drops an id it has seen and an invalid event", async () => {
    const got: string[] = [];
    sub((e) => void got.push(e.id));
    const a = ev();
    emitUsage([a, a, { ...a, id: "other", extra: 1 } as never, { nope: true } as never]);
    await usageIdle();
    expect(got).toEqual([a.id]);
    expect(lines(monthFile())).toHaveLength(1);
  });
  it("keeps going when a handler throws, and reports it once", async () => {
    const got: string[] = [];
    const bad = sub(() => {
      throw new Error("secret detail");
    });
    sub((e) => void got.push(e.id), { plugin: "good" });
    const [a, b] = [ev(), ev()];
    emitUsage([a, b]);
    await usageIdle();
    expect(got).toEqual([a.id, b.id]);
    expect(bad.problems).toEqual([REASON_THREW]);
  });
  it("reports a handler that rejects", async () => {
    const bad = sub(() => Promise.reject(new Error("x")));
    emitUsage(ev());
    await usageIdle();
    expect(bad.problems).toEqual([REASON_THREW]);
  });
  it("gives up on a handler that never settles and skips it after 3 stuck calls", async () => {
    let calls = 0;
    const stuck = sub(() => {
      calls++;
      return new Promise(() => {});
    }, { timeoutMs: 5 });
    const got: string[] = [];
    sub((e) => void got.push(e.id), { plugin: "good" });
    const all = Array.from({ length: 6 }, () => ev());
    emitUsage(all);
    // the stuck calls never settle, so the wait is bounded here
    await usageIdle(200);
    expect(calls).toBe(3);
    expect(got).toEqual(all.map((e) => e.id));
    expect(stuck.problems).toEqual([REASON_TIMEOUT, REASON_SKIPPED]);
  });
  it("lets a slow handler finish its late call without counting it as stuck any more", async () => {
    let release!: () => void;
    let calls = 0;
    sub(() => {
      calls++;
      return calls === 1 ? new Promise<void>((r) => (release = r)) : undefined;
    }, { timeoutMs: 5 });
    emitUsage([ev(), ev(), ev(), ev(), ev()]);
    // let the first call start, then let it finish late
    await new Promise((r) => setImmediate(r));
    release();
    await usageIdle(5000);
    expect(calls).toBe(5);
  });
  it("waits for a handler call still running after its subscription was disposed", async () => {
    let release!: () => void;
    sub(() => new Promise<void>((r) => (release = r)), { owner: "a" });
    emitUsage(ev());
    await new Promise((r) => setImmediate(r)); // the call has started
    disposeUsage("a");
    const state = { idle: false };
    const idleP = usageIdle(2000).then(() => (state.idle = true));
    await new Promise((r) => setImmediate(r));
    expect(state.idle).toBe(false);
    release();
    await idleP;
    expect(state.idle).toBe(true);
  });
  it("drops events and reports once when a queue is full", async () => {
    let release!: () => void;
    const slow = sub(() => new Promise<void>((r) => (release = r)), { timeoutMs: 60_000 });
    emitUsage(ev());
    await new Promise((r) => setImmediate(r)); // the first call is running
    emitUsage(Array.from({ length: QUEUE_MAX + 5 }, () => ev()));
    expect(slow.problems).toEqual([REASON_FULL]);
    resetUsage();
    release();
  });
  it("still stores the event when the file cannot be written", async () => {
    chmodSync(home, 0o777);
    const got: string[] = [];
    sub((e) => void got.push(e.id));
    const a = ev();
    emitUsage(a);
    await usageIdle();
    expect(got).toEqual([a.id]);
  });
  it("removes the handlers of an owner, and keeps those of others", async () => {
    const mine: string[] = [];
    const other: string[] = [];
    sub((e) => void mine.push(e.id), { owner: "a" });
    sub((e) => void other.push(e.id), { owner: "b" });
    disposeUsage("a");
    const a = ev();
    emitUsage(a);
    await usageIdle();
    expect(mine).toEqual([]);
    expect(other).toEqual([a.id]);
  });
  it("drops queued events when the owner is disposed", async () => {
    const got: string[] = [];
    sub((e) => void got.push(e.id), { owner: "a" });
    emitUsage(ev());
    disposeUsage("a");
    await usageIdle();
    expect(got).toEqual([]);
  });
  it("stops with the function subscribeUsage returns", async () => {
    const got: string[] = [];
    const s = sub((e) => void got.push(e.id));
    s.off();
    emitUsage(ev());
    await usageIdle();
    expect(got).toEqual([]);
  });
  it("never throws, whatever it is given", () => {
    expect(() => emitUsage(undefined as never)).not.toThrow();
    expect(() => emitUsage([null, 5, "x"] as never)).not.toThrow();
  });
});
