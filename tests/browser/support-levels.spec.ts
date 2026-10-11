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

const FLOW_NOTE = "Editing a flow needs a wider screen (1024 px or more)";

test("a flow at 768 px: view and test run only", async ({ browser }) => {
  const page = await openAs(browser, "admin", 768, "#/flows/gate");
  try {
    await expect(page.locator("#level-note")).toBeVisible();
    await expect(page.locator("#level-note")).toContainText(FLOW_NOTE);
    await expect(page.getByRole("button", { name: "Test run" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
    await expect(page.locator(".insert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "+ Blank flow" })).toHaveCount(0);
    await page.locator("[data-step='1']").click();
    await expect(page.locator("#step-1")).toBeVisible();
    await expectNoSidewaysScroll(page);
  } finally {
    await page.context().close();
  }
});

test("a flow at 1024 px: as before", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1024, "#/flows/gate");
  try {
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    await expect(page.locator(".insert")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Blank flow" })).toBeVisible();
    await expect(page.locator("#level-note")).toBeHidden();
  } finally {
    await page.context().close();
  }
});

test("a flow with unsaved text keeps it across 1024 px, down and up", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1024, "#/flows/gate");
  try {
    await page.getByRole("button", { name: "YAML" }).click();
    const area = page.locator("textarea.yaml-editor");
    await area.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n# typed here");
    const typed = await area.inputValue();
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(area).toHaveAttribute("readonly", "");
    await expect(area).toHaveValue(typed);
    await expect(page.locator("#level-note")).toContainText("unsaved changes are kept");
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(page.locator("textarea.yaml-editor")).toHaveValue(typed);
  } finally {
    await page.context().close();
  }
});

test("variables show a name next to a value in both inspectors", async ({ browser }) => {
  const yaml = [
    "name: kv-demo", "workspace: empty", "vars:", "  alpha: \"1\"", "  beta: \"2\"", "steps:",
    "  - {id: sub, type: flow, flow: gate, vars: {one: a, two: b}}", "",
  ].join("\n");
  // The seed is not changed: the flow is answered by the test.
  const page = await openAs(browser, "admin", 800, "#/flows/kv-demo", {
    before: async (p) => {
      await p.route("**/api/flows/kv-demo", (route) => (route.request().method() === "GET"
        ? route.fulfill({ json: { name: "kv-demo", scope: "repo", yaml } })
        : route.fallback()));
    },
  });
  try {
    const grid = async (box: string) => {
      const kv = page.locator(`${box} .kv`);
      await expect(kv).toBeVisible();
      await expect(kv.locator("button")).toHaveCount(0);
      const inputs = kv.locator("input");
      await expect(inputs).toHaveCount(4);
      const at = async (i: number) => (await inputs.nth(i).boundingBox())!;
      const [n1, v1, n2, v2] = [await at(0), await at(1), await at(2), await at(3)];
      expect(Math.abs(n1.y - v1.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(n2.y - v2.y)).toBeLessThanOrEqual(2);
      expect(n1.x).toBeLessThan(v1.x);
      expect(n2.x).toBeLessThan(v2.x);
      expect(n2.y).toBeGreaterThan(n1.y);
    };
    await grid("#flow-settings");
    await page.locator("[data-step='0']").click();
    await grid("#step-0");
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
