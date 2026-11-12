import { expect, test, type Page } from "@playwright/test";
import { asSimple, expectNoSidewaysScroll, openAs, type Role } from "./helpers.js";
import { VIEW_HEIGHT, WIDTHS, usesDrawer } from "./widths.js";

// Redesign 8 (#847): the shell, Start work and a change page at 375 px in each view and theme, by keyboard, in plain words.
const VIEWS: { name: string; role: Role; simple: boolean }[] = [
  { name: "admin", role: "admin", simple: false },
  { name: "advanced", role: "user", simple: false },
  { name: "simple", role: "user", simple: true },
];

for (const view of VIEWS) {
  for (const theme of ["light", "dark"] as const) {
    test(`the shell, Start work and a change at 375 px, ${view.name} view, ${theme}, by keyboard`, async ({ browser }) => {
      const page = await openAs(browser, view.role, 375, "#/home", { theme, before: view.simple ? asSimple : undefined });
      try {
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(theme === "dark");
        await expectNoSidewaysScroll(page);

        // The drawer: Enter opens it, Tab stays inside (forward from the last control, back from the first), Escape returns to the button.
        const menu = page.locator("#menu-btn");
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#side")).toBeVisible();
        const inSide = () => page.evaluate(() => !!document.activeElement?.closest("#side"));
        expect(await inSide()).toBe(true);
        await page.keyboard.press("Shift+Tab");
        expect(await inSide(), "Shift+Tab from the first control").toBe(true);
        for (let i = 0; i < 20; i++) {
          await page.keyboard.press("Tab");
          expect(await inSide(), `Tab ${i + 1}`).toBe(true);
        }
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();

        // The words of the shell: "change", never "story" or "issue" (the GitHub name is allowed).
        const words = await page.evaluate(async () => {
          const { oldWordsIn } = await import("/change-words.js");
          return oldWordsIn(`${(document.getElementById("side") as HTMLElement).innerText} ${(document.getElementById("top") as HTMLElement).innerText}`);
        });
        expect(words).toEqual([]);

        // Start work: Tab reaches the box for the change.
        await page.goto(page.url().replace(/#.*$/, "") + "#/start");
        const box = page.getByLabel("What would you like to change?").first();
        await expect(box).toBeVisible();
        let reached = false;
        for (let i = 0; i < 40 && !reached; i++) {
          await page.keyboard.press("Tab");
          reached = await box.evaluate((el) => el === document.activeElement);
        }
        expect(reached, "Tab reaches the box").toBe(true);
        await expectNoSidewaysScroll(page);

        // A change page has the five phases and does not scroll sideways (not in the Simple view, which has its own project page).
        if (!view.simple) {
          await page.goto(page.url().replace(/#.*$/, "") + "#/runs");
          const row = page.locator("#main a[href^='#/runs/']").first();
          await expect(row).toBeVisible();
          await row.focus();
          await page.keyboard.press("Enter");
          const strip = page.locator("ol.scf-phase-strip").first();
          await expect(strip).toBeVisible();
          expect((await strip.boundingBox())!.width).toBeLessThanOrEqual(375);
          await expectNoSidewaysScroll(page);
        }
      } finally {
        await page.context().close();
      }
    });
  }
}

// UI quality 1b (#368): no sideways scroll, 44 px touch targets, and dialogs that are sheets below 768 px.

const PAGES: [string, string, string | RegExp][] = [
  ["Home", "#/home", "Seeded gate run"],
  ["Runs", "#/runs", "Seeded failed run"],
  ["Start work", "#/start", "gate"],
  ["Repositories", "#/repos", /No repositories yet/],
  ["Autonomy", "#/autonomy", /Repositories/],
  ["Epics", "#/epics", /Epics|epic/i],
  ["Refinement", "#/refinement", /Refinement/i],
  ["Setup check", "#/setup", /Setup check/],
  ["Help", "#/help", /Help/i],
];

/** No table box scrolls inside itself: `expectNoSidewaysScroll` looks at the document only, and a `.table-box` can scroll on its own. */
async function expectNoBoxScroll(page: Page): Promise<void> {
  const wide = await page.evaluate(() => [...document.querySelectorAll(".table-box")]
    .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className} ${e.scrollWidth}>${e.clientWidth}`));
  expect(wide, "a table box scrolls sideways").toEqual([]);
}

test("no sideways scroll at 375 px in the Advanced view, also in the compact Changes table", async ({ browser }) => {
  const PAGES_375: [string, string | RegExp][] = [
    ["#/runs", "Seeded succeeded run"], ["#/epics", /Epics|epic/i], ["#/repos", "acme/app"],
    ["#/refinement", /Refinement/i], ["#/setup", /Setup check/], ["#/help", /Help/i],
  ];
  for (const [hash, text] of PAGES_375) {
    const page = await openAs(browser, "user", 375, hash);
    try {
      await expect(page.locator("#main"), hash).toContainText(text);
      await expectNoSidewaysScroll(page);
      await expectNoBoxScroll(page);
      if (hash === "#/runs") {
        await page.evaluate(() => localStorage.setItem("scf-runs-density", "compact"));
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("#main")).toContainText(text);
        await expect(page.locator("#main table.run-table").first()).toBeVisible();
        await expectNoSidewaysScroll(page);
        await expectNoBoxScroll(page);
      }
    } finally {
      await page.context().close();
    }
  }
});

test("the compact Changes table does not scroll sideways at 360 px for the admin", async ({ browser }) => {
  const page = await openAs(browser, "admin", 360, "#/runs");
  try {
    await page.evaluate(() => localStorage.setItem("scf-runs-density", "compact"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#main")).toContainText("Seeded failed run");
    await expect(page.locator("#main table.run-table").first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectNoBoxScroll(page);
  } finally {
    await page.context().close();
  }
});

const TARGETS ='button, a.btn, a[data-nav], .brand, select, textarea, summary, input:not([type=checkbox]):not([type=radio]):not([type=hidden])';
const ADD = '[data-focus="add-toolbar"]'; // the empty page also has an "+ Add repository" button in its empty state
const dialog =(page: Page) => page.locator('[role="dialog"]');

async function openAddDialog(page: Page) {
  await page.locator(ADD).click();
  await expect(dialog(page)).toBeVisible();
}

for (const width of WIDTHS) {
  test(`no sideways scroll at ${width} px`, async ({ browser }) => {
    for (const [name, hash, text] of PAGES) {
      const page = await openAs(browser, "admin", width, hash);
      try {
        await expect(page.locator("#main"), name).toContainText(text);
        await expectNoSidewaysScroll(page);
        if (width < 768) await expectNoBoxScroll(page);
        if (name === "Repositories") {
          await openAddDialog(page);
          await expectNoSidewaysScroll(page);
        }
      } finally {
        await page.context().close();
      }
    }
  });

  test(`log and diff stay in their own box at ${width} px`, async ({ browser }) => {
    test.setTimeout(120_000);
    const log = await openAs(browser, "admin", width, "#/runs/ui-big-log", { large: true });
    try {
      await expect(log.locator("#main")).toContainText("Large seeded log run", { timeout: 30_000 });
      await log.locator('button[data-tab="details"]').click();
      await log.locator('#main [data-section="log"] > summary').click();
      await expect(log.locator("#main pre.log")).toBeVisible({ timeout: 30_000 });
      await expectNoSidewaysScroll(log);
      expect(await log.locator("pre.log").evaluate((e) => e.clientWidth)).toBeLessThanOrEqual(width);
    } finally {
      await log.context().close();
    }
    const diff = await openAs(browser, "admin", width, "#/runs/ui-big-diff", { large: true });
    try {
      await expect(diff.locator("#main")).toContainText("Large seeded diff run", { timeout: 30_000 });
      await diff.locator('button[data-tab="diff"]').click();
      await expect(diff.locator("#main pre.diff")).toBeVisible({ timeout: 30_000 });
      await expectNoSidewaysScroll(diff);
      expect(await diff.locator("pre.diff").first().evaluate((e) => e.clientWidth)).toBeLessThanOrEqual(width);
    } finally {
      await diff.context().close();
    }
  });

  test(`touch targets are 44 px at ${width} px`, async ({ browser }) => {
    const page = await openAs(browser, "admin", width, "#/repos", { touch: true });
    try {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the touch profile is coarse").toBe(true);
      await expect(page.locator("#main")).toContainText(/No repositories yet/);
      if (usesDrawer(width)) await page.locator("#menu-btn").click();
      const tooSmall = async (scope: string): Promise<string[]> => {
        const found: string[] = [];
        for (const el of await page.locator(`${scope} :is(${TARGETS})`).all()) {
          if (!(await el.isVisible())) continue;
          const box = await el.boundingBox();
          if (!box || box.width <= 0) continue;
          if (box.width < 43.5 || box.height < 43.5) found.push(`${scope} ${await el.evaluate((e) => e.outerHTML.slice(0, 80))}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        return found;
      };
      expect([...(await tooSmall("#top")), ...(await tooSmall("#side"))]).toEqual([]);
      if (usesDrawer(width)) await page.keyboard.press("Escape");
      await openAddDialog(page);
      expect(await tooSmall('[role="dialog"]')).toEqual([]);
      // neighbouring targets in the dialog are at least 8 px apart
      const close = await page.evaluate((sel) => {
        const boxes = [...document.querySelectorAll(`[role="dialog"] :is(${sel})`)].map((e) => ({ r: e.getBoundingClientRect(), n: e.outerHTML.slice(0, 60) })).filter((b) => b.r.width > 0);
        const out: string[] = [];
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!.r, b = boxes[j]!.r;
          const gapX = Math.max(b.left - a.right, a.left - b.right), gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
          if (Math.max(gapX, gapY) < 7.5) out.push(`${boxes[i]!.n} / ${boxes[j]!.n}`);
        }
        return out;
      }, TARGETS);
      expect(close, "targets closer than 8 px").toEqual([]);
      await expectNoSidewaysScroll(page);
    } finally {
      await page.context().close();
    }
  });
}

test("the dialog is a bottom sheet at 360 px", async ({ browser }) => {
  const page = await openAs(browser, "admin", 360, "#/repos");
  try {
    await expect(page.locator("#main")).toContainText(/No repositories yet/);
    await openAddDialog(page);
    const box = (await dialog(page).boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBe(360);
    expect(Math.abs(box.y + box.height - VIEW_HEIGHT)).toBeLessThanOrEqual(1);
    expect(box.height).toBeLessThanOrEqual(0.9 * VIEW_HEIGHT + 0.5);
    expect(await dialog(page).evaluate((e) => getComputedStyle(e).overflowY)).toBe("auto");
    const close = (await dialog(page).locator(".modal-head button").first().boundingBox())!;
    expect(close.y).toBeGreaterThanOrEqual(0);
    expect(close.y + close.height).toBeLessThanOrEqual(VIEW_HEIGHT);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator(ADD)).toBeFocused();
  } finally {
    await page.context().close();
  }
});

test("the dialog is centred at 1024 px", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1024, "#/repos");
  try {
    await expect(page.locator("#main")).toContainText(/No repositories yet/);
    await openAddDialog(page);
    const box = (await dialog(page).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 512)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - VIEW_HEIGHT / 2)).toBeLessThanOrEqual(1);
    expect(box.y).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(640);
  } finally {
    await page.context().close();
  }
});
