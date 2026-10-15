import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, openAs } from "./helpers.js";
import { WIDTHS } from "./widths.js";

// The epic page (#489) at every width: no sideways scroll of the page. The wide chain graph and the tables scroll in their own boxes.
// The two API answers are stubbed, so the page has a wide graph, long titles and a long history without seeding an epic.

const LONG = "A very long story title without any natural break that goes on and on and on and on and on";
const counts = { done: 2, working: 1, waiting: 9, your_turn: 0, failed: 0, split: 0, dropped: 0 };
const stories = Array.from({ length: 12 }, (_, i) => ({
  issue: 100 + i, title: i % 3 === 0 ? LONG : `Story ${i}`, state: i < 2 ? "done" : i === 2 ? "working" : "waiting",
  words: i < 2 ? "Done" : i === 2 ? "Working" : "Waiting", createdAt: "2026-10-01T00:00:00Z",
}));
const nodes = stories.map((s, i) => ({
  issue: s.issue, title: s.title, state: s.state, done: i < 2, order: i, level: i,
  dependsOn: i ? [s.issue - 1] : [], outside: [], ...(i < 6 ? { critical: true } : {}),
}));
const detail = {
  repo: "acme/app", data: { state: "fresh", readAt: "2026-10-14T08:48:00Z", cut: false, ageMs: 60_000 },
  epic: {
    id: "12", key: "#12", issue: 12, title: LONG, counts, total: 12, notHanded: 0, growth: { atStart: 12, now: 12, split: 0 }, growthText: "12 at the start, 12 now", finished: false,
    forecast: { kind: "range", earliest: "2026-10-20T10:00:00Z", expected: "2026-10-22T10:00:00Z", latest: "2026-10-27T10:00:00Z", drivers: [], text: LONG, leavesOut: ["usage limits", "a person's answer"] },
    holdUps: [],
  },
  stories,
  chains: {
    order: stories.map((s) => s.issue), nodes, edges: nodes.slice(1).map((n, i) => ({ from: n.issue, to: nodes[i]!.issue, ...(i < 5 ? { critical: true } : {}) })),
    outside: [{ issue: 77, title: LONG }], cycles: [[110, 111]], criticalPath: { stories: stories.slice(0, 6).map((s) => s.issue), remaining: 4, at: 102 },
  },
  series: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, stories: 12, done: Math.min(2, i) })),
  pace: { perDay: 0.7, days: Array.from({ length: 14 }, (_, i) => ({ from: `f${i}`, to: `t${i}`, done: i % 3 })) },
  medianStoryMs: 3 * 3_600_000,
  history: Array.from({ length: 10 }, (_, i) => ({ day: `2026-10-0${i + 1}`, at: `2026-10-0${i + 1}T08:00:00Z`, kind: "range", earliest: "2026-10-20T10:00:00Z", expected: `2026-10-${20 + (i % 4)}T10:00:00Z`, latest: "2026-10-27T10:00:00Z" })),
};

async function stub(page: Page) {
  await page.route("**/api/admin/repos", (r) => r.fulfill({ json: [{ id: "r1", github: "acme/app", owner: "none" }] }));
  await page.route("**/api/repos/r1/epics/12", (r) => r.fulfill({ json: detail }));
}

for (const width of WIDTHS) {
  test(`the epic page has no sideways scroll at ${width} px`, async ({ browser }) => {
    const page = await openAs(browser, "admin", width, "#/home");
    try {
      await stub(page);
      await page.evaluate(() => { location.hash = "#/epics/12?repo=acme%2Fapp"; });
      await expect(page.locator("#main")).toContainText("Dependency chains");
      await expectNoSidewaysScroll(page);
      for (const d of await page.locator("#main details").all()) await d.locator("summary").click();
      await expectNoSidewaysScroll(page);
      // the graph is wider than a phone and scrolls inside its own box
      const graph = page.locator(".chain-graph");
      const box = await graph.evaluate((e) => ({ client: e.clientWidth, scroll: e.scrollWidth }));
      if (width <= 768) expect(box.scroll).toBeGreaterThan(box.client);
      expect(await page.locator(".epic-chart svg").evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(width);
    } finally {
      await page.context().close();
    }
  });
}
