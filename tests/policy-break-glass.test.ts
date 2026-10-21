import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { StoreError } from "../src/auth/store.js";
import { jsonFiles } from "../src/home-migrate.js";
import {
  activeBreakGlass,
  BREAK_GLASS_FILE,
  breakGlassFile,
  breakGlassMs,
  breakGlassReasonProblem,
  endBreakGlass,
  readBreakGlass,
  startBreakGlass,
} from "../src/engine/policy-break-glass.js";
import { POLICY_USAGE, policyCommand } from "../src/engine/policy-cli.js";

const faults = vi.hoisted(() => ({ failWrite: false, failRename: "", failRm: "" }));

vi.mock("../src/auth/audit.js", async (orig) => {
  const real = await orig<typeof import("../src/auth/audit.js")>();
  return {
    ...real,
    prepareAuditLocked: (by: string, event: Parameters<typeof real.prepareAuditLocked>[1]) => {
      const log = real.prepareAuditLocked(by, event);
      return {
        write() {
          if (faults.failWrite) throw new StoreError("cannot-write", "audit", "could not be written");
          log.write();
        },
        close: () => log.close(),
      };
    },
  };
});
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (faults.failRename && String(to).endsWith(faults.failRename)) throw new Error("injected");
      return real.renameSync(from, to);
    },
    rmSync: (p: string, o?: Parameters<typeof real.rmSync>[1]) => {
      if (faults.failRm && String(p).endsWith(faults.failRm)) throw new Error("injected");
      return real.rmSync(p, o);
    },
  };
});

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "break-glass-"));
  process.env.FACTORY_HOME = home;
  faults.failWrite = false;
  faults.failRename = "";
  faults.failRm = "";
});
afterEach(() => {
  faults.failWrite = false;
  faults.failRename = "";
  faults.failRm = "";
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const audit = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const file = () => breakGlassFile(home);
const NOW = new Date("2026-05-01T10:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const rec = (over: Record<string, unknown> = {}) => ({
  version: 1,
  reason: "outage",
  startedAt: at(-60_000),
  expiresAt: at(60 * 60_000),
  actor: { kind: "cli", osUser: "admin" },
  ...over,
});
const put = (r: unknown) => writeFileSync(file(), typeof r === "string" ? r : JSON.stringify(r));
const start = (o: { reason?: string; for?: string } = { reason: "outage", for: "30m" }) => startBreakGlass({ ...o, now: () => NOW });
const stateOf = (r: unknown, now = NOW) => {
  put(r);
  return readBreakGlass(home, now).state;
};

describe("reason and duration checks", () => {
  it("checks the reason", () => {
    expect(breakGlassReasonProblem("a".repeat(200))).toBeUndefined();
    expect(breakGlassReasonProblem("a".repeat(201))).toMatch(/longer than 200/);
    expect(breakGlassReasonProblem("  x  ")).toBeUndefined();
    for (const bad of [undefined, "", "   ", "a\nb", "a\tb", "a\u0085b", "outage\n", "\toutage", "\routage", "outage\u0000"]) {
      expect(breakGlassReasonProblem(bad), JSON.stringify(bad)).toBeTruthy();
    }
    const token = "ghp_" + "A".repeat(36);
    const p = breakGlassReasonProblem(`token ${token}`)!;
    expect(p).toMatch(/credential/);
    expect(p).not.toContain(token);
  });

  it("checks the duration", () => {
    expect(breakGlassMs("4h")).toBe(14_400_000);
    expect(breakGlassMs("240m")).toBe(14_400_000);
    expect(breakGlassMs("1m")).toBe(60_000);
    for (const bad of ["5h", "241m", "0m", "0h", "05m", "90s", "1.5h", "", "m", undefined]) expect(breakGlassMs(bad), String(bad)).toBeUndefined();
  });

  it("refuses bad input with no file and no audit line", () => {
    for (const o of [
      { for: "30m" },
      { reason: "  ", for: "30m" },
      { reason: "a".repeat(201), for: "30m" },
      { reason: "outage\n", for: "30m" },
      { reason: "ghp_" + "A".repeat(36), for: "30m" },
      { reason: "outage" },
      { reason: "outage", for: "5h" },
      { reason: "outage", for: "0m" },
    ]) {
      expect(start(o).ok).toBe(false);
    }
    expect(existsSync(file())).toBe(false);
    expect(audit()).toEqual([]);
  });
});

describe("start and end", () => {
  it("writes the record and one start line", () => {
    const r = start({ reason: "  outage  ", for: "30m" });
    expect(r).toEqual({ ok: true, expiresAt: at(30 * 60_000) });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const j = JSON.parse(readFileSync(file(), "utf8"));
    expect(Object.keys(j)).toEqual(["version", "reason", "startedAt", "expiresAt", "actor"]);
    expect(j.reason).toBe("outage");
    expect(j.actor.kind).toBe("cli");
    expect(j.actor.osUser).toMatch(/^[A-Za-z0-9._-]{1,64}$|^unknown$/);
    expect(readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(audit()).toMatchObject([{ by: "cli", action: "policy-break-glass-start", result: "ok", target: at(30 * 60_000), detail: "outage" }]);
  });

  it("refuses a second start and writes a failed line", () => {
    start();
    const before = readFileSync(file(), "utf8");
    const r = start();
    expect(r).toEqual({ ok: false, reason: `a break-glass is already active until ${at(30 * 60_000)}; end it first with scf policy break-glass --end` });
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(audit().map((l) => l.result)).toEqual(["ok", "failed"]);
  });

  it("writes the expiry end line before a new start over an expired file", () => {
    put(rec({ startedAt: at(-120_000), expiresAt: at(-60_000) }));
    expect(start().ok).toBe(true);
    expect(audit().map((l) => [l.action, l.result, l.target, l.detail])).toEqual([
      ["policy-break-glass-end", "ok", at(-60_000), "expired"],
      ["policy-break-glass-start", "ok", at(30 * 60_000), "outage"],
    ]);
    expect(readBreakGlass(home, NOW).state).toBe("active");
  });

  it("refuses a start over an invalid file or a folder", () => {
    put("{not json");
    expect(start().ok).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe("{not json");
    rmSync(file());
    mkdirSync(file());
    expect(start()).toEqual({ ok: false, reason: `${BREAK_GLASS_FILE} is a folder; remove it by hand` });
    expect(statSync(file()).isDirectory()).toBe(true);
    expect(audit().map((l) => l.result)).toEqual(["failed", "failed"]);
  });

  it("ends an active record", () => {
    start();
    expect(endBreakGlass({ now: () => NOW })).toEqual({ ok: true, detail: "ended" });
    expect(existsSync(file())).toBe(false);
    expect(readdirSync(home).filter((n) => n.includes("ending"))).toEqual([]);
    expect(audit().at(-1)).toMatchObject({ action: "policy-break-glass-end", by: "cli", result: "ok", target: at(30 * 60_000), detail: "ended" });
  });

  it("ends an expired record, a bad file and a link", () => {
    put(rec({ startedAt: at(-120_000), expiresAt: at(-60_000) }));
    expect(endBreakGlass({ now: () => NOW })).toEqual({ ok: true, detail: "expired" });
    put("garbage");
    expect(endBreakGlass({ now: () => NOW })).toEqual({ ok: true, detail: "invalid" });
    expect(audit().at(-1)).toMatchObject({ target: "unknown", detail: "invalid" });
    const outside = join(home, "outside.txt");
    writeFileSync(outside, "keep");
    symlinkSync(outside, file());
    expect(endBreakGlass({ now: () => NOW })).toEqual({ ok: true, detail: "invalid" });
    expect(existsSync(file())).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("refuses a folder and reports a missing record", () => {
    expect(endBreakGlass()).toEqual({ ok: false, reason: "no break-glass is active" });
    expect(audit()).toEqual([]);
    mkdirSync(file());
    expect(endBreakGlass().ok).toBe(false);
    expect(statSync(file()).isDirectory()).toBe(true);
  });
});

describe("audit failures", () => {
  it("does not start when the audit log is a folder", () => {
    mkdirSync(auditPath());
    expect(start().ok).toBe(false);
    expect(existsSync(file())).toBe(false);
  });

  it("does not start when the line cannot be written", () => {
    faults.failWrite = true;
    expect(start().ok).toBe(false);
    expect(readBreakGlass(home, NOW).state).toBe("missing");
    expect(audit()).toEqual([]);
    expect(readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("never reads a temp file that could not be removed", () => {
    faults.failWrite = true;
    faults.failRm = ".tmp";
    expect(start().ok).toBe(false);
    expect(readBreakGlass(home, NOW).state).toBe("missing");
    expect(audit()).toEqual([]);
  });

  it("writes a failed line when the final rename fails", () => {
    faults.failRename = BREAK_GLASS_FILE;
    expect(start().ok).toBe(false);
    expect(readBreakGlass(home, NOW).state).toBe("missing");
    expect(audit().map((l) => l.result)).toEqual(["ok", "failed"]);
  });

  it("puts the record back when the end line fails, and ends once later", () => {
    start();
    const before = readFileSync(file(), "utf8");
    faults.failWrite = true;
    expect(endBreakGlass({ now: () => NOW })).toMatchObject({ ok: false, reason: expect.stringContaining("was not ended") });
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(audit().filter((l) => l.action === "policy-break-glass-end")).toEqual([]);
    faults.failWrite = false;
    expect(endBreakGlass({ now: () => NOW })).toEqual({ ok: true, detail: "ended" });
    expect(audit().filter((l) => l.action === "policy-break-glass-end")).toHaveLength(1);
  });

  it("stays off when the line and the put-back both fail", () => {
    start();
    faults.failWrite = true;
    faults.failRename = BREAK_GLASS_FILE;
    expect(endBreakGlass({ now: () => NOW })).toMatchObject({ ok: false, reason: expect.stringContaining("no longer active") });
    expect(readBreakGlass(home, NOW).state).toBe("missing");
    expect(audit().filter((l) => l.action === "policy-break-glass-end")).toEqual([]);
  });

  it("never reads or restores a leftover side file", () => {
    start();
    faults.failRm = ".ending";
    expect(endBreakGlass({ now: () => NOW })).toEqual({ ok: true, detail: "ended" });
    faults.failRm = "";
    expect(readdirSync(home).some((n) => n.endsWith(".ending"))).toBe(true);
    expect(readBreakGlass(home, NOW).state).toBe("missing");
    expect(start().ok).toBe(true);
    expect(endBreakGlass({ now: () => NOW }).ok).toBe(true);
    expect(audit().filter((l) => l.action === "policy-break-glass-end")).toHaveLength(2);
  });
});

describe("lock", () => {
  it("gives the lock message when another command holds the lock", () => {
    mkdirSync(join(home, "auth.lock"));
    writeFileSync(join(home, "auth.lock", "pid"), String(process.pid));
    const msg = "another scf command holds the data-folder lock; try again";
    expect(startBreakGlass({ reason: "outage", for: "30m", waitMs: 0 })).toEqual({ ok: false, reason: msg });
    put(rec());
    expect(endBreakGlass({ waitMs: 0 })).toEqual({ ok: false, reason: msg });
    expect(existsSync(file())).toBe(true);
  });
});

describe("readBreakGlass", () => {
  it("reports missing, links, folders, size, JSON and fields", () => {
    expect(readBreakGlass(home, NOW).state).toBe("missing");
    expect(stateOf(rec())).toBe("active");
    rmSync(file());
    symlinkSync(join(home, "x"), file());
    expect(readBreakGlass(home, NOW).state).toBe("invalid");
    rmSync(file());
    mkdirSync(file());
    expect(readBreakGlass(home, NOW).state).toBe("invalid");
    rmSync(file(), { recursive: true });
    expect(stateOf("x".repeat(4097))).toBe("invalid");
    expect(stateOf("{")).toBe("invalid");
    expect(stateOf({ ...rec(), extra: 1 })).toBe("invalid");
    expect(stateOf(rec({ actor: { kind: "cli", osUser: "a", x: 1 } }))).toBe("invalid");
    expect(stateOf(rec({ version: 2 }))).toBe("invalid");
    expect(stateOf(rec({ actor: { kind: "cli", osUser: "a b" } }))).toBe("invalid");
    expect(stateOf(rec({ actor: { kind: "cli", osUser: "unknown" } }))).toBe("active");
  });

  it("checks the reason", () => {
    expect(stateOf(rec({ reason: " outage " }))).toBe("invalid");
    expect(stateOf(rec({ reason: "a\nb" }))).toBe("invalid");
    expect(stateOf(rec({ reason: "ghp_" + "A".repeat(36) }))).toBe("invalid");
  });

  it("checks the times", () => {
    expect(stateOf(rec({ startedAt: at(-5 * 3_600_000), expiresAt: at(60_000) }))).toBe("invalid");
    expect(stateOf(rec({ startedAt: at(0), expiresAt: at(0) }))).toBe("invalid");
    expect(stateOf(rec({ startedAt: at(61_000), expiresAt: at(120_000) }))).toBe("invalid");
    expect(stateOf(rec({ startedAt: at(59_000), expiresAt: at(120_000) }))).toBe("active");
    expect(stateOf(rec({ startedAt: at(0), expiresAt: at(4 * 3_600_000 + 1000) }))).toBe("invalid");
    expect(stateOf(rec({ startedAt: at(-120_000), expiresAt: at(0) }))).toBe("expired");
    expect(stateOf(rec({ startedAt: at(-120_000), expiresAt: at(1) }))).toBe("active");
  });

  it.skipIf(process.getuid?.() === 0)("never throws on an unreadable file", () => {
    put(rec());
    chmodSync(file(), 0);
    expect(readBreakGlass(home, NOW).state).toBe("invalid");
  });
});

describe("activeBreakGlass", () => {
  const expired = () => rec({ startedAt: at(-120_000), expiresAt: at(-60_000) });

  it("writes one expiry line", () => {
    put(expired());
    expect(activeBreakGlass(home, NOW)).toBeUndefined();
    expect(activeBreakGlass(home, NOW)).toBeUndefined();
    expect(audit().map((l) => [l.action, l.detail])).toEqual([["policy-break-glass-end", "expired"]]);
    expect(existsSync(file())).toBe(false);
  });

  it("returns an active record and writes nothing", () => {
    put(rec());
    expect(activeBreakGlass(home, NOW)?.reason).toBe("outage");
    expect(audit()).toEqual([]);
  });

  it("leaves another folder alone", () => {
    const other = mkdtempSync(join(tmpdir(), "break-glass-other-"));
    try {
      writeFileSync(breakGlassFile(other), JSON.stringify(expired()));
      expect(activeBreakGlass(other, NOW)).toBeUndefined();
      expect(existsSync(breakGlassFile(other))).toBe(true);
      expect(audit()).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("keeps the file and writes nothing when the line fails, then writes it once", () => {
    put(expired());
    faults.failWrite = true;
    expect(activeBreakGlass(home, NOW)).toBeUndefined();
    expect(existsSync(file())).toBe(true);
    expect(audit()).toEqual([]);
    faults.failWrite = false;
    expect(activeBreakGlass(home, NOW)).toBeUndefined();
    expect(audit()).toHaveLength(1);
    expect(existsSync(file())).toBe(false);
  });

  it("writes nothing while the lock is held", () => {
    put(expired());
    mkdirSync(join(home, "auth.lock"));
    writeFileSync(join(home, "auth.lock", "pid"), String(process.pid));
    expect(activeBreakGlass(home, NOW)).toBeUndefined();
    expect(existsSync(file())).toBe(true);
    expect(audit()).toEqual([]);
  });
});

describe("data folder move", () => {
  it("does not list the record for rewriting", () => {
    put(rec());
    expect(jsonFiles(home)).toEqual([]);
  });
});

describe("policyCommand", () => {
  const run = (pos: string[], o: Parameters<typeof policyCommand>[1] = {}) => {
    const out: string[] = [];
    const code = policyCommand(pos, o, (l) => out.push(l));
    return { out, code };
  };

  it("starts, refuses and ends", () => {
    const s = run(["break-glass"], { reason: "outage", for: "30m" });
    expect(s.code).toBe(0);
    expect(s.out[0]).toMatch(/^✔ break-glass active until \d{4}-/);
    expect(s.out[1]).toBe("  end it early with: scf policy break-glass --end");
    const again = run(["break-glass"], { reason: "outage", for: "30m" });
    expect(again.code).toBe(1);
    expect(again.out[0]).toMatch(/^✘ a break-glass is already active/);
    expect(again.out[0]).not.toContain(home);
    expect(run(["break-glass"], { end: true })).toEqual({ out: ["✔ break-glass ended"], code: 0 });
    expect(run(["break-glass"], { end: true })).toEqual({ out: ["✘ no break-glass is active"], code: 1 });
  });

  it("refuses a bad reason with exit 1", () => {
    const r = run(["break-glass"], { for: "30m" });
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^✘ /);
  });

  it("throws the usage for wrong arguments", () => {
    for (const [pos, o] of [
      [["break-glass", "x"], {}],
      [["break-glass"], { end: true, reason: "x" }],
      [["break-glass"], { end: true, for: "5m" }],
      [["break-glass"], { force: true, reason: "x", for: "5m" }],
      [["break-glass"], { force: true, end: true }],
      [["restore", "org"], { reason: "x" }],
      [["restore", "org"], { for: "5m" }],
      [["restore", "org"], { end: true }],
    ] as const) {
      expect(() => policyCommand([...pos], o, () => undefined)).toThrow(POLICY_USAGE);
    }
  });
});
