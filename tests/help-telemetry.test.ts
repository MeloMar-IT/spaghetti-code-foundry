import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEEDBACK_REASONS, REFUSAL_CODES } from "../src/help/store.js";
import { COUNTERS, LATENCY_BOUNDS_S, STATS_KEEP_DAYS, addStats, emptyStats, latencyBucket, readStats, statsPath, sumStats, sweepStats } from "../src/help/telemetry.js";

let home: string;
let saved: string | undefined;
let t: number;
const now = () => new Date(t);
const opts = { now };
const DAY = 86_400_000;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "help-stats-"));
  process.env.FACTORY_HOME = home;
  t = Date.parse("2026-03-01T10:00:00.000Z");
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("the quality numbers", () => {
  it("makes the row of the day and adds up", () => {
    addStats({ counts: { turns: 1, answered: 1 }, failed: { timeout: 1 }, refused: { paused: 1 }, latencyMs: 1200 }, opts);
    addStats({ counts: { turns: 2 }, failed: { timeout: 1, provider: 1 }, reasons: { unclear: 1 }, latencyMs: 61_000 }, opts);
    const rows = readStats();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: "2026-03-01", turns: 3, answered: 1, failed: { timeout: 2, provider: 1 }, refused: { paused: 1 }, reasons: { unclear: 1 }, latency: [1, 0, 0, 0, 1, 0] });
  });

  it("never goes below zero and ignores what is not a number", () => {
    addStats({ counts: { helpful: 1 } }, opts);
    addStats({ counts: { helpful: -5, turns: Number.NaN, answered: 2.9 }, failed: { timeout: -1 }, latencyMs: Number.NaN }, opts);
    const row = readStats()[0]!;
    expect(row.helpful).toBe(0);
    expect(row.turns).toBe(0);
    expect(row.answered).toBe(2);
    expect(row.failed).toEqual({});
    expect(row.latency).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("puts a duration in its bucket", () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(4999)).toBe(0);
    expect(latencyBucket(5000)).toBe(1);
    expect(latencyBucket(119_999)).toBe(4);
    expect(latencyBucket(120_000)).toBe(5);
    expect(latencyBucket(Number.POSITIVE_INFINITY)).toBe(0);
    expect(latencyBucket(-3)).toBe(0);
    expect(LATENCY_BOUNDS_S).toHaveLength(5);
  });

  it("books on the day it is told, and ignores a day that is past the keep time", () => {
    addStats({ counts: { helpful: 1 } }, { ...opts, day: "2026-02-27" });
    addStats({ counts: { helpful: 1 } }, { ...opts, day: new Date(t - (STATS_KEEP_DAYS + 1) * DAY).toISOString().slice(0, 10) });
    expect(readStats().map((r) => [r.day, r.helpful])).toEqual([["2026-02-27", 1]]);
  });

  it("removes the rows that are older than the keep time", () => {
    addStats({ counts: { turns: 1 } }, { ...opts, day: "2026-03-01" });
    t += (STATS_KEEP_DAYS + 1) * DAY;
    expect(sweepStats(opts)).toBe(1);
    expect(readStats()).toEqual([]);
    expect(sweepStats(opts)).toBe(0);
  });

  it("holds counts only: no account, no conversation, no text", () => {
    addStats({ counts: { turns: 1 } }, opts);
    const file = JSON.parse(readFileSync(statsPath(), "utf8"));
    expect(Object.keys(file).sort()).toEqual(["days", "version"]);
    const allowed = new Set(["day", ...COUNTERS, "failed", "refused", "reasons", "latency"]);
    for (const k of Object.keys(file.days[0])) expect(allowed.has(k), k).toBe(true);
    // an unknown key makes the file unreadable, so an account id or a text can never be kept in it
    for (const extra of [{ owner: "x" }, { text: "hello" }, { conversation: "c" }]) {
      writeFileSync(statsPath(), JSON.stringify({ version: 1, days: [{ ...file.days[0], ...extra }] }));
      expect(() => readStats()).toThrow();
    }
    writeFileSync(statsPath(), JSON.stringify({ version: 1, days: [{ ...file.days[0], failed: { "made-up": 1 } }] }));
    expect(() => readStats()).toThrow();
    writeFileSync(statsPath(), "not json");
    expect(() => readStats()).toThrow();
    expect(() => addStats({ counts: { turns: 1 } }, opts)).toThrow();
  });

  it("knows every code that is refused and every reason", () => {
    addStats({ refused: Object.fromEntries(REFUSAL_CODES.map((c) => [c, 1])), reasons: Object.fromEntries(FEEDBACK_REASONS.map((c) => [c, 1])) }, opts);
    const row = readStats()[0]!;
    expect(Object.keys(row.refused)).toEqual([...REFUSAL_CODES]);
    expect(Object.keys(row.reasons).sort()).toEqual([...FEEDBACK_REASONS].sort());
  });

  it("sums rows under a label", () => {
    addStats({ counts: { turns: 1, helpful: 1 }, failed: { quota: 1 }, latencyMs: 100 }, { ...opts, day: "2026-03-01" });
    addStats({ counts: { turns: 2 }, failed: { quota: 2 }, reasons: { incorrect: 1 }, latencyMs: 100 }, { ...opts, day: "2026-02-28" });
    const sum = sumStats(readStats(), "last 7 days");
    expect(sum).toMatchObject({ day: "last 7 days", turns: 3, helpful: 1, failed: { quota: 3 }, reasons: { incorrect: 1 }, latency: [2, 0, 0, 0, 0, 0] });
    expect(sumStats([], "none")).toEqual(emptyStats("none"));
  });
});
