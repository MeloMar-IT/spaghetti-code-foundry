import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shareReportFrom } from "../src/metrics-share/build.js";
import { loadSentReport, saveSentReport, withShareLock, type SentRecord } from "../src/metrics-share/state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("withShareLock", () => {
  it("keeps a lock alive while its holder works longer than the stale time", async () => {
    const file = join(dir, "lock");
    const opts = { file, staleMs: 60_000, heartbeatMs: 2 };
    const result = await withShareLock(async () => {
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(file, old, old); // the lock now looks an hour old
      // wait until the holder has renewed the lock's time
      while (statSync(file).mtimeMs < Date.now() - 60_000) await new Promise((r) => setTimeout(r, 2));
      return withShareLock(async () => "taken over", opts);
    }, opts);
    expect(result).toBe("busy");
  });
});

const report = (day = "2026-11-19") => shareReportFrom({ day, accountIds: [], foundryVersion: "0.4.0", briefs: [], runs: [], watcherSources: new Map() });
const rec = (o: Partial<SentRecord> = {}): SentRecord => ({ version: 1, at: "2026-11-20T00:01:00.000Z", day: "2026-11-19", result: "accepted", status: 200, report: report(), ...o });

describe("the copy of the last sent report (#888)", () => {
  it("is saved with mode 0600 and read back", () => {
    const file = join(dir, "last.json");
    expect(saveSentReport(rec(), file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadSentReport(file)).toEqual({ sent: rec(), broken: false });
  });

  it("is none for a missing file, and broken for bad JSON or an extra field", () => {
    const file = join(dir, "last.json");
    expect(loadSentReport(file)).toEqual({ broken: false });
    writeFileSync(file, "{");
    expect(loadSentReport(file)).toEqual({ broken: true });
    writeFileSync(file, JSON.stringify({ ...rec(), extra: 1 }));
    expect(loadSentReport(file)).toEqual({ broken: true });
  });

  it("removes the older copy when a new one cannot be saved, and never throws", () => {
    const file = join(dir, "last.json");
    expect(saveSentReport(rec(), file)).toBe(true);
    const bad = { ...rec(), report: { day: "2026-11-19" } } as unknown as SentRecord;
    expect(saveSentReport(bad, file)).toBe(false);
    expect(existsSync(file)).toBe(false);
    writeFileSync(join(dir, "file"), "");
    expect(saveSentReport(rec(), join(dir, "file", "last.json"))).toBe(false);
  });
});
