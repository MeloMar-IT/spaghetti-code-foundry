import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { deleteUrl, retryAfterOf, sendDelete, sendReport, userAgent, type PushTarget } from "../src/metrics-share/push.js";
import type { ShareReport } from "../src/metrics-share/report.js";
import { fakeReceiver, type FakeReceiver } from "./fixtures/fake-receiver.js";

const report = { version: 1, day: "2026-11-19", install: "ab".repeat(16) } as unknown as ShareReport;
const ID = "0123456789abcdef0123456789abcdef";
let open: FakeReceiver[] = [];
const receiver = async (...a: Parameters<typeof fakeReceiver>) => {
  const r = await fakeReceiver(...a);
  open.push(r);
  return r;
};
const target = (endpoint: string, timeoutMs = 5000): PushTarget => ({ endpoint, timeoutMs, version: "0.4.0" });
afterEach(async () => {
  await Promise.all(open.map((r) => r.close()));
  open = [];
});

describe("sendReport", () => {
  it("POSTs only the report with exactly host, content-type, content-length, connection and user-agent", async () => {
    const r = await receiver();
    expect(await sendReport(target(r.endpoint), report)).toEqual({ result: "accepted", status: 200 });
    expect(r.got).toHaveLength(1);
    const g = r.got[0]!;
    expect(g.method).toBe("POST");
    expect(g.url).toBe("/api/metrics");
    expect(Object.keys(g.headers).sort()).toEqual(["connection", "content-length", "content-type", "host", "user-agent"]);
    expect(g.headers["user-agent"]).toBe("spaghetti-code-foundry/0.4.0");
    expect(g.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(g.body)).toEqual(report);
  });

  it("sends no cookie, also after the receiver set one", async () => {
    const r = await receiver(() => ({ status: 200, headers: { "Set-Cookie": "s=1; Path=/" } }));
    await sendReport(target(r.endpoint), report);
    await sendReport(target(r.endpoint), report);
    expect(r.got).toHaveLength(2);
    for (const g of r.got) expect(g.headers.cookie).toBeUndefined();
  });

  it("does not follow a redirect", async () => {
    const other = await receiver();
    const r = await receiver(() => ({ status: 302, headers: { Location: other.endpoint } }));
    expect(await sendReport(target(r.endpoint), report)).toEqual({ result: "refused", status: 302 });
    expect(other.got).toHaveLength(0);
  });

  it("reads only the status and a retry_after from a small JSON answer", async () => {
    const r = await receiver(() => ({ status: 429, body: JSON.stringify({ retry_after: 7200, other: "x" }) }));
    expect(await sendReport(target(r.endpoint), report)).toEqual({ result: "refused", status: 429, retryAfterS: 7200 });
    r.answer = () => ({ status: 503, body: JSON.stringify({ retry_after: 7200, pad: "x".repeat(1024 * 1024) }) });
    expect(await sendReport(target(r.endpoint), report)).toEqual({ result: "refused", status: 503 });
    r.answer = () => ({ status: 200, body: JSON.stringify({ retry_after: 60 }) });
    expect(await sendReport(target(r.endpoint), report)).toEqual({ result: "accepted", status: 200 });
  });

  it("is unreachable when the receiver does not answer in time or is not there", async () => {
    const r = await receiver(() => "hang");
    expect(await sendReport(target(r.endpoint, 200), report)).toEqual({ result: "unreachable" });
    const s = http.createServer();
    await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((res) => s.close(() => res()));
    expect(await sendReport(target(`http://127.0.0.1:${port}/api/metrics`), report)).toEqual({ result: "unreachable" });
  });

  it("is unreachable when aborted", async () => {
    const r = await receiver(() => "hang");
    const c = new AbortController();
    const p = sendReport(target(r.endpoint), report, c.signal);
    c.abort();
    expect(await p).toEqual({ result: "unreachable" });
  });

  it("makes no connection to an endpoint that is not allowed", async () => {
    expect(await sendReport(target("http://example.invalid/api/metrics"), report)).toEqual({ result: "unreachable" });
    expect(await sendReport(target("https://u:p@example.invalid/x"), report)).toEqual({ result: "unreachable" });
  });
});

describe("sendReport answers", () => {
  it("accepts a 200 at once, even when its body never ends", async () => {
    const r = await receiver(() => ({ status: 200, hold: true }));
    expect(await sendReport(target(r.endpoint, 5000), report)).toEqual({ result: "accepted", status: 200 });
  });
});

describe("sendDelete", () => {
  it("sends DELETE <endpoint>/<install> with no body", async () => {
    const r = await receiver(() => ({ status: 204 }));
    expect(await sendDelete(target(r.endpoint), ID)).toEqual({ result: "accepted", status: 204 });
    expect(r.got.map((g) => [g.method, g.url, g.body])).toEqual([["DELETE", `/api/metrics/${ID}`, ""]]);
    expect(Object.keys(r.got[0]!.headers).sort()).toEqual(["connection", "content-length", "host", "user-agent"]);
    expect(await sendDelete(target(r.endpoint), "../x")).toEqual({ result: "unreachable" });
    expect(r.got).toHaveLength(1);
  });

  it("builds the address and the answer fields", () => {
    expect(deleteUrl("https://h/api/metrics/", ID)).toBe(`https://h/api/metrics/${ID}`);
    expect(userAgent("0.4.0")).toBe("spaghetti-code-foundry/0.4.0");
    expect(userAgent("bad value\n")).toBe("spaghetti-code-foundry/unknown");
    expect(retryAfterOf('{"retry_after":1}')).toBe(1);
    for (const b of ['{"retry_after":0}', '{"retry_after":86401}', '{"retry_after":1.5}', '{"retry_after":"60"}', "null", "x", "[]"]) expect(retryAfterOf(b), b).toBeUndefined();
  });
});
