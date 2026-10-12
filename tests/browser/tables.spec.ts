import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, openAs, type Role } from "./helpers.js";
import { WIDTHS } from "./widths.js";

// UI quality 1c (#369): Runs, Repositories and Refinement are cards below 768 px; every other table scrolls in its own box.

const LONG_NAME = `acme/${"r".repeat(120)}`;
const LONG_WORD = "w".repeat(200);
const LONG_TEXT = "The step is waiting for somebody to decide what happens with this change ".repeat(4).trim();

interface CardPage {
  name: string;
  role: Role;
  hash: string;
  ready: string | RegExp;
  /** rewrites the list answer of the server so its first item has a very long repository name and status text */
  api: RegExp;
  stretch: (body: any) => void;
  /** the cell of the first row that holds the repository, and the one that holds the long status text */
  repoCell: string;
  textCell: string;
  long: string;
}

const PAGES: CardPage[] = [
  // Runs is not here any more: both run lists are sections of cards at every width (#378), see the tests at the end.
  {
    name: "Repositories", role: "user", hash: "#/repos", ready: "acme/app", api: /\/api\/repos(\?.*)?$/,
    stretch: (list: any[]) => { list[0].url = `https://github.com/${LONG_NAME}`; },
    repoCell: "td:nth-child(1)", textCell: "td:nth-child(3)", long: LONG_NAME,
  },
  {
    name: "Refinement", role: "user", hash: "#/refinement", ready: "Show the build status", api: /\/api\/refinement(\?.*)?$/,
    stretch: (body: any) => { body.sessions[0].repo = LONG_NAME; body.sessions[0].title = LONG_TEXT; },
    repoCell: "td:nth-child(2)", textCell: "td:nth-child(1)", long: LONG_NAME,
  },
];

const FIRST_ROW = "table.cards tbody tr";

async function open(browser: Parameters<typeof openAs>[0], p: CardPage, width: number, long = false, touch = false) {
  const page = await openAs(browser, p.role, width, p.hash, {
    touch,
    before: long
      ? async (pg) => {
        await pg.route(p.api, async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          p.stretch(body);
          await route.fulfill({ response: res, json: body });
        });
      }
      : undefined,
  });
  await expect(page.locator("#main")).toContainText(long ? p.long : p.ready, { timeout: 15_000 });
  return page;
}

for (const p of PAGES) {
  test(`${p.name}: rows are labelled cards at 360 px`, async ({ browser }) => {
    const page = await open(browser, p, 360);
    try {
      await expectNoSidewaysScroll(page);
      const info = await page.evaluate((sel) => {
        const table = document.querySelector("table.cards") as HTMLElement;
        const head = table.querySelector("thead") as HTMLElement;
        const hb = head.getBoundingClientRect();
        const headStyle = getComputedStyle(head);
        const row = document.querySelector(sel) as HTMLElement;
        const cells = [...row.querySelectorAll("td[data-label]")] as HTMLElement[];
        const shown = cells.filter((c) => c.getClientRects().length > 0);
        return {
          head: { w: hb.width, h: hb.height, position: headStyle.position, clip: headStyle.clipPath },
          headRowRole: head.querySelector("tr")!.getAttribute("role"),
          headersKept: [...head.querySelectorAll("th")].map((th) => th.textContent!.trim()),
          tableRole: table.getAttribute("role"),
          cells: shown.map((c) => ({ label: c.dataset.label!, content: getComputedStyle(c, "::before").content, display: getComputedStyle(c, "::before").display, top: c.getBoundingClientRect().top })),
          rowDisplay: getComputedStyle(row).display,
        };
      }, FIRST_ROW);
      // the header row is clipped to nothing, but stays in the accessibility tree
      expect(info.head.w).toBeLessThanOrEqual(1);
      expect(info.head.h).toBeLessThanOrEqual(1);
      expect(info.head.position).toBe("absolute");
      expect(info.head.clip).not.toBe("none");
      expect(info.headRowRole).toBe("row");
      expect(info.tableRole).toBe("table");
      expect(info.headersKept.length).toBeGreaterThan(2);
      expect(info.rowDisplay).not.toBe("table-row");
      expect(info.cells.length).toBeGreaterThan(2);
      for (const c of info.cells) {
        expect(c.content, c.label).toContain(c.label);
        expect(c.display, c.label).toBe("block");
      }
      // the first cell (the main link) is on top and the last one below it
      expect(info.cells[0]!.top).toBeLessThan(info.cells[info.cells.length - 1]!.top);
    } finally {
      await page.context().close();
    }
  });

  for (const width of WIDTHS.filter((w) => w >= 768)) {
    test(`${p.name}: stays a table at ${width} px`, async ({ browser }) => {
      const page = await open(browser, p, width);
      try {
        await expectNoSidewaysScroll(page);
        const info = await page.evaluate((sel) => {
          const row = document.querySelector(sel) as HTMLElement;
          const cell = row.querySelector("td[data-label]") as HTMLElement;
          return {
            headHeight: document.querySelector("table.cards thead tr")!.getBoundingClientRect().height,
            cellDisplay: getComputedStyle(cell).display,
            before: getComputedStyle(cell, "::before").content,
            rowDisplay: getComputedStyle(row).display,
          };
        }, FIRST_ROW);
        expect(info.headHeight).toBeGreaterThan(10);
        expect(info.cellDisplay).toBe("table-cell");
        expect(info.before).toBe("none");
        expect(info.rowDisplay).toBe("table-row");
      } finally {
        await page.context().close();
      }
    });
  }

  test(`${p.name}: a very long repository name and status text stay inside the viewport at 360 px`, async ({ browser }) => {
    const page = await open(browser, p, 360, true);
    try {
      const r = await page.evaluate(({ sel, repoSel, textSel, long }) => {
        // the row that carries the long name (on Runs a second table lists the runs that need you)
        const row = [...document.querySelectorAll(sel)].find((e) => e.textContent!.includes(long)) as HTMLElement;
        const box = row.closest(".table-box") as HTMLElement;
        const right = (e: Element | null) => (e ? e.getBoundingClientRect().right : -1);
        return {
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          boxScroll: box.scrollWidth,
          boxClient: box.clientWidth,
          row: right(row),
          repo: right(row.querySelector(repoSel)),
          text: right(row.querySelector(textSel)),
          cells: [...row.querySelectorAll("td")].map((c) => right(c)),
        };
      }, { sel: FIRST_ROW, repoSel: p.repoCell, textSel: p.textCell, long: p.long });
      expect(r.scroll).toBeLessThanOrEqual(r.client);
      // no sideways scroll inside the box either
      expect(r.boxScroll).toBeLessThanOrEqual(r.boxClient);
      expect(r.row).toBeLessThanOrEqual(360);
      expect(r.repo).toBeGreaterThan(0);
      expect(r.repo).toBeLessThanOrEqual(360);
      expect(r.text).toBeGreaterThan(0);
      expect(r.text).toBeLessThanOrEqual(360);
      for (const c of r.cells) expect(c).toBeLessThanOrEqual(360);
    } finally {
      await page.context().close();
    }
  });
}

test("Runs: Enter on the link of a card opens the run", async ({ browser }) => {
  const page = await open(browser, PAGES[0]!, 360);
  try {
    const link = page.locator(`${FIRST_ROW} td:first-child a`).first();
    await link.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/runs\/.+/);
  } finally {
    await page.context().close();
  }
});

test("Runs: a tap on a card opens the run, and the link is touch sized", async ({ browser }) => {
  const page = await open(browser, PAGES[0]!, 360, false, true);
  try {
    const box = await page.locator(`${FIRST_ROW} td:first-child a`).first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    await page.locator(`${FIRST_ROW} td:nth-child(2)`).first().tap();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/runs\/.+/);
  } finally {
    await page.context().close();
  }
});

test("Refinement: a tap on a card opens the session", async ({ browser }) => {
  const page = await open(browser, PAGES[2]!, 360, false, true);
  try {
    await page.locator(`${FIRST_ROW} td:nth-child(2)`).first().tap();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/refinement\/.+/);
  } finally {
    await page.context().close();
  }
});

test("Repositories: the repository is a link to GitHub, first in the card", async ({ browser }) => {
  const page = await open(browser, PAGES[1]!, 360);
  try {
    const link = page.locator(`${FIRST_ROW} td:first-child a.repo-link`);
    await expect(link).toHaveAttribute("href", "https://github.com/acme/app");
    await expect(link).toHaveAttribute("target", "_blank");
    await link.focus();
    await expect(link).toBeFocused();
  } finally {
    await page.context().close();
  }
});

test("My runs: the link comes first in the card and the parts are labelled at 360 px", async ({ browser }) => {
  const page = await openAs(browser, "user", 360, "#/runs");
  try {
    await expect(page.locator("#main")).toContainText("Seeded failed run");
    await expect(page.locator("ul.run-cards li").first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    const r = await page.evaluate(() => {
      const card = document.querySelector("ul.run-cards li") as HTMLElement;
      const link = card.querySelector(".run-link")!.getBoundingClientRect();
      const first = card.querySelector(".row")!;
      const others = [...first.children].filter((c) => !c.classList.contains("run-link")).map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0); // the "?" help text is hidden
      const labelled = [...card.querySelectorAll("[data-label]")].map((e) => ({ label: e.getAttribute("data-label")!, content: getComputedStyle(e, "::before").content }));
      return { link: { x: link.x, y: link.y }, others: others.map((o) => ({ x: o.x, y: o.y })), labelled };
    });
    // the status comes first: it is not after the link
    for (const o of r.others.slice(0, 1)) expect(o.y < r.link.y || (o.y === r.link.y && o.x <= r.link.x)).toBe(true);
    expect(r.labelled.length).toBeGreaterThan(0);
    for (const l of r.labelled) expect(l.content).toContain(l.label);
  } finally {
    await page.context().close();
  }
});

test("My runs: a very long status text wraps inside the card at 360 px", async ({ browser }) => {
  const page = await openAs(browser, "user", 360, "#/runs", {
    before: async (pg) => {
      await pg.route(/\/api\/runs(\?.*)?$/, async (route) => {
        const res = await route.fetch();
        const list = await res.json();
        if (list[0]?.next) list[0].next = { ...list[0].next, status: LONG_TEXT };
        await route.fulfill({ response: res, json: list });
      });
    },
  });
  try {
    await expect(page.locator("#main")).toContainText(LONG_TEXT.slice(0, 40), { timeout: 15_000 });
    await expectNoSidewaysScroll(page);
    const r = await page.evaluate((t) => {
      const pill = [...document.querySelectorAll("ul.run-cards .pill")].find((e) => e.textContent!.includes(t))!;
      const b = pill.getBoundingClientRect();
      return { right: b.right, white: getComputedStyle(pill).whiteSpace };
    }, LONG_TEXT.slice(0, 40));
    expect(r.white).toBe("normal");
    expect(r.right).toBeLessThanOrEqual(360);
  } finally {
    await page.context().close();
  }
});

// ---- the other tables scroll inside their own box ----

const BOXED: [string, string, boolean][] = [
  ["Users", "#/users", true],
  ["Models", "#/models", true],
  ["Overview", "#/operations", false],
  ["Dashboard", "#/dashboard", false],
  ["Problems", "#/problems", false],
  ["Watchers", "#/watchers", false],
  ["All repositories", "#/all-repos", false],
  ["Credentials", "#/credentials", false],
  ["Audit", "#/audit", false],
];

async function boxes(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll("#main table")].map((t) => {
    const box = t.closest(".table-box") as HTMLElement | null;
    return { boxed: !!box, parentIsBox: !!t.parentElement?.closest(".table-box"), overflow: box ? getComputedStyle(box).overflowX : "" };
  }));
}

test("every other table is in a .table-box that scrolls inside itself at 360 px", async ({ browser }) => {
  for (const [name, hash, required] of BOXED) {
    const page = await openAs(browser, "admin", 360, hash);
    try {
      await expect(page.locator("#main")).not.toBeEmpty();
      await expect(page.locator("#main h1").first()).toBeVisible();
      const tables = await boxes(page);
      if (required) expect(tables.length, `${name} has a table`).toBeGreaterThan(0);
      for (const t of tables) {
        expect(t.boxed, name).toBe(true);
        expect(["auto", "scroll"], name).toContain(t.overflow);
      }
      await expectNoSidewaysScroll(page);
      if (!tables.length) continue;
      // make the first table far wider than the screen: its box scrolls, the page does not
      const r = await page.evaluate(() => {
        const t = document.querySelector("#main .table-box table") as HTMLElement;
        t.style.minWidth = "1200px";
        const box = t.closest(".table-box") as HTMLElement;
        return { boxScroll: box.scrollWidth, boxClient: box.clientWidth, doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth };
      });
      expect(r.boxScroll, `${name}: the box scrolls`).toBeGreaterThan(r.boxClient);
      expect(r.doc, `${name}: the page does not`).toBeLessThanOrEqual(r.view);
    } finally {
      await page.context().close();
    }
  }
});

// ---- Runs: sections of cards at every width (#378) ----

for (const width of [360, 1280]) {
  test(`Runs: the admin cards show the status first and label Owner, Steps and Cost at ${width} px`, async ({ browser }) => {
    const page = await openAs(browser, "admin", width, "#/runs");
    try {
      await expect(page.locator("#main")).toContainText("Seeded failed run");
      await expectNoSidewaysScroll(page);
      const r = await page.evaluate(() => {
        const card = document.querySelector("ul.run-cards li") as HTMLElement;
        const pill = card.querySelector(".pill")!.getBoundingClientRect();
        const link = card.querySelector(".run-link")!.getBoundingClientRect();
        const fields = [...card.querySelectorAll(".run-field[data-label]")].map((e) => ({ label: e.getAttribute("data-label")!, content: getComputedStyle(e, "::before").content }));
        return { pillFirst: pill.y < link.y || (pill.y === link.y && pill.x <= link.x), fields };
      });
      expect(r.pillFirst).toBe(true);
      expect(r.fields.map((f) => f.label)).toEqual(expect.arrayContaining(["Owner", "Steps", "Cost"]));
      for (const f of r.fields) expect(f.content).toContain(f.label);
    } finally {
      await page.context().close();
    }
  });
}
