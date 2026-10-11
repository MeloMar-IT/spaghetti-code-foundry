import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, openAs } from "./helpers.js";

/** The board on a narrow screen shows one column, chosen with a picker; from 768 px up all columns show. */

const COLUMNS = [
  ["your_turn", "Your turn"], ["waiting", "Waiting for another story"], ["queued", "Queued"], ["planning", "Planning"], ["coding", "Coding"],
  ["reviewing", "Reviewing"], ["merging", "Merging"], ["done", "Done"], ["failed", "Failed"],
] as const;

const card = (issue: number, title: string, column: string) => ({ key: `acme/app#${issue}`, issue, title, column, next: { text: "A long sentence that tells what happens next with this story, so the card is wide enough to matter." }, after: [], chain: [] });
const CARDS = [
  card(5, "Five", "coding"),
  card(6, "Six", "done"),
  card(7, "Reviewing story", "reviewing"),
];
const BOARD = { repos: [{ repo: "acme/app", columns: COLUMNS.map(([id, title]) => ({ id, title, cards: CARDS.filter((c) => c.column === id) })) }] };

const open = (browser: Parameters<typeof openAs>[0], width: number) =>
  openAs(browser, "admin", width, "#/board", { before: (p: Page) => p.route("**/api/board", (r) => r.fulfill({ json: BOARD })) });

/** The board's own scroll box is not wider than itself: the document check cannot see inside it. */
async function expectBoardFits(page: Page) {
  const { scroll, client } = await page.evaluate(() => {
    const el = document.querySelector(".board")!;
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(scroll, `the board is ${scroll} px wide in a ${client} px box`).toBeLessThanOrEqual(client);
}

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
