import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { StoreError } from "../src/auth/store.js";
import { SHARING_TARGET, getUser, listUsers, setMetricsSharing, sharingAnswer, usersPath, UserError } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { sharingAccounts } from "../src/metrics-share/sources.js";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "sharing-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const person = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(), name: "Ann", email: `${randomUUID()}@example.com`, role: "user", status: "active",
  created: "2026-01-01T00:00:00.000Z", lastSignIn: null, ...over,
});
const service = (over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  return { id, name: "Robot", email: `${id}@service.invalid`, role: "user", status: "active", created: "2026-01-01T00:00:00.000Z", lastSignIn: null, kind: "service", scope: ["GET runs"], ...over };
};
const put = (users: unknown[]) => writeFileSync(usersPath(), JSON.stringify({ version: 1, users }), { mode: 0o600 });
const audit = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("the sharing answer", () => {
  it("is unasked for an account without one, also from an old users.json", () => {
    const ann = person();
    put([ann]);
    const u = getUser(ann.id)!;
    expect(u.metricsSharing).toBeUndefined();
    expect(sharingAnswer(u)).toBe("unasked");
  });

  it("stores yes and no, each with one audit line by the account itself", () => {
    const ann = person();
    put([ann]);
    const yes = setMetricsSharing(ann.id, "yes", new Date("2026-11-20T10:00:00.000Z"));
    expect(yes.metricsSharing).toEqual({ answer: "yes", changed: "2026-11-20T10:00:00.000Z" });
    expect(sharingAnswer(getUser(ann.id)!)).toBe("yes");
    setMetricsSharing(ann.id, "no", new Date("2026-11-21T10:00:00.000Z"));
    expect(getUser(ann.id)!.metricsSharing).toEqual({ answer: "no", changed: "2026-11-21T10:00:00.000Z" });
    expect(audit().map(({ time: _t, ...rest }) => rest)).toEqual([
      { by: ann.id, action: "settings-change", result: "ok", target: SHARING_TARGET, detail: "unasked -> yes" },
      { by: ann.id, action: "settings-change", result: "ok", target: SHARING_TARGET, detail: "yes -> no" },
    ]);
  });

  it("writes nothing for the same answer again", () => {
    const ann = person({ metricsSharing: { answer: "yes", changed: "2026-11-01T00:00:00.000Z" } });
    put([ann]);
    const before = readFileSync(usersPath(), "utf8");
    expect(setMetricsSharing(ann.id, "yes").metricsSharing?.changed).toBe("2026-11-01T00:00:00.000Z");
    expect(readFileSync(usersPath(), "utf8")).toBe(before);
    expect(audit()).toEqual([]);
  });

  it("refuses a bad answer, an unknown account and a service account", () => {
    const robot = service();
    put([robot]);
    expect(() => setMetricsSharing(robot.id, "unasked" as "yes")).toThrowError(expect.objectContaining({ code: "bad-answer" }));
    expect(() => setMetricsSharing(randomUUID(), "yes")).toThrowError(expect.objectContaining({ code: "not-found" }));
    expect(() => setMetricsSharing(robot.id, "yes")).toThrowError(expect.objectContaining({ code: "service-account" }));
    expect(() => setMetricsSharing(robot.id, "yes")).toThrow(UserError);
    expect(audit()).toEqual([]);
  });

  it("refuses a users.json with an answer on a service account, or a bad answer", () => {
    put([service({ metricsSharing: { answer: "yes", changed: "2026-11-01T00:00:00.000Z" } })]);
    expect(() => listUsers()).toThrowError(expect.objectContaining({ kind: "wrong-format" }));
    put([person({ metricsSharing: { answer: "unasked", changed: "2026-11-01T00:00:00.000Z" } })]);
    expect(() => listUsers()).toThrow(StoreError);
  });

  it("changes nothing when the audit log cannot be opened", () => {
    const ann = person();
    put([ann]);
    mkdirSync(auditPath()); // a folder: it cannot be opened for appending
    const before = readFileSync(usersPath(), "utf8");
    expect(() => setMetricsSharing(ann.id, "yes")).toThrow();
    expect(readFileSync(usersPath(), "utf8")).toBe(before);
  });
});

describe("sharingAccounts", () => {
  it("counts only the person accounts that said yes, and nobody while sharing is not allowed", () => {
    const yes = person({ metricsSharing: { answer: "yes", changed: "2026-11-01T00:00:00.000Z" } });
    const no = person({ metricsSharing: { answer: "no", changed: "2026-11-01T00:00:00.000Z" } });
    put([yes, no, person(), service()]);
    expect(sharingAccounts(true)).toEqual([yes.id]);
    expect(sharingAccounts(false)).toEqual([]);
  });

  it("reads the admin switch from config.yaml, default on", () => {
    const yes = person({ metricsSharing: { answer: "yes", changed: "2026-11-01T00:00:00.000Z" } });
    put([yes]);
    expect(sharingAccounts()).toEqual([yes.id]);
    writeFileSync(join(home, "config.yaml"), "metrics_sharing:\n  allowed: false\n");
    expect(sharingAccounts()).toEqual([]);
  });
});

describe("metrics_sharing.allowed", () => {
  it("defaults to true and keeps an old config valid", () => {
    expect(ConfigSchema.parse({}).metrics_sharing).toEqual({ allowed: true, endpoint: "https://spaghetti-code-foundry.com/api/metrics", timeout_ms: 10000 });
    expect(ConfigSchema.parse({ metrics_sharing: { allowed: false } }).metrics_sharing.allowed).toBe(false);
    expect(ConfigSchema.safeParse({ metrics_sharing: { allowed: "no" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ metrics_sharing: { other: 1 } }).success).toBe(false);
  });
});

describe("metrics_sharing.endpoint and timeout_ms (#889)", () => {
  const ok = (v: Record<string, unknown>) => ConfigSchema.safeParse({ metrics_sharing: v }).success;
  it("accepts https, and plain http only for localhost and 127.0.0.1", () => {
    expect(ok({ endpoint: "https://example.com/api/metrics" })).toBe(true);
    expect(ok({ endpoint: "http://localhost:1/x" })).toBe(true);
    expect(ok({ endpoint: "http://127.0.0.1:1/x" })).toBe(true);
  });
  it("refuses other addresses", () => {
    for (const endpoint of ["http://example.com/x", "http://[::1]/x", "http://127.0.0.2/x", "https://u:p@h/x", "https://u@h/x", "https://h/x?a", "https://h/x#a", "ftp://h", "https://h/ x", "not a url", `https://h/${"a".repeat(2050)}`]) {
      expect(ok({ endpoint }), endpoint).toBe(false);
    }
    const r = ConfigSchema.safeParse({ metrics_sharing: { endpoint: "http://example.com/x" } });
    expect(r.success ? "" : r.error.issues[0]!.message).toMatch(/plain http is allowed only for localhost or 127\.0\.0\.1/);
  });
  it("keeps timeout_ms between 1000 and 60000", () => {
    expect(ok({ timeout_ms: 1000 })).toBe(true);
    expect(ok({ timeout_ms: 60000 })).toBe(true);
    expect(ok({ timeout_ms: 999 })).toBe(false);
    expect(ok({ timeout_ms: 60001 })).toBe(false);
    expect(ok({ timeout_ms: 1500.5 })).toBe(false);
  });
});
