import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, expectUsable, openAs } from "./helpers.js";

/**
 * The Simple view at 375 px. The shared seed account is never changed: the page's own GET /api/session answer is
 * edited on the way (view = simple), so only this page sees the Simple view.
 */
async function asSimple(page: Page): Promise<void> {
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { user: Record<string, unknown> };
    body.user = { ...body.user, view: "simple" };
    await route.fulfill({ response: res, json: body });
  });
}

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
