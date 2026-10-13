import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import {
  apiAs, boardJson, card, clipped, expectBoardFits, expectNoSidewaysScroll, expectReadable, expectUsable, lengthen, openAs, seed, type Role,
} from "./helpers.js";
import { STRESS, type StressName } from "./widths.js";

// Long and large content at 360 px with touch: the seven items of STRESS. Every state ends with expectNoSidewaysScroll.
// The results are copied to "### Stress content at 360 px" in docs/ui-redesign/measurement.md.

const WIDTH = 360;
const TOUCH = { touch: true } as const;

const use = (page: Page, control: Locator) => expectUsable(page, control, TOUCH);

async function arrived(page: Page, content: Locator): Promise<void> {
  // a page that draws again (the run page, on every event) can replace the element between the two reads: look again
  await expect(async () => { await expectReadable(page, content); }).toPass({ timeout: 10_000 });
  await expectNoSidewaysScroll(page);
}

/** What is in #main once a page has drawn its data: the same texts as READY in navigation.spec.ts (a spec file cannot be imported). */
const PAGES: Record<Role, ReadonlyArray<{ hash: string; ready: string }>> = {
  admin: [
    { hash: "#/home", ready: "Seeded gate run" },
    { hash: "#/runs", ready: "Seeded failed run" },
    { hash: "#/repos", ready: "No repositories yet" },
    { hash: "#/refinement", ready: "Show the build status" },
    { hash: "#/start", ready: "gate" },
  ],
  user: [
    { hash: "#/home", ready: "Seeded failed run" },
    { hash: "#/runs", ready: "Seeded succeeded run" },
    { hash: "#/repos", ready: "acme/app" },
    { hash: "#/refinement", ready: "Show the build status" },
    { hash: "#/start", ready: "gate" },
  ],
};

const rightEdge = async (target: Locator): Promise<number> => {
  const box = await target.boundingBox();
  if (!box) throw new Error("the element has no box");
  return box.x + box.width;
};

/** The stress data of the large server; fails with a plain message when the launcher did not seed it. */
function stressData(): { statusRun: string; diffRun: string; repo: string } {
  const stress = seed("large").stress;
  if (!stress) throw new Error("the large server has no stress data");
  if (stress.repo.length !== 100) throw new Error(`the stress repository name has ${stress.repo.length} characters, expected 100`);
  return stress;
}

/** The repository name is shown in full, not clipped, and ends inside the window. */
async function expectNameShown(page: Page, where: Locator, name: string): Promise<void> {
  await expect(where).toHaveText(name);
  expect(await clipped(page, where, { strict: true }), "nothing of the name is clipped").toEqual([]);
  expect(await rightEdge(where), "the name ends inside the window").toBeLessThanOrEqual(WIDTH);
  await expectNoSidewaysScroll(page);
}

async function textOf(locator: Locator): Promise<string> {
  return locator.evaluate((e) => e.textContent ?? "");
}

/** The usable and visible `button, a.btn, select` under the scope. */
async function expectControlsUsable(page: Page, scope: string): Promise<void> {
  const controls = page.locator(`${scope} :is(button, a.btn, select)`);
  for (const control of await controls.all()) {
    if (await control.isVisible()) await use(page, control);
  }
}

/** The big run's log tab or diff tab. */
async function openTab(page: Page, tab: "log" | "diff"): Promise<void> {
  const button = page.locator(`button[data-tab="${tab}"]`);
  await use(page, button);
  await button.click();
}

const ITEMS: Record<StressName, (browser: Browser) => Promise<void>> = {
  "Repository name": async (browser) => {
    test.setTimeout(120_000);
    const stress = stressData();
    const name = stress.repo;

    // the run page (admin, large server)
    let page = await openAs(browser, "admin", WIDTH, `#/runs/${stress.statusRun}`, { large: true, ...TOUCH });
    try {
      const work = page.locator('#main dd[data-fact="work"]');
      await expect(work).toBeVisible({ timeout: 30_000 });
      await expectNameShown(page, work, name);
    } finally {
      await page.context().close();
    }

    // the Runs list (admin, large server), found through the search
    page = await openAs(browser, "admin", WIDTH, `#/runs?q=${encodeURIComponent("Stress seeded status run")}`, { large: true, ...TOUCH });
    try {
      const row = page.locator("li.run-card").filter({ has: page.locator(`a[data-focus="open-${stress.statusRun}"]`) });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expectNameShown(page, row.locator('[data-label="Repository"]'), name);
    } finally {
      await page.context().close();
    }

    // Repositories (user): the first repository carries the stress name, the shape of the answer stays
    page = await openAs(browser, "user", WIDTH, "#/repos", {
      ...TOUCH,
      before: async (p) => {
        await p.route((url) => url.pathname === "/api/repos", async (route) => {
          if (route.request().method() !== "GET") { await route.continue(); return; }
          const response = await route.fetch();
          const body: unknown = await response.json();
          const first: unknown = Array.isArray(body) ? body[0] : undefined;
          if (!Array.isArray(body) || typeof first !== "object" || first === null) { await route.fulfill({ response, json: body }); return; }
          await route.fulfill({ response, json: [{ ...first, github: name }, ...body.slice(1)] });
        });
      },
    });
    try {
      const cell = page.locator("#main td.repo-name").first();
      await expect(cell).toBeVisible();
      await expectNameShown(page, cell, name);
    } finally {
      await page.context().close();
    }
  },

  "Text 40 % longer": async (browser) => {
    test.setTimeout(180_000);
    for (const role of ["user", "admin"] as const) {
      for (const { hash, ready } of PAGES[role]) {
        // a fresh context per page: the router keeps some marked elements of #top (the title) between pages, so an old mark would hide unlengthened text
        const page = await openAs(browser, role, WIDTH, hash, TOUCH);
        try {
          await expect(page.locator("#main")).toContainText(ready);
          // a page that draws again replaces the text of #main (not of #top): lengthen each region on its own, right before its checks
          await expect(async () => {
            for (const scope of ["#top", "#main"]) {
              if ((await page.locator(`${scope} [data-lengthened]`).count()) === 0) await lengthen(page, scope);
              expect(await page.locator(`${scope} [data-lengthened]`).count(), `${scope} is lengthened on ${role} ${hash}`).toBeGreaterThan(0);
            }
            expect(await clipped(page, "#top, #main", { strict: true }), `clipped on ${role} ${hash}`).toEqual([]);
            await expectControlsUsable(page, "#top");
            await expectControlsUsable(page, "#main");
          }).toPass({ timeout: 20_000 });
          await expectNoSidewaysScroll(page);

          // the drawer with its links and buttons
          const menu = page.locator("#menu-btn");
          await use(page, menu);
          await menu.click();
          await expect(page.locator("body")).toHaveClass(/drawer-open/);
          await lengthen(page, "#side");
          expect(await clipped(page, "#side", { strict: true }), `drawer clipped on ${role} ${hash}`).toEqual([]);
          for (const link of await page.locator("#side a[data-nav]").all()) await use(page, link);
          await expectControlsUsable(page, "#side");
          await expectNoSidewaysScroll(page);
          await page.keyboard.press("Escape");
          await expect(page.locator("body")).not.toHaveClass(/drawer-open/);
          await expectNoSidewaysScroll(page);
        } finally {
          await page.context().close();
        }
      }
    }
  },

  "Status of 2,000 characters": async (browser) => {
    test.setTimeout(120_000);
    const stress = stressData();
    const api = await apiAs("admin", "large");
    let page: Page | undefined;
    try {
      const run: unknown = await (await api.send("GET", `/api/runs/${stress.statusRun}`)).json();
      const reason: unknown = typeof run === "object" && run !== null ? Reflect.get(run, "reason") : undefined;
      if (typeof reason !== "string") throw new Error("the run has no reason text");
      expect(reason.length, "the API keeps the reason in full").toBe(2000);

      page = await openAs(browser, "admin", WIDTH, `#/runs/${stress.statusRun}`, { large: true, ...TOUCH });
      const failure = page.locator(".card.next-step.failure");
      await expect(failure).toContainText("This run failed", { timeout: 30_000 });
      await arrived(page, failure.locator(".next-parts").first());
      await arrived(page, failure.locator("dl.meta").first());

      const summary = failure.locator('summary[data-focus="raw-details"]');
      await use(page, summary);
      await summary.click();
      const raw = failure.locator("details.raw pre");
      await expect(raw).toBeVisible();
      // not toHaveText: the reason ends with a space and Playwright normalises whitespace
      expect(await textOf(raw), "the raw details hold all 2,000 characters").toBe(reason);
      await arrived(page, raw);
      await arrived(page, failure);
    } finally {
      await page?.context().close();
      await api.close();
    }
  },

  "Log of 5,000 lines": async (browser) => {
    test.setTimeout(120_000);
    const page = await openAs(browser, "admin", WIDTH, "#/runs/ui-big-log", { large: true, ...TOUCH });
    try {
      await expect(page.locator("#main")).toContainText("Large seeded", { timeout: 30_000 });
      await openTab(page, "log");
      const log = page.locator("#main pre.log");
      const lines = log.locator("> span:not(.log-note)");
      await expect(lines).toHaveCount(2000, { timeout: 30_000 });
      await expect(log.locator(".log-note")).toHaveText("3000 earlier lines are not shown");
      await expect(lines.first()).toHaveText(/^line 3001 of the large log/);
      await expect(lines.last()).toHaveText(/^line 5000 of the large log/);
      expect(await rightEdge(log), "the log ends inside the window").toBeLessThanOrEqual(WIDTH);
      expect((await log.boundingBox())?.width ?? Infinity, "the log is not wider than the window").toBeLessThanOrEqual(WIDTH);
      await arrived(page, log);
    } finally {
      await page.context().close();
    }
  },

  "Large diff": async (browser) => {
    test.setTimeout(120_000);
    const stress = stressData();

    // 400 character lines: the diff scrolls inside its own box
    let page = await openAs(browser, "admin", WIDTH, `#/runs/${stress.diffRun}`, { large: true, ...TOUCH });
    try {
      await openTab(page, "diff");
      const diff = page.locator("#main pre.diff").first();
      await expect(diff).toContainText("wide line 20", { timeout: 30_000 });
      expect((await diff.boundingBox())?.width ?? Infinity, "the diff box is not wider than the window").toBeLessThanOrEqual(WIDTH);
      const sizes = await diff.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(sizes.scroll, "the lines are wider than the box").toBeGreaterThan(sizes.client);
      const end = await diff.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
        return { left: el.scrollLeft, client: el.clientWidth, scroll: el.scrollWidth, pageX: window.scrollX };
      });
      expect(end.left + end.client, "the diff scrolls to its end").toBeGreaterThanOrEqual(end.scroll - 1);
      expect(end.pageX, "the page itself did not scroll").toBe(0);
      await arrived(page, diff);
    } finally {
      await page.context().close();
    }

    // the big diff: show all lines
    page = await openAs(browser, "admin", WIDTH, "#/runs/ui-big-diff", { large: true, ...TOUCH });
    try {
      await openTab(page, "diff");
      const diff = page.locator("#main pre.diff").first();
      await expect(diff).toBeVisible({ timeout: 30_000 });
      await expectNoSidewaysScroll(page);
      const all = page.getByRole("button", { name: "Show all 2005 lines" });
      await use(page, all);
      await all.click();
      await expect(diff.locator(".add")).toHaveCount(1000, { timeout: 30_000 });
      await expect(diff.locator(".del")).toHaveCount(1000);
      await expectNoSidewaysScroll(page);
    } finally {
      await page.context().close();
    }
  },

  "Board with 30 cards": async (browser) => {
    const cards = Array.from({ length: 30 }, (_, i) => card(100 + i, `Story ${i + 1}`, "coding"));
    const page = await openAs(browser, "admin", WIDTH, "#/board", {
      ...TOUCH,
      before: async (p) => { await p.route("**/api/board", (r) => r.fulfill({ json: boardJson(cards) })); },
    });
    try {
      const pick = page.locator("#main .board-pick select");
      await use(page, pick);
      await pick.selectOption("coding");
      await expect(page.locator("#main .board-col:visible")).toHaveCount(1);
      await expect(page.locator("#main .board-col.coding .board-card")).toHaveCount(30);
      await use(page, page.locator('#main .board-col.coding a[data-focus="card-acme/app#129-issue"]'));
      await expectBoardFits(page);
      await expectNoSidewaysScroll(page);
    } finally {
      await page.context().close();
    }
  },

  "Tall dialog": async (browser) => {
    const api = await apiAs("user");
    const page = await openAs(browser, "user", WIDTH, "#/repos", TOUCH);
    try {
      await page.setViewportSize({ width: WIDTH, height: 480 });
      const before = await (await api.send("GET", "/api/repos")).json();
      const add = page.locator('[data-focus="add-toolbar"]');
      await use(page, add);
      await add.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expectNoSidewaysScroll(page);

      await dialog.locator('input[name="url"]').fill("https://example.com/acme/tall.git");
      await dialog.getByRole("button", { name: "Next", exact: true }).click();
      await dialog.locator('select[name="method"]').selectOption("https-token");
      const submit = dialog.getByRole("button", { name: "Add repository", exact: true });
      await expect(submit).toBeAttached();

      const sizes = await dialog.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(sizes.scroll, "the form is taller than the dialog at 480 px").toBeGreaterThan(sizes.client);
      const box = await dialog.boundingBox();
      expect(box?.y ?? -1, "the dialog starts inside the window").toBeGreaterThanOrEqual(0);
      expect((box?.y ?? Infinity) + (box?.height ?? Infinity), "the dialog ends inside the window").toBeLessThanOrEqual(480);
      await arrived(page, dialog);

      await use(page, dialog.locator(".modal-head button").first());
      await use(page, submit);
      await use(page, dialog.getByRole("button", { name: "Back", exact: true }));
      await expectNoSidewaysScroll(page);

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await (await api.send("GET", "/api/repos")).json(), "nothing was added").toEqual(before);
      await expectNoSidewaysScroll(page);
    } finally {
      await page.context().close();
      await api.close();
    }
  },
};

STRESS.forEach((name, i) => {
  test(`${i + 1} ${name} at 360 touch`, async ({ browser }) => {
    await ITEMS[name](browser);
  });
});
