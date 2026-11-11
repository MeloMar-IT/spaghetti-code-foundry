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

test("the list layout fits 375 px with long text, in Midnight and Editorial", async ({ browser }) => {
  const page = await openAs(browser, "user", 375, "#/home", { touch: true, before: asSimple });
  try {
    await expect(page.locator("#main .simple-home")).toBeVisible();
    for (const look of ["midnight", "editorial"]) {
      // A fixed model: three things that need the person and three that are being built, with very long words.
      const drawn = await page.evaluate(async (l) => {
        const { drawLayout } = (await import("/simple-home.js")) as { drawLayout(m: unknown, layout: string): Node[] };
        document.documentElement.setAttribute("data-look", l);
        const long = "Averyveryverylongwordwithoutanybreaksatall".repeat(3);
        const item = (i: number) => ({ id: `i${i}`, title: `${long} ${i}`, sentence: long, action: { label: "Open", href: `#/repos/r${i}`, external: false }, cause: long, runHref: null, owner: "", tag: ["question", "check", "stuck"][i % 3] });
        const build = (i: number) => ({ id: `b${i}`, title: `${long} ${i}`, phase: { index: i }, line: long, href: `#/repos/r${i}` });
        const model = {
          counters: ["check", "building", "ready", "published-week"].map((key) => ({ key, label: long, count: 3, href: `#/home?list=${key}` })),
          attention: [0, 1, 2].map(item), building: [0, 1, 2].map(build), list: "", lists: {}, project: null,
        };
        const main = document.querySelector("#main")!;
        main.replaceChildren(...drawLayout(model, "list"));
        return { rows: main.querySelectorAll(".simple-row").length, columns: main.querySelectorAll(".simple-column").length };
      }, look);
      expect(drawn).toEqual({ rows: 3, columns: 3 });
      await expect(page.locator("#main .simple-home[data-layout='list']")).toBeVisible();
      await expectNoSidewaysScroll(page);
      const xs = await page.locator("#main .simple-column").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
      expect(new Set(xs).size).toBe(1);
      const rowXs = await page.locator("#main .simple-row h3").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
      expect(new Set(rowXs).size).toBe(1);
    }
  } finally {
    await page.context().close();
  }
});
