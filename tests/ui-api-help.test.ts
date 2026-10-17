import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The real ui/api.js with a stubbed fetch: the three calls of a corrective action.
let mod: any;
const calls: any[] = [];
const reload = vi.fn();
const realFetch = globalThis.fetch;
const realLocation = (globalThis as any).location;

const reply = (status: number, body: any) => ({ ok: status < 400, status, statusText: "x", headers: { get: () => null }, json: async () => body });

beforeEach(async () => {
  mod = await import("../ui/api.js" as string);
  calls.length = 0;
  reload.mockClear();
  (globalThis as any).location = { reload };
  globalThis.fetch = vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return reply(200, { ok: true }) as any; }) as any;
  mod.setCsrf("csrf-1");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).location = realLocation;
  mod.setViewAs("");
  mod.setCsrf("");
});

describe("the action calls of ui/api.js", () => {
  it("send POST with the exact body, the encoded address and the CSRF header", async () => {
    await mod.api.prepareHelpAction("c/1", { message: "a1", index: 0 });
    await mod.api.confirmHelpAction("c/1", { token: "t1", message: "a1", index: 0 });
    await mod.api.cancelHelpAction("c/1", "t1");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/help/conversations/c%2F1/actions",
      "/api/help/conversations/c%2F1/actions/confirm",
      "/api/help/conversations/c%2F1/actions/cancel",
    ]);
    expect(calls.map((c) => JSON.parse(c.init.body))).toEqual([{ message: "a1", index: 0 }, { token: "t1", message: "a1", index: 0 }, { token: "t1" }]);
    for (const c of calls) {
      expect(c.init.method).toBe("POST");
      expect(c.init.headers).toMatchObject({ "x-csrf-token": "csrf-1", "content-type": "application/json" });
    }
  });

  it("reject with the status and the server's text", async () => {
    globalThis.fetch = vi.fn(async () => reply(409, { error: "this confirmation does not work" }) as any) as any;
    await expect(mod.api.confirmHelpAction("c1", { token: "t", message: "a1", index: 0 })).rejects.toMatchObject({ status: 409, message: "this confirmation does not work" });
  });

  it("do not reload the page on a 401", async () => {
    globalThis.fetch = vi.fn(async () => reply(401, { error: "no" }) as any) as any;
    await expect(mod.api.prepareHelpAction("c1", { message: "a1", index: 0 })).rejects.toMatchObject({ status: 401 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("are refused in a preview before any request", async () => {
    mod.setViewAs("u1");
    for (const call of [() => mod.api.prepareHelpAction("c1", {}), () => mod.api.confirmHelpAction("c1", {}), () => mod.api.cancelHelpAction("c1", "t")]) {
      await expect(call()).rejects.toMatchObject({ preview: true, message: mod.PREVIEW_TEXT });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
