import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, openAs } from "./helpers.js";

/** Below 768 px the administration pages are read-only and say why; from 768 px up they are as before. */

const NOTE = "Editing needs a wider screen (768 px or more).";

test("Users at 360 px: the notice, no change controls, the table stays", async ({ browser }) => {
  const page = await openAs(browser, "admin", 360, "#/users");
  try {
    await expect(page.locator("#level-note")).toBeVisible();
    await expect(page.locator("#level-note")).toHaveText(NOTE);
    await expect(page.locator("#main table")).toContainText("ann@example.com");
    await expect(page.getByRole("button", { name: "+ Add user" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Default limits" })).toHaveCount(0);
    await expectNoSidewaysScroll(page);
  } finally {
    await page.context().close();
  }
});

test("Users at 768 px: no notice, both buttons", async ({ browser }) => {
  const page = await openAs(browser, "admin", 768, "#/users");
  try {
    await expect(page.locator("#main table")).toContainText("ann@example.com");
    await expect(page.locator("#level-note")).toBeHidden();
    await expect(page.getByRole("button", { name: "+ Add user" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Default limits" })).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a crossing and back while a dialog is open keeps the dialog and its text", async ({ browser }) => {
  const page = await openAs(browser, "admin", 768, "#/users");
  try {
    await page.getByRole("button", { name: "+ Add user" }).click();
    const name = page.locator("#modal-root input[name=name]");
    await name.fill("Zed");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.setViewportSize({ width: 768, height: 800 });
    await expect(name).toHaveValue("Zed");
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-root")).toBeHidden();
    await expect(page.getByRole("button", { name: "+ Add user" })).toBeVisible();
    await expect(page.locator("#level-note")).toBeHidden();
  } finally {
    await page.context().close();
  }
});

test("a crossing during a pending save keeps the dialog busy, then redraws once it is done", async ({ browser }) => {
  const page = await openAs(browser, "admin", 768, "#/users");
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route("**/api/users", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await gate;
      return route.fulfill({ status: 201, json: { user: { id: "new1", name: "Zed", email: "zed@example.com", role: "user", status: "active", runs: 0, hasPassword: false }, token: "A".repeat(43) } });
    });
    await page.getByRole("button", { name: "+ Add user" }).click();
    await page.locator("#modal-root input[name=name]").fill("Zed");
    await page.locator("#modal-root input[name=email]").fill("zed@example.com");
    await page.locator("#modal-root").getByRole("button", { name: "Add user" }).click();
    await expect(page.locator("#modal-root").getByRole("button", { name: "Add user" })).toBeDisabled();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(page.locator("#modal-root input[name=name]")).toBeVisible();
    await expect(page.locator("#modal-root input[name=name]")).toHaveValue("Zed");
    release();
    await expect(page.locator("#modal-root")).toContainText("This link works once");
    await page.locator("#modal-root").getByRole("button", { name: "Done" }).click();
    await expect(page.locator("#modal-root")).toBeHidden();
    await expect(page.locator("#level-note")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add user" })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("a crossing while a dialog is open keeps the dialog and redraws after it closes", async ({ browser }) => {
  const page = await openAs(browser, "admin", 768, "#/users");
  try {
    await page.getByRole("button", { name: "+ Add user" }).click();
    const name = page.locator("#modal-root input[name=name]");
    await name.fill("Zed");
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(name).toHaveValue("Zed");
    await expect(page.locator("#modal-root input[name=name]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#level-note")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add user" })).toHaveCount(0);
    await page.setViewportSize({ width: 768, height: 800 });
    await expect(page.getByRole("button", { name: "+ Add user" })).toBeVisible();
    await expect(page.locator("#level-note")).toBeHidden();
  } finally {
    await page.context().close();
  }
});
