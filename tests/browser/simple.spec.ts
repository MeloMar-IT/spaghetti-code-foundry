import { expect, test, type Page } from "@playwright/test";
import { asSimple, expectNoSidewaysScroll, expectUsable, openAs } from "./helpers.js";

/** The forbidden terms in the visible text of the whole page: shell, top bar and #main (the page's own list, so the two never differ). */
const forbiddenOnPage = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const { forbiddenIn } = (await import("/simple-words.js")) as { forbiddenIn(t: string): string[] };
    return forbiddenIn(document.body.innerText);
  });

test("My projects and the project page work at 375 px and by keyboard", async ({ browser }) => {
  const page = await openAs(browser, "user", 375, "#/home", { touch: true, before: asSimple });
  try {
    await expect(page.getByRole("heading", { name: "My projects", level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectUsable(page, page.locator("#main a.simple-big").first(), { touch: true });
    expect(await forbiddenOnPage(page)).toEqual([]);

    // Tab reaches the project link; Enter opens the project page.
    const link = page.locator("#main .simple-card h2 a").first();
    for (let i = 0; i < 40 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/repos\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "What you need to do" })).toBeVisible();
    await expectNoSidewaysScroll(page);
    for (const b of await page.locator("#main a.simple-big, #main summary").all()) await expectUsable(page, b, { touch: true });
    expect(await forbiddenOnPage(page)).toEqual([]);
  } finally {
    await page.context().close();
  }
});

test("the Bento tiles stack in one column on a phone, and the hero is dark", async ({ browser }) => {
  const page = await openAs(browser, "user", 375, "#/home?list=check", { touch: true, before: asSimple });
  try {
    await page.evaluate(() => document.documentElement.setAttribute("data-look", "bento"));
    await page.evaluate(() => dispatchEvent(new HashChangeEvent("hashchange")));
    const tiles = page.locator("#main .simple-home[data-layout='tiles'] > .simple-tile");
    await expect(tiles.first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    // one column: every tile has the same left edge and width, and each sits below the one before
    const boxes = await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, w: r.width, y: r.y })));
    expect(boxes.length).toBeGreaterThan(5);
    for (const [i, b] of boxes.entries()) {
      expect(Math.abs(b.x - boxes[0]!.x)).toBeLessThan(1);
      expect(Math.abs(b.w - boxes[0]!.w)).toBeLessThan(1);
      if (i) expect(b.y).toBeGreaterThan(boxes[i - 1]!.y);
    }
    // the hero is dark even under a light page
    const hero = await page.locator(".simple-tile-dark").evaluate((e) => {
      const lum = (c: string) => { const m = c.match(/\d+(\.\d+)?/g)!.map(Number); return 0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!; };
      const s = getComputedStyle(e);
      return { bg: lum(s.backgroundColor), fg: lum(s.color) };
    });
    expect(hero.bg).toBeLessThan(hero.fg);
  } finally {
    await page.context().close();
  }
});
