import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { breakGlassFile, breakGlassWatch } from "../src/engine/policy-break-glass.js";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "bg-watch-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const NOW = new Date("2026-05-01T10:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const put = (over: Record<string, unknown> = {}) =>
  writeFileSync(breakGlassFile(home), JSON.stringify({ version: 1, reason: "outage", startedAt: iso(-60_000), expiresAt: iso(60 * 60_000), actor: { kind: "cli", osUser: "admin" }, ...over }));
const audit = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

const watch = () => {
  const lines: string[] = [];
  let t = NOW.getTime();
  const tick = breakGlassWatch((l) => lines.push(l), () => new Date(t));
  return { lines, tick, to: (ms: number) => void (t = NOW.getTime() + ms) };
};
const ACTIVE = (until: string) => `! policy: break-glass active until ${until} (outage) — a mandatory policy that cannot be used does not stop privileged steps`;

describe("breakGlassWatch", () => {
  it("says nothing with no file", () => {
    const w = watch();
    w.tick();
    expect(w.lines).toEqual([]);
  });

  it("logs when active: first tick, a new startedAt, and every 15 minutes", () => {
    put();
    const w = watch();
    w.tick();
    expect(w.lines).toEqual([ACTIVE(iso(3_600_000))]);
    w.to(60_000);
    w.tick();
    expect(w.lines).toHaveLength(1);
    w.to(15 * 60_000);
    w.tick();
    expect(w.lines).toHaveLength(2);
    put({ startedAt: iso(15 * 60_000 - 1000), expiresAt: iso(2 * 3_600_000) });
    w.to(15 * 60_000 + 1000);
    w.tick();
    expect(w.lines).toEqual([ACTIVE(iso(3_600_000)), ACTIVE(iso(3_600_000)), ACTIVE(iso(2 * 3_600_000))]);
  });

  it("ends an expired record once, with the audit line", () => {
    put({ expiresAt: iso(10 * 60_000) });
    const w = watch();
    w.tick();
    w.to(11 * 60_000);
    w.tick();
    expect(w.lines.at(-1)).toBe("policy: break-glass ended (expired)");
    expect(existsSync(breakGlassFile(home))).toBe(false);
    expect(audit().filter((a) => a.action === "policy-break-glass-end" && a.detail === "expired")).toHaveLength(1);
    const n = w.lines.length;
    w.to(12 * 60_000);
    w.tick();
    expect(w.lines).toHaveLength(n);
  });

  it("logs the end once when the file is removed or becomes invalid while shown", () => {
    put();
    const w = watch();
    w.tick();
    rmSync(breakGlassFile(home));
    w.tick();
    w.tick();
    expect(w.lines.filter((l) => l === "policy: break-glass ended")).toHaveLength(1);
    put();
    w.tick();
    writeFileSync(breakGlassFile(home), "{ nope");
    w.tick();
    expect(w.lines.filter((l) => l === "policy: break-glass ended")).toHaveLength(2);
  });

  it("does nothing while the data-folder lock is held, and ends it after", () => {
    put({ expiresAt: iso(10 * 60_000) });
    const w = watch();
    w.to(11 * 60_000);
    mkdirSync(join(home, "auth.lock"));
    writeFileSync(join(home, "auth.lock", "pid"), String(process.pid));
    w.tick();
    expect(w.lines).toEqual([]);
    expect(existsSync(breakGlassFile(home))).toBe(true);
    expect(audit()).toEqual([]);
    rmSync(join(home, "auth.lock"), { recursive: true });
    w.tick();
    expect(w.lines).toEqual(["policy: break-glass ended (expired)"]);
  });

  it("never throws, even when the log does", () => {
    put();
    const tick = breakGlassWatch(() => {
      throw new Error("log");
    }, () => NOW);
    expect(() => tick()).not.toThrow();
  });
});
