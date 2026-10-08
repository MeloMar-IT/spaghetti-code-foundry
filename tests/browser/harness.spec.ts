import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expectNoSidewaysScroll, openAs, openUrl, seed } from "./helpers.js";
import { BASELINE_DIR, GALLERY_URL, UPDATING } from "./paths.js";
import { FIXED_NOW, skipVisual } from "./visual-matrix.js";

test("expectNoSidewaysScroll passes on a page that fits", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage();
    await page.setContent("<p>ok</p>");
    await expectNoSidewaysScroll(page);
  } finally {
    await context.close();
  }
});

test("expectNoSidewaysScroll fails on a page that is too wide", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage();
    await page.setContent('<div style="width:2000px">x</div>');
    await expect(expectNoSidewaysScroll(page)).rejects.toThrow(/wide/);
  } finally {
    await context.close();
  }
});

test("openAs signs in the admin on the admin display", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1440);
  try {
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator("body")).not.toHaveClass(/signed-out/);
    await expect(page.locator("#account-name")).toHaveText("Test Admin");
  } finally {
    await page.context().close();
  }
});

test("openAs signs in the user on the user display at the given width", async ({ browser }) => {
  const page = await openAs(browser, "user", 360);
  try {
    expect(new URL(page.url()).pathname).toBe("/user/");
    await expect(page.locator("#account-name")).toHaveText("Ann");
    expect(page.viewportSize()?.width).toBe(360);
  } finally {
    await page.context().close();
  }
});

test("the seeded runs show in the admin's run list", async ({ browser }) => {
  const s = seed();
  const page = await openAs(browser, "admin", 1440, "#/runs");
  try {
    expect(s.runs.waiting).toBeTruthy();
    await expect(page.locator("#main")).toContainText("Seeded gate run");
    await expect(page.locator("#main")).toContainText("Seeded failed run");
  } finally {
    await page.context().close();
  }
});

test("theme and density reach the page before its scripts", async ({ browser }) => {
  const dark = await openAs(browser, "admin", 1440, "", { theme: "dark", density: "compact" });
  try {
    await expect(dark.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(dark.locator("html")).toHaveAttribute("data-density", "compact");
    expect(await dark.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  } finally {
    await dark.context().close();
  }
  const light = await openAs(browser, "admin", 1440, "", { theme: "light", density: "default" });
  try {
    await expect(light.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(light.locator("html")).not.toHaveAttribute("data-density", /.*/);
  } finally {
    await light.context().close();
  }
});

test("fixedNow fixes the clock", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1440, "", { theme: "light", fixedNow: FIXED_NOW });
  try {
    expect(await page.evaluate(() => Date.now())).toBe(Date.parse(FIXED_NOW));
  } finally {
    await page.context().close();
  }
});

// Same rule as visual.spec.ts; also not registered while updating, because the comparison would overwrite the baseline.
const canCompare = !UPDATING && !skipVisual(process.platform, existsSync(BASELINE_DIR), "none");

if (canCompare) test("a style change fails the screenshot comparison", async ({ browser }, info) => {
  const page = await openUrl(browser, GALLERY_URL, 1440, { theme: "light", density: "default", fixedNow: FIXED_NOW });
  try {
    await expect(page.locator("body")).toContainText("Visual system demo");
    await page.evaluate(() => document.fonts.ready);
    // the unchanged page matches this baseline in visual.spec.ts; here only the changed page is compared
    await page.addStyleTag({ content: ".table-box{background:#c00 !important} h1{font-size:40px !important}" });
    await expect(expect(page).toHaveScreenshot("gallery-light-default-1440.png")).rejects.toThrow();
    for (const part of ["expected", "actual", "diff"]) {
      expect(existsSync(join(info.outputDir, `gallery-light-default-1440-${part}.png`)), part).toBe(true);
    }
  } finally {
    await page.context().close();
  }
});
