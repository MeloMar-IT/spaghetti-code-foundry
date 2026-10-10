import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// My runs: loading, success, empty, filtered empty, partial, stale, offline and permission states, the refresh that draws
// only what changed, and Remove next to the poller. Fake DOM, fake timers and a fake `a`.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/user/runs.js" as string);
});
afterAll(() => restore());

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const flush = () => vi.advanceTimersByTimeAsync(0);
const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of el.children) if (c instanceof FakeElement) { out.push(c); walk(c, out); }
  return out;
};
const named = (root: FakeElement, name: string) => {
  const el = walk(root).find((e) => e.attrs["data-focus"] === name);
  if (!el) throw new Error(`no control named ${name}`);
  return el;
};
const has = (root: FakeElement, name: string) => walk(root).some((e) => e.attrs["data-focus"] === name);
const withClass = (root: FakeElement, cls: string) => walk(root).filter((el) => (el.attrs.class ?? "").split(" ").includes(cls));
const removeButtons = (root: FakeElement) => root.all("button").filter((b) => b.textContent === "Remove");
const count = (text: string, part: string) => text.split(part).length - 1;
const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const run = (id: string, over: any = {}) => ({ runId: id, flow: `flow-${id}`, task: `task ${id}`, status: "running", startedAt: iso(10), vars: {}, history: [], next: nextStep("running", { runId: id }, {}), ...over });
const job = (id: string, over: any = {}) => ({ runId: id, kind: "run", enqueuedAt: iso(5), task: `queued ${id}`, ahead: 0, next: nextStep("queued", { runId: id }, {}), ...over });

describe("My runs states", () => {
  let data: { runs: any[]; pending: any[] };
  let a: any;
  let ask: ReturnType<typeof vi.fn>;
  const open = async (opts: Record<string, unknown> = {}) => {
    const main = document.createElement("div") as unknown as FakeElement;
    const stop = (await ui.renderMyRuns(main, { a, ask, ...opts })) as () => void;
    return { main, stop, list: main.children[2] as FakeElement };
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    data = { runs: [run("r1")], pending: [] };
    ask = vi.fn(async () => true);
    a = { runs: vi.fn(async () => data.runs), queue: vi.fn(async () => ({ pending: data.pending, active: [] })), cancelRun: vi.fn(async () => ({ cancelled: true })) };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows a card skeleton under the heading while the runs load", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    a.runs = vi.fn(async () => { await gate; return data.runs; });
    const main = document.createElement("div") as unknown as FakeElement;
    const p = ui.renderMyRuns(main, { a, ask });
    await flush();
    expect(main.all("h1")[0]!.textContent).toBe("My runs");
    expect(withClass(main.children[2] as FakeElement, "skeleton-cards")).toHaveLength(1);
    release();
    (await p)();
  });

  it("draws the cards and the time of the last answer", async () => {
    const { main, list, stop } = await open();
    expect(list.all("li")).toHaveLength(1);
    expect(main.textContent).toContain("Updated ");
    stop();
  });

  it("does not redraw when the refreshed answer is the same", async () => {
    const { list, stop } = await open();
    const card = list.all("li")[0];
    await tick(30_000);
    expect(a.runs).toHaveBeenCalledTimes(2);
    expect(list.all("li")[0]).toBe(card);
    stop();
  });

  it("keeps the cards after a failed refresh, shows one note with Retry, and removes it after a good answer", async () => {
    const { main, list, stop } = await open();
    a.runs.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    await tick(30_000);
    await tick(30_000);
    expect(list.all("li")).toHaveLength(1);
    expect(count(main.textContent, "Could not refresh. Showing data from")).toBe(1);
    a.runs.mockImplementation(async () => data.runs);
    named(main, "my-runs-refresh-retry").click();
    await flush();
    expect(main.textContent).not.toContain("Could not refresh");
    stop();
  });

  it("keeps the stale note when a refresh fails while the Remove dialog is open and the dialog closes", async () => {
    data.pending = [job("q1")];
    let answer!: (v: boolean) => void;
    ask = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
    const { main, list, stop } = await open();
    removeButtons(list)[0]!.fire("click");
    a.runs.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    await tick(30_000);
    answer(false);
    await tick(300);
    expect(count(main.textContent, "Could not refresh. Showing data from")).toBe(1);
    stop();
  });

  it("shows an offline error with Retry when the first load cannot reach the server", async () => {
    a.runs.mockRejectedValue(new TypeError("Failed to fetch"));
    const { main, list, stop } = await open();
    expect(typeof stop).toBe("function");
    expect(withClass(list, "state-error")[0]!.attrs["data-kind"]).toBe("offline");
    a.runs.mockImplementation(async () => data.runs);
    named(main, "my-runs-retry").click();
    await flush();
    expect(list.all("li")).toHaveLength(1);
    stop();
  });

  it("shows a permission state on a 403", async () => {
    a.runs.mockRejectedValue({ status: 403, message: "no" });
    const { list, stop } = await open();
    expect(withClass(list, "state-permission")).toHaveLength(1);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("says there are no runs and offers Start work", async () => {
    data.runs = [];
    const { list, stop } = await open();
    expect(ui.NO_RUNS).toBe("No runs yet.");
    expect(list.textContent).toContain("No runs yet.");
    expect(named(list, "start").attrs.href).toBe("#/start");
    stop();
  });

  it("keeps the filtered empty state", async () => {
    const { list, stop } = await open({ query: { repo: "no/pe" } });
    expect(list.textContent).toContain("No runs match Repository: no/pe.");
    stop();
  });

  it("draws the runs with a note when the queue fails, and Retry brings the queued run", async () => {
    data.pending = [job("q1")];
    a.queue.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const { list, stop } = await open();
    expect(list.all("li")).toHaveLength(1);
    expect(list.textContent).toContain("Could not load the queue.");
    expect(removeButtons(list)).toHaveLength(0);
    a.queue.mockImplementation(async () => ({ pending: data.pending, active: [] }));
    named(list, "queue-retry").click();
    await flush();
    expect(list.all("li")).toHaveLength(2);
    expect(removeButtons(list)).toHaveLength(1);
    expect(list.textContent).not.toContain("Could not load the queue.");
    stop();
  });

  it("shows no Remove button in the read-only preview in any state, and still offers Retry", async () => {
    data.pending = [job("q1")];
    const ok = await open({ readOnly: true });
    expect(ok.list.all("li")).toHaveLength(2);
    expect(removeButtons(ok.main)).toHaveLength(0);
    a.runs.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    await tick(30_000);
    expect(removeButtons(ok.main)).toHaveLength(0);
    expect(has(ok.main, "my-runs-refresh-retry")).toBe(true);
    ok.stop();

    a.runs.mockImplementation(async () => data.runs);
    a.queue.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const partial = await open({ readOnly: true });
    expect(removeButtons(partial.main)).toHaveLength(0);
    expect(has(partial.main, "queue-retry")).toBe(true);
    partial.stop();

    a.runs.mockRejectedValue(new TypeError("Failed to fetch"));
    const failed = await open({ readOnly: true });
    expect(removeButtons(failed.main)).toHaveLength(0);
    expect(has(failed.main, "my-runs-retry")).toBe(true);
    failed.stop();
  });

  it("asks once more after Remove, and shows the stale note when that fails", async () => {
    data.pending = [job("q1")];
    const { main, list, stop } = await open();
    expect(a.runs).toHaveBeenCalledTimes(1);
    a.runs.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    removeButtons(list)[0]!.fire("click");
    await flush();
    expect(a.cancelRun).toHaveBeenCalledTimes(1);
    expect(a.runs).toHaveBeenCalledTimes(2);
    expect(list.all("li")).toHaveLength(2);
    expect(count(main.textContent, "Could not refresh. Showing data from")).toBe(1);
    stop();
  });

  it("drops an answer asked before the cancel", async () => {
    data.pending = [job("q1")];
    const { list, stop } = await open();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const before = { runs: data.runs, pending: data.pending };
    a.runs.mockImplementationOnce(async () => { await gate; return before.runs; });
    a.queue.mockImplementationOnce(async () => ({ pending: before.pending, active: [] }));
    await tick(30_000); // a slow poll starts with the job still queued
    data.pending = [];
    removeButtons(list)[0]!.fire("click");
    await flush();
    release();
    await flush();
    expect(list.all("li")).toHaveLength(1);
    expect(removeButtons(list)).toHaveLength(0);
    stop();
  });

  it("stops asking after the cleanup, and the page has no interval", async () => {
    const { stop } = await open();
    stop();
    a.runs.mockClear();
    await tick(90_000);
    expect(a.runs).not.toHaveBeenCalled();
    const src = readFileSync("ui/user/runs.js", "utf8");
    expect(src.slice(src.indexOf("export async function renderMyRuns"), src.indexOf("// ── The run page ──"))).not.toContain("setInterval");
  });
});
