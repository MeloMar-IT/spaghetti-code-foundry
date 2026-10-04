import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditEntrySchema, auditPath, auditSweeper, purgeAudit, scanAudit, writeAudit } from "../src/auth/audit.js";
import { StoreError, replaceFileLocked, withAuthLock } from "../src/auth/store.js";

// The audit log clean-up (#98): replaceFileLocked, purgeAudit, auditSweeper.
let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "audit-purge-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const uid = randomUUID();
const at = (daysAgo: number, extra = 0) => new Date(NOW - daysAgo * DAY - extra).toISOString();
const entry = (time: string, target = "run-1") => JSON.stringify({ time, by: uid, action: "run-start", result: "ok", target });
const mode = (p: string) => statSync(p).mode & 0o777;
const B = (s: string) => Buffer.from(s, "utf8");
const lockDir = () => join(home, "auth.lock");
const holdLock = () => {
  mkdirSync(lockDir());
  writeFileSync(join(lockDir(), "pid"), String(process.pid));
};
const kindOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof StoreError ? { kind: e.kind, message: e.message } : e;
  }
  return undefined;
};
const seed = (data: Buffer | string, m = 0o644) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(auditPath(), data, { mode: m });
  chmodSync(auditPath(), m);
};
const read = () => readFileSync(auditPath());

describe("replaceFileLocked", () => {
  const target = () => join(home, "x.dat");
  const tmp = () => `${target()}.tmp`;
  const prep = () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(target(), "old\n");
  };

  it("needs the lock and the locked folder, and does not call fill", () => {
    prep();
    let called = 0;
    const fill = () => void called++;
    expect(() => replaceFileLocked(target(), fill)).toThrow();
    expect(() => withAuthLock(() => replaceFileLocked(join(tmpdir(), "elsewhere.dat"), fill))).toThrow();
    expect(called).toBe(0);
  });

  it("writes what fill writes, in order, with mode 0600, over a leftover .tmp", () => {
    prep();
    writeFileSync(tmp(), "stale", { mode: 0o644 });
    chmodSync(tmp(), 0o644);
    withAuthLock(() =>
      replaceFileLocked(target(), (w) => {
        w(B("a\n"));
        w(B("b\n"));
      }),
    );
    expect(readFileSync(target(), "utf8")).toBe("a\nb\n");
    expect(mode(target())).toBe(0o600);
    expect(existsSync(tmp())).toBe(false);
  });

  it("sets mode 0600 even under a restrictive umask", () => {
    prep();
    let old = 0;
    try {
      withAuthLock(() => {
        old = process.umask(0o277); // only for the new file: the lock needs its own folder writable
        replaceFileLocked(target(), (w) => w(B("a\n")));
      });
    } finally {
      process.umask(old);
    }
    expect(mode(target())).toBe(0o600);
  });

  it("keeps the old file and leaves no .tmp when fill fails", () => {
    prep();
    const err = new StoreError("unreadable", "f", "cannot be read");
    expect(kindOf(() => withAuthLock(() => replaceFileLocked(target(), (w) => { w(B("part")); throw err; })))).toMatchObject({ kind: "unreadable" });
    expect(kindOf(() => withAuthLock(() => replaceFileLocked(target(), () => { throw new Error("boom"); })))).toMatchObject({ kind: "cannot-write" });
    expect(readFileSync(target(), "utf8")).toBe("old\n");
    expect(existsSync(tmp())).toBe(false);
  });

  it("answers locked when the lock was taken over, and cannot-write when .tmp is a folder", () => {
    prep();
    expect(kindOf(() => withAuthLock(() => replaceFileLocked(target(), (w) => { w(B("new")); rmSync(lockDir(), { recursive: true }); })))).toMatchObject({ kind: "locked" });
    expect(readFileSync(target(), "utf8")).toBe("old\n");
    expect(existsSync(tmp())).toBe(false);
    mkdirSync(tmp());
    expect(kindOf(() => withAuthLock(() => replaceFileLocked(target(), (w) => w(B("new")))))).toMatchObject({ kind: "cannot-write" });
    expect(readFileSync(target(), "utf8")).toBe("old\n");
  });
});

describe("purgeAudit", () => {
  it("removes old lines, keeps the others byte for byte, sets mode 0600", () => {
    const keep = [entry(at(1)), "{ not json", entry(at(179))];
    seed(B([entry(at(200)), keep[0], entry(at(300)), keep[1], keep[2], ""].join("\n")));
    expect(purgeAudit(180, { now: NOW })).toBe(2);
    expect(read()).toEqual(B(keep.join("\n") + "\n"));
    expect(mode(auditPath())).toBe(0o600);
    expect(existsSync(`${auditPath()}.tmp`)).toBe(false);
  });

  it("keeps a line exactly `days` old and removes one 1 ms older", () => {
    const edge = entry(at(10));
    seed(B(`${edge}\n${entry(at(10, 1))}\n`));
    expect(purgeAudit(10, { now: NOW })).toBe(1);
    expect(read()).toEqual(B(`${edge}\n`));
  });

  const unreadable = [
    B("{ not json\n"),
    B("\n"),
    B(`${JSON.stringify({ time: at(400), by: uid, action: "no-such-action", result: "ok" })}\n`),
    B(`${JSON.stringify({ by: uid, action: "run-start", result: "ok", target: "t" })}\n`),
    Buffer.from([0xff, 0xfe, 10]),
    Buffer.concat([B("x".repeat(70_000)), B("\n")]),
  ];
  const cutOff = B(entry(at(400)).slice(0, 30));

  it("keeps lines that cannot be read, also a cut-off last line", () => {
    const parts = [unreadable[0]!, B(entry(at(300)) + "\n"), unreadable[1]!, unreadable[2]!, B(entry(at(250)) + "\n"), unreadable[3]!, unreadable[4]!, unreadable[5]!, cutOff];
    seed(Buffer.concat(parts));
    expect(purgeAudit(180, { now: NOW })).toBe(2);
    expect(read()).toEqual(Buffer.concat([unreadable[0]!, unreadable[1]!, unreadable[2]!, unreadable[3]!, unreadable[4]!, unreadable[5]!, cutOff]));
  });

  it("keeps a valid old entry that holds bytes that are not UTF-8", () => {
    const mid = (bad: number[], tail: string) => Buffer.concat([B(`{"time":"${at(400)}","by":"${uid}","action":"run-start","result":"ok","target":"a`), Buffer.from(bad), B(`${tail}"}\n`)]);
    const l1 = mid([0xff], "b");
    const l2 = mid([0xc3], "");
    for (const l of [l1, l2]) expect(AuditEntrySchema.safeParse(JSON.parse(l.toString("utf8"))).success).toBe(true);
    seed(Buffer.concat([l1, l2]));
    expect(purgeAudit(180, { now: NOW })).toBe(0);
    expect(read()).toEqual(Buffer.concat([l1, l2]));
  });

  it("removes an old line with multi-byte text and keeps a new one", () => {
    const oldL = entry(at(400), "é 日本 😀");
    const newL = entry(at(1), "é 日本 😀");
    seed(B(`${oldL}\n${newL}\n`));
    expect(purgeAudit(180, { now: NOW })).toBe(1);
    expect(read()).toEqual(B(`${newL}\n`));
  });

  it("follows the size rule of the reader: 65,536 bytes is read, 65,537 is not", () => {
    const pad = (n: number) => {
      const base = entry(at(400));
      return base.slice(0, -1) + " ".repeat(n - base.length) + "}";
    };
    const exact = pad(65_536);
    expect(B(exact).length).toBe(65_536);
    seed(B(exact + "\n"));
    expect(purgeAudit(180, { now: NOW })).toBe(1);
    const over = pad(65_537);
    seed(B(over + "\n"));
    expect(purgeAudit(180, { now: NOW })).toBe(0);
    expect(read()).toEqual(B(over + "\n"));
  });

  describe("chunk sizes", () => {
    const keepLines = [B(entry(at(1), "é日本😀") + "\n"), unreadable[0]!, unreadable[4]!, B(entry(at(5), "ü") + "\r\n"), unreadable[5]!, unreadable[2]!];
    const oldLines = [B(entry(at(300), "é日本😀") + "\n"), B(entry(at(500), "ü") + "\r\n")];
    const input = Buffer.concat([oldLines[0]!, keepLines[0]!, keepLines[1]!, oldLines[1]!, keepLines[2]!, keepLines[3]!, keepLines[4]!, keepLines[5]!, cutOff]);
    const expected = Buffer.concat([...keepLines, cutOff]);
    it.each([1, 2, 3, 5, 7, 64, 4096, undefined])("chunk %s", (chunk) => {
      seed(input);
      expect(purgeAudit(180, { now: NOW, chunk })).toBe(2);
      expect(read()).toEqual(expected);
    });
  });

  it("leaves nothing old for scanAudit, and all newer records", async () => {
    const now = Date.now();
    const t = (d: number) => new Date(now - d * DAY).toISOString();
    seed(B([entry(t(300)), entry(t(5)), entry(t(250)), entry(t(1))].join("\n") + "\n"));
    expect(purgeAudit(180)).toBe(2);
    const times: string[] = [];
    for await (const r of scanAudit()) times.push(r.time);
    expect(times).toEqual([t(5), t(1)]);
  });

  it("handles a last line without a newline", () => {
    seed(B(`${entry(at(1))}\n${entry(at(400))}`));
    expect(purgeAudit(180, { now: NOW })).toBe(1);
    expect(read()).toEqual(B(`${entry(at(1))}\n`));
    const keep = entry(at(1), "last");
    seed(B(`${entry(at(400))}\n${keep}`));
    expect(purgeAudit(180, { now: NOW })).toBe(1);
    expect(read()).toEqual(B(keep));
    writeAudit("cli", { action: "create", userId: uid });
    const ls = read().toString("utf8").split("\n");
    expect(ls[0]).toBe(keep);
    expect(JSON.parse(ls[1]!).action).toBe("create");
  });

  it("does not touch the file when nothing is old", () => {
    seed(B(`${entry(at(1))}\n`));
    const before = lstatSync(auditPath());
    expect(purgeAudit(180, { now: NOW })).toBe(0);
    const after = lstatSync(auditPath());
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(mode(auditPath())).toBe(0o644);
    expect(existsSync(`${auditPath()}.tmp`)).toBe(false);
  });

  it("leaves an empty file with mode 0600 when all are old, and appends still work", () => {
    seed(B(`${entry(at(400))}\n${entry(at(500))}\n`));
    expect(purgeAudit(180, { now: NOW })).toBe(2);
    expect(read().length).toBe(0);
    expect(mode(auditPath())).toBe(0o600);
    writeAudit("cli", { action: "create", userId: uid });
    expect(read().toString("utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("does nothing for a missing file and makes no folder", () => {
    const gone = join(home, "not-there");
    process.env.FACTORY_HOME = gone;
    expect(purgeAudit(180, { now: NOW })).toBe(0);
    expect(existsSync(gone)).toBe(false);
  });

  it("refuses a symlink, a folder and a dangling symlink", () => {
    mkdirSync(home, { recursive: true });
    const real = join(home, "real.jsonl");
    const text = `${entry(at(400))}\n`;
    writeFileSync(real, text);
    symlinkSync(real, auditPath());
    expect(kindOf(() => purgeAudit(180, { now: NOW }))).toMatchObject({ kind: "unreadable", message: expect.stringContaining("audit.jsonl") });
    expect(readFileSync(real, "utf8")).toBe(text);
    expect(lstatSync(auditPath()).isSymbolicLink()).toBe(true);
    rmSync(auditPath());
    mkdirSync(auditPath());
    expect(kindOf(() => purgeAudit(180, { now: NOW }))).toMatchObject({ kind: "unreadable" });
    rmSync(auditPath(), { recursive: true });
    symlinkSync(join(home, "nowhere"), auditPath());
    expect(kindOf(() => purgeAudit(180, { now: NOW }))).toMatchObject({ kind: "unreadable" });
  });

  it("answers locked quickly when the lock is busy, and leaves the file", () => {
    const text = `${entry(at(400))}\n`;
    seed(B(text));
    holdLock();
    let t = Date.now();
    expect(kindOf(() => purgeAudit(1, { now: NOW, waitMs: 0 }))).toMatchObject({ kind: "locked" });
    expect(Date.now() - t).toBeLessThan(1000);
    t = Date.now();
    expect(kindOf(() => purgeAudit(1, { now: NOW }))).toMatchObject({ kind: "locked" });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(readFileSync(auditPath(), "utf8")).toBe(text);
  });

  it("throws for a bad number of days and leaves the file", () => {
    const text = `${entry(at(400))}\n`;
    seed(B(text));
    for (const d of [0, -1, 1.5, NaN]) expect(() => purgeAudit(d, { now: NOW })).toThrow();
    expect(readFileSync(auditPath(), "utf8")).toBe(text);
  });
});

describe("auditSweeper", () => {
  const rel = (d: number) => new Date(Date.now() - d * DAY).toISOString();

  it("removes, logs once and logs nothing the second time", () => {
    seed(B(`${entry(rel(200))}\n${entry(rel(1))}\n${entry(rel(300))}\n`));
    const logs: string[] = [];
    const sweep = auditSweeper(() => 180, (m) => logs.push(m));
    sweep();
    expect(logs).toEqual(["audit: removed 2 line(s) older than 180 days"]);
    sweep();
    expect(logs).toHaveLength(1);
  });

  it("reads days on every round", () => {
    seed(B(`${entry(rel(200))}\n`));
    let days = 3650;
    const sweep = auditSweeper(() => days, undefined);
    sweep();
    expect(read().length).toBeGreaterThan(0);
    days = 180;
    sweep();
    expect(read().length).toBe(0);
  });

  it("never throws, names the file and the kind, and tries again", () => {
    const logs: string[] = [];
    const sweep = auditSweeper(() => 180, (m) => logs.push(m));
    mkdirSync(auditPath(), { recursive: true });
    sweep();
    rmSync(auditPath(), { recursive: true });
    const text = `${entry(rel(200))}\n`;
    seed(B(text));
    holdLock();
    sweep();
    expect(readFileSync(auditPath(), "utf8")).toBe(text);
    rmSync(lockDir(), { recursive: true });
    sweep();
    expect(read().length).toBe(0);
    seed(B(text));
    auditSweeper(() => { throw new Error(home); }, (m) => logs.push(m))();
    auditSweeper(() => 0, (m) => logs.push(m))();
    expect(readFileSync(auditPath(), "utf8")).toBe(text);
    expect(logs.slice(0, 2)).toEqual(["audit: audit.jsonl unreadable (clean-up)", "audit: auth.lock locked (clean-up)"]);
    expect(logs.slice(3)).toEqual(["audit: audit.jsonl unexpected (clean-up)", "audit: audit.jsonl unexpected (clean-up)"]);
    for (const l of logs) {
      expect(l).toMatch(/^(audit: \S+ [a-z-]+ \(clean-up\)|audit: removed .*)$/);
      expect(l).not.toContain(home);
    }
    expect(() => auditSweeper(() => 0, undefined)()).not.toThrow();
    expect(() => auditSweeper(() => 0, () => { throw new Error("x"); })()).not.toThrow();
  });
});
