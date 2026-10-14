import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Forecast } from "../src/epics/forecast.js";
import { dropForecasts, epicForecastsDir, forecastHistory, MAX_FORECAST_DAYS, readForecasts, saveForecasts, saveMissingForecasts } from "../src/epics/forecast-store.js";

const range = (n: number): Forecast => ({
  kind: "range", earliest: `2026-11-0${n}T00:00:00Z`, expected: `2026-11-0${n + 1}T00:00:00Z`, latest: `2026-11-0${n + 2}T00:00:00Z`,
  drivers: [], leavesOut: ["usage-limits", "answers"], left: 5, perDay: 1, chain: 1, partsPerStory: 1,
});
const D = (day: string, h = 10) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
const REPO = "acme/app";
const fileName = `${encodeURIComponent(REPO)}.json`;

beforeEach(() => rmSync(epicForecastsDir(), { recursive: true, force: true }));

describe("forecast store", () => {
  it("first save gives one entry for today only", () => {
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"));
    const h = forecastHistory(REPO, "#1");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ day: "2026-10-14", kind: "range", left: 5, expected: "2026-11-02T00:00:00Z" });
  });
  it("the same day overwrites; the next day appends", () => {
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14", 8));
    saveForecasts(REPO, new Map([["#1", range(3)]]), D("2026-10-14", 18));
    expect(forecastHistory(REPO, "#1").map((e) => e.expected)).toEqual(["2026-11-04T00:00:00Z"]);
    saveForecasts(REPO, new Map([["#1", range(2)]]), D("2026-10-15"));
    expect(forecastHistory(REPO, "#1").map((e) => e.day)).toEqual(["2026-10-14", "2026-10-15"]);
  });
  it("skips finished epics, keeps other epics' history, stores too-early", () => {
    saveForecasts(REPO, new Map([["#1", range(1)], ["#2", range(1)]]), D("2026-10-14"));
    saveForecasts(REPO, new Map<string, Forecast>([["#1", { kind: "finished" }], ["label:x", { kind: "too-early", reason: "little-history", leavesOut: ["answers"] }]]), D("2026-10-15"));
    expect(forecastHistory(REPO, "#1")).toHaveLength(1);
    expect(forecastHistory(REPO, "#2")).toHaveLength(1);
    expect(forecastHistory(REPO, "label:x")[0]).toMatchObject({ kind: "too-early", reason: "little-history", day: "2026-10-15" });
  });
  it("writes nothing when only finished epics are given", () => {
    saveForecasts(REPO, new Map<string, Forecast>([["#1", { kind: "finished" }]]), D("2026-10-14"));
    expect(readForecasts(REPO)).toBeUndefined();
  });
  it("a bad file reads as missing and the next save repairs it", () => {
    mkdirSync(epicForecastsDir(), { recursive: true });
    const file = join(epicForecastsDir(), fileName);
    for (const bad of ["{nope", JSON.stringify({ version: 2, repo: REPO, epics: {} }), JSON.stringify({ version: 1, repo: "other/x", epics: {} })]) {
      writeFileSync(file, bad);
      expect(readForecasts(REPO)).toBeUndefined();
    }
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"));
    expect(readForecasts(REPO)?.epics["#1"]).toHaveLength(1);
  });
  it("leaves no temporary or lock file", () => {
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"));
    expect(readdirSync(epicForecastsDir())).toEqual([fileName]);
  });
  it("keeps the newest MAX_FORECAST_DAYS", () => {
    const start = Date.parse("2024-01-01T10:00:00Z");
    for (let i = 0; i <= MAX_FORECAST_DAYS; i++) saveForecasts(REPO, new Map([["#1", range(1)]]), new Date(start + i * 86_400_000));
    const h = forecastHistory(REPO, "#1");
    expect(h).toHaveLength(MAX_FORECAST_DAYS);
    expect(h[0]!.day).toBe("2024-01-02");
  });
  it("keeps repositories apart and drops one", () => {
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"));
    saveForecasts("acme/other", new Map([["#1", range(2)]]), D("2026-10-14"));
    expect(forecastHistory("acme/other", "#1")[0]!.expected).toBe("2026-11-03T00:00:00Z");
    dropForecasts(REPO);
    expect(readForecasts(REPO)).toBeUndefined();
    expect(forecastHistory("acme/other", "#1")).toHaveLength(1);
  });
  it("a save gives up on a held lock with history intact; a stale lock is taken over", () => {
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"));
    const lock = join(epicForecastsDir(), `${fileName}.lock`);
    writeFileSync(lock, "");
    expect(() => saveForecasts(REPO, new Map([["#2", range(1)]]), D("2026-10-15"), 60)).toThrow(/another process/);
    expect(forecastHistory(REPO, "#1")).toHaveLength(1);
    expect(forecastHistory(REPO, "#2")).toHaveLength(0);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    saveForecasts(REPO, new Map([["#2", range(1)]]), D("2026-10-15"), 60);
    expect(forecastHistory(REPO, "#2")).toHaveLength(1);
    expect(forecastHistory(REPO, "#1")).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)("a failed write keeps history and leaves no temporary or lock file", () => {
    saveForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"));
    chmodSync(epicForecastsDir(), 0o500);
    try {
      expect(() => saveForecasts(REPO, new Map([["#2", range(1)]]), D("2026-10-15"))).toThrow();
    } finally {
      chmodSync(epicForecastsDir(), 0o700);
    }
    expect(readdirSync(epicForecastsDir())).toEqual([fileName]);
    expect(forecastHistory(REPO, "#1")).toHaveLength(1);
  });
});

describe("saveMissingForecasts", () => {
  it("keeps a day that is saved, also against a writer with another time and forecast", async () => {
    expect(await saveMissingForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14", 8))).toEqual(["#1"]);
    expect(await saveMissingForecasts(REPO, new Map([["#1", range(3)]]), D("2026-10-14", 18))).toEqual([]);
    expect(forecastHistory(REPO, "#1")).toEqual([expect.objectContaining({ day: "2026-10-14", at: "2026-10-14T08:00:00.000Z", expected: "2026-11-02T00:00:00Z" })]);
    expect(await saveMissingForecasts(REPO, new Map([["#1", range(2)], ["#2", range(2)]]), D("2026-10-15"))).toEqual(["#1", "#2"]);
    expect(forecastHistory(REPO, "#1").map((e) => e.day)).toEqual(["2026-10-14", "2026-10-15"]);
  });
  it("saves one entry when two writers race", async () => {
    const saved = await Promise.all([
      saveMissingForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14", 8)),
      saveMissingForecasts(REPO, new Map([["#1", range(3)]]), D("2026-10-14", 9)),
    ]);
    expect(saved.flat()).toEqual(["#1"]);
    expect(forecastHistory(REPO, "#1")).toHaveLength(1);
    expect(readdirSync(epicForecastsDir())).toEqual([fileName]);
  });
  it("skips finished epics and writes nothing for them", async () => {
    expect(await saveMissingForecasts(REPO, new Map<string, Forecast>([["#1", { kind: "finished" }]]), D("2026-10-14"))).toEqual([]);
    expect(readForecasts(REPO)).toBeUndefined();
  });
  it("gives up when another process holds the lock", async () => {
    mkdirSync(epicForecastsDir(), { recursive: true });
    const lock = join(epicForecastsDir(), `${fileName}.lock`);
    writeFileSync(lock, "");
    await expect(saveMissingForecasts(REPO, new Map([["#1", range(1)]]), D("2026-10-14"), 60)).rejects.toThrow(/another process/);
    expect(readForecasts(REPO)).toBeUndefined();
    rmSync(lock);
  });
});
