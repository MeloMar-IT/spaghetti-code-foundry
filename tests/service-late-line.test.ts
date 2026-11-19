import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { CLIENT_MAX, cleanClient, clientOf } from "../src/auth/audit-client.js";
import { createServiceAccount, getServiceAccount, recordServiceUse, revokeServiceToken, writeServiceLine } from "../src/auth/service-accounts.js";
import { createUser } from "../src/auth/users.js";
import { HttpError } from "../src/server/http.js";
import { clientLabel, flushServiceLines, newServiceCall, pendingServiceLines, serviceCaller, serviceOk, type ServiceCall, type ServiceResponse } from "../src/server/service-requests.js";

// The client label and the late audit line of a service account's change (#877). Unit level: no server.

let home: string;
let saved: string | undefined;
const logs: string[] = [];
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-late-"));
  process.env.FACTORY_HOME = home;
  logs.length = 0;
});
afterEach(() => {
  flushServiceLines();
  vi.useRealTimers();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const ctx = { config: () => ({ server: { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false } }), opts: { port: 4321 }, diagLog: (m: string) => logs.push(m) } as never;
const local = (url: string) => ({ method: "GET", url, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:4321" } }) as never;
/** The service-request lines of the log, newest last. */
const lines = () =>
  existsSync(auditPath())
    ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.action === "service-request")
    : [];
type FakeRes = EventEmitter & { statusCode: number; writableFinished: boolean } & ServiceResponse;
const fakeRes = (): FakeRes => Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true }) as unknown as FakeRes;
const lockDir = () => join(home, "auth.lock");
const holdLock = () => {
  mkdirSync(lockDir());
  writeFileSync(join(lockDir(), "pid"), String(process.pid));
};

let made = 0;
/** A live call of a fresh account, past serviceCaller. */
function liveCall(method: string, seg: string[], client?: string, actsFor?: string): ServiceCall {
  const { token } = createServiceAccount({ name: `Robot ${++made}`, scope: ["POST runs/:id/cancel", "POST your-turn/act"], ...(actsFor ? { actsFor } : {}) });
  const call = newServiceCall(token!, method, seg, client);
  serviceCaller(ctx, local(`/api/${seg.join("/")}`), call, undefined);
  return call;
}

describe("cleanClient", () => {
  it("removes control, format and separator characters, and trims", () => {
    expect(cleanClient("Kitchen\u0000 tab\u0007let\n")).toBe("Kitchen tablet");
    expect(cleanClient("a‮b​c d")).toBe("abcd");
  });
  it("cuts a long label to 64 code points, never splitting an emoji", () => {
    expect(cleanClient("a".repeat(100))).toBe("a".repeat(CLIENT_MAX));
    const cut = cleanClient("😀".repeat(70))!;
    expect(Array.from(cut)).toHaveLength(64);
    expect(cut).toBe("😀".repeat(64));
  });
  it("gives nothing for a blank or non-string value, and hides a token", () => {
    for (const v of ["   ", "", 5, undefined, "\u0000\u0001"]) expect(cleanClient(v)).toBeUndefined();
    expect(cleanClient("x scf_svc_abc")).toBe("hidden");
  });
  it("reads the header of a request", () => {
    expect(clientLabel({ headers: { "x-scf-client": " phone\t" } } as never)).toBe("phone");
    expect(clientLabel({ headers: {} } as never)).toBeUndefined();
  });
});

describe("clientOf", () => {
  it("reads the label from the last part of a service line", () => {
    expect(clientOf({ action: "service-request", detail: "200; acts for x; client Kitchen" })).toBe("Kitchen");
    expect(clientOf({ action: "service-request", detail: "client A; B" })).toBe("A; B");
    expect(clientOf({ action: "service-request", detail: "200; acts for x" })).toBeUndefined();
    expect(clientOf({ action: "service-request" })).toBeUndefined();
    expect(clientOf({ action: "edit", detail: "client A" })).toBeUndefined();
  });
});

describe("recordServiceUse with defer, and writeServiceLine", () => {
  it("checks a live token and touches it, but writes no line", () => {
    const { account } = createServiceAccount({ name: "Robot", scope: [] });
    expect(recordServiceUse(account.id, { result: "ok", target: "POST x" }, { touch: true, defer: true })).toBe(true);
    expect(lines()).toHaveLength(0);
    expect(getServiceAccount(account.id)!.token!.used).toBeTruthy();
  });
  it("still writes the failed line of a revoked token at once", () => {
    const { account } = createServiceAccount({ name: "Robot", scope: [] });
    revokeServiceToken(account.id);
    expect(recordServiceUse(account.id, { result: "ok", target: "POST x" }, { touch: true, defer: true })).toBe(false);
    expect(lines()).toEqual([expect.objectContaining({ result: "failed", detail: "the token ended" })]);
  });
  it("throws when the log cannot be opened", () => {
    const { account } = createServiceAccount({ name: "Robot", scope: [] });
    mkdirSync(auditPath());
    expect(() => recordServiceUse(account.id, { result: "ok", target: "POST x" }, { touch: true, defer: true })).toThrow();
  });
  it("writeServiceLine writes the line as given, also for a revoked token", () => {
    const { account } = createServiceAccount({ name: "Robot", scope: [] });
    revokeServiceToken(account.id);
    writeServiceLine(account.id, { result: "ok", target: "POST x", detail: "200" });
    expect(lines()).toEqual([expect.objectContaining({ by: account.id, result: "ok", target: "POST x", detail: "200" })]);
  });
});

describe("serviceOk on a change", () => {
  it("writes one ok line when the response is done, with the status and the label", () => {
    const call = liveCall("POST", ["your-turn", "act"], "phone");
    const res = fakeRes();
    serviceOk(ctx, call, res);
    expect(call.written).toBe(true);
    expect(lines()).toHaveLength(0);
    res.emit("close");
    expect(lines()).toEqual([expect.objectContaining({ by: call.account!.id, result: "ok", target: "POST your-turn/act", detail: "200; client phone" })]);
    res.emit("close");
    expect(lines()).toHaveLength(1);
  });

  it("names the person it acts for", async () => {
    const ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345", role: "user" });
    const call = liveCall("POST", ["runs", "r1", "cancel"], "tablet", ann.id);
    const res = fakeRes();
    serviceOk(ctx, call, res);
    res.emit("close");
    expect(lines()[0].detail).toBe(`200; acts for ${ann.id}; client tablet`);
  });

  it("writes failed for an error status and for a connection closed early", () => {
    const call = liveCall("POST", ["runs", "r1", "cancel"]);
    const res = fakeRes();
    serviceOk(ctx, call, res);
    res.statusCode = 409;
    res.emit("close");
    expect(lines()[0]).toMatchObject({ result: "failed", detail: "409" });
    const early = Object.assign(fakeRes(), { writableFinished: false });
    serviceOk(ctx, liveCall("POST", ["runs", "r1", "cancel"]), early);
    early.emit("close");
    expect(lines()[1]).toMatchObject({ result: "failed", detail: "200 the connection closed early" });
  });

  it("writes a read's line at once and waits for nothing", () => {
    const { token } = createServiceAccount({ name: "Reader", scope: ["GET runs"] });
    const call = newServiceCall(token!, "GET", ["runs"], "phone");
    serviceCaller(ctx, local("/api/runs"), call, undefined);
    const res = fakeRes();
    serviceOk(ctx, call, res);
    expect(lines()).toEqual([expect.objectContaining({ result: "ok", target: "GET runs", detail: "client phone" })]);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("answers 503 before the handler when the log cannot be opened", () => {
    const call = liveCall("POST", ["runs", "r1", "cancel"]);
    mkdirSync(auditPath());
    const res = fakeRes();
    expect(() => serviceOk(ctx, call, res)).toThrow(HttpError);
    expect(res.listenerCount("close")).toBe(0);
  });
});

describe("the late write", () => {
  it("tries again while another process holds the lock", () => {
    vi.useFakeTimers();
    const call = liveCall("POST", ["runs", "r1", "cancel"], "phone");
    const res = fakeRes();
    serviceOk(ctx, call, res);
    holdLock();
    res.emit("close");
    expect(lines()).toHaveLength(0);
    vi.advanceTimersByTime(75);
    expect(lines()).toHaveLength(0);
    rmSync(lockDir(), { recursive: true });
    vi.advanceTimersByTime(25);
    expect(lines()).toHaveLength(1);
    expect(pendingServiceLines()).toBe(0);
    expect(logs).toEqual([]);
  });

  it("gives up after the retries: logs once and leaves no timer", () => {
    vi.useFakeTimers();
    const res = fakeRes();
    serviceOk(ctx, liveCall("POST", ["runs", "r1", "cancel"]), res);
    holdLock();
    res.emit("close");
    vi.advanceTimersByTime(25 * 30);
    expect(logs).toEqual(["auth: auth.lock locked (service-request late)"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(pendingServiceLines()).toBe(0);
    rmSync(lockDir(), { recursive: true });
    expect(lines()).toHaveLength(0);
  });

  it("logs another write error at once, with no retry", () => {
    vi.useFakeTimers();
    const res = fakeRes();
    serviceOk(ctx, liveCall("POST", ["runs", "r1", "cancel"]), res);
    rmSync(auditPath(), { force: true });
    mkdirSync(auditPath());
    res.emit("close");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^auth: audit\.jsonl \S+ \(service-request late\)$/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes a waiting line once when flushed (as on process exit)", () => {
    vi.useFakeTimers();
    const res = fakeRes();
    serviceOk(ctx, liveCall("POST", ["runs", "r1", "cancel"]), res);
    holdLock();
    res.emit("close");
    expect(pendingServiceLines()).toBe(1);
    expect(process.listeners("exit")).toContain(flushServiceLines);
    rmSync(lockDir(), { recursive: true });
    flushServiceLines();
    expect(lines()).toHaveLength(1);
    vi.advanceTimersByTime(25 * 30);
    expect(lines()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
