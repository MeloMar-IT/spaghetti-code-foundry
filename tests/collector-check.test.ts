import { describe, expect, it } from "vitest";
import { REASONS, checkDay, checkReport, installOf, isInstallId, isJsonContentType } from "../collector/check.js";
import { RateLimiter } from "../collector/limits.js";
import { NO_INSTALL } from "../src/metrics-share/report.js";
import { report } from "./collector-report.js";

const NOW = new Date("2026-11-20T12:00:00Z");

describe("collector checks (#890)", () => {
  it("takes a valid report", () => {
    const r = checkReport(report(), NOW);
    expect(r.ok).toBe(true);
  });

  it("refuses a wrong schema with a fixed reason", () => {
    const bad: unknown[] = [
      { ...report(), extra: 1 },
      report({ cost: { byModel: { opus: { tokensIn: 1, tokensOut: 1, extra: 1 } as never }, byStep: {} } }),
      report({ cost: { byModel: { "my-secret-model": { tokensIn: 1, tokensOut: 1 } } as never, byStep: {} } }),
      { ...report(), version: 2 },
      report({ day: "2026-02-30" }),
      "a string",
      null,
    ];
    for (const b of bad) expect(checkReport(b, NOW)).toEqual({ ok: false, reason: REASONS.badSchema });
  });

  it("takes days from today−7 to today only", () => {
    expect(checkReport(report({ day: "2026-11-21" }), NOW)).toEqual({ ok: false, reason: "future_day" });
    expect(checkReport(report({ day: "2026-11-12" }), NOW)).toEqual({ ok: false, reason: "old_day" });
    expect(checkReport(report({ day: "2026-11-13" }), NOW).ok).toBe(true);
    expect(checkReport(report({ day: "2026-11-20" }), NOW).ok).toBe(true);
    expect(checkDay("2026-13-01", NOW)).toBe("bad_schema");
  });

  it("refuses the placeholder install id", () => {
    expect(checkReport(report({ install: NO_INSTALL }), NOW)).toEqual({ ok: false, reason: "bad_install" });
    expect(isInstallId(NO_INSTALL)).toBe(false);
    expect(installOf({ install: 5 })).toBeUndefined();
    expect(installOf({ install: "A".repeat(32) })).toBeUndefined();
    expect(installOf({ install: "a".repeat(31) })).toBeUndefined();
    expect(installOf([])).toBeUndefined();
    expect(installOf({ install: "b".repeat(32) })).toBe("b".repeat(32));
  });

  it("knows a JSON content type", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/jsonp")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("collector rate limits (#890)", () => {
  it("allows 20 requests an hour per install", () => {
    let t = 0;
    const l = new RateLimiter({ perInstallPerHour: 20, totalPerHour: 1000 }, () => t);
    for (let i = 0; i < 20; i++) expect(l.takeInstall("a")).toEqual({ ok: true });
    const r = l.takeInstall("a");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.retryAfter).toBe(3600);
    t = 30 * 60_000;
    const r2 = l.takeInstall("a");
    expect(!r2.ok && r2.retryAfter).toBe(1800);
    expect(l.takeInstall("b")).toEqual({ ok: true });
    t = 3_600_000;
    expect(l.takeInstall("a")).toEqual({ ok: true });
  });

  it("has a total limit and gives a slot back", () => {
    let t = 1000;
    const l = new RateLimiter({ perInstallPerHour: 20, totalPerHour: 3 }, () => t);
    for (let i = 0; i < 3; i++) expect(l.takeTotal().ok).toBe(true);
    t += 1500;
    const r = l.takeTotal();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Number.isInteger(r.retryAfter)).toBe(true);
      expect(r.retryAfter).toBeGreaterThanOrEqual(1);
    }
    l.giveBackTotal();
    expect(l.takeTotal().ok).toBe(true);
  });

  it("forgets installs whose window has passed", () => {
    let t = 0;
    const l = new RateLimiter(undefined, () => t);
    for (let i = 0; i < 50; i++) l.takeInstall(`i${i}`);
    t = 2 * 3_600_000;
    for (let i = 0; i < 50; i++) l.takeInstall("x");
    expect(l.size).toBe(1);
  });
});
