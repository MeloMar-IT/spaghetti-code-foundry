import { describe, expect, it } from "vitest";
import { AuditEntrySchema } from "../src/auth/audit.js";
import { SERVICE_DROPPED_TEXT, clientOf, isPrintable, parseServiceLine, serviceLineDetail } from "../src/auth/audit-client.js";
import { HttpError } from "../src/server/http.js";
import { LineLimiter, SERVICE_LINE_LIMIT, readServiceLine } from "../src/server/api-service-line.js";

// A service account's own audit line (#884), as units: the detail format, the body check and the limiter. No server.

const PERSON = "00000000-0000-4000-8000-0000000000a1";

describe("serviceLineDetail and parseServiceLine", () => {
  it("round-trips all parts, and only the result", () => {
    const full = { result: "refused" as const, code: "bad_signature", text: "signature did not match", actsFor: PERSON, client: "Kitchen tablet" };
    const d = serviceLineDetail(full);
    expect(d).toBe(`refused; code bad_signature; text "signature did not match"; acts for ${PERSON}; client Kitchen tablet`);
    expect(parseServiceLine(d)).toEqual(full);
    expect(serviceLineDetail({ result: "ok" })).toBe("ok");
    expect(parseServiceLine("ok")).toEqual({ result: "ok" });
  });

  it("keeps a text that looks like the later parts inside its quotes", () => {
    const text = `a "quote" \\ back; client fake; acts for ${PERSON}`;
    const d = serviceLineDetail({ result: "failed", text, client: "real" });
    expect(parseServiceLine(d)).toEqual({ result: "failed", text, client: "real" });
    expect(clientOf({ action: "service-line", detail: d })).toBe("real");
    const noClient = serviceLineDetail({ result: "failed", text: "x; client fake" });
    expect(clientOf({ action: "service-line", detail: noClient })).toBeUndefined();
  });

  it("reads the label of a dropped line, and nothing from a detail that does not parse", () => {
    expect(clientOf({ action: "service-line-dropped", detail: `${SERVICE_DROPPED_TEXT}; acts for ${PERSON}; client phone` })).toBe("phone");
    expect(clientOf({ action: "service-line", detail: "maybe; client phone" })).toBeUndefined();
    expect(clientOf({ action: "sign-in", detail: "client phone" })).toBeUndefined();
  });

  it("fits the audit schema at its largest", () => {
    const detail = serviceLineDetail({ result: "refused", code: "c".repeat(64), text: '"\\'.repeat(150), actsFor: PERSON, client: "é".repeat(64) });
    const entry = { time: new Date().toISOString(), by: PERSON, action: "service-line", result: "failed", target: "e".repeat(64), detail };
    expect(AuditEntrySchema.safeParse(entry).success).toBe(true);
    expect(parseServiceLine(detail)?.text).toBe('"\\'.repeat(150));
  });
});

describe("isPrintable", () => {
  it("gives the same answer every time (no regex state)", () => {
    expect(isPrintable("a\tb")).toBe(false);
    expect(isPrintable("a\tb")).toBe(false);
    expect(isPrintable("plain text")).toBe(true);
    expect(isPrintable("plain text")).toBe(true);
  });
});

describe("readServiceLine", () => {
  const status = (body: Record<string, unknown>) => {
    try {
      readServiceLine(body);
      return 200;
    } catch (e) {
      return e instanceof HttpError ? e.status : 0;
    }
  };

  it("accepts a minimal and a full body", () => {
    expect(readServiceLine({ event: "sign-check", result: "ok" })).toEqual({ event: "sign-check", result: "ok" });
    expect(readServiceLine({ event: "a.b_c-1", result: "refused", code: "bad_signature", detail: " x".repeat(150) })).toEqual({
      event: "a.b_c-1", result: "refused", code: "bad_signature", detail: " x".repeat(150),
    });
  });

  it("answers 400 for each bad body", () => {
    const ok = { event: "e", result: "ok" };
    for (const bad of [
      { ...ok, extra: 1 },
      { result: "ok" },
      { ...ok, event: "Upper" },
      { ...ok, event: "e".repeat(65) },
      { ...ok, result: "maybe" },
      { ...ok, result: 1 },
      { ...ok, code: "has space" },
      { ...ok, code: null },
      { ...ok, detail: "d".repeat(301) },
      { ...ok, detail: `  ${"d".repeat(297)}  ` },
      { ...ok, detail: "\ttext" },
      { ...ok, detail: "text\n" },
      { ...ok, detail: "" },
      { ...ok, detail: ["x"] },
      { ...ok, detail: "token SCF_SVC_abc" },
      { ...ok, code: "scf_svc_x" },
      { ...ok, event: "scf_svc_x" },
    ]) {
      expect(status(bad), JSON.stringify(bad)).toBe(400);
    }
  });

  it("never repeats the sent value in its message", () => {
    expect(() => readServiceLine({ event: "e", result: "ok", detail: "secret\u0000words" })).toThrow(/^"detail" must be printable text/);
    expect(() => readServiceLine({ event: "Secret", result: "ok" })).toThrow(/^"event" must be/);
  });
});

describe("LineLimiter", () => {
  it("refuses the 121st line, asks for one dropped line, and retries a failed one", () => {
    const l = new LineLimiter();
    for (let i = 0; i < SERVICE_LINE_LIMIT; i++) expect(l.take("a", 1000 + i)).toEqual({ ok: true });
    const first = l.take("a", 2000);
    expect(first).toMatchObject({ ok: false, writeDropped: true });
    const after = first.ok ? 0 : first.retryAfterS;
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(60);
    // pending: no second write
    expect(l.take("a", 2001)).toMatchObject({ ok: false, writeDropped: false });
    l.droppedFailed("a");
    expect(l.take("a", 2002)).toMatchObject({ ok: false, writeDropped: true });
    l.droppedWritten("a", 2003);
    expect(l.take("a", 2004)).toMatchObject({ ok: false, writeDropped: false });
    // another account has its own count
    expect(l.take("b", 2005)).toEqual({ ok: true });
  });

  it("frees slots as the window slides, and asks for a new dropped line a minute later", () => {
    const l = new LineLimiter(2, 60_000);
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 30_000).ok).toBe(true);
    const r = l.take("a", 40_000);
    expect(r).toEqual({ ok: false, retryAfterS: 20, writeDropped: true });
    l.droppedWritten("a", 40_000);
    expect(l.take("a", 60_000).ok).toBe(true);
    expect(l.take("a", 70_000)).toMatchObject({ ok: false, writeDropped: false });
    expect(l.take("a", 100_000).ok).toBe(true);
    expect(l.take("a", 100_001)).toMatchObject({ ok: false, writeDropped: true });
  });

  it("forgets an account with nothing left to keep", () => {
    const l = new LineLimiter(1, 1000);
    l.take("a", 0);
    expect(l.size).toBe(1);
    l.take("b", 5000);
    expect(l.size).toBe(1);
  });
});
