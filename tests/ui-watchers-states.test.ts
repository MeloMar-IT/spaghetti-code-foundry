import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The states of the Watchers page: loading, a failed load, a busy "Check now", and a reload that fails.
let restore: () => void;
let admin: any;
beforeAll(async () => {
  restore = installFakeDom();
  admin = await import("../ui/watchers.js" as string);
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const watcher = (over: object = {}) => ({
  id: "w", repoId: "r1", source: "issues", enabled: true, github_repo: "o/a", flow: "issue-gitflow", label: "go", every: "5m", max_per_tick: 1,
  state: { name: "running" }, status: { id: "w", lastActions: [] }, ...over,
});
let watchers: any[];
let getsFail: Set<string>;
let getGate: Promise<void> | undefined;
let tickGate: Promise<void> | undefined;
let tickError: string | undefined;
let sent: string[];
let watcherGets: number;

beforeEach(() => {
  watchers = [watcher()];
  getsFail = new Set();
  getGate = undefined;
  tickGate = undefined;
  tickError = undefined;
  sent = [];
  watcherGets = 0;
  document.getElementById("modal-root")!.replaceChildren();
  document.getElementById("toast")!.textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string }) => {
    if (init.method === "GET") {
      if (url === "/api/watchers") watcherGets++;
      if (getGate) await getGate;
      if (getsFail.has(url)) return reply({ error: "down" }, 500);
      if (url === "/api/watchers") return reply(watchers);
      if (url === "/api/admin/repos") return reply([{ id: "r1", url: "https://github.com/o/a", method: "github-token", settings: {}, account: { name: "Ann", email: "a@x", role: "user", status: "active" } }]);
      return reply([]);
    }
    sent.push(`${init.method} ${url}`);
    if (tickGate) await tickGate;
    return tickError ? reply({ error: tickError }, 500) : reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 5));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const toastText = () => document.getElementById("toast")!.textContent as string;
const button = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text)!;
const stale = (main: FakeElement) => main.all("p").filter((p) => (p.attrs.class ?? "").includes("stale-note"));
const row = (main: FakeElement) => main.all("tr").find((r) => r.textContent.startsWith("w"))!;
const drawDetail = async (main: FakeElement, id = "w") => admin.renderWatcherDetail(main, id);
const busy = (main: FakeElement) => main.all("div").some((d) => d.attrs["aria-busy"] === "true");

describe("Watchers states", () => {
  it("draws a skeleton while the three GETs are held", async () => {
    const g = gate();
    getGate = g.promise;
    const main = new FakeElement("div");
    const done = admin.renderWatchers(main);
    await flush();
    expect(busy(main)).toBe(true);
    expect(main.textContent).toContain("Loading watchers…");
    g.release();
    await done;
    expect(busy(main)).toBe(false);
    expect(row(main)).toBeDefined();
  });

  it("the detail draws a skeleton while the GETs are held", async () => {
    const g = gate();
    getGate = g.promise;
    const main = new FakeElement("div");
    const done = drawDetail(main);
    await flush();
    expect(busy(main)).toBe(true);
    expect(main.textContent).toContain("Loading the watcher…");
    g.release();
    await done;
    expect(busy(main)).toBe(false);
    expect(button(main, "Check now")).toBeDefined();
  });

  it("rejects when /api/watchers fails, so the router draws the error", async () => {
    getsFail.add("/api/watchers");
    await expect(admin.renderWatchers(new FakeElement("div"))).rejects.toThrow("down");
  });

  it("Check now shows Checking… on the page with the button disabled, and no toast; then reloads", async () => {
    const main = new FakeElement("div");
    await drawDetail(main);
    const g = gate();
    tickGate = g.promise;
    const before = watcherGets;
    button(main, "Check now").click();
    await flush();
    expect(main.textContent).toContain("Checking…");
    expect(button(main, "Check now").disabled).toBe(true);
    expect(toastText()).toBe("");
    g.release();
    await flush();
    expect(sent).toEqual(["POST /api/watchers/w/tick"]);
    expect(watcherGets).toBe(before + 1);
    expect(main.textContent).not.toContain("Checking…");
    expect(button(main, "Check now").disabled).toBe(false);
  });

  it("a failed Check now shows an error toast and the button works again", async () => {
    const main = new FakeElement("div");
    await drawDetail(main);
    tickError = "the check failed";
    button(main, "Check now").click();
    await flush();
    expect(toastText()).toBe("the check failed");
    expect(button(main, "Check now").disabled).toBe(false);
    expect(main.textContent).not.toContain("Checking…");
  });

  it("a reload that fails keeps the page and shows a failed stale note; Retry redraws", async () => {
    const main = new FakeElement("div");
    await drawDetail(main);
    getsFail.add("/api/watchers");
    button(main, "Check now").click();
    await flush();
    expect(button(main, "Check now")).toBeDefined();
    expect(stale(main)).toHaveLength(1);
    expect(stale(main)[0]!.attrs.class).toContain("failed");
    getsFail.clear();
    button(stale(main)[0]!, "Retry").click();
    await flush();
    expect(stale(main)).toHaveLength(0);
    expect(button(main, "Check now")).toBeDefined();
  });

  it("a list reload that fails keeps the rows and shows a failed stale note", async () => {
    const main = new FakeElement("div");
    await admin.renderWatchers(main);
    getsFail.add("/api/watchers");
    button(main, "↻").click();
    await flush();
    expect(row(main)).toBeDefined();
    expect(stale(main)[0]!.attrs.class).toContain("failed");
  });

  it("only the newest reload draws, even when an older one answers last", async () => {
    const main = new FakeElement("div");
    await admin.renderWatchers(main);
    const older = gate();
    const newer = gate();
    const inner = (globalThis as any).fetch;
    let n = 0;
    (globalThis as any).fetch = async (url: string, init: { method: string }) => {
      if (url === "/api/watchers" && init.method === "GET") {
        const mine = ++n;
        await (mine === 1 ? older.promise : newer.promise);
        return { ok: true, status: 200, statusText: "x", json: async () => (mine === 1 ? [watcher({ id: "old-one" })] : [watcher({ id: "new-one" })]) };
      }
      return inner(url, init);
    };
    button(main, "↻").click();
    await flush();
    button(main, "↻").click();
    await flush();
    newer.release();
    await flush();
    older.release();
    await flush();
    expect(main.textContent).toContain("new-one");
    expect(main.textContent).not.toContain("old-one");
  });

  it("an empty page says No watchers yet and keeps the add button", async () => {
    watchers = [];
    const main = new FakeElement("div");
    await admin.renderWatchers(main);
    const empty = main.all("div").find((d) => d.attrs.class === "empty")!;
    expect(empty.textContent).toContain("No watchers yet.");
    expect(button(empty, "+ Add watcher")).toBeDefined();
  });
});
