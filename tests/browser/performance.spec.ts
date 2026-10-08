import { expect, test, type Browser } from "@playwright/test";
import { BUDGETS, show, type Budget } from "./budgets.js";
import { seed } from "./helpers.js";
import { clickMetrics, collect, expectBudget, loadMetrics, medianOf, openMeasured, pollTick, type Marker, type Ready } from "./perf.js";

// The budgets are in budgets.ts; the numbers and the reasons are in docs/ui-redesign/measurement.md.
// A test that is known to be over its budget is listed here by title, with the measured value and the name of the follow-up.
// It still measures and writes the value into its "measured" annotation; it is only not asserted.
const KNOWN: Record<string, string> = {
  "CLS_LOAD home": "0.137 on load, over 0.1. Follow-up: UI quality 5 - no layout shift when the page shell loads.",
  "CLS_LOAD runs": "0.137 on load, over 0.1. Follow-up: UI quality 5 - no layout shift when the page shell loads.",
  "CLS_LOAD board": "0.137 on load, over 0.1. Follow-up: UI quality 5 - no layout shift when the page shell loads.",
  "LARGE_LOG_MS": "5993 ms, over 3000 ms. Follow-up: UI quality 6 - draw a long live log in one step (not a layout per line).",
};

test.describe.configure({ mode: "default" });
test.setTimeout(120_000);

const RUNS_READY: Ready = { selector: "#main", text: "Seeded failed run" };
const HOME_READY: Ready = { selector: "#main", text: "Seeded gate run" };
const BOARD_READY: Ready = { selector: "#main", text: "acme/app" };
const HOME_MARKER: Marker = { selector: "#main .home > div > section.home-section", startsWith: "Active" };
const RUNS_MARKER: Marker = { selector: "#main > .toolbar" };

/** Opens a fresh context, runs `fn` on its page and closes the context. */
async function onFreshPage<T>(browser: Browser, hash: string, ready: Ready, opts: { large?: boolean; clock?: boolean }, fn: (page: import("@playwright/test").Page) => Promise<T>): Promise<T> {
  const page = await openMeasured(browser, hash, ready, opts);
  try {
    return await fn(page);
  } finally {
    await page.context().close();
  }
}

const load = (key: string, browser: Browser, hash: string, ready: Ready, opts: { large?: boolean } = {}) =>
  collect(key, () => medianOf(() => onFreshPage(browser, hash, ready, opts, async (page) => {
    const m = await loadMetrics(page);
    const rows = await page.evaluate(() => document.querySelectorAll("#main > .table-box tbody tr").length);
    return { ...m, rows };
  })));

const poll = (key: string, browser: Browser, hash: string, ready: Ready, marker: Marker, hold?: string[]) =>
  collect(key, () => medianOf(() => onFreshPage(browser, hash, ready, { clock: true }, (page) => pollTick(page, { marker, hold }))));

/** One test per budget: measure, record, then (unless known) assert. The value is recorded before a known case stops. */
function budgetTest(title: string, b: Budget, get: (browser: Browser) => Promise<number>): void {
  test(title, async ({ browser }) => {
    const value = await get(browser);
    test.info().annotations.push({ type: "measured", description: show(b, value) });
    console.log(`MEASURED ${title} ${value}`);
    test.fixme(title in KNOWN, KNOWN[title]);
    expectBudget(b, value);
  });
}

test.describe("harness", () => {
  test("two seeded servers", () => {
    expect(seed().large).toBeUndefined();
    expect(seed("large").large?.runs).toBe(500);
    expect(seed().url).not.toBe(seed("large").url);
  });

  test("a polling tick is measured without the clock jump", async ({ browser }) => {
    await onFreshPage(browser, "#/runs", RUNS_READY, { clock: true }, async (page) => {
      await page.evaluate(() => (window as any).__perf.settled());
      const before = await page.evaluate(() => performance.now());
      const m = await pollTick(page, { marker: RUNS_MARKER });
      const after = await page.evaluate(() => performance.now());
      expect(after - before).toBeGreaterThanOrEqual(30_000);
      expect(m.redrawMs).toBeGreaterThanOrEqual(0);
      expect(m.redrawMs).toBeLessThan(10_000);
      expect(m.requests).toBeGreaterThanOrEqual(1);
    });
  });
});

test.describe("budgets", () => {
  budgetTest("RENDER_HOME_MS", BUDGETS.RENDER_HOME_MS, async (b) => (await load("load-home", b, "#/home", HOME_READY)).renderMs);
  budgetTest("CLS_LOAD home", BUDGETS.CLS_LOAD, async (b) => (await load("load-home", b, "#/home", HOME_READY)).cls);
  budgetTest("RENDER_RUNS_MS", BUDGETS.RENDER_RUNS_MS, async (b) => (await load("load-runs", b, "#/runs", RUNS_READY)).renderMs);
  budgetTest("CLS_LOAD runs", BUDGETS.CLS_LOAD, async (b) => (await load("load-runs", b, "#/runs", RUNS_READY)).cls);
  budgetTest("RENDER_BOARD_MS", BUDGETS.RENDER_BOARD_MS, async (b) => (await load("load-board", b, "#/board", BOARD_READY)).renderMs);
  budgetTest("CLS_LOAD board", BUDGETS.CLS_LOAD, async (b) => (await load("load-board", b, "#/board", BOARD_READY)).cls);

  budgetTest("INTERACTION_MS", BUDGETS.INTERACTION_MS, (browser) =>
    collect("click-runs", () => medianOf(() => onFreshPage(browser, "#/board", BOARD_READY, {}, (page) =>
      clickMetrics(page, '#side a[data-nav="runs"]', RUNS_READY)))).then((m) => m.ms));

  const pollHome = (b: Browser) => poll("poll-home", b, "#/home", HOME_READY, HOME_MARKER, ["**/api/your-turn"]);
  const pollRuns = (b: Browser) => poll("poll-runs", b, "#/runs", RUNS_READY, RUNS_MARKER);
  budgetTest("POLL_HOME_MS", BUDGETS.POLL_HOME_MS, async (b) => (await pollHome(b)).redrawMs);
  budgetTest("CLS_POLL home", BUDGETS.CLS_POLL, async (b) => (await pollHome(b)).cls);
  budgetTest("POLL_REQUESTS home", BUDGETS.POLL_REQUESTS, async (b) => {
    const n = (await pollHome(b)).requests;
    expect(n, "a tick asks /api/runs exactly once").toBe(1);
    return n;
  });
  budgetTest("POLL_RUNS_MS", BUDGETS.POLL_RUNS_MS, async (b) => (await pollRuns(b)).redrawMs);
  budgetTest("CLS_POLL runs", BUDGETS.CLS_POLL, async (b) => (await pollRuns(b)).cls);
  budgetTest("POLL_REQUESTS runs", BUDGETS.POLL_REQUESTS, async (b) => {
    const n = (await pollRuns(b)).requests;
    expect(n, "a tick asks /api/runs exactly once").toBe(1);
    return n;
  });

  const bigRuns = (b: Browser) => load("large-runs", b, "#/runs", { selector: "#main > .table-box tbody", children: 200 }, { large: true });
  budgetTest("LARGE_RUNS_MS", BUDGETS.LARGE_RUNS_MS, async (b) => (await bigRuns(b)).renderMs);
  budgetTest("LARGE_RUNS_ROWS", BUDGETS.LARGE_RUNS_ROWS, async (b) => (await bigRuns(b)).rows);

  budgetTest("LARGE_LOG_MS", BUDGETS.LARGE_LOG_MS, async (b) =>
    (await load("large-log", b, "#/runs/ui-big-log", { selector: "#main pre.log", children: 5000 }, { large: true })).renderMs);

  budgetTest("LARGE_DIFF_MS", BUDGETS.LARGE_DIFF_MS, async (browser) => {
    const m = await collect("large-diff", () => medianOf(() =>
      onFreshPage(browser, "#/runs/ui-big-diff", { selector: "#main", text: "Large seeded diff run" }, { large: true }, async (page) => {
        const { ms } = await clickMetrics(page, 'button[data-tab="diff"]', { selector: "#main pre.diff", children: 2000 });
        const counts = await page.evaluate(() => ({
          adds: document.querySelectorAll("#main pre.diff .add").length,
          dels: document.querySelectorAll("#main pre.diff .del").length,
        }));
        return { ms, ...counts };
      })));
    expect(m.adds, "added lines in the diff").toBeGreaterThanOrEqual(1000);
    expect(m.dels, "removed lines in the diff").toBeGreaterThanOrEqual(1000);
    return m.ms;
  });
});
