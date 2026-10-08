import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, navFor, openAs, type Role } from "./helpers.js";
import { WIDTHS, usesDrawer } from "./widths.js";

/**
 * What is in #main once a page has drawn its data (the router sets aria-current before the page draws, so that alone is not enough).
 * A page that draws late is the one that can make the document wider, so the width is only checked after this text is there.
 */
const READY: Record<Role, Record<string, string | RegExp>> = {
  admin: {
    home: "Seeded gate run",
    board: "acme/app",
    refinement: "Show the build status",
    runs: "Seeded failed run",
    repos: /No repositories yet/,
    flows: "Welcome to Spaghetti Code Foundry",
    administration: "ann@example.com",
    start: "gate",
  },
  user: {
    runs: "Seeded succeeded run",
    repos: "acme/app",
    refinement: "Show the build status",
    start: "gate",
  },
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ready = (page: Page, role: Role, id: string) => expect(page.locator("#main")).toContainText(READY[role][id]!);

/** Where a link must be: fully inside the window sideways. */
async function expectInside(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, `${selector} has a box`).not.toBeNull();
  expect(box!.x, `${selector} starts inside the window`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${selector} ends inside the window`).toBeLessThanOrEqual(width);
}

for (const role of ["admin", "user"] as const) {
  for (const width of WIDTHS) {
    test(`${role} display at ${width} px: every primary link works without sideways scroll`, async ({ browser }) => {
      // A case that fails for real is marked here, with the measured width and a pointer to part 1b.
      test.fixme(role === "admin" && width === 360, "sideways scroll at 360 px (486 px wide on Home, 671 px on Administration > Users) — fixed in UI quality 1b (part 2 of #264)");
      test.fixme(role === "admin" && width === 768, "sideways scroll at 768 px (887 px wide on Administration > Users) — fixed in UI quality 1b (part 2 of #264)");
      const drawer = usesDrawer(width);
      const page = await openAs(browser, role, width);
      try {
        await expectNoSidewaysScroll(page);
        const { primary, actions } = await navFor(role);
        const hrefs = await page.locator("#side a[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
        expect(hrefs, "the links in the page match ui/ia.js").toEqual(primary.map((p) => p.href));

        for (const p of primary) {
          const link = page.locator(`#side a[data-nav="${p.id}"]`);
          if (drawer) {
            await expect(link).toBeHidden();
            await page.locator("#menu-btn").click();
            await expect(page.locator("body")).toHaveClass(/drawer-open/);
            await expect(page.locator("#menu-btn")).toHaveAttribute("aria-expanded", "true");
            await expect(page.locator("#scrim")).toBeVisible();
            await expectNoSidewaysScroll(page);
          } else {
            await expect(page.locator("#side")).toBeVisible();
          }
          await expect(link).toBeVisible();
          const box = await link.boundingBox();
          expect(box, `${p.label} has a box`).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          await link.click();
          await expect(page).toHaveURL(new RegExp(escape(p.href) + "$"));
          await expect(link).toHaveAttribute("aria-current", /page|true/);
          if (drawer) {
            await expect(page.locator("body")).not.toHaveClass(/drawer-open/);
            await expect(page.locator("#scrim")).toBeHidden();
            await expect(page.locator("#menu-btn")).toHaveAttribute("aria-expanded", "false");
          }
          await ready(page, role, p.id);
          await expectNoSidewaysScroll(page);
        }

        for (const a of actions) {
          const action = `#top-actions a[data-nav="${a.id}"]`;
          await expect(page.locator(action)).toBeVisible();
          await expectInside(page, action);
          await page.locator(action).click();
          await expect(page).toHaveURL(new RegExp(escape(a.href) + "$"));
          await ready(page, role, a.id);
          await expectNoSidewaysScroll(page);
        }
      } finally {
        await page.context().close();
      }
    });
  }
}
