import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, openAs } from "./helpers.js";
import { VIEW_HEIGHT, WIDTHS, usesDrawer } from "./widths.js";

// UI quality 1b (#368): no sideways scroll, 44 px touch targets, and dialogs that are sheets below 768 px.

const PAGES: [string, string, string | RegExp][] = [
  ["Home", "#/home", "Seeded gate run"],
  ["Runs", "#/runs", "Seeded failed run"],
  ["Start work", "#/start", "gate"],
  ["Repositories", "#/repos", /No repositories yet/],
];

const TARGETS = 'button, a.btn, a[data-nav], .brand, select, textarea, summary, input:not([type=checkbox]):not([type=radio]):not([type=hidden])';
const ADD = '[data-focus="add-toolbar"]'; // the empty page also has an "+ Add repository" button in its empty state
const dialog =(page: Page) => page.locator('[role="dialog"]');

async function openAddDialog(page: Page) {
  await page.locator(ADD).click();
  await expect(dialog(page)).toBeVisible();
}

for (const width of WIDTHS) {
  test(`no sideways scroll at ${width} px`, async ({ browser }) => {
    for (const [name, hash, text] of PAGES) {
      const page = await openAs(browser, "admin", width, hash);
      try {
        await expect(page.locator("#main"), name).toContainText(text);
        await expectNoSidewaysScroll(page);
        if (name === "Repositories") {
          await openAddDialog(page);
          await expectNoSidewaysScroll(page);
        }
      } finally {
        await page.context().close();
      }
    }
  });

  test(`log and diff stay in their own box at ${width} px`, async ({ browser }) => {
    test.setTimeout(120_000);
    const log = await openAs(browser, "admin", width, "#/runs/ui-big-log", { large: true });
    try {
      await expect(log.locator("#main pre.log")).toBeVisible({ timeout: 30_000 });
      await expectNoSidewaysScroll(log);
      expect(await log.locator("pre.log").evaluate((e) => e.clientWidth)).toBeLessThanOrEqual(width);
    } finally {
      await log.context().close();
    }
    const diff = await openAs(browser, "admin", width, "#/runs/ui-big-diff", { large: true });
    try {
      await expect(diff.locator("#main")).toContainText("Large seeded diff run", { timeout: 30_000 });
      await diff.locator('button[data-tab="diff"]').click();
      await expect(diff.locator("#main pre.diff")).toBeVisible({ timeout: 30_000 });
      await expectNoSidewaysScroll(diff);
      expect(await diff.locator("pre.diff").first().evaluate((e) => e.clientWidth)).toBeLessThanOrEqual(width);
    } finally {
      await diff.context().close();
    }
  });

  test(`touch targets are 44 px at ${width} px`, async ({ browser }) => {
    const page = await openAs(browser, "admin", width, "#/repos", { touch: true });
    try {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the touch profile is coarse").toBe(true);
      await expect(page.locator("#main")).toContainText(/No repositories yet/);
      if (usesDrawer(width)) await page.locator("#menu-btn").click();
      const tooSmall = async (scope: string): Promise<string[]> => {
        const found: string[] = [];
        for (const el of await page.locator(`${scope} :is(${TARGETS})`).all()) {
          if (!(await el.isVisible())) continue;
          const box = await el.boundingBox();
          if (!box || box.width <= 0) continue;
          if (box.width < 43.5 || box.height < 43.5) found.push(`${scope} ${await el.evaluate((e) => e.outerHTML.slice(0, 80))}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        return found;
      };
      expect([...(await tooSmall("#top")), ...(await tooSmall("#side"))]).toEqual([]);
      if (usesDrawer(width)) await page.keyboard.press("Escape");
      await openAddDialog(page);
      expect(await tooSmall('[role="dialog"]')).toEqual([]);
      // neighbouring targets in the dialog are at least 8 px apart
      const close = await page.evaluate((sel) => {
        const boxes = [...document.querySelectorAll(`[role="dialog"] :is(${sel})`)].map((e) => ({ r: e.getBoundingClientRect(), n: e.outerHTML.slice(0, 60) })).filter((b) => b.r.width > 0);
        const out: string[] = [];
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!.r, b = boxes[j]!.r;
          const gapX = Math.max(b.left - a.right, a.left - b.right), gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
          if (Math.max(gapX, gapY) < 7.5) out.push(`${boxes[i]!.n} / ${boxes[j]!.n}`);
        }
        return out;
      }, TARGETS);
      expect(close, "targets closer than 8 px").toEqual([]);
      await expectNoSidewaysScroll(page);
    } finally {
      await page.context().close();
    }
  });
}

test("the dialog is a bottom sheet at 360 px", async ({ browser }) => {
  const page = await openAs(browser, "admin", 360, "#/repos");
  try {
    await expect(page.locator("#main")).toContainText(/No repositories yet/);
    await openAddDialog(page);
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(360);
    expect(Math.abs(box.y + box.height - VIEW_HEIGHT)).toBeLessThanOrEqual(1);
    expect(box.height).toBeLessThanOrEqual(0.9 * VIEW_HEIGHT + 0.5);
    expect(await dialog(page).evaluate((e) => getComputedStyle(e).overflowY)).toBe("auto");
    const close = (await dialog(page).locator(".modal-head button").first().boundingBox())!;
    expect(close.y).toBeGreaterThanOrEqual(0);
    expect(close.y + close.height).toBeLessThanOrEqual(VIEW_HEIGHT);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(ADD)).toBeFocused();
  } finally {
    await page.context().close();
  }
});

test("the dialog is centred at 1024 px", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1024, "#/repos");
  try {
    await expect(page.locator("#main")).toContainText(/No repositories yet/);
    await openAddDialog(page);
    const box = (await dialog(page).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 512)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - VIEW_HEIGHT / 2)).toBeLessThanOrEqual(1);
    expect(box.y).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(640);
  } finally {
    await page.context().close();
  }
});
