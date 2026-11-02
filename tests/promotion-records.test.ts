import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withAuthLock } from "../src/auth/store.js";
import { findRecord, MAX_RECORDS_BYTES, readRecordBook, RECORDS_FILE, writeRecord, type PromotionEntry } from "../src/promotion/records.js";

const SHA = (c: string) => c.repeat(64);
const REPORT = "timeout-2026-01-01T00-00-00-000Z";
const entry = (over: Partial<PromotionEntry> = {}): PromotionEntry => ({
  kind: "flow",
  id: "my-flow",
  version: "1",
  sha256: SHA("a"),
  reportId: REPORT,
  reports: [{ suite: "timeout", id: REPORT, sha256: SHA("b") }],
  promotedAt: "2026-01-02T00:00:00.000Z",
  by: "cli",
  ...over,
});

let home: string;
let saved: string | undefined;
const file = () => join(home, "promotions", RECORDS_FILE);
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as { records: PromotionEntry[] };

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "records-test-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("the promotion record book", () => {
  it("reads a missing folder and a missing file as an empty book", () => {
    expect(readRecordBook(home)).toEqual({ ok: true, book: { version: 1, records: [] } });
    mkdirSync(join(home, "promotions"));
    expect(readRecordBook(home)).toEqual({ ok: true, book: { version: 1, records: [] } });
  });

  it("writes a record with mode 0600 in a 0700 folder, and reads it back", () => {
    expect(writeRecord(entry())).toEqual({ ok: true });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "promotions")).mode & 0o777).toBe(0o700);
    const r = readRecordBook(home);
    expect(r.ok && findRecord(r.book, entry())).toEqual(entry());
  });

  it("replaces the same kind, id, version and hash and keeps the others", () => {
    writeRecord(entry());
    writeRecord(entry({ sha256: SHA("c") })); // same version, other hash
    writeRecord(entry({ version: "2" })); // same hash, other version
    writeRecord(entry({ by: "someone" })); // the same ref again
    const records = stored().records;
    expect(records).toHaveLength(3);
    expect(records.filter((r) => r.version === "1" && r.sha256 === SHA("a"))).toEqual([entry({ by: "someone" })]);
    const book = readRecordBook(home);
    expect(book.ok && findRecord(book.book, { kind: "flow", id: "my-flow", version: "2", sha256: SHA("c") })).toBeUndefined();
  });

  it("gives a fixed reason for a bad, an oversized and a linked file, and leaves it unchanged", () => {
    mkdirSync(join(home, "promotions"));
    writeFileSync(file(), "{ nope");
    const bad = readRecordBook(home);
    expect(bad).toEqual({ ok: false, reason: "promotions/records.json is not valid; it is not changed, fix or restore it" });
    expect(writeRecord(entry())).toEqual({ ok: false, reason: bad.ok ? "" : bad.reason });
    expect(readFileSync(file(), "utf8")).toBe("{ nope");

    writeFileSync(file(), " ".repeat(MAX_RECORDS_BYTES + 1));
    expect(readRecordBook(home)).toEqual({ ok: false, reason: "promotions/records.json is larger than 4 MiB" });

    rmSync(file());
    writeFileSync(join(home, "target.json"), "{}");
    symlinkSync(join(home, "target.json"), file());
    const link = readRecordBook(home);
    expect(link.ok).toBe(false);
    expect(JSON.stringify(link)).not.toContain(home);
  });

  it("refuses a record with an extra field", () => {
    mkdirSync(join(home, "promotions"));
    writeFileSync(file(), JSON.stringify({ version: 1, records: [{ ...entry(), extra: 1 }] }));
    expect(readRecordBook(home).ok).toBe(false);
  });

  it("answers at once with a reason, and writes nothing, when the lock cannot be taken", () => {
    const started = Date.now();
    const r = withAuthLock(() => writeRecord(entry(), { waitMs: 0 }));
    // the lock is not re-entrant, so the inner write cannot get it
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(existsSync(file())).toBe(false);
  });

  it("makes a folder with loose permissions private", () => {
    mkdirSync(join(home, "promotions"), { mode: 0o755 });
    chmodSync(join(home, "promotions"), 0o755);
    expect(writeRecord(entry())).toEqual({ ok: true });
    expect(statSync(join(home, "promotions")).mode & 0o777).toBe(0o700);
  });
});
