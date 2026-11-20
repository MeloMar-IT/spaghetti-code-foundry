import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import type { ServiceAccount } from "../src/auth/service-accounts.js";
import { HttpError } from "../src/server/http.js";
import { LineLimiter, writeOwnLine, type LineDeps } from "../src/server/api-service-line.js";

// Writing a service account's own line (#884) while the lock is held or the log is broken. Unit level: no server, no timers
// (the retry delay is a hook the test controls).

let home: string;
let saved: string | undefined;
const logs: string[] = [];
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-line-"));
  process.env.FACTORY_HOME = home;
  logs.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const ROBOT = { id: "00000000-0000-4000-8000-0000000000c3", kind: "service", role: "user", scope: [] } as unknown as ServiceAccount;
const BODY = { event: "sign-check", result: "ok" as const };
const lockDir = () => join(home, "auth.lock");
const holdLock = () => {
  mkdirSync(lockDir());
  writeFileSync(join(lockDir(), "pid"), String(process.pid));
};
const releaseLock = () => rmSync(lockDir(), { recursive: true, force: true });
const lines = (action: string) =>
  existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.action === action) : [];

/** Deps with a delay that counts its calls and runs `onDelay` (no real wait). */
function deps(opts: { limiter?: LineLimiter; tries?: number; onDelay?: (n: number) => void | Promise<void> } = {}): LineDeps & { delays: () => number } {
  let n = 0;
  return {
    limiter: opts.limiter ?? new LineLimiter(),
    tries: opts.tries ?? 20,
    delay: async () => {
      n++;
      await opts.onDelay?.(n);
    },
    now: () => 1_000_000,
    log: (m) => logs.push(m),
    delays: () => n,
  };
}

async function statusOf(p: Promise<void>): Promise<{ status: number; headers?: Record<string, string>; message?: string }> {
  try {
    await p;
    return { status: 201 };
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return { status: e.status, ...(e.headers ? { headers: e.headers } : {}), message: e.message };
  }
}

describe("the normal line", () => {
  it("is written once when the lock is released after a few tries", async () => {
    holdLock();
    const d = deps({ onDelay: (n) => (n === 3 ? releaseLock() : undefined) });
    expect((await statusOf(writeOwnLine(ROBOT, BODY, "tab", d))).status).toBe(201);
    expect(d.delays()).toBe(3);
    expect(lines("service-line")).toHaveLength(1);
    expect(lines("service-line")[0]).toMatchObject({ by: ROBOT.id, result: "ok", target: "sign-check", detail: "ok; client tab" });
  });

  it("answers 503 with Retry-After 1 when the lock stays held, and writes nothing", async () => {
    holdLock();
    const d = deps({ tries: 5 });
    const r = await statusOf(writeOwnLine(ROBOT, BODY, undefined, d));
    expect(r).toMatchObject({ status: 503, headers: { "retry-after": "1" } });
    expect(d.delays()).toBe(4);
    releaseLock();
    expect(lines("service-line")).toHaveLength(0);
    expect(logs.some((l) => l.includes("locked"))).toBe(true);
  });

  it("answers 500 with a fixed message for another store error", async () => {
    mkdirSync(auditPath(), { recursive: true });
    const d = deps();
    const r = await statusOf(writeOwnLine(ROBOT, { ...BODY, detail: "private words" }, undefined, d));
    expect(r.status).toBe(500);
    expect(r.message).toBe("the audit log is not working; see the server log");
    expect(d.delays()).toBe(0);
    expect(logs.join("\n")).not.toContain("private words");
  });
});

describe("the dropped line", () => {
  const full = () => {
    const limiter = new LineLimiter(1, 60_000);
    limiter.take(ROBOT.id, 1_000_000);
    return limiter;
  };

  it("is not lost when the lock is held at first, and is written once later", async () => {
    const limiter = full();
    holdLock();
    expect((await statusOf(writeOwnLine(ROBOT, BODY, "tab", deps({ limiter, tries: 2 })))).status).toBe(429);
    releaseLock();
    expect(lines("service-line-dropped")).toHaveLength(0);
    expect((await statusOf(writeOwnLine(ROBOT, BODY, "tab", deps({ limiter })))).status).toBe(429);
    expect((await statusOf(writeOwnLine(ROBOT, BODY, "tab", deps({ limiter })))).status).toBe(429);
    const dropped = lines("service-line-dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ by: ROBOT.id, result: "failed", target: "POST audit/service-line", detail: "over 120 lines a minute; client tab" });
  });

  it("is written once when calls come in while it is pending", async () => {
    const limiter = full();
    holdLock();
    let others: Promise<unknown> | undefined;
    const d = deps({
      limiter,
      onDelay: async (n) => {
        if (n === 1) others = Promise.all([1, 2, 3].map(() => statusOf(writeOwnLine(ROBOT, BODY, undefined, deps({ limiter })))));
        if (n === 2) releaseLock();
      },
    });
    const r = await statusOf(writeOwnLine(ROBOT, BODY, undefined, d));
    expect(r.status).toBe(429);
    expect(r.headers?.["retry-after"]).toBe("60");
    const rest = (await others) as { status: number }[];
    expect(rest.map((x) => x.status)).toEqual([429, 429, 429]);
    expect(lines("service-line-dropped")).toHaveLength(1);
  });
});
