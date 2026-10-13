import { expect, test, type Page } from "@playwright/test";
import { boardJson, card, expectBoardFits, expectNoSidewaysScroll, openAs } from "./helpers.js";

/** The board on a narrow screen shows one column, chosen with a picker; from 768 px up all columns show. */

const CARDS = [
  card(5, "Five", "coding"),
  card(6, "Six", "done"),
  card(7, "Reviewing story", "reviewing"),
];
const BOARD = boardJson(CARDS);

const open = (browser: Parameters<typeof openAs>[0], width: number) =>
  openAs(browser, "admin", width, "#/board", { before: (p: Page) => p.route("**/api/board", (r) => r.fulfill({ json: BOARD })) });

test("360 px: one column at a time, chosen with the picker", async ({ browser }) => {
  const page = await open(browser, 360);
  try {
    await expect(page.locator("#main")).toContainText("Five");
    await expectNoSidewaysScroll(page);
    await expectBoardFits(page);
    const pick = page.locator("#main .board-pick select");
    await expect(pick).toBeVisible();
    await expect(pick).toHaveValue("coding");
    await expect(page.locator("#main .board-col").filter({ visible: true })).toHaveCount(1);
    await expect(page.locator("#main .board-col.coding")).toBeVisible();
    await pick.selectOption("done");
    await expect(page.locator("#main .board-col.done")).toBeVisible();
    await expect(page.locator("#main .board-col.coding")).toBeHidden();
    await expect(page.locator("#main .board-col.done")).toContainText("#6");
    await expectNoSidewaysScroll(page);
    await expectBoardFits(page);
  } finally {
    await page.context().close();
  }
});

for (const width of [768, 1024]) {
  test(`${width} px: no picker, all columns visible`, async ({ browser }) => {
    const page = await open(browser, width);
    try {
      await expect(page.locator("#main")).toContainText("Five");
      await expect(page.locator("#main .board-pick")).toBeHidden();
      await expect(page.locator("#main .board-col").filter({ visible: true })).toHaveCount(9);
    } finally {
      await page.context().close();
    }
  });
}
