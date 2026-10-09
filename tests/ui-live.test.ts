import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let live: any;
let states: any;
beforeAll(async () => {
  restore = installFakeDom();
  live = await import("../ui/live.js" as string);
  states = await import("../ui/states.js" as string);
});
afterAll(() => restore());

const doc = () => document as any;
let winListeners: Record<string, ((e?: unknown) => void)[]>;
interface Flight { res: (v: unknown) => void; rej: (e: unknown) => void }
let flights: Flight[];
let pollers: any[];
const T0 = new Date("2026-10-01T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  flights = [];
  pollers = [];
  winListeners = {};
  for (const k of Object.keys(doc().listeners)) delete doc().listeners[k];
  (globalThis as any).addEventListener = (t: string, f: (e?: unknown) => void) => (winListeners[t] ??= []).push(f);
  (globalThis as any).removeEventListener = (t: string, f: unknown) => { winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f); };
  const root = document.getElementById("modal-root") as any;
  root.replaceChildren();
});
afterEach(() => {
  for (const p of pollers) p.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  doc().visibilityState = "visible";
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
  delete (globalThis as any).location;
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
});
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const setNavigator = (value: unknown) => Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });

const load = vi.fn(() => new Promise((res, rej) => { flights.push({ res, rej }); }));
beforeEach(() => { load.mockClear(); });
const flush = () => vi.advanceTimersByTimeAsync(0);
const fireDoc = (t: string) => { for (const f of [...(doc().listeners[t] ?? [])]) f(); };
const fireWin = (t: string) => { for (const f of [...(winListeners[t] ?? [])]) f(); };
const hide = () => { doc().visibilityState = "hidden"; fireDoc("visibilitychange"); };
const show = () => { doc().visibilityState = "visible"; fireDoc("visibilitychange"); };
const make = (opts: Record<string, unknown> = {}) => {
  const draw = vi.fn();
  const onState = vi.fn();
  const p = live.poller({ load, draw, onState, every: 1000, ...opts });
  pollers.push(p);
  return { p, draw, onState };
};
const answerLast = async (v: unknown) => { flights[flights.length - 1]!.res(v); await flush(); };

describe("module", () => {
  const src = readFileSync("ui/live.js", "utf8");
  it("imports only dom.js and states.js and exports the four functions", () => {
    expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["./dom.js", "./states.js"]);
    expect([...src.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["dialogOpen", "keepScroll", "liveStates", "poller"]);
    expect(src).not.toContain("innerHTML");
    expect(src).not.toContain("style:");
  });
});

describe("poller basics", () => {
  it("asks at once, draws, reports and resolves ready", async () => {
    const { p, draw, onState } = make();
    expect(load).toHaveBeenCalledTimes(1);
    await answerLast({ a: 1 });
    await p.ready;
    expect(draw).toHaveBeenCalledWith({ a: 1 });
    expect(onState).toHaveBeenCalledWith({ at: T0.getTime(), failed: false });
  });

  it("does not draw the same answer twice but reports it", async () => {
    const { p, draw, onState } = make();
    await answerLast({ a: 1 });
    void p.refresh();
    await answerLast({ a: 1 });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledTimes(2);
    void p.refresh();
    await answerLast({ a: 2 });
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("ignores undefined", async () => {
    const { p, draw, onState } = make();
    await answerLast(undefined);
    await p.ready;
    expect(draw).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("reports a failure with the last good time", async () => {
    const { p, draw, onState } = make();
    const err = new Error("x");
    flights[0]!.rej(err);
    await flush();
    await p.ready;
    expect(draw).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ at: undefined, failed: true, error: err });
    void p.refresh();
    await answerLast({ a: 1 });
    vi.setSystemTime(new Date(T0.getTime() + 5000));
    void p.refresh();
    flights[flights.length - 1]!.rej(err);
    await flush();
    expect(onState).toHaveBeenLastCalledWith({ at: T0.getTime() + 0, failed: true, error: err });
  });

  it("ticks after every ms", async () => {
    make();
    await answerLast({});
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("show draws when changed and reports once", async () => {
    const { p, draw, onState } = make();
    await answerLast({ a: 1 });
    onState.mockClear();
    p.show({ a: 2 });
    expect(draw).toHaveBeenLastCalledWith({ a: 2 });
    expect(onState).toHaveBeenCalledTimes(1);
    p.show({ a: 2 });
    expect(draw).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenCalledTimes(2);
    p.show(undefined);
    expect(onState).toHaveBeenCalledTimes(2);
  });

  it("a draw that throws is not a failed request and is tried again", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const draw = vi.fn(() => { throw new Error("draw"); });
    const { p, onState } = make({ draw });
    await answerLast({ a: 1 });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ at: T0.getTime(), failed: false });
    void p.refresh();
    await answerLast({ a: 1 });
    expect(draw).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("data that cannot be serialized is a failure from load() and from show()", async () => {
    const circular: any = {};
    circular.self = circular;
    const { p, draw, onState } = make();
    await answerLast({ a: 1 });
    await p.ready;
    void p.refresh();
    await answerLast(circular);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith({ at: T0.getTime(), failed: true, error: expect.any(TypeError) });
    p.show({ big: 1n });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls.at(-1)[0].failed).toBe(true);
    // The first answer is unserializable: ready still resolves and a queued follow-up still runs.
    load.mockClear();
    const q = make();
    void q.p.refresh();
    await answerLast(circular);
    await q.p.ready;
    expect(q.onState.mock.calls[0][0]).toMatchObject({ at: undefined, failed: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("an onState that throws is called once per answer", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onState = vi.fn(() => { throw new Error("state"); });
    const { draw } = make({ onState });
    await answerLast({ a: 1 });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("single flight", () => {
  it("two ticks and a refresh during a flight give one follow-up", async () => {
    const { p } = make();
    await vi.advanceTimersByTimeAsync(2500);
    void p.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    await answerLast({ a: 1 });
    expect(load).toHaveBeenCalledTimes(2);
    await answerLast({ a: 1 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("hidden tab", () => {
  it("makes no request when created hidden and resolves ready", async () => {
    doc().visibilityState = "hidden";
    const { p } = make();
    await p.ready;
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).not.toHaveBeenCalled();
    show();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refresh and online do nothing while hidden", async () => {
    doc().visibilityState = "hidden";
    const { p } = make();
    await p.refresh();
    fireWin("online");
    await flush();
    expect(load).not.toHaveBeenCalled();
  });

  it("hiding during a slow request: no follow-up until return, then exactly one", async () => {
    const { p } = make();
    void p.refresh();
    hide();
    await answerLast({ a: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(1);
    show();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a return while the flight runs gives one follow-up", async () => {
    make();
    hide();
    show();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    await answerLast({});
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("wake", () => {
  it("is awaited before the request; a rejection is ignored", async () => {
    let release!: () => void;
    const wake = vi.fn(() => new Promise<void>((r) => { release = r; }));
    make({ wake });
    await answerLast({});
    hide();
    show();
    await flush();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    const bad = vi.fn(() => Promise.reject(new Error("no")));
    load.mockClear();
    make({ wake: bad });
    await answerLast({});
    hide();
    show();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("tick, refresh and online during wake are folded into one request", async () => {
    let release!: () => void;
    const wake = () => new Promise<void>((r) => { release = r; });
    const { p } = make({ wake });
    await answerLast({});
    hide();
    show();
    await vi.advanceTimersByTimeAsync(3000);
    void p.refresh();
    fireWin("online");
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await answerLast({});
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hiding during wake: no request, the next return gives one", async () => {
    let release!: () => void;
    const wake = () => new Promise<void>((r) => { release = r; });
    make({ wake });
    await answerLast({});
    hide();
    show();
    hide();
    release();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    show();
    release();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hidden, visible, hidden, visible during one wake: wake once, one request", async () => {
    let release!: () => void;
    const wake = vi.fn(() => new Promise<void>((r) => { release = r; }));
    make({ wake });
    await answerLast({});
    hide();
    show();
    hide();
    show();
    expect(wake).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("hold", () => {
  it("keeps the newest answer until the hold ends", async () => {
    let held = true;
    const { p, draw, onState } = make({ hold: () => held, every: 100000 });
    await answerLast({ a: 1 });
    expect(draw).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);
    p.show({ a: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(draw).not.toHaveBeenCalled();
    held = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith({ a: 2 });
  });

  it("drops a held answer equal to the drawn one", async () => {
    let held = false;
    const { p, draw } = make({ hold: () => held, every: 100000 });
    await answerLast({ a: 1 });
    held = true;
    p.show({ a: 2 });
    p.show({ a: 1 });
    held = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(draw).toHaveBeenCalledTimes(1);
  });
});

describe("offline", () => {
  it("blocks requests and reports offline until online", async () => {
    const { p, onState } = make();
    await answerLast({ a: 1 });
    fireWin("offline");
    const call = onState.mock.calls.at(-1)[0];
    expect(call.failed).toBe(true);
    expect(call.at).toBe(T0.getTime());
    expect(states.explainError(call.error).kind).toBe("offline");
    await vi.advanceTimersByTimeAsync(3000);
    await p.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    fireWin("online");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("online while hidden makes no request", async () => {
    make();
    await answerLast({});
    fireWin("offline");
    hide();
    fireWin("online");
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("created while the browser is already offline: no request, a failed state", async () => {
    setNavigator({ onLine: false });
    const { p, onState } = make();
    await flush();
    await p.ready;
    expect(load).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0][0].failed).toBe(true);
    expect(onState.mock.calls[0][0].at).toBeUndefined();
    fireWin("online");
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("is ignored on %s", async (hostname) => {
    (globalThis as any).location = { hostname };
    setNavigator({ onLine: false });
    const { onState } = make();
    expect(load).toHaveBeenCalledTimes(1);
    await answerLast({});
    onState.mockClear();
    fireWin("offline");
    expect(onState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("behaves as offline on another host", async () => {
    (globalThis as any).location = { hostname: "factory.example" };
    const { onState } = make();
    await answerLast({});
    fireWin("offline");
    expect(onState.mock.calls.at(-1)[0].failed).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("stop", () => {
  it("removes listeners and timers and ignores late answers", async () => {
    const { p, draw, onState } = make();
    const ready = p.ready;
    p.stop();
    await ready;
    expect(doc().listeners.visibilitychange).toEqual([]);
    expect(winListeners.online).toEqual([]);
    expect(winListeners.offline).toEqual([]);
    await answerLast({ a: 1 });
    p.show({ a: 2 });
    await vi.advanceTimersByTimeAsync(60000);
    await p.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(draw).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("does not draw a held answer", async () => {
    const { p, draw } = make({ hold: () => true });
    await answerLast({ a: 1 });
    p.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(draw).not.toHaveBeenCalled();
  });
});

describe("keepScroll", () => {
  const el = (v: string, top: number, left = 0) => {
    const e = new FakeElement("div");
    e.attrs["data-scroll"] = v;
    e.scrollTop = top;
    e.scrollLeft = left;
    return e;
  };
  it("restores the page and the marked elements by value", () => {
    const box = new FakeElement("div");
    const a = el("a", 10, 1);
    const b = el("b", 20, 2);
    box.append(a, b);
    const root = document.documentElement as any;
    root.scrollTop = 300;
    root.scrollLeft = 7;
    const result = live.keepScroll(box, () => {
      root.scrollTop = 0;
      root.scrollLeft = 0;
      box.replaceChildren(el("c", 0), el("b", 0), el("a", 0));
      return "done";
    });
    expect(result).toBe("done");
    const [c, b2, a2] = box.children as FakeElement[];
    expect([a2!.scrollTop, a2!.scrollLeft, b2!.scrollTop, b2!.scrollLeft, c!.scrollTop]).toEqual([10, 1, 20, 2, 0]);
    expect([root.scrollTop, root.scrollLeft]).toEqual([300, 7]);
  });

  it("keeps duplicate values apart and restores when fn throws", () => {
    const box = new FakeElement("div");
    box.append(el("x", 5), el("x", 9));
    expect(() => live.keepScroll(box, () => {
      box.replaceChildren(el("x", 0), el("x", 0));
      throw new Error("boom");
    })).toThrow("boom");
    expect((box.children as FakeElement[]).map((c) => c.scrollTop)).toEqual([5, 9]);
  });
});

describe("dialogOpen", () => {
  it("is true when #modal-root has children", () => {
    const root = document.getElementById("modal-root") as any;
    expect(live.dialogOpen()).toBe(false);
    root.append(new FakeElement("div"));
    expect(live.dialogOpen()).toBe(true);
  });
});

describe("liveStates", () => {
  const at = T0.getTime();
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const setup = (opts: Record<string, unknown> = {}) => {
    const body = new FakeElement("div");
    const retry = vi.fn();
    const heading = () => new FakeElement("h2");
    const s = live.liveStates({ body, heading, label: "Loading board", what: "Could not load the board.", retry, ...opts });
    return { body, retry, s };
  };

  it("starts with the heading and a skeleton, also without heading", () => {
    const { body } = setup({ rows: 5, shape: "table" });
    expect((body.children[0] as FakeElement).tag).toBe("h2");
    const sk = body.children[1] as FakeElement;
    expect(sk.attrs.class).toContain("skeleton-table");
    expect(sk.textContent).toBe("Loading board");
    expect(sk.all("div")).toHaveLength(5);
    const b2 = new FakeElement("div");
    live.liveStates({ body: b2, label: "x" });
    expect(b2.children).toHaveLength(1);
  });

  it("shows the error state once on the first failure", () => {
    const { body, retry, s } = setup();
    s.onState({ at: undefined, failed: true, error: new TypeError("x") });
    const err = body.children[1] as FakeElement;
    expect(err.attrs.class).toContain("state-error");
    expect(err.textContent).toContain("Could not load the board.");
    const btn = err.all("button")[0]!;
    expect(btn.attrs["data-focus"]).toBe("retry");
    btn.click();
    expect(retry).toHaveBeenCalledTimes(1);
    s.onState({ at: undefined, failed: true, error: new TypeError("x") });
    expect(body.children[1]).toBe(err);
  });

  it("names the buttons after focus", () => {
    const { body, s } = setup({ focus: "board" });
    s.onState({ at: undefined, failed: true, error: new Error("x") });
    expect((body.children[1] as FakeElement).all("button")[0]!.attrs["data-focus"]).toBe("board-retry");
    s.onState({ at, failed: true });
    expect(s.alert.all("button")[0].attrs["data-focus"]).toBe("board-refresh-retry");
  });

  it("writes the note only when the text changes; quiet writes nothing", () => {
    const { s } = setup();
    s.onState({ at, failed: false });
    expect(s.note.textContent).toBe(`Updated ${time}`);
    const first = s.note.children[0];
    s.onState({ at: at + 1000, failed: false });
    expect(s.note.children[0]).toBe(first);
    s.onState({ at: at + 3 * 60_000, failed: false });
    expect(s.note.children[0]).not.toBe(first);
    const q = setup({ quiet: true });
    q.s.onState({ at, failed: false });
    expect(q.s.note.children).toHaveLength(0);
  });

  it("shows one banner after data and clears it on success", () => {
    const { body, retry, s } = setup();
    s.onState({ at, failed: false });
    const before = [...body.children];
    s.onState({ at, failed: true });
    const b = s.alert.children[0] as FakeElement;
    expect(b.attrs.role).toBe("alert");
    expect(b.textContent).toContain(states.staleText(at, true));
    b.all("button")[0]!.click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(b.all("button")[0]!.attrs["data-focus"]).toBe("refresh-retry");
    s.onState({ at, failed: true });
    expect(s.alert.children[0]).toBe(b);
    expect(body.children).toEqual(before);
    s.onState({ at, failed: false });
    expect(s.alert.children).toHaveLength(0);
    s.onState({ at, failed: true });
    expect(s.alert.children[0]).not.toBe(b);
  });

  it("walks through the states with a real poller", async () => {
    const { s } = setup();
    const p = live.poller({ load, draw: () => {}, onState: s.onState, every: 100000 });
    pollers.push(p);
    flights[0]!.rej(new Error("x"));
    await flush();
    expect((s.alert.children as unknown[]).length).toBe(0);
    void p.refresh();
    await answerLast({ a: 1 });
    expect(s.note.textContent).toContain("Updated");
    void p.refresh();
    flights[flights.length - 1]!.rej(new Error("x"));
    await flush();
    expect(s.alert.children).toHaveLength(1);
  });
});
