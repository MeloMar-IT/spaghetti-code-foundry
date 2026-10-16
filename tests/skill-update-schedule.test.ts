import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import { isDue, nextCheck, readUpdateChecks, recordUpdateCheck, updateChecksPath, type UpdateCheck } from "../src/skills/update-schedule.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-15T10:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() - ms);
const last = (ms: number, outcome: UpdateCheck["outcome"] = "OK"): UpdateCheck => ({ checkedAt: at(ms).toISOString(), outcome });

describe("isDue", () => {
  it("never makes a manual source due", () => {
    expect(isDue("manual", undefined, NOW)).toBe(false);
    expect(isDue("manual", last(100 * DAY), NOW)).toBe(false);
  });
  it("is due when there is no record, or its time cannot be used", () => {
    expect(isDue("weekly", undefined, NOW)).toBe(true);
    expect(isDue("weekly", { checkedAt: "garbage", outcome: "OK" }, NOW)).toBe(true);
    expect(isDue("weekly", last(-1000), NOW)).toBe(true);
  });
  it("uses at least 1, 7 and 30 days, with no grace", () => {
    for (const [cadence, days] of [["daily", 1], ["weekly", 7], ["monthly", 30]] as const) {
      expect(isDue(cadence, last(days * DAY - 1), NOW)).toBe(false);
      expect(isDue(cadence, last(days * DAY), NOW)).toBe(true);
      expect(isDue(cadence, last(days * DAY + 1), NOW)).toBe(true);
    }
  });
  it("retries a PROBLEM at once, whatever the last success was", () => {
    const problem: UpdateCheck = { checkedAt: at(60_000).toISOString(), outcome: "PROBLEM", succeededAt: at(2 * 60_000).toISOString() };
    expect(isDue("monthly", problem, NOW)).toBe(true);
  });
});

describe("nextCheck", () => {
  it("keeps the old success time on PROBLEM and sets it otherwise", () => {
    const prev: UpdateCheck = { checkedAt: "2026-10-01T00:00:00.000Z", outcome: "OK", succeededAt: "2026-10-01T00:00:00.000Z" };
    expect(nextCheck(prev, "PROBLEM", NOW)).toEqual({ checkedAt: NOW.toISOString(), outcome: "PROBLEM", succeededAt: prev.succeededAt });
    expect(nextCheck(prev, "OK", NOW)).toEqual({ checkedAt: NOW.toISOString(), outcome: "OK", succeededAt: NOW.toISOString() });
    expect(nextCheck(undefined, "PROBLEM", NOW)).toEqual({ checkedAt: NOW.toISOString(), outcome: "PROBLEM" });
  });
});

describe("the check record", () => {
  let home = "";
  const fresh = () => (home = mkdtempSync(join(tmpdir(), "skill-update-checks-")));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads a missing file as none", () => {
    expect(readUpdateChecks({ home: fresh() })).toEqual({ state: "none" });
  });

  it("writes and reads back; mode 0600, no temporary file, other ids kept", () => {
    fresh();
    recordUpdateCheck("a", "OK", NOW, { home });
    recordUpdateCheck("b", "PROBLEM", NOW, { home });
    const r = readUpdateChecks({ home });
    expect(r).toEqual({
      state: "ok",
      checks: { a: { checkedAt: NOW.toISOString(), outcome: "OK", succeededAt: NOW.toISOString() }, b: { checkedAt: NOW.toISOString(), outcome: "PROBLEM" } },
    });
    expect(statSync(updateChecksPath(home)).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(updateChecksPath(home), "utf8")).schema).toBe(1);
  });

  it("keeps only the ids it is told to keep", () => {
    fresh();
    recordUpdateCheck("a", "OK", NOW, { home });
    recordUpdateCheck("b", "OK", NOW, { home, keep: new Set(["b"]) });
    expect(Object.keys((readUpdateChecks({ home }) as { checks: object }).checks)).toEqual(["b"]);
  });

  it("reports an unreadable file with a fixed reason and replaces it on the next write", () => {
    fresh();
    const path = updateChecksPath(home);
    const bad: [string, () => void][] = [
      ["is not valid JSON", () => writeFileSync(path, "nope secret-text")],
      ["has the wrong format", () => writeFileSync(path, JSON.stringify({ schema: 2, sources: {} }))],
      ["has the wrong format", () => writeFileSync(path, JSON.stringify({ schema: 1, sources: { "BAD ID": { checkedAt: NOW.toISOString(), outcome: "OK" } } }))],
      ["is larger than 65536 bytes", () => writeFileSync(path, " ".repeat(70_000))],
      ["is a symbolic link", () => symlinkSync(join(home, "elsewhere"), path)],
      ["is not a regular file", () => mkdirSync(path)],
    ];
    for (const [reason, make] of bad) {
      rmSync(path, { recursive: true, force: true });
      make();
      const r = readUpdateChecks({ home });
      if (reason === "is a symbolic link" && r.state === "unreadable" && r.reason === "cannot be read") continue; // a link to nothing
      expect(r).toEqual({ state: "unreadable", reason });
      expect(JSON.stringify(r)).not.toContain("secret");
    }
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, "nope");
    recordUpdateCheck("a", "OK", NOW, { home });
    expect(readUpdateChecks({ home }).state).toBe("ok");
  });

  it("fails with a StoreError when the data folder cannot be used", () => {
    fresh();
    writeFileSync(join(home, "file"), "x");
    expect(() => recordUpdateCheck("a", "OK", NOW, { home: join(home, "file", "sub") })).toThrow(StoreError);
    expect(existsSync(join(home, "file", "sub"))).toBe(false);
  });
});
