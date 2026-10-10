import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The admin run page: loading, not found, no permission, offline, queued, stream loss with Reconnect, and Retry for the
// transcript and the diff. Fake DOM, fake timers, a table of answers and a fake EventSource.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let runs: any;
let states: any;
beforeAll(async () => {
  restore = installFakeDom();
  runs = await import("../ui/runs.js" as string);
  states = await import("../ui/run-states.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const connected = () => {
  const m = new FakeElement("div") as FakeElement & { isConnected: boolean };
  m.isConnected = true;
  return m;
};
const toastText = () => (globalThis as any).document.getElementById("toast").textContent as string;
const RUN = { runId: "r1", flow: "walk", status: "succeeded", startedAt: "2026-10-01T12:00:00Z", history: [], totalCostUsd: 0, task: "do the thing", vars: {} };
const refused = (msg: string, status: number) => Object.assign(new Error(msg), { status });

// ── the helpers ──

describe("run-states helpers", () => {
  it("runLoadState draws loading, not found, no permission and an error with Retry", () => {
    const back = { href: "#/runs", label: "Runs", focus: "back-runs" };
    const loading = states.runLoadState(null, { back }) as FakeElement;
    expect(loading.attrs["aria-busy"]).toBe("true");
    expect(loading.attrs.class).toContain("skeleton-detail");
    const missing = states.runLoadState(refused("x", 404), { back }) as FakeElement;
    expect(missing.textContent).toContain(states.NOT_FOUND);
    expect(one(missing, "a").attrs.href).toBe("#/runs");
    const denied = states.runLoadState(refused("x", 403), { back }) as FakeElement;
    expect(denied.attrs["data-kind"]).toBe("permission");
    expect(find(denied, "button")).toHaveLength(0);
    const onRetry = vi.fn();
    const failed = states.runLoadState(refused("boom", 500), { back, onRetry }) as FakeElement;
    expect(failed.textContent).toContain("Could not load the run.");
    one(failed, "button").click();
    expect(onRetry).toHaveBeenCalled();
  });

  it("isRun rejects what is not a run", () => {
    expect(states.isRun({})).toBe(false);
    expect(states.isRun([])).toBe(false);
    expect(states.isRun(null)).toBe(false);
    expect(states.isRun(RUN)).toBe(true);
  });

  it("loadInto shows Retry on a failure, draws on the retry, and mounts nothing when not current", async () => {
    const box = new FakeElement("div");
    let fail = true;
    const opts = { loading: "Loading…", load: async () => { if (fail) throw refused("nope", 500); return "ok"; }, draw: (v: string) => { const p = new FakeElement("p"); p.children.push(v); return p; }, what: "Could not load it.", focus: "x-retry" };
    await states.loadInto(box, opts);
    expect(box.textContent).toContain("Could not load it.");
    fail = false;
    one(box, "button", { "data-focus": "x-retry" }).click();
    await flush();
    expect(box.textContent).toBe("ok");

    const other = new FakeElement("div");
    await states.loadInto(other, { ...opts, current: () => false });
    expect(other.textContent).toBe("Loading…");
  });

  describe("runStream", () => {
    const fake = () => {
      const s: any = { listeners: {} as any, readyState: 1, close: vi.fn(), addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); } };
      return s;
    };
    const setup = () => {
      const made: any[] = [];
      const seen: string[] = [];
      const onLost = vi.fn();
      const onReopen = vi.fn(() => seen.push("reopen"));
      const stream = states.runStream({ open: () => { const s = fake(); made.push(s); return s; }, on: { log: (e: any) => seen.push(`log:${e.data}`) }, onLost, onReopen });
      stream.start();
      return { made, seen, onLost, onReopen, stream };
    };

    it("shows one banner after two closed errors, none while the browser retries", () => {
      const { made, stream, onLost } = setup();
      made[0].readyState = 0;
      made[0].onerror();
      expect(stream.el.children).toHaveLength(0);
      made[0].readyState = 2;
      made[0].onerror();
      made[0].onerror();
      expect(find(stream.el, "div", { "data-kind": "error" })).toHaveLength(1);
      expect(stream.el.textContent).toContain(states.STREAM_LOST);
      expect(stream.down()).toBe(true);
      expect(onLost).toHaveBeenCalledTimes(2);
    });

    it("Reconnect opens a new stream, ignores the old one, and calls onReopen once before the first event", () => {
      const { made, seen, stream } = setup();
      made[0].readyState = 2;
      made[0].onerror();
      one(stream.el, "button", { "data-focus": "stream-reconnect" }).click();
      expect(made).toHaveLength(2);
      expect(made[0].close).toHaveBeenCalled();
      expect(stream.el.textContent).toContain(states.STREAM_LOST);
      made[0].listeners.log[0]({ data: "late" });
      expect(seen).toEqual([]);
      made[1].listeners.log[0]({ data: "a" });
      made[1].listeners.log[0]({ data: "b" });
      expect(seen).toEqual(["reopen", "log:a", "log:b"]);
      expect(stream.el.children).toHaveLength(0);
      expect(stream.down()).toBe(false);
    });

    it("close closes the current stream", () => {
      const { made, stream } = setup();
      made[0].readyState = 2;
      made[0].onerror();
      one(stream.el, "button").click();
      stream.close();
      expect(made[1].close).toHaveBeenCalled();
    });

    it("a Reconnect that throws keeps the banner and asks onLost", () => {
      const onLost = vi.fn();
      let n = 0;
      const first = fake();
      const stream = states.runStream({ open: () => { if (n++) throw new Error("ended"); return first; }, onLost });
      stream.start();
      first.readyState = 2;
      first.onerror();
      onLost.mockClear();
      one(stream.el, "button").click();
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(stream.el.textContent).toContain(states.STREAM_LOST);
    });
  });
});

// ── the page ──

describe("renderRunDetail states", () => {
  const realFetch = globalThis.fetch;
  let table: Record<string, { status?: number; body?: unknown; hang?: boolean; net?: boolean }>;
  let asked: string[];
  let sources: any[];
  let pending: Record<string, (v: { status?: number; body?: unknown }) => void>;
  let main: FakeElement;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    table = { "/api/runs/r1": { body: RUN }, "/api/queue": { body: { pending: [], active: [] } } };
    asked = [];
    sources = [];
    pending = {};
    (globalThis as any).document.getElementById("toast").textContent = "";
    (globalThis as any).fetch = (url: string) => {
      asked.push(url);
      const respond = ({ status = 200, body = {} }: { status?: number; body?: unknown }) => ({ ok: status < 400, status, statusText: status === 404 ? "Not Found" : "x", json: async () => (status < 400 ? body : { error: (body as any)?.error ?? "failed" }) });
      const t = table[url] ?? { body: {} };
      if (t.net) return Promise.reject(new TypeError("Failed to fetch"));
      if (t.hang) return new Promise((resolve) => { pending[url] = (v) => resolve(respond(v)); });
      return Promise.resolve(respond(t));
    };
    (globalThis as any).EventSource = class {
      static CLOSED = 2;
      readyState = 1;
      handlers: Record<string, (e: { data: string }) => void> = {};
      close = vi.fn();
      onerror: (() => void) | null = null;
      constructor(public url: string) { sources.push(this); }
      addEventListener(type: string, fn: (e: { data: string }) => void) { this.handlers[type] = fn; }
    };
  });
  afterEach(() => {
    stop?.();
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    delete (globalThis as any).EventSource;
  });

  const open = async () => {
    main = connected();
    stop = runs.renderRunDetail(main, "r1");
    await flush();
  };
  const update = (i: number, summary: unknown = RUN) => sources[i].handlers.update({ data: JSON.stringify({ summary }) });
  const log = (i: number, line: string) => sources[i].handlers.log({ data: JSON.stringify({ line }) });
  const lose = (i = 0) => { sources[i].readyState = 2; sources[i].onerror(); };
  const banners = () => find(main, "div", { "data-kind": "error", role: "alert" }).filter((d) => d.textContent.includes(states.STREAM_LOST));
  const actionButtons = () => main.all("div").filter((d) => (d.attrs.class ?? "").includes("run-actions")).flatMap((d) => d.all("button"));
  const tabsBox = () => one(main, "button", { "data-tab": "log" }).parent!.parent!;

  it("shows the skeleton and hides the tabs until the run arrives", async () => {
    table["/api/runs/r1"] = { hang: true };
    await open();
    const sk = one(main, "div", { "aria-busy": "true" });
    expect(sk.attrs.class).toContain("skeleton-detail");
    expect(tabsBox().hidden).toBe(true);
    pending["/api/runs/r1"]!({ body: RUN });
    await flush();
    expect(find(main, "div", { "aria-busy": "true" })).toHaveLength(0);
    expect(tabsBox().hidden).toBe(false);
    expect(main.textContent).toContain("do the thing");
  });

  it("a stream update ends the skeleton while the GET is still pending", async () => {
    table["/api/runs/r1"] = { hang: true };
    await open();
    update(0);
    expect(find(main, "div", { "aria-busy": "true" })).toHaveLength(0);
    expect(tabsBox().hidden).toBe(false);
    pending["/api/runs/r1"]!({ status: 404, body: { error: "gone" } });
    await flush();
    expect(main.textContent).not.toContain(states.NOT_FOUND);
  });

  it("does not draw an answer that is not a run", async () => {
    table["/api/runs/r1"] = { body: {} };
    await open();
    expect(one(main, "div", { "aria-busy": "true" })).toBeTruthy();
  });

  it("says not found for a 404 that is not in the queue, with a link back and no buttons", async () => {
    table["/api/runs/r1"] = { status: 404, body: { error: "run not found" } };
    await open();
    expect(main.textContent).toContain(states.NOT_FOUND);
    expect(one(main, "a", { href: "#/runs" }).textContent).toBe("Runs");
    expect(actionButtons()).toHaveLength(0);
  });

  it("shows a queued head for a 404 when the queue has the run, and the full page after the first update", async () => {
    table["/api/runs/r1"] = { status: 404, body: { error: "run not found" } };
    table["/api/queue"] = { body: { pending: [{ runId: "r1", flow: "walk", task: "queued", ahead: 0 }], active: [] } };
    await open();
    expect(main.textContent).toContain("Queued run");
    expect(main.textContent).not.toContain(states.NOT_FOUND);
    expect(actionButtons()).toHaveLength(0);
    expect(tabsBox().hidden).toBe(true);
    update(0);
    expect(tabsBox().hidden).toBe(false);
    expect(main.textContent).toContain("do the thing");
  });

  it("does not say not found for a run that moved from the queue to the active list", async () => {
    table["/api/runs/r1"] = { status: 404, body: { error: "run not found" } };
    table["/api/queue"] = { body: { pending: [], active: [{ runId: "r1" }] } };
    await open();
    expect(main.textContent).not.toContain(states.NOT_FOUND);
    expect(one(main, "div", { "aria-busy": "true" })).toBeTruthy();
  });

  it("goes back to the skeleton when Retry finds the run active without a record", async () => {
    table["/api/runs/r1"] = { status: 500, body: { error: "boom" } };
    await open();
    expect(main.textContent).toContain("Could not load the run.");
    table["/api/runs/r1"] = { status: 404, body: { error: "run not found" } };
    table["/api/queue"] = { body: { pending: [], active: [{ runId: "r1" }] } };
    one(main, "button", { "data-focus": "run-retry" }).click();
    await flush();
    expect(main.textContent).not.toContain("Could not load the run.");
    expect(one(main, "div", { "aria-busy": "true" })).toBeTruthy();
  });

  it("shows an error with Retry, not not found, when the queue call fails after a 404", async () => {
    table["/api/runs/r1"] = { status: 404, body: { error: "run not found" } };
    table["/api/queue"] = { net: true };
    await open();
    expect(main.textContent).not.toContain(states.NOT_FOUND);
    expect(one(main, "div", { "data-kind": "offline" })).toBeTruthy();
    expect(one(main, "button", { "data-focus": "run-retry" })).toBeTruthy();
  });

  it("shows the permission state for a 403, with a link back and no Retry", async () => {
    table["/api/runs/r1"] = { status: 403, body: { error: "no" } };
    await open();
    const denied = one(main, "div", { "data-kind": "permission" });
    expect(one(denied, "a").attrs.href).toBe("#/runs");
    expect(find(main, "button", { "data-focus": "run-retry" })).toHaveLength(0);
  });

  it("shows an error with Retry for a 500 and for a network failure; Retry asks again and draws the run", async () => {
    for (const first of [{ status: 500, body: { error: "boom" } }, { net: true }]) {
      table["/api/runs/r1"] = first;
      asked.length = 0;
      await open();
      expect(main.textContent).toContain("Could not load the run.");
      table["/api/runs/r1"] = { body: RUN };
      asked.length = 0;
      one(main, "button", { "data-focus": "run-retry" }).click();
      await flush();
      expect(asked).toEqual(["/api/runs/r1"]);
      expect(main.textContent).toContain("do the thing");
      expect(tabsBox().hidden).toBe(false);
      stop();
    }
  });

  it("shows one banner when the stream is lost, keeps the page, and asks the server again", async () => {
    await open();
    update(0);
    log(0, "▶ step one");
    asked.length = 0;
    lose();
    lose();
    expect(banners()).toHaveLength(1);
    expect(main.textContent).toContain("do the thing");
    one(main, "button", { "data-tab": "log" }).click();
    expect(main.textContent).toContain("▶ step one");
    expect(toastText()).toBe("");
    await flush();
    expect(asked).toContain("/api/runs/r1");
    expect(banners()).toHaveLength(1);
  });

  it("Reconnect opens a second stream, the next event removes the banner and the replayed log is not doubled", async () => {
    await open();
    update(0);
    log(0, "▶ step one");
    lose();
    one(main, "button", { "data-focus": "stream-reconnect" }).click();
    expect(sources).toHaveLength(2);
    expect(sources[0].close).toHaveBeenCalled();
    expect(banners()).toHaveLength(1);
    log(1, "▶ step one");
    update(1);
    expect(banners()).toHaveLength(0);
    one(main, "button", { "data-tab": "log" }).click();
    expect(main.textContent.split("▶ step one").length - 1).toBe(1);
    log(0, "late");
    expect(main.textContent).not.toContain("late");
  });

  it("a loss check that returns after a replayed log line does not replace the recovered page", async () => {
    await open();
    update(0);
    table["/api/runs/r1"] = { hang: true };
    lose();
    one(main, "button", { "data-focus": "stream-reconnect" }).click();
    log(1, "replayed");
    pending["/api/runs/r1"]!({ status: 404, body: { error: "gone" } });
    await flush();
    expect(main.textContent).not.toContain(states.NOT_FOUND);
    expect(main.textContent).toContain("do the thing");
  });

  it("a closed stream with a 404 (not queued) shows not found; with a 403 the permission state", async () => {
    await open();
    update(0);
    table["/api/runs/r1"] = { status: 404, body: { error: "gone" } };
    lose();
    await flush();
    expect(main.textContent).toContain(states.NOT_FOUND);
    expect(banners()).toHaveLength(1);
    stop();

    table["/api/runs/r1"] = { body: RUN };
    await open();
    update(sources.length - 1);
    table["/api/runs/r1"] = { status: 403, body: { error: "no" } };
    lose(sources.length - 1);
    await flush();
    expect(find(main, "div", { "data-kind": "permission" })).toHaveLength(1);
  });

  it("the cleanup closes the stream made by Reconnect and a late GET draws nothing", async () => {
    await open();
    update(0);
    table["/api/runs/r1"] = { hang: true };
    lose();
    one(main, "button", { "data-focus": "stream-reconnect" }).click();
    stop();
    expect(sources[1].close).toHaveBeenCalled();
    const before = main.textContent;
    pending["/api/runs/r1"]!({ status: 404, body: { error: "gone" } });
    await flush();
    expect(main.textContent).toBe(before);
  });

  it("a transcript failure shows Retry, and Retry draws the transcript", async () => {
    const step = { id: "code", type: "claude", ok: true, visit: 1, durationMs: 10, output: "x" };
    table["/api/runs/r1"] = { body: { ...RUN, history: [step] } };
    table["/api/runs/r1/transcript/0"] = { status: 500, body: { error: "disk gone" } };
    await open();
    update(0, { ...RUN, history: [step] });
    one(main, "button", { "data-tab": "steps" }).click();
    const details = one(main, "details");
    details.attrs.open = "true";
    (details as any).open = true;
    for (const fn of details.listeners.toggle ?? []) fn({ target: details });
    await flush();
    const retry = one(main, "button", { "data-focus": "step-0-retry" });
    expect(main.textContent).toContain("Could not load the transcript.");
    table["/api/runs/r1/transcript/0"] = { body: { events: [{ kind: "text", text: "hello transcript" }] } };
    retry.click();
    await flush();
    expect(find(main, "button", { "data-focus": "step-0-retry" })).toHaveLength(0);
    expect(main.textContent).toContain("hello transcript");
  });

  it("a diff failure shows Retry, Retry draws the diff, and a late failure does not replace the log", async () => {
    await open();
    update(0);
    table["/api/runs/r1/diff"] = { status: 500, body: { error: "git failed" } };
    one(main, "button", { "data-tab": "diff" }).click();
    await flush();
    expect(one(main, "button", { "data-focus": "diff-retry" })).toBeTruthy();
    table["/api/runs/r1/diff"] = { body: { patch: "diff --git a b\n+x", stat: "1 file" } };
    one(main, "button", { "data-focus": "diff-retry" }).click();
    await flush();
    expect(find(main, "pre", { class: "diff" }).length).toBeGreaterThan(0);

    // The panels are built once: a new load comes from Refresh, and a late failure stays in the Changes panel.
    table["/api/runs/r1/diff"] = { hang: true };
    one(main, "button", { "data-focus": "diff-refresh" }).click();
    one(main, "button", { "data-tab": "log" }).click();
    pending["/api/runs/r1/diff"]!({ status: 500, body: { error: "late" } });
    await flush();
    expect(one(main, "button", { "data-tab": "log" }).attrs["aria-selected"]).toBe("true");
    expect(find(main, "pre", { role: "log" })).toHaveLength(1);
  });

  it("an older run without flowDef still draws its steps", async () => {
    const old = { ...RUN, status: "stopped", state: { next: "x" }, history: [{ id: "a", type: "shell", ok: false, visit: 1, durationMs: 5, output: "o" }] };
    table["/api/runs/r1"] = { body: old };
    await open();
    update(0, old);
    one(main, "button", { "data-tab": "steps" }).click();
    expect(main.textContent).toContain("what this step does is not saved with this run");
    expect(find(main, "select", { "data-focus": "act-retry-from" })).toHaveLength(0);
  });
});
