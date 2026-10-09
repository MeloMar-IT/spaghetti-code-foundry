import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The states of the Users page: loading, empty, partial (limits), stale (a reload that fails) and the order of reloads.
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/users.js" as string);
});
afterAll(() => restore());

type Get = { status?: number; error?: string; gate?: Promise<void>; users?: any[] };
let users: any[];
let gets: Get[]; // one entry per GET /api/users, taken in order; none left means a good answer
let limitsFail: boolean;
let sent: string[];
const realFetch = globalThis.fetch;
const user = (over: object = {}) => ({
  id: "u1", name: "Ann", email: "ann@example.com", role: "user", status: "active", created: "2026-01-01T00:00:00.000Z",
  lastSignIn: new Date().toISOString(), runs: 2, hasPassword: true, lockedUntil: null, ...over,
});
const page = { origin: () => "https://x", clipboard: () => undefined, reload: vi.fn(), go: vi.fn() };

beforeEach(() => {
  users = [user({ id: "me", name: "Root", role: "admin", runs: 0 }), user()];
  gets = [];
  limitsFail = false;
  sent = [];
  delete (globalThis as any).location;
  document.getElementById("modal-root")!.replaceChildren();
  document.getElementById("main")!.replaceChildren();
  (document as any).listeners.keydown = [];
  document.getElementById("toast")!.textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string }) => {
    if (url === "/api/users" && init.method === "GET") {
      const g = gets.shift();
      if (g?.gate) await g.gate;
      if (g?.status) return reply({ error: g.error }, g.status);
      return reply((g?.users ?? users).map((u) => ({ ...u })));
    }
    if (url.endsWith("/limits") && init.method === "GET") return limitsFail ? reply({ error: "broken" }, 500) : reply({ defaults: {}, users: {} });
    if (url.endsWith("/app-repos")) return reply({ repos: [] });
    sent.push(`${init.method} ${url}`);
    if (url.endsWith("/block")) return reply({ user: users[1], cancelled: { queued: 1, running: 0, waiting: 0 } });
    return reply({ user: users[1] });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => document.getElementById("main") as unknown as FakeElement;
const root = () => document.getElementById("modal-root") as unknown as FakeElement;
const toastText = () => document.getElementById("toast")!.textContent as string;
const button = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text);
const rows = () => main().all("tr").filter((r) => r.all("td").length);
const rowOf = (name: string) => rows().find((r) => r.all("td")[0]!.textContent.startsWith(name))!;
const show = async () => {
  await ui.renderUsers(main(), { me: "me", page });
};
const stale = () => main().all("p").filter((p) => (p.attrs.class ?? "").includes("stale-note"));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const open = async (name: string, label: string) => {
  button(rowOf(name), label)!.click();
  await flush();
};

describe("loading", () => {
  it("draws a skeleton while /api/users is held", async () => {
    const g = gate();
    gets.push({ gate: g.promise });
    const done = show();
    await flush();
    expect(main().all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(true);
    expect(main().textContent).toContain("Loading users…");
    g.release();
    await done;
    expect(main().all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(false);
    expect(rows()).toHaveLength(2);
  });
  it("rejects when /api/users fails, so the router draws the error", async () => {
    gets.push({ status: 500, error: "down" });
    await expect(show()).rejects.toThrow("down");
  });
  it("draws nothing when the page was left while it loads", async () => {
    (globalThis as any).location = { hash: "#/runs" };
    const g = gate();
    gets.push({ gate: g.promise });
    const done = show();
    await flush();
    expect(main().children).toHaveLength(0);
    g.release();
    await done;
    expect(main().children).toHaveLength(0);
  });
});

describe("empty and partial", () => {
  it("an empty list says No users yet and offers + Add user", async () => {
    users = [];
    await show();
    const empty = main().all("div").find((d) => d.attrs.class === "empty")!;
    expect(empty.textContent).toContain("No users yet.");
    expect(main().all("table")).toHaveLength(0);
    const buttons = main().all("button").filter((b) => b.textContent === "+ Add user");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    button(empty, "+ Add user")!.click();
    await flush();
    expect(root().children.length).toBeGreaterThan(0);
  });
  it("when the limits fail, the column says not available and the list is drawn", async () => {
    limitsFail = true;
    await show();
    expect(rowOf("Ann").all("td")[6]!.textContent).toBe("not available");
    expect(rows()).toHaveLength(2);
  });
});

describe("a reload that fails", () => {
  const unlock = async () => {
    users[1]!.lockedUntil = new Date(Date.now() + 600_000).toISOString();
    await show();
    await open("Ann", "Unlock");
    gets.push({ status: 500, error: "down" });
    button(root(), "Unlock")!.click();
    await flush();
    await flush();
  };
  it("keeps the rows, shows a failed stale note and no error toast", async () => {
    await unlock();
    expect(sent).toContain("POST /api/users/u1/unlock");
    expect(rows()).toHaveLength(2);
    expect(stale()).toHaveLength(1);
    expect(stale()[0]!.attrs.class).toContain("failed");
    expect(stale()[0]!.textContent).toContain("Could not refresh. Showing data from");
    expect(toastText()).toBe("Ann is unlocked");
  });
  it("Retry with a good answer redraws and the note is gone", async () => {
    await unlock();
    button(stale()[0]!, "Retry")!.click();
    await flush();
    await flush();
    expect(stale()).toHaveLength(0);
    expect(rows()).toHaveLength(2);
  });
  it("the row buttons still work", async () => {
    await unlock();
    await open("Ann", "App repositories");
    expect(root().children.length).toBeGreaterThan(0);
  });
  it("after Block the notice is shown together with the stale note", async () => {
    await show();
    await open("Ann", "Block");
    gets.push({ status: 500, error: "down" });
    button(root(), "Block")!.click();
    await flush();
    await flush();
    expect(main().textContent).toContain(ui.cancelledText("Ann", 1));
    expect(stale()).toHaveLength(1);
    expect(rows()).toHaveLength(2);
  });
  it("only the newest reload draws, even when an older one answers last", async () => {
    await show();
    const older = gate();
    const newer = gate();
    gets.push({ gate: older.promise, users: [user({ id: "me", name: "Root", role: "admin" })] }, { gate: newer.promise, users: [user({ id: "me", name: "Root", role: "admin" }), user(), user({ id: "u2", name: "Bob" })] });
    // two "+ Add user" dialogs closed in a row start two reloads
    for (let i = 0; i < 2; i++) {
      button(main(), "+ Add user")!.click();
      await flush();
      (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
      await flush();
    }
    newer.release();
    await flush();
    await flush();
    expect(rows()).toHaveLength(3);
    older.release();
    await flush();
    await flush();
    expect(rows()).toHaveLength(3);
  });
});
