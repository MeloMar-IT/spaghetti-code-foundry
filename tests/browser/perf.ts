import { expect, type Browser, type Page } from "@playwright/test";
import { overBudget, median, POLL_TICK_MS, RUNS_PER_MEASURE, type Budget } from "./budgets.js";
import { openAs } from "./helpers.js";

/** When a page counts as ready: an element has the text, or at least this many children. */
export type Ready = { selector: string; text: string } | { selector: string; children: number };
/** The node whose removal marks the redraw of a polling tick (the first match whose text starts with `startsWith`). */
export type Marker = { selector: string; startsWith?: string };

const WAIT_MS = 30_000;

/** Runs in the page before its own scripts (`page.addInitScript`). Sets window.__perf; nothing outside it may be used here. */
function initPerf(ready: Ready | null): void {
  const w = window as any;
  const check = (r: any): boolean => {
    const el = document.querySelector(r.selector);
    if (!el) return false;
    return "text" in r ? (el.textContent || "").includes(r.text) : el.children.length >= r.children;
  };
  let watching: any = null;
  let resolveReady: () => void = () => {};
  let resolveRedrawn: () => void = () => {};
  let mutations = 0;
  let po: PerformanceObserver | undefined;
  const P: any = {
    // looked up on each call, so a fake clock installed later is what is read (timestamps are compared within one clock)
    now: () => window.performance.now(),
    cls: 0, clsAt: 0, clsError: null, lastMutation: 0, readyAt: null, clickAt: null, pending: 0,
    route: null, polledAt: null, requests: 0, redrawAt: null, marker: null,
    ready: Promise.resolve(), redrawn: Promise.resolve(),
    check,
    flush() {
      if (!po) return;
      for (const e of po.takeRecords() as any[]) if (!e.hadRecentInput) P.cls += e.value;
    },
    watch(r: any) {
      P.readyAt = null;
      watching = r;
      P.ready = new Promise<void>((res) => { resolveReady = res; });
      if (check(r)) { P.readyAt = P.now(); resolveReady(); }
    },
    settled(): Promise<void> {
      return new Promise<void>((res) => {
        const round = () => {
          const seen = mutations;
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            if (P.pending === 0 && mutations === seen) { P.flush(); res(); } else round();
          }));
        };
        round();
      });
    },
    arm(route: string, selector: string, startsWith?: string) {
      P.flush();
      const node = [...document.querySelectorAll(selector)].find((el) => startsWith === undefined || (el.textContent || "").trim().startsWith(startsWith));
      if (!node) throw new Error(`marker not found: ${selector}${startsWith === undefined ? "" : ` starting with "${startsWith}"`}`);
      P.route = route; P.requests = 0; P.polledAt = null; P.redrawAt = null; P.marker = node; P.clsAt = P.cls;
      P.redrawn = new Promise<void>((res) => { resolveRedrawn = res; });
    },
  };
  w.__perf = P;

  try {
    if (!(PerformanceObserver.supportedEntryTypes || []).includes("layout-shift")) throw new Error("layout-shift is not supported");
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) P.cls += e.value;
    });
    po.observe({ type: "layout-shift", buffered: true } as PerformanceObserverInit);
  } catch (e) {
    po = undefined;
    P.clsError = `layout shift cannot be observed: ${(e as Error).message}`;
  }

  const mo = new MutationObserver(() => {
    mutations++;
    P.lastMutation = P.now();
    if (watching && P.readyAt === null && check(watching)) { P.readyAt = P.now(); resolveReady(); }
    if (P.marker && P.redrawAt === null && !P.marker.isConnected) { P.redrawAt = P.now(); resolveRedrawn(); }
  });
  mo.observe(document, { subtree: true, childList: true, characterData: true });

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input: any, init?: any) {
    let path = "";
    try { path = new URL(typeof input === "string" ? input : input.url, location.href).pathname; } catch { /* not a URL */ }
    if (P.route && path === P.route) {
      P.requests++;
      if (P.polledAt === null) P.polledAt = P.now();
    }
    P.pending++;
    return realFetch(input, init).finally(() => { P.pending--; });
  } as typeof window.fetch;

  if (ready) P.watch(ready);
}

/** Fails with `what` when the promise does not finish in time (the page-side waits have no timeout of their own). */
async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not done in ${WAIT_MS} ms`)), WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
  }
}

const untilReady = (page: Page) => within(page.evaluate(() => (window as any).__perf.ready), "the page did not get ready");
const untilSettled = (page: Page) => within(page.evaluate(() => (window as any).__perf.settled()), "the page did not settle");

/** A new context at 1440 px as admin, on `hash`, with the measuring script in it; `ready` is watched from the start. The caller closes `page.context()`. */
export function openMeasured(browser: Browser, hash: string, ready: Ready, opts: { large?: boolean; clock?: boolean } = {}): Promise<Page> {
  return openAs(browser, "admin", 1440, hash, {
    large: opts.large,
    clock: opts.clock,
    before: async (page) => { await page.addInitScript(initPerf, ready); },
  });
}

/** The time from navigation until the page was ready, and the layout shift until it was settled. Not for pages with the fake clock. */
export async function loadMetrics(page: Page): Promise<{ renderMs: number; cls: number }> {
  await untilReady(page);
  await untilSettled(page);
  return page.evaluate(() => {
    const P = (window as any).__perf;
    if (P.clsError) throw new Error(P.clsError);
    return { renderMs: P.readyAt as number, cls: P.cls as number };
  });
}

/** The time from a click until `ready` holds. Throws when it holds before the click. */
export async function clickMetrics(page: Page, click: string, ready: Ready): Promise<{ ms: number }> {
  const already = await page.evaluate((r) => (window as any).__perf.check(r) as boolean, ready);
  if (already) throw new Error(`${JSON.stringify(ready)} is already on the page`);
  await page.evaluate((r) => {
    const P = (window as any).__perf;
    document.addEventListener("click", () => { P.clickAt = P.now(); P.watch(r); }, { capture: true, once: true });
  }, ready);
  await page.locator(click).click();
  await untilReady(page);
  return page.evaluate(() => {
    const P = (window as any).__perf;
    return { ms: (P.readyAt - P.clickAt) as number };
  });
}

/**
 * One polling tick: jumps the fake clock by POLL_TICK_MS and times the redraw from the request of `route` to the removal of the
 * marker node. Both stamps are taken after the jump, so the jump is not in the time. `hold` patterns are kept back until the redraw.
 */
export async function pollTick(page: Page, opts: { marker: Marker; hold?: string[]; route?: string }): Promise<{ redrawMs: number; cls: number; requests: number }> {
  const route = opts.route ?? "/api/runs";
  await untilReady(page);
  await untilSettled(page);

  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const held: { pattern: string; handler: (r: import("@playwright/test").Route) => Promise<void> }[] = [];
  try {
    for (const pattern of opts.hold ?? []) {
      const handler = async (r: import("@playwright/test").Route) => {
        await gate;
        await r.continue().catch(() => {}); // the page may be gone by now
      };
      held.push({ pattern, handler });
      await page.route(pattern, handler);
    }
    await page.evaluate(({ route, marker }) => (window as any).__perf.arm(route, marker.selector, marker.startsWith), { route, marker: opts.marker });
    await page.clock.fastForward(POLL_TICK_MS);
    await within(page.evaluate(() => (window as any).__perf.redrawn), "the marker was not redrawn");
  } finally {
    release();
    for (const h of held) await page.unroute(h.pattern, h.handler).catch(() => {});
  }
  await untilSettled(page);
  return page.evaluate(() => {
    const P = (window as any).__perf;
    if (P.clsError) throw new Error(P.clsError);
    return { redrawMs: (P.redrawAt - P.polledAt) as number, cls: (P.cls - P.clsAt) as number, requests: P.requests as number };
  });
}

/** Runs the measure RUNS_PER_MEASURE times, one after the other, and takes the median of each value. */
export async function medianOf<T extends Record<string, number>>(run: () => Promise<T>): Promise<T> {
  const all: T[] = [];
  for (let i = 0; i < RUNS_PER_MEASURE; i++) all.push(await run());
  const first = all[0] ?? {};
  return Object.fromEntries(Object.keys(first).map((k) => [k, median(all.map((r) => r[k] as number))])) as T;
}

const collected = new Map<string, Promise<unknown>>();

/** Runs a measure once per key in this worker; tests that share a key share the result. */
export function collect<T>(key: string, run: () => Promise<T>): Promise<T> {
  let p = collected.get(key) as Promise<T> | undefined;
  if (!p) {
    p = run();
    collected.set(key, p);
  }
  return p;
}

export function expectBudget(b: Budget, value: number): void {
  expect(value, overBudget(b, value) ?? "").toBeLessThanOrEqual(b.limit);
}
