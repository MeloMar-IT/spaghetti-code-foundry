import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin-credentials.js" as string);
  api = (await import("../ui/api.js" as string)).api;
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

let list: any[];
let heldGets: (() => void)[][];
const realFetch = globalThis.fetch;
let nextId = 1;

beforeEach(() => {
  list = [];
  heldGets = [];
  delete (globalThis as any).location;
  (globalThis as any).fetch = async () => {
    const snapshot = [...list];
    const wait = heldGets.shift();
    if (wait) await new Promise<void>((r) => wait.push(r));
    return { ok: true, status: 200, statusText: "x", json: async () => snapshot };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const rec = (over: object = {}) => ({
  id: `c${nextId++}`,
  type: "token",
  name: "gh",
  created: "2026-10-01T08:00:00.000Z",
  lastUsed: null,
  fingerprint: "0123456789abcdef",
  owner: "u1",
  ownerName: "Ann",
  ...over,
});
const show = () => ui.renderCredentials(main());
const rows = () => walk(main()).filter((e) => e.tag === "tr").slice(1).map((tr) => walk(tr).filter((e) => e.tag === "td").map((td) => td.textContent));

describe("the page", () => {
  it("shows never for no time", () => {
    expect(ui.whenText(null)).toBe("never");
    expect(ui.whenText("2026-10-02T09:00:00.000Z")).toBe(new Date("2026-10-02T09:00:00.000Z").toLocaleString());
  });

  it("draws the heading, the columns and the rows in the order given", async () => {
    list = [rec({ ownerName: "Zed", name: "z" }), rec({ lastUsed: "2026-10-02T09:00:00.000Z" })];
    await show();
    expect(walk(main()).find((e) => e.tag === "h1")!.textContent).toBe("Credentials");
    expect(walk(main()).filter((e) => e.tag === "th").map((e) => e.textContent)).toEqual(["Owner", "Name", "Type", "Fingerprint", "Created", "Last used"]);
    const created = ui.whenText("2026-10-01T08:00:00.000Z");
    expect(rows()).toEqual([
      ["Zed", "z", "token", "0123456789abcdef", created, "never"],
      ["Ann", "gh", "token", "0123456789abcdef", created, ui.whenText("2026-10-02T09:00:00.000Z")],
    ]);
  });

  it("shows a deleted account as it comes", async () => {
    list = [rec({ ownerName: "deleted account" })];
    await show();
    expect(rows()[0]![0]).toBe("deleted account");
  });

  it("shows an empty text and no table", async () => {
    await show();
    expect(main().textContent).toContain("No stored credentials yet.");
    expect(walk(main()).filter((e) => e.tag === "table")).toEqual([]);
    expect(walk(main()).filter((e) => e.tag === "button")).toEqual([]);
  });

  it("has no button with rows", async () => {
    list = [rec()];
    await show();
    expect(walk(main()).filter((e) => e.tag === "button")).toEqual([]);
  });

  it("sets text as text", async () => {
    list = [rec({ name: "<img src=x onerror=1>" })];
    await show();
    expect(rows()[0]![1]).toBe("<img src=x onerror=1>");
    expect(walk(main()).filter((e) => e.tag === "img")).toEqual([]);
  });
});

describe("late answers", () => {
  it("draws nothing after the person left the page", async () => {
    (globalThis as any).location = { hash: "#/credentials" };
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    const loading = show();
    await flush();
    (globalThis as any).location = { hash: "#/runs" };
    main().textContent = "Runs page";
    gate.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("Runs page");
  });

  it("draws only the newest of overlapping loads", async () => {
    (globalThis as any).location = { hash: "#/credentials" };
    list = [rec()];
    const older: (() => void)[] = [];
    heldGets.push(older);
    const first = show();
    await flush();
    list = [];
    const second = show();
    await flush();
    older.forEach((f) => f());
    await Promise.all([first, second]);
    expect(main().textContent).toContain("No stored credentials yet.");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");

  it("links the page and imports it", async () => {
    const ia = (await import("../ui/ia.js" as string)) as { subnavFor: (r: string, d: string) => { href: string }[] };
    const repos = ia.subnavFor("admin", "repos").map((l) => l.href);
    expect(repos.indexOf("#/credentials")).toBe(repos.indexOf("#/all-repos") + 1);
    const app = read("app.js");
    expect(app).toContain('from "./admin-credentials.js"');
    expect(app).toContain('section === "credentials"');
  });

  it("drops a late cleanup and a late error in the router", () => {
    // app.js starts the whole display on import, so the guard is checked in the source
    const app = read("app.js");
    expect(app).toContain("const mine = ++routeGen;");
    expect(app).toContain("if (mine === routeGen) S.cleanup = off;");
    expect(app).toContain("if (mine !== routeGen) return;");
  });

  it("uses the right route", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return { ok: true, status: 200, json: async () => [] };
    };
    await api.allCredentials();
    expect(seen).toEqual(["GET /api/admin/credentials"]);
  });

  describe("states", () => {
    const byClass = (cls: string) => walk(main()).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
    const failWith = (status: number | "throw", error = "x") => {
      (globalThis as any).fetch = async () => {
        if (status === "throw") throw new TypeError("fetch failed");
        return { ok: false, status, statusText: "x", json: async () => ({ error }) };
      };
    };

    it("draws a skeleton while loading, without buttons", async () => {
      const gate: (() => void)[] = [];
      heldGets.push(gate);
      const loading = show();
      await flush();
      expect(byClass("skeleton")).toHaveLength(1);
      expect(walk(main()).some((e) => e.tag === "button")).toBe(false);
      gate.forEach((r) => r());
      await loading;
      expect(byClass("skeleton")).toHaveLength(0);
    });

    it("shows a 500 with Retry, and Retry loads again", async () => {
      failWith(500, "the store is broken");
      await show();
      expect(byClass("state-error")[0]!.attrs["data-kind"]).toBe("server");
      expect(main().textContent).toContain("The credentials could not be loaded. the store is broken");
      (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "x", json: async () => [rec({ name: "after-retry" })] });
      walk(main()).find((e) => e.tag === "button" && e.textContent === "Retry")!.click();
      await flush();
      expect(main().textContent).toContain("after-retry");
      expect(byClass("state-error")).toHaveLength(0);
    });

    it("shows a 403 as a permission state", async () => {
      failWith(403, "admin only");
      await show();
      expect(byClass("state-permission")[0]!.textContent).toContain("Only an admin can see the stored credentials.");
      expect(walk(main()).some((e) => e.tag === "button")).toBe(false);
    });

    it("shows a network failure as offline", async () => {
      failWith("throw");
      await show();
      expect(byClass("state-error")[0]!.attrs["data-kind"]).toBe("offline");
    });

    it("disposing an older render does not stop a newer one that is still loading", async () => {
      (globalThis as any).location = { hash: "#/credentials" };
      list = [rec({ name: "kept" })];
      const a: (() => void)[] = [];
      const b: (() => void)[] = [];
      heldGets.push(a, b);
      const first = show();
      await flush();
      const second = show();
      await flush();
      a.forEach((r) => r());
      (await first)();
      b.forEach((r) => r());
      await second;
      expect(main().textContent).toContain("kept");
      expect(byClass("skeleton")).toHaveLength(0);
    });

    it("draws an empty list through the empty box", async () => {
      await show();
      expect(byClass("empty")[0]!.textContent).toContain("No stored credentials yet.");
    });

    it("shows only the fingerprint as key text, with a failure too", async () => {
      list = [rec({ fingerprint: "ffeeddccbbaa9988" })];
      await show();
      expect(main().textContent).toContain("ffeeddccbbaa9988");
      failWith(500, "boom");
      await show();
      expect(main().textContent).not.toContain("ffeeddccbbaa9988");
    });
  });

  it("never gives the page to a user", () => {
    expect(auth.userHash("#/credentials")).toBe("#/runs");
    expect(auth.otherDisplay({ role: "user" }, "admin", "#/credentials")).toBe("/user/");
  });

  it("never sets HTML", () => {
    expect(read("admin-credentials.js")).not.toContain("innerHTML");
  });
});
