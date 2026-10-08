import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openAs, openUrl, seed } from "./helpers.js";
import { BASELINE_DIR, GALLERY_URL, UPDATING } from "./paths.js";
import { FIXED_NOW, noBaselinesMessage, skipVisual, visualCases } from "./visual-matrix.js";

// No baseline folder (or not darwin): the visual tests are not registered, and this says why.
const off = skipVisual(process.platform, existsSync(BASELINE_DIR), UPDATING ? "all" : "none");
if (off && process.env.TEST_WORKER_INDEX === undefined) console.log(noBaselinesMessage(process.platform));

for (const c of off ? [] : visualCases()) {
  test(`visual: ${c.name}`, async ({ browser }) => {
    const s = seed();
    const opts = { theme: c.theme, density: c.density, fixedNow: FIXED_NOW };
    const def = c.page;
    const page =
      def.kind === "display" ? await openAs(browser, def.role!, c.width, def.hash(s), opts)
      : def.kind === "signin" ? await openUrl(browser, s.url + "/", c.width, opts)
      : await openUrl(browser, GALLERY_URL, c.width, opts);
    try {
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-theme", c.theme);
      if (c.density === "compact") await expect(html).toHaveAttribute("data-density", "compact");
      else await expect(html).not.toHaveAttribute("data-density", /.*/);
      const root = page.locator(def.kind === "display" ? "#main" : "body");
      for (const text of def.ready) await expect(root).toContainText(text);
      // the health chip is loaded after the page and shows in the header of every admin page
      if (def.role === "admin") await expect(page.locator("#health-btn")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${c.name}.png`, { mask: def.masks(s).map((sel) => page.locator(sel)) });
    } finally {
      await page.context().close();
    }
  });
}
