import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, openAs, seed } from "./helpers.js";

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
