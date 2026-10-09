import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// Your turn through the poller: skeleton, one onState per request, failures that keep the page, no requests in a hidden tab.

/* eslint-disable @typescript-eslint/no-explicit-any */
const seen = vi.hoisted(() => ({ states: [] as any[] }));
vi.mock("../ui/live.js", async (orig) => {
  const real = await orig<any>();
  return { ...real, poller: (o: any) => real.poller({ ...o, onState: (s: any) => { seen.states.push(s); o.onState?.(s); } }) };
});

let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/turn.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; body?: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
let cleanups: (() => void)[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  cleanups = [];
  seen.states.length = 0;
  (document as any).title = "";
  (document as any).visibilityState = "visible";
  (globalThis as any).fetch = (url: string, init?: { method?: string; body?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  for (const c of cleanups) c();
  (document as any).visibilityState = "visible";
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const item = (over: Record<string, unknown> = {}) => ({
  key: "k5", repo: "o/a", what: "Five", next: nextStep("questions", { repo: "o/a", issue: 5, title: "Five" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5", questions: 2 }),
  since: "2026-10-01T10:00:00Z", unblocks: 0, dismissable: true, ...over,
});
const data = (items: unknown[]) => ({ count: items.length, groups: items.length ? [{ repo: "o/a", items }] : [], dismissed: 0, ...(items.length ? {} : { empty: "Nothing needs you." }) });
const start = async (first: unknown, opts: Record<string, unknown> = {}) => {
  const main = new FakeElement("main");
  const p = ui.renderYourTurn(main, opts);
  await flush();
  calls.shift()!.answer(first);
  const cleanup = await p;
  cleanups.push(cleanup);
  return { main, cleanup };
};
const buttons = (main: FakeElement, name: string) => main.querySelectorAll("button").filter((b) => b.attrs["data-focus"] === name);

describe("renderYourTurn live states", () => {
  it("shows a skeleton and the heading before the first answer", async () => {
    const main = new FakeElement("main");
    const p = ui.renderYourTurn(main);
    await flush();
    expect(main.all("div").some((d) => d.attrs.class?.startsWith("skeleton"))).toBe(true);
    expect(main.all("h1")[0]!.textContent).toBe("Your turn");
    calls.shift()!.answer(data([item()]));
    cleanups.push(await p);
    const emb = new FakeElement("main");
    const q = ui.renderYourTurn(emb, { embedded: true });
    await flush();
    expect(emb.all("div").some((d) => d.attrs.class?.startsWith("skeleton"))).toBe(true);
    expect(emb.all("h2")[0]!.textContent).toBe("Needs you");
    calls.shift()!.answer(data([]));
    cleanups.push(await q);
  });

  it("one successful poll gives one onState", async () => {
    await start(data([item()]));
    expect(seen.states).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(data([item({ what: "New" })]));
    await flush();
    expect(seen.states).toHaveLength(2);
  });

  it("a badge answer reaches the page once", async () => {
    const onData = vi.fn();
    const { main } = await start(data([item()]), { onData });
    const p = ui.refresh();
    calls.shift()!.answer(data([item({ what: "Badge" })]));
    await p;
    expect(seen.states).toHaveLength(2);
    expect(onData).toHaveBeenCalledTimes(2);
    expect(main.textContent).toContain("Badge");
  });

  it("an action answer reaches the page once", async () => {
    const { main } = await start(data([item()]));
    main.all("button").find((b) => b.textContent === "Dismiss")!.listeners.click![0]!();
    const post = calls.shift()!;
    expect(post.method).toBe("POST");
    post.answer(data([]));
    await flush();
    expect(seen.states).toHaveLength(2);
    expect(main.textContent).toContain("Nothing needs you.");
  });

  it("an unchanged poll does not call onData again", async () => {
    const onData = vi.fn();
    await start(data([item()]), { onData });
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(data([item()]));
    await flush();
    expect(onData).toHaveBeenCalledTimes(1);
    expect(seen.states).toHaveLength(2);
  });

  it("a first-load failure resolves, shows the error with Retry, and Retry draws", async () => {
    const main = new FakeElement("main");
    const p = ui.renderYourTurn(main);
    await flush();
    calls.shift()!.answer({ error: "down" }, false);
    const cleanup = await p;
    cleanups.push(cleanup);
    expect(typeof cleanup).toBe("function");
    expect(main.textContent).toContain("Could not load what needs you.");
    const retry = buttons(main, "retry");
    expect(retry).toHaveLength(1);
    retry[0]!.click();
    await flush();
    expect(calls).toHaveLength(1);
    calls.shift()!.answer(data([item()]));
    await flush();
    expect(main.textContent).toContain("Five");
    expect(main.textContent).not.toContain("Could not load what needs you.");
  });

  it("the focus option names the Retry buttons", async () => {
    const main = new FakeElement("main");
    const p = ui.renderYourTurn(main, { focus: "needs" });
    await flush();
    calls.shift()!.answer({ error: "down" }, false);
    cleanups.push(await p);
    expect(buttons(main, "needs-retry")).toHaveLength(1);
    buttons(main, "needs-retry")[0]!.click();
    await flush();
    calls.shift()!.answer(data([item()]));
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer({ error: "down" }, false);
    await flush();
    expect(buttons(main, "needs-refresh-retry")).toHaveLength(1);
  });

  it("a failure after data keeps the items and shows the banner once; success removes it", async () => {
    const { main } = await start(data([item()]));
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      calls.shift()!.answer({ error: "down" }, false);
      await flush();
    }
    expect(main.textContent).toContain("Five");
    expect(main.textContent).toContain("Could not refresh");
    expect(buttons(main, "refresh-retry")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(data([item({ what: "Back" })]));
    await flush();
    expect(main.textContent).toContain("Back");
    expect(main.textContent).not.toContain("Could not refresh");
  });

  it("the standalone page has an Updated note; the embedded one has none", async () => {
    const a = await start(data([item()]));
    expect(a.main.textContent).toContain("Updated");
    const b = await start(data([item()]), { embedded: true });
    expect(b.main.textContent).not.toContain("Updated");
  });

  it("a hidden tab makes no page request; the badge still asks every 30 s", async () => {
    (document as any).visibilityState = "hidden";
    const main = new FakeElement("main");
    cleanups.push(await ui.renderYourTurn(main));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    const first = ui.startBadge();
    await flush();
    calls.shift()!.answer(data([]));
    await first;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
  });

  it("keeps the scroll position across a redraw", async () => {
    const { main } = await start(data([item()]));
    const root = (document as any).documentElement;
    root.scrollTop = 120;
    const real = main.replaceChildren.bind(main);
    main.replaceChildren = (...nodes: any[]) => { root.scrollTop = 0; real(...nodes); };
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(data([item({ what: "Scrolled" })]));
    await flush();
    expect(main.textContent).toContain("Scrolled");
    expect(root.scrollTop).toBe(120);
    root.scrollTop = 0;
  });

  it("a poll that a newer request replaced is ignored", async () => {
    const main = new FakeElement("main");
    const p = ui.renderYourTurn(main);
    await flush();
    const poll = calls.shift()!;
    const r = ui.refresh();
    const newer = calls.shift()!;
    newer.answer(data([item({ what: "Newer" })]));
    await r;
    expect(seen.states).toHaveLength(1);
    poll.answer(data([item({ what: "Older" })]));
    cleanups.push(await p); // ready resolves when the first request ends
    expect(seen.states).toHaveLength(1);
    expect(main.textContent).toContain("Newer");
    expect(main.textContent).not.toContain("Older");
  });

  it("a failed Dismiss still shows its error when a poll started after it", async () => {
    const { main } = await start(data([item()]));
    main.all("button").find((b) => b.textContent === "Dismiss")!.listeners.click![0]!();
    const post = calls.shift()!;
    await vi.advanceTimersByTimeAsync(5000); // a poll starts while the dismiss is pending
    post.answer({ error: "no such item" }, false);
    await flush();
    const toast = document.getElementById("toast") as unknown as FakeElement;
    expect((toast as any).className).toBe("show error");
    expect(toast.textContent).not.toContain("Item dismissed");
  });

  it("the failure of an older poll does not show a banner after a newer answer", async () => {
    const { main } = await start(data([item()]));
    await vi.advanceTimersByTimeAsync(5000);
    const poll = calls.shift()!;
    const r = ui.refresh();
    calls.shift()!.answer(data([item({ what: "Newer" })]));
    await r;
    poll.answer({ error: "down" }, false);
    await flush();
    expect(seen.states.filter((s) => s.failed)).toEqual([]);
    expect(main.textContent).not.toContain("Could not refresh");
    expect(main.textContent).toContain("Newer");
  });
});
