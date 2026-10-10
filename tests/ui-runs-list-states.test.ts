import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The admin Runs list: loading, success, empty, partial, stale, offline and permission states, and the refresh that
// draws only what changed. Fake DOM, fake timers, a stubbed `fetch` with a table of answers and a table of failures.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const doc = () => (globalThis as any).document;
const realFetch = globalThis.fetch;
let answers: Record<string, unknown>;
let fails: Record<string, number | "offline">;
let asked: string[];
let gate: Promise<void> | null;

const RUN = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, flow: `flow-${id}`, status: "waiting", startedAt: new Date().toISOString(), history: [], totalCostUsd: 0, task: "do it", vars: {}, next: nextStep("approval", { repo: "o/r", runId: id }, {}), ...over });
const QUEUE = { pending: [], active: [], concurrency: 2 };
const OWNERS = [{ id: "u1", name: "Ann", runs: 1 }, { id: "u2", name: "Bob", runs: 1 }];
const good = (list: any[] = [RUN("r1")]) => {
  answers["/api/runs"] = list;
  answers["/api/queue"] = QUEUE;
  answers["/api/run-owners"] = OWNERS;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  answers = {};
  fails = {};
  asked = [];
  gate = null;
  doc().activeElement = null;
  doc().getElementById("modal-root").replaceChildren();
  doc().getElementById("main").replaceChildren();
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).fetch = async (url: string) => {
    asked.push(url);
    const path = url.split("?")[0]!;
    const body = answers[url] ?? answers[path] ?? {};
    const f = fails[path];
    if (f === "offline") throw new TypeError("Failed to fetch");
    if (f) return { ok: false, status: f, statusText: "Failed", json: async () => ({ error: `broken ${f}` }) };
    if (gate && path === "/api/runs") await gate;
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const flush = () => vi.advanceTimersByTimeAsync(0);
const connected = () => { const m = new FakeElement("main"); (m as any).isConnected = true; return m; };
const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of el.children) if (c instanceof FakeElement) { out.push(c); walk(c, out); }
  return out;
};
const find = (root: FakeElement, name: string) => walk(root).find((el) => el.attrs["data-focus"] === name);
const named = (root: FakeElement, name: string) => {
  const el = find(root, name);
  if (!el) throw new Error(`no control named ${name}`);
  return el;
};
const withClass = (root: FakeElement, cls: string) => walk(root).filter((el) => (el.attrs.class ?? "").split(" ").includes(cls));
const count = (text: string, part: string) => text.split(part).length - 1;
const gateOn = () => {
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  return () => { gate = null; release(); };
};
const open = async (opts: Record<string, unknown> = {}) => {
  const main = connected();
  const stop = (await runs.renderRunsList(main, opts)) as () => void;
  return { main, stop };
};

describe("Runs list states", () => {
  it("shows a table skeleton under the heading while the runs load", async () => {
    good();
    const release = gateOn();
    const main = connected();
    const p = runs.renderRunsList(main);
    await flush();
    expect(main.all("h1")[0]!.textContent).toBe("Runs");
    const sk = withClass(main, "skeleton-table");
    expect(sk).toHaveLength(1);
    expect(sk[0]!.attrs["aria-busy"]).toBe("true");
    release();
    const stop = await p;
    await flush();
    expect(main.all("table").length).toBeGreaterThan(0);
    expect(withClass(main, "skeleton")).toHaveLength(0);
    stop();
  });

  it("draws the rows, the counts, the owner filter and the time of the last answer", async () => {
    good([RUN("r1"), RUN("r2")]);
    const { main, stop } = await open();
    expect(main.all("tr").length).toBeGreaterThan(2);
    expect(main.textContent).toContain("0/2 running · 0 queued");
    expect(main.all("select")).toHaveLength(1);
    expect(main.textContent).toContain("Updated ");
    expect(main.textContent).not.toContain("refreshes every");
    stop();
  });

  it("does not redraw when the refreshed answer is the same", async () => {
    good();
    const { main, stop } = await open();
    const row = main.all("tr").find((tr) => (tr.attrs.class ?? "") === "link")!;
    const select = named(main, "owner-filter");
    asked.length = 0;
    await tick(30_000);
    expect(asked).toContain("/api/runs");
    expect(main.all("tr").find((tr) => (tr.attrs.class ?? "") === "link")).toBe(row);
    expect(named(main, "owner-filter")).toBe(select);
    stop();
  });

  it("draws a changed answer", async () => {
    good();
    const { main, stop } = await open();
    good([RUN("r1", { task: "Brand new task" })]);
    await tick(30_000);
    expect(main.textContent).toContain("Brand new task");
    stop();
  });

  it("holds a changed answer while the owner filter has the focus and draws it after", async () => {
    good();
    const { main, stop } = await open();
    const select = named(main, "owner-filter");
    select.focus();
    good([RUN("r1", { task: "Brand new task" })]);
    asked.length = 0;
    await tick(30_000);
    expect(asked).toContain("/api/runs");
    expect(named(main, "owner-filter")).toBe(select);
    expect(main.textContent).not.toContain("Brand new task");
    named(main, "run-r1").focus();
    await tick(300);
    expect(main.textContent).toContain("Brand new task");
    stop();
  });

  it("draws an owner change at once, with the select focused", async () => {
    good();
    answers["/api/runs?owner=u2"] = [RUN("r2", { task: "Bob's task", ownerName: "Bob" })];
    const { main, stop } = await open();
    named(main, "owner-filter").focus();
    main.all("select")[0]!.fire("change", { target: { value: "u2" } });
    await flush();
    expect(main.textContent).toContain("Bob's task");
    expect(main.textContent).toContain("Owner: Bob");
    stop();
  });

  it("drops a slow answer that a newer request for the same owner has overtaken", async () => {
    good();
    answers["/api/runs?owner=u2"] = [RUN("r2", { task: "Bob's task" })];
    const { main, stop } = await open();
    const release = gateOn();
    main.all("select")[0]!.fire("change", { target: { value: "u2" } }); // slow
    await flush();
    const quick = gate;
    gate = null; // the next request is not slow
    good([RUN("r1", { task: "Fresh task" })]);
    main.all("select")[0]!.fire("change", { target: { value: "" } });
    await flush();
    expect(main.textContent).toContain("Fresh task");
    gate = quick;
    release();
    await flush();
    expect(main.textContent).toContain("Fresh task");
    expect(main.textContent).not.toContain("Bob's task");
    stop();
  });

  it("rolls the owner filter back when a tick that overtook the owner request fails", async () => {
    good();
    answers["/api/runs?owner=u2"] = [RUN("r2", { task: "Bob's task" })];
    const go = vi.fn();
    const { main, stop } = await open({ go });
    const release = gateOn();
    main.all("select")[0]!.fire("change", { target: { value: "u2" } }); // slow
    await flush();
    fails["/api/runs"] = 500;
    await tick(30_000); // the tick overtakes it and fails
    expect(go).toHaveBeenLastCalledWith("#/runs");
    delete fails["/api/runs"];
    release();
    await flush();
    expect(main.textContent).not.toContain("Bob's task");
    expect(main.textContent).not.toContain("Owner: Bob");
    stop();
  });

  it("draws the error again after a permission state in between", async () => {
    good();
    fails["/api/runs"] = 500;
    const { main, stop } = await open();
    expect(withClass(main, "state-error")[0]!.attrs["data-kind"]).toBe("server");
    fails["/api/runs"] = 403;
    await tick(30_000);
    expect(withClass(main, "state-permission")).toHaveLength(1);
    fails["/api/runs"] = 500;
    await tick(30_000);
    expect(withClass(main, "state-permission")).toHaveLength(0);
    expect(withClass(main, "state-error")[0]!.attrs["data-kind"]).toBe("server");
    stop();
  });

  it("keeps the rows after a failed refresh, shows one note with Retry, and removes it after a good answer", async () => {
    good();
    const { main, stop } = await open();
    fails["/api/runs"] = 500;
    await tick(30_000);
    expect(main.all("tr").length).toBeGreaterThan(1);
    expect(count(main.textContent, "Could not refresh. Showing data from")).toBe(1);
    await tick(30_000);
    expect(count(main.textContent, "Could not refresh. Showing data from")).toBe(1);
    delete fails["/api/runs"];
    named(main, "runs-refresh-retry").click();
    await flush();
    expect(main.textContent).not.toContain("Could not refresh");
    stop();
  });

  it("shows an offline error with Retry when the first load cannot reach the server", async () => {
    good();
    fails["/api/runs"] = "offline";
    const main = connected();
    const stop = await runs.renderRunsList(main);
    expect(typeof stop).toBe("function");
    expect(withClass(main, "state-error")[0]!.attrs["data-kind"]).toBe("offline");
    delete fails["/api/runs"];
    named(main, "runs-retry").click();
    await flush();
    expect(main.all("table").length).toBeGreaterThan(0);
    stop();
  });

  it("shows a server error on the first load", async () => {
    good();
    fails["/api/runs"] = 500;
    const { main, stop } = await open();
    expect(withClass(main, "state-error")[0]!.attrs["data-kind"]).toBe("server");
    expect(main.textContent).toContain("Could not load the runs.");
    stop();
  });

  it("shows a permission state on a 403, without Retry, and recovers when the answer turns good", async () => {
    good();
    fails["/api/runs"] = 403;
    const { main, stop } = await open();
    expect(withClass(main, "state-permission")).toHaveLength(1);
    expect(main.textContent).toContain("You are not allowed to see the runs.");
    expect(find(main, "runs-retry")).toBeUndefined();
    delete fails["/api/runs"];
    await tick(30_000);
    expect(main.all("table").length).toBeGreaterThan(0);
    stop();
  });

  it.each([true, false])("says there are no runs and offers Start work (admin: %s)", async (admin) => {
    good([]);
    const { main, stop } = await open({ admin });
    expect(main.textContent).toContain("No runs yet.");
    expect(main.textContent).not.toContain("Open a flow");
    const link = main.all("a").find((a) => a.attrs.href === "#/start");
    expect(link?.textContent).toBe("Start work");
    stop();
  });

  it("draws the runs without the queue when the queue fails, and Retry brings it back", async () => {
    good([RUN("r1")]);
    answers["/api/queue"] = { pending: [{ runId: "q1", kind: "run", task: "queued", next: nextStep("queued", { runId: "q1" }, {}) }], active: [], concurrency: 2 };
    fails["/api/queue"] = 500;
    const { main, stop } = await open();
    expect(main.all("tr").length).toBeGreaterThan(1);
    expect(main.all("h3").some((x) => x.textContent === "Queue")).toBe(false);
    expect(main.textContent).not.toContain("running ·");
    expect(main.textContent).toContain("Could not load the queue.");
    delete fails["/api/queue"];
    named(main, "queue-retry").click();
    await flush();
    expect(main.all("h3").some((x) => x.textContent === "Queue")).toBe(true);
    expect(main.textContent).toContain("0/2 running · 1 queued");
    expect(main.textContent).not.toContain("Could not load the queue.");
    stop();
  });

  it("draws the runs without the owner filter when the owners fail", async () => {
    good();
    fails["/api/run-owners"] = 500;
    const { main, stop } = await open({ query: { owner: "u2" } });
    expect(main.all("tr").length).toBeGreaterThan(1);
    expect(main.all("select")).toHaveLength(0);
    expect(main.textContent).toContain("Could not load the owners.");
    expect(find(main, "owners-retry")).toBeDefined();
    expect(main.textContent).toContain("Owner: u2");
    stop();
  });

  it("never asks for the owners for a user", async () => {
    good();
    fails["/api/queue"] = 500;
    const { main, stop } = await open({ admin: false });
    expect(main.all("tr").length).toBeGreaterThan(1);
    expect(main.textContent).toContain("Could not load the queue.");
    expect(asked).not.toContain("/api/run-owners");
    stop();
  });

  it("stops asking after the cleanup, and the list has no interval", async () => {
    good();
    const { stop } = await open();
    stop();
    asked.length = 0;
    await tick(90_000);
    expect(asked).toEqual([]);
    const src = readFileSync("ui/runs.js", "utf8");
    const body = src.slice(src.indexOf("export async function renderRunsList"), src.indexOf("export function statusAnnouncer"));
    expect(body).not.toContain("setInterval");
  });
});
