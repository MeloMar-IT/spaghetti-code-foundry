import { mkdirSync, mkdtempSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastLogWrite } from "../src/monitor/monitor.js";
import { userRun } from "../src/server/user-view.js";
import { newestSlotWait, readSlotWaits, SLOT_WAITS_DIR, slotClock, slotWaitLimitMs, slotWaitText, timedOutError, WAIT_STALE_MS, type SlotWait } from "../src/steps/slot-waits.js";
import { slotWaitsRecordable } from "../src/agents/run.js";

const closed = (from: number, to: number): SlotWait => ({ from, to, open: false });
const open = (from: number, to: number): SlotWait => ({ from, to, open: true });
const clock = (waits: SlotWait[], now: number, o: { limitMs?: number; maxExtraMs?: number } = {}) => slotClock(waits, { began: 0, limitMs: o.limitMs ?? 10_000, maxExtraMs: o.maxExtraMs ?? 5_400_000, now });

describe("slotClock", () => {
  it("a 10 s limit with 8 s of wait is not up at 10 s and is up at 18 s", () => {
    const waits = [closed(2000, 10_000)];
    expect(clock(waits, 10_000)).toEqual({ nextCheckMs: 8000, waitedMs: 8000, countedMs: 8000 });
    expect(clock(waits, 18_000).nextCheckMs).toBe(0);
  });

  it("without a wait the time is up at the limit", () => {
    expect(clock([], 9_999).nextCheckMs).toBe(1);
    expect(clock([], 10_000).nextCheckMs).toBe(0);
  });

  it("an open wait keeps the next look at least a second away", () => {
    const c = clock([open(9_500, 10_000)], 10_000);
    expect(c.nextCheckMs).toBeGreaterThanOrEqual(1000);
  });

  it("a wait that stays open until the bound ends the step at limit + bound", () => {
    const o = { limitMs: 10_000, maxExtraMs: 5_000 };
    expect(clock([open(0, 15_000)], 15_000, o)).toMatchObject({ nextCheckMs: 0, countedMs: 5_000, waitedMs: 15_000 });
    expect(clock([open(0, 14_999)], 14_999, o).nextCheckMs).toBe(1);
  });

  it("never schedules a look past limit + bound, also while some allowance is left", () => {
    // limit 200, bound 500: at 200 the allowance is nearly all there, the floor of 1 s would reach 1200 instead of 700
    const o = { limitMs: 200, maxExtraMs: 500 };
    expect(clock([open(0, 200)], 200, o).nextCheckMs).toBe(500);
    for (const now of [1, 200, 450, 699]) expect(now + clock([open(0, now)], now, o).nextCheckMs).toBeLessThanOrEqual(700);
  });

  it("overlapping waits count once", () => {
    const c = clock([closed(0, 6000), closed(3000, 9000)], 12_000, { limitMs: 5000 });
    expect(c.waitedMs).toBe(9000);
    expect(c.countedMs).toBe(9000);
  });

  it("a wait before the process began is clipped, and a time in the future is clipped to now", () => {
    expect(slotClock([closed(0, 3000)], { began: 1000, limitMs: 10_000, maxExtraMs: 1e9, now: 5000 }).waitedMs).toBe(2000);
    expect(clock([closed(1000, 99_000)], 4000).waitedMs).toBe(3000);
  });

  it("a bound of 0 gives no credit", () => {
    expect(clock([closed(0, 8000)], 10_000, { maxExtraMs: 0 })).toEqual({ nextCheckMs: 0, waitedMs: 8000, countedMs: 0 });
  });
});

describe("readSlotWaits", () => {
  const folder = () => mkdtempSync(join(tmpdir(), "waits-"));
  const touch = (file: string, ms: number) => utimesSync(file, ms / 1000, ms / 1000);

  it("reads done files up to their last touch, and fresh and stale wait files", () => {
    const d = folder();
    const now = 1_000_000_000_000;
    writeFileSync(join(d, "100-1.done"), "");
    touch(join(d, "100-1.done"), now - 60_000);
    writeFileSync(join(d, "200-2.wait"), "");
    touch(join(d, "200-2.wait"), now - 1000);
    writeFileSync(join(d, "300-3.wait"), "");
    touch(join(d, "300-3.wait"), now - WAIT_STALE_MS - 5000);
    const waits = readSlotWaits(d, now);
    expect(waits).toHaveLength(3);
    expect(waits).toContainEqual({ from: 100, to: now - 60_000, open: false });
    expect(waits).toContainEqual({ from: 200, to: now, open: true });
    expect(waits).toContainEqual({ from: 300, to: now - WAIT_STALE_MS - 5000, open: false });
  });

  it("ignores other names, folders and links, and a missing folder gives nothing", () => {
    const d = folder();
    writeFileSync(join(d, "notes.txt"), "");
    writeFileSync(join(d, "1-2.wait.bak"), "");
    mkdirSync(join(d, "5-5.wait"));
    writeFileSync(join(d, "target"), "");
    symlinkSync(join(d, "target"), join(d, "6-6.done"));
    expect(readSlotWaits(d, Date.now())).toEqual([]);
    expect(readSlotWaits(join(d, "nope"), Date.now())).toEqual([]);
  });

  it("finds a wait that is renamed to .done between the listing and the look at it", () => {
    const d = folder();
    const now = 1_000_000_000_000;
    writeFileSync(join(d, "500-7.wait"), "");
    touch(join(d, "500-7.wait"), now - 2000);
    const waits = readSlotWaits(d, now, () => renameSync(join(d, "500-7.wait"), join(d, "500-7.done")));
    expect(waits).toEqual([{ from: 500, to: now - 2000, open: false }]);
  });

  it("reads at most the newest 1000 files", () => {
    const d = folder();
    for (let i = 1; i <= 1005; i++) writeFileSync(join(d, `${i}-1.done`), "");
    const waits = readSlotWaits(d, Date.now());
    expect(waits).toHaveLength(1000);
    expect(Math.min(...waits.map((w) => w.from))).toBe(6);
  });
});

describe("texts and settings", () => {
  it("slotWaitLimitMs: 5400 s by default, digits only", () => {
    expect(slotWaitLimitMs({})).toBe(5_400_000);
    expect(slotWaitLimitMs({ FACTORY_TEST_SLOT_WAIT_SEC: "120" })).toBe(120_000);
    expect(slotWaitLimitMs({ FACTORY_TEST_SLOT_WAIT_SEC: "-5" })).toBe(5_400_000);
    expect(slotWaitLimitMs({ FACTORY_TEST_SLOT_WAIT_SEC: "1e3" })).toBe(5_400_000);
  });

  it("slotWaitText and timedOutError", () => {
    expect(slotWaitText(40_000)).toBe("40 s");
    expect(slotWaitText(18 * 60_000)).toBe("18 min");
    expect(timedOutError()).toBe("timed out");
    expect(timedOutError({ waitedMs: 0, countedMs: 0 })).toBe("timed out");
    expect(timedOutError({ waitedMs: 18 * 60_000, countedMs: 18 * 60_000 })).toBe("timed out (waited 18 min for a test slot, which did not count)");
    expect(timedOutError({ waitedMs: 95 * 60_000, countedMs: 90 * 60_000, capped: true })).toBe("timed out (waited 95 min for a test slot, more than the 90 min that can be left out)");
  });

  it("a read-only Codex session cannot record waits; the others can", () => {
    expect(slotWaitsRecordable("codex", "read-only")).toBe(false);
    expect(slotWaitsRecordable("codex", "workspace-write")).toBe(true);
    expect(slotWaitsRecordable("codex", "danger-full-access")).toBe(true);
    expect(slotWaitsRecordable("claude", "read-only")).toBe(true);
  });
});

describe("signs of life and the user view", () => {
  it("newestSlotWait and lastLogWrite see a heartbeat of a wait file", () => {
    const run = mkdtempSync(join(tmpdir(), "run-"));
    expect(newestSlotWait(run)).toBe(0);
    expect(lastLogWrite(run)).toBeUndefined();
    const step = join(run, SLOT_WAITS_DIR, "001-test");
    mkdirSync(step, { recursive: true });
    writeFileSync(join(step, "1-1.wait"), "");
    writeFileSync(join(step, "other.txt"), "");
    utimesSync(join(step, "1-1.wait"), 1_700_000_000, 1_700_000_000);
    expect(newestSlotWait(run)).toBe(1_700_000_000_000);
    expect(lastLogWrite(run)).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("userRun passes slotWaitMs of a step and leaves it out when there is none", () => {
    const base = { runId: "r", flow: "f", source: "ui", task: "t", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z" };
    const rec = { id: "a", type: "shell", visit: 1, ok: true, startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5 };
    const v = userRun({ ...base, history: [{ ...rec, slotWaitMs: 90_000 }, { ...rec, id: "b" }] } as never);
    expect(v.history[0]!.slotWaitMs).toBe(90_000);
    expect("slotWaitMs" in v.history[1]!).toBe(false);
  });
});
