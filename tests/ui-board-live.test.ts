import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The Board refreshes through ui/live.js: skeleton, Updated note, one banner, scroll kept, hidden tab pauses.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let states: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/board.js" as string);
  states = await import("../ui/states.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
const realFetch = globalThis.fetch;
const doc = () => (globalThis as any).document;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  calls = [];
  doc().visibilityState = "visible";
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  doc().visibilityState = "visible";
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const COLS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];
const card = (over: Record<string, unknown> = {}) => ({
  key: "acme/app#89", issue: 89, title: "Eighty-nine", column: "waiting", runId: "r89", after: [88], chain: [88, 87], watcher: "w1",
  next: nextStep("dependency", { repo: "acme/app", issue: 89, title: "Eighty-nine", runId: "r89" }, { watched: true, blockers: [{ issue: 88 }] }), ...over,
});
const board = (cards: any[] = [card()]) => ({ repos: [{ repo: "acme/app", columns: COLS.map((id) => ({ id, title: id, cards: cards.filter((c) => c.column === id) })) }] });
const find = (root: FakeElement, tag: string, cls: string): FakeElement[] => root.all(tag).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const named = (root: FakeElement, name: string) => root.all("button").find((b) => b.attrs["data-focus"] === name)!;
const fireVisibility = () => { for (const f of [...doc().listeners.visibilitychange]) f(); };
const open = (wanted = "acme/app") => {
  const m = new FakeElement("main");
  return { m, stop: ui.renderBoard(m, wanted) as () => void };
};
const fail = async (text = "boom") => { calls.shift()!.answer({ error: text }, false); await flush(); };

describe("renderBoard with the poller", () => {
  it("Retry after a failed first load makes one request, and the answer replaces the error", async () => {
    const { m, stop } = open();
    await fail();
    expect(find(m, "div", "state-error")).toHaveLength(1);
    named(m, "board-retry").listeners.click![0]!();
    await flush();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/board"]);
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("Eighty-nine");
    expect(find(m, "div", "state-error")).toHaveLength(0);
    stop();
  });

  it("keeps the same error node over repeated first-load failures", async () => {
    const { m, stop } = open();
    await fail();
    const first = find(m, "div", "state-error")[0];
    await vi.advanceTimersByTimeAsync(5000);
    await fail("again");
    expect(find(m, "div", "state-error")[0]).toBe(first);
    stop();
  });

  it("shows when the board was updated", async () => {
    const { m, stop } = open();
    calls.shift()!.answer(board());
    await flush();
    expect(m.children[2]!.textContent).toBe(states.staleText(Date.now(), false));
    expect(m.children[2]!.textContent).toMatch(/^Updated /);
    stop();
  });

  it("shows the Could not refresh banner once however many refreshes fail, and removes it on success", async () => {
    const { m, stop } = open();
    calls.shift()!.answer(board());
    await flush();
    const bodyBox = m.children[1]!;
    const first = bodyBox.children;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      await fail();
    }
    expect(m.children[0]!.textContent.match(/Could not refresh\. Showing data from/g)).toHaveLength(1);
    expect(m.all("button").filter((b) => b.attrs["data-focus"] === "board-refresh-retry")).toHaveLength(1);
    expect(m.textContent).toContain("Eighty-nine");
    expect(bodyBox.children).toEqual(first);
    named(m, "board-refresh-retry").listeners.click![0]!();
    await flush();
    expect(calls).toHaveLength(1);
    calls.shift()!.answer(board());
    await flush();
    expect(m.children[0]!.textContent).toBe("");
    stop();
  });

  it("makes no request in a hidden tab from the start, and one when it is visible again", async () => {
    doc().visibilityState = "hidden";
    const { m, stop } = open();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(0);
    expect(m.all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(true);
    doc().visibilityState = "visible";
    fireVisibility();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/board" });
    stop();
  });

  it("makes no request in a hidden tab after data", async () => {
    const { stop } = open();
    calls.shift()!.answer(board());
    await flush();
    doc().visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(0);
    stop();
  });

  it("asks for the board even when the tick of the watcher fails", async () => {
    const { m, stop } = open();
    calls.shift()!.answer(board());
    await flush();
    m.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/89")!.listeners.click![0]!();
    fireVisibility();
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/watchers/w1/tick" });
    calls[0]!.answer({}, false);
    await flush();
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/board" });
    stop();
  });

  it("keeps the page scroll and the sideways scroll of .board when the poller draws again", async () => {
    const { m, stop } = open();
    calls.shift()!.answer(board());
    await flush();
    const old = find(m, "div", "board")[0]!;
    expect(old.attrs["data-scroll"]).toBe("board");
    (old as any).scrollLeft = 120;
    doc().documentElement.scrollTop = 300;
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([card({ title: "Changed" })]));
    await flush();
    const now = find(m, "div", "board")[0]!;
    expect(now).not.toBe(old);
    expect(now.attrs["data-scroll"]).toBe("board");
    expect((now as any).scrollLeft).toBe(120);
    expect(doc().documentElement.scrollTop).toBe(300);
    stop();
  });

  it("keeps the scroll when a button redraws without a request", async () => {
    const { m, stop } = open();
    calls.shift()!.answer(board());
    await flush();
    (find(m, "div", "board")[0] as any).scrollLeft = 120;
    doc().documentElement.scrollTop = 300;
    m.all("button").find((b) => b.textContent === "What is in the way of #89?")!.listeners.click![0]!();
    expect(calls).toHaveLength(0);
    expect((find(m, "div", "board")[0] as any).scrollLeft).toBe(120);
    expect(doc().documentElement.scrollTop).toBe(300);
    stop();
  });

  it("stops asking and listening after cleanup", async () => {
    const { stop } = open();
    const before = (doc().listeners.visibilitychange ?? []).length;
    expect(before).toBeGreaterThan(0);
    stop();
    expect((doc().listeners.visibilitychange ?? []).length).toBeLessThan(before);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it("has no timer or visibility code of its own", () => {
    const src = readFileSync("ui/board.js", "utf8");
    expect(src).toContain('from "./live.js"');
    expect(src).not.toMatch(/setInterval|visibilitychange/);
  });
});
