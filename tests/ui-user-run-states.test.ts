import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The run page of a user: loading, not found, no permission, offline, stream loss with Reconnect, the read-only preview,
// and Retry for the changes. Fake DOM, fake timers; the API and the stream are injected.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let states: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/user/runs.js" as string);
  states = await import("../ui/run-states.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const toastText = () => (document as any).getElementById("toast").textContent as string;
const refused = (msg: string, status: number) => Object.assign(new Error(msg), { status });
const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const rec = (kind: any, runId = "r1", d: any = {}) => nextStep(kind, { runId }, d);

describe("renderMyRun states", () => {
  let main: FakeElement;
  let a: any;
  let streams: any[];
  let state: { summary: any; runError: any; pending: any[]; queueError?: any; hang?: boolean };
  let release: ((v: any) => void) | null;
  const stream = () => streams[streams.length - 1];
  const emit = (s: any, type: string, data: unknown) => { for (const fn of s.listeners[type] ?? []) fn({ data: JSON.stringify(data) }); };
  const open = async (opts: any = {}) => {
    main = document.createElement("div") as unknown as FakeElement;
    const cleanup = ui.renderMyRun(main, "r1", { a, go: vi.fn(), ...opts }) as () => void;
    await flush();
    return cleanup;
  };
  const summaryOf = (over: any = {}) => ({
    runId: "r1", flow: "build", task: "Do the thing", status: "running", startedAt: iso(3), vars: {}, history: [], state: { next: "s" },
    next: rec("running"), ...over,
  });
  const banners = () => main.all("div").filter((d) => d.attrs["data-kind"] === "error" && d.textContent.includes(states.STREAM_LOST));
  const lose = (s = stream()) => { s.readyState = 2; s.onerror(); };
  const names = () => main.all("button").map((b) => b.textContent);

  beforeEach(() => {
    vi.useFakeTimers();
    (document as any).getElementById("toast").textContent = "";
    (document as any).activeElement = null;
    state = { summary: summaryOf(), runError: null, pending: [] };
    release = null;
    streams = [];
    a = {
      run: vi.fn(() => {
        if (state.hang) return new Promise((resolve) => { release = resolve; });
        if (state.runError) return Promise.reject(state.runError);
        return Promise.resolve(state.summary);
      }),
      queue: vi.fn(async () => { if (state.queueError) throw state.queueError; return { pending: state.pending, active: [] }; }),
      events: vi.fn(() => {
        const s: any = { listeners: {}, readyState: 1, close: vi.fn(), addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); } };
        streams.push(s);
        return s;
      }),
      diff: vi.fn(async () => ({ patch: "+a", stat: "1 file" })),
    };
  });

  it("shows the skeleton while the run is loading", async () => {
    state.hang = true;
    const stop = await open();
    expect(one(main, "div", { "aria-busy": "true" }).attrs.class).toContain("skeleton-detail");
    release!(summaryOf());
    await flush();
    expect(find(main, "div", { "aria-busy": "true" })).toHaveLength(0);
    stop();
  });

  it("says not found with a link back for a 404", async () => {
    state.summary = null;
    state.runError = refused("gone", 404);
    const stop = await open();
    expect(main.textContent).toContain(ui.NOT_FOUND);
    expect(one(main, "a", { href: "#/runs" }).textContent).toBe("My runs");
    stop();
  });

  it("shows the permission state for a 403, also when the queue call fails or still lists the run", async () => {
    state.summary = null;
    state.runError = refused("no", 403);
    state.queueError = new Error("queue down");
    let stop = await open();
    expect(find(main, "div", { "data-kind": "permission" })).toHaveLength(1);
    expect(find(main, "button", { "data-focus": "run-retry" })).toHaveLength(0);
    stop();

    state.queueError = null;
    state.pending = [{ runId: "r1", kind: "run", enqueuedAt: iso(1), task: "queued", ahead: 0, next: rec("queued") }];
    stop = await open();
    expect(find(main, "div", { "data-kind": "permission" })).toHaveLength(1);
    expect(main.textContent).not.toContain("Queued run");
    expect(find(main, "form")[0]!.hidden).toBe(true);
    stop();
  });

  it("shows an error with Retry for a 500 and for a network failure; Retry asks again and draws the run", async () => {
    for (const err of [refused("boom", 500), new TypeError("Failed to fetch")]) {
      state.summary = null;
      state.runError = err;
      const stop = await open();
      expect(main.textContent).toContain("Could not load the run.");
      if (err instanceof TypeError) expect(one(main, "div", { role: "alert" }).attrs["data-kind"]).toBe("offline");
      state.summary = summaryOf();
      state.runError = null;
      a.run.mockClear();
      one(main, "button", { "data-focus": "run-retry" }).click();
      await flush();
      expect(a.run).toHaveBeenCalledTimes(1);
      expect(main.textContent).toContain("Do the thing");
      stop();
    }
  });

  it("draws the queued head for a 404 when the queue has the run", async () => {
    state.summary = null;
    state.runError = refused("gone", 404);
    state.pending = [{ runId: "r1", kind: "run", enqueuedAt: iso(1), task: "queued", ahead: 0, next: rec("queued") }];
    const stop = await open();
    expect(main.textContent).toContain("Queued run");
    expect(main.textContent).not.toContain(ui.NOT_FOUND);
    stop();
  });

  it("keeps the skeleton for a 404 while the queue lists the run as active", async () => {
    state.summary = null;
    state.runError = refused("gone", 404);
    a.queue.mockImplementation(async () => ({ pending: [], active: [{ runId: "r1" }] }));
    const stop = await open();
    expect(main.textContent).not.toContain(ui.NOT_FOUND);
    expect(one(main, "div", { "aria-busy": "true" })).toBeTruthy();
    emit(stream(), "update", { summary: summaryOf() });
    expect(main.textContent).toContain("Do the thing");
    stop();
  });

  it("does not draw an unchanged state again on the next refresh", async () => {
    state.summary = null;
    state.runError = refused("boom", 500);
    const stop = await open();
    const retry = one(main, "button", { "data-focus": "run-retry" });
    retry.click();
    await flush();
    expect(one(main, "button", { "data-focus": "run-retry" })).toBe(retry);
    stop();
  });

  it("shows one banner when the stream is lost, keeps the page and the log, and asks the run again", async () => {
    const stop = await open();
    emit(stream(), "update", { summary: summaryOf() });
    emit(stream(), "log", { line: "▶ one" });
    a.run.mockClear();
    lose();
    lose();
    expect(banners()).toHaveLength(1);
    expect(main.textContent).toContain("Do the thing");
    expect(main.textContent).toContain("▶ one");
    expect(toastText()).toBe("");
    await flush();
    expect(a.run).toHaveBeenCalled();
    expect(banners()).toHaveLength(1);
    stop();
  });

  it("shows no banner while the browser retries by itself", async () => {
    const stop = await open();
    stream().readyState = 0;
    stream().onerror();
    expect(banners()).toHaveLength(0);
    stop();
  });

  it("Reconnect opens the stream again; the next update removes the banner and the replayed log is not doubled", async () => {
    const stop = await open();
    emit(stream(), "update", { summary: summaryOf() });
    emit(stream(), "log", { line: "▶ one" });
    const first = stream();
    lose();
    one(main, "button", { "data-focus": "stream-reconnect" }).click();
    expect(a.events).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
    expect(banners()).toHaveLength(1);
    emit(stream(), "log", { line: "▶ one" });
    emit(stream(), "update", { summary: summaryOf() });
    expect(banners()).toHaveLength(0);
    expect(main.textContent.split("▶ one").length - 1).toBe(1);
    stop();
  });

  it("Reconnect when the events call throws does not throw, keeps the banner and asks the run", async () => {
    const stop = await open();
    emit(stream(), "update", { summary: summaryOf() });
    lose();
    a.events.mockImplementationOnce(() => { throw refused("The view has ended.", 403); });
    a.run.mockClear();
    expect(() => one(main, "button", { "data-focus": "stream-reconnect" }).click()).not.toThrow();
    await flush();
    expect(banners()).toHaveLength(1);
    expect(a.run).toHaveBeenCalled();
    stop();
  });

  it("a closed stream with a 404 and no job shows not found; with a 403 the permission state", async () => {
    let stop = await open();
    emit(stream(), "update", { summary: summaryOf() });
    state.runError = refused("gone", 404);
    lose();
    await flush();
    expect(main.textContent).toContain(ui.NOT_FOUND);
    stop();

    state.runError = null;
    stop = await open();
    emit(stream(), "update", { summary: summaryOf() });
    state.runError = refused("no", 403);
    lose();
    await flush();
    expect(find(main, "div", { "data-kind": "permission" })).toHaveLength(1);
    stop();
  });

  it("the cleanup after a Reconnect closes the second stream and stops the timers", async () => {
    state.pending = [{ runId: "r1", kind: "run", enqueuedAt: iso(1), task: "queued", ahead: 0, next: rec("queued") }];
    const stop = await open();
    lose();
    one(main, "button", { "data-focus": "stream-reconnect" }).click();
    stop();
    expect(stream().close).toHaveBeenCalled();
    const n = a.queue.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.queue.mock.calls.length).toBe(n);
  });

  it("a diff failure shows Retry, and Retry draws the diff", async () => {
    const stop = await open();
    emit(stream(), "update", { summary: summaryOf() });
    a.diff.mockRejectedValueOnce(refused("git failed", 500));
    one(main, "button", { "data-tab": "diff" }).click();
    await flush();
    const retry = one(main, "button", { "data-focus": "diff-retry" });
    retry.click();
    await flush();
    expect(find(main, "pre", { class: "diff" }).length).toBeGreaterThan(0);
    stop();
  });

  describe("read-only preview", () => {
    const FORBIDDEN = /^(✔ )?(Approve|Reject|Cancel)|Retry from the failing step/;
    const noActions = () => {
      expect(names().filter((n) => FORBIDDEN.test(n))).toEqual([]);
      for (const f of main.all("form")) expect(f.hidden).toBe(true);
    };

    it("shows no action in loading, not found, no permission, error, stream loss and a waiting run", async () => {
      state.hang = true;
      let stop = await open({ readOnly: true });
      noActions();
      stop();
      state.hang = false;

      for (const err of [refused("gone", 404), refused("no", 403), refused("boom", 500)]) {
        state.summary = null;
        state.runError = err;
        stop = await open({ readOnly: true });
        noActions();
        stop();
      }

      state.runError = null;
      state.summary = summaryOf({ status: "waiting", next: rec("approval"), questions: "Q?", canAnswer: true });
      stop = await open({ readOnly: true });
      emit(stream(), "update", { summary: state.summary });
      lose();
      expect(banners()).toHaveLength(1);
      noActions();
      stop();
    });

    it("a closed stream still asks the run once more", async () => {
      const stop = await open({ readOnly: true });
      emit(stream(), "update", { summary: summaryOf() });
      a.run.mockClear();
      lose();
      await flush();
      expect(a.run).toHaveBeenCalledTimes(1);
      stop();
    });
  });
});
