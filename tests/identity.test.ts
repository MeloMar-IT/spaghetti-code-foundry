import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  REASON_BAD, REASON_BUSY, REASON_THREW, REASON_TIMEOUT, disposeIdentity, hasIdentityProvider, readIdentityAnswer, resolveIdentity, supplyIdentity,
  type IdentityProvider, type IdentityRequest,
} from "../src/auth/identity.js";
import { identityRequest } from "../src/server/identity-session.js";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const req: IdentityRequest = { method: "GET", url: "/api/session", headers: { host: "x" }, remoteAddress: "127.0.0.1" };
let reports: string[] = [];
const supply = (provider: IdentityProvider, owner = "t") => supplyIdentity({ owner, plugin: owner, provider, report: (r) => reports.push(r) });
afterEach(() => {
  disposeIdentity("t");
  disposeIdentity("other");
  reports = [];
});

describe("the slot", () => {
  it("takes one supplier; only its owner disposes it", () => {
    expect(hasIdentityProvider()).toBe(false);
    expect(supply({ resolve: () => null })).toBe("ok");
    expect(hasIdentityProvider()).toBe(true);
    expect(supply({ resolve: () => null }, "other")).toEqual({ taken: "t" });
    disposeIdentity("other");
    expect(hasIdentityProvider()).toBe(true);
    disposeIdentity("t");
    expect(hasIdentityProvider()).toBe(false);
  });
});

describe("readIdentityAnswer", () => {
  it("accepts a valid answer: lower-case id, trimmed name, admin wins", () => {
    expect(readIdentityAnswer({ id: ID.toUpperCase(), name: "  Ann ", roles: ["user", "admin"], workspace: "team-a" })).toEqual({
      kind: "user", id: ID, name: "Ann", role: "admin", workspace: "team-a",
    });
    expect(readIdentityAnswer({ id: ID, name: "Bo", roles: ["user"] })).toEqual({ kind: "user", id: ID, name: "Bo", role: "user" });
  });
  it("null is nobody", () => expect(readIdentityAnswer(null)).toEqual({ kind: "none" }));
  it("refuses everything else", () => {
    const ok = { id: ID, name: "Ann", roles: ["user"] };
    const bad: unknown[] = [
      undefined, "x", [], 5, { ...ok, id: "nope" }, { ...ok, name: "" }, { ...ok, name: "   " }, { ...ok, name: "a".repeat(101) }, { ...ok, name: "a\u0007b" },
      { ...ok, roles: ["owner"] }, { ...ok, roles: [] }, { ...ok, roles: ["admin", "admin"] }, { ...ok, roles: ["admin", "user", "user"] },
      { ...ok, workspace: "Bad Space" }, { ...ok, extra: 1 },
      { get id(): string { throw new Error("SECRET-TEXT"); }, name: "A", roles: ["user"] },
    ];
    bad.forEach((b, i) => expect(readIdentityAnswer(b), `case ${i}`).toEqual({ kind: "error" }));
  });
});

describe("resolveIdentity", () => {
  const ok = { id: ID, name: "Ann", roles: ["user" as const] };
  it("without a supplier is an error", async () => expect(await resolveIdentity(req)).toEqual({ kind: "error" }));
  it("takes a sync and an async answer", async () => {
    supply({ resolve: () => ok });
    expect((await resolveIdentity(req)).kind).toBe("user");
    disposeIdentity("t");
    supply({ resolve: async () => null });
    expect(await resolveIdentity(req)).toEqual({ kind: "none" });
  });
  it("a throw or a rejection is an error that is reported once, without the text", async () => {
    let n = 0;
    supply({
      resolve: () => {
        if (n++ % 2) throw new Error("SECRET-TEXT");
        return Promise.reject(new Error("SECRET-TEXT"));
      },
    });
    expect(await resolveIdentity(req)).toEqual({ kind: "error" });
    expect(await resolveIdentity(req)).toEqual({ kind: "error" });
    expect(reports).toEqual([REASON_THREW]);
    expect(JSON.stringify(reports)).not.toContain("SECRET");
  });
  it("an invalid answer is reported as such", async () => {
    supply({ resolve: () => ({ id: "x" }) as never });
    expect(await resolveIdentity(req)).toEqual({ kind: "error" });
    expect(reports).toEqual([REASON_BAD]);
  });
  it("a timeout aborts the signal, and a late rejection is harmless", async () => {
    let signal: AbortSignal | undefined;
    let fail!: (e: Error) => void;
    supply({
      resolve: (_r, s) => {
        signal = s;
        return new Promise((_, rej) => (fail = rej));
      },
    });
    expect(await resolveIdentity(req, { timeoutMs: 20 })).toEqual({ kind: "error" });
    expect(signal!.aborted).toBe(true);
    expect(reports).toEqual([REASON_TIMEOUT]);
    fail(new Error("SECRET-TEXT")); // would be an unhandled rejection (vitest fails on one)
    await new Promise((r) => setTimeout(r, 10));
  });
  it("a synchronous answer that took longer than the deadline is refused", async () => {
    supply({
      resolve: () => {
        const end = performance.now() + 30;
        while (performance.now() < end) {
          /* busy */
        }
        return ok;
      },
    });
    expect(await resolveIdentity(req, { timeoutMs: 10 })).toEqual({ kind: "error" });
  });
  it("8 waiting calls fill the slots; the 9th is refused without calling the provider", async () => {
    const release: (() => void)[] = [];
    let calls = 0;
    supply({
      resolve: () => {
        calls++;
        return new Promise((r) => release.push(() => r(ok)));
      },
    });
    const first = Array.from({ length: 8 }, () => resolveIdentity(req, { timeoutMs: 5000 }));
    expect(await resolveIdentity(req)).toEqual({ kind: "error" });
    expect(calls).toBe(8);
    expect(reports).toEqual([REASON_BUSY]);
    release.forEach((r) => r());
    expect((await Promise.all(first)).every((r) => r.kind === "user")).toBe(true);
    release.length = 0;
    const again = resolveIdentity(req);
    await new Promise((r) => setTimeout(r, 0));
    release.forEach((r) => r());
    expect((await again).kind).toBe("user");
  });
  it("hands the provider a frozen request", async () => {
    let seen: IdentityRequest | undefined;
    supply({
      resolve: (r) => {
        seen = r;
        return null;
      },
    });
    await resolveIdentity({ ...req, headers: { a: "1" } });
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen!.headers)).toBe(true);
  });
});

describe("identityRequest", () => {
  const fake = (headers: Record<string, string | string[]>) => ({ method: "GET", url: "/x", headers, socket: { remoteAddress: "10.0.0.1" } }) as unknown as IncomingMessage;
  it("drops only the session cookie", () => {
    const r = identityRequest(fake({ cookie: "a=1; scf_session_80=SECRET; b=2", "x-multi": ["p", "q"] }), "scf_session_80");
    expect(r.headers.cookie).toBe("a=1; b=2");
    expect(r.headers["x-multi"]).toBe("p, q");
    expect(r.remoteAddress).toBe("10.0.0.1");
  });
  it("drops the header when nothing is left", () => {
    expect(identityRequest(fake({ cookie: "scf_session_80=SECRET" }), "scf_session_80").headers).not.toHaveProperty("cookie");
  });
});
