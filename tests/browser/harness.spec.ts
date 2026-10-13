import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clipped, expectNoSidewaysScroll, expectReadable, expectUsable, lengthen, openAs, openUrl, seed } from "./helpers.js";
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

async function withContent(browser: Browser, html: string, fn: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  try {
    const page = await context.newPage();
    await page.setContent("<!doctype html><style>body{margin:0}</style>" + html);
    await fn(page);
  } finally {
    await context.close();
  }
}

const ROWS = (n: number): string => Array.from({ length: n }, () => '<p style="margin:0;height:40px">row</p>').join("");
const LONG = "a long line of text that does not fit in the box";
const BAR = '<div id="bar" style="position:fixed;left:0;right:0;bottom:0;height:60px;background:#000"></div>';
const scrolls = (page: Page): Promise<number[]> => page.evaluate(() => [window.scrollY, document.querySelector("#s")?.scrollTop ?? 0]);

test("withContent gives a standards-mode page of 360 × 800", async ({ browser }) => {
  await withContent(browser, "<p>ok</p>", async (page) => {
    expect(await page.evaluate(() => [document.compatMode, document.documentElement.clientWidth, document.documentElement.clientHeight])).toEqual(["CSS1Compat", 360, 800]);
  });
});

test("expectUsable passes on a 48 px button", async ({ browser }) => {
  await withContent(browser, '<button id="b" style="width:48px;height:48px">Go</button>', async (page) => {
    await expectUsable(page, page.locator("#b"), { touch: true });
  });
});

test("expectUsable rejects a covered button", async ({ browser }) => {
  const html = '<button id="b" style="width:48px;height:48px">Go</button><div id="cover" style="position:fixed;inset:0;background:#000"></div>';
  await withContent(browser, html, async (page) => {
    await expect(expectUsable(page, page.locator("#b"), { touch: true })).rejects.toThrow(/covered by div#cover/);
  });
});

test("expectUsable rejects a button outside the viewport", async ({ browser }) => {
  const html = '<button id="b" style="position:absolute;left:400px;top:20px;width:48px;height:48px">Go</button>';
  await withContent(browser, html, async (page) => {
    await expect(expectUsable(page, page.locator("#b"))).rejects.toThrow(/outside the viewport/);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
  });
});

test("expectUsable wants 44 px only with touch", async ({ browser }) => {
  await withContent(browser, '<button id="b" style="width:30px;height:30px;padding:0">x</button>', async (page) => {
    await expect(expectUsable(page, page.locator("#b"), { touch: true })).rejects.toThrow(/44 × 44/);
    await expectUsable(page, page.locator("#b"));
  });
});

test("expectReadable passes on a tall box", async ({ browser }) => {
  await withContent(browser, '<div id="t"><p>start</p><div style="height:2000px"></div><p>end</p></div>', async (page) => {
    await expectReadable(page, page.locator("#t"));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test("expectReadable passes on a reachable scroll box", async ({ browser }) => {
  await withContent(browser, `<div id="t" style="height:400px;overflow:auto">${ROWS(30)}</div>`, async (page) => {
    await expectReadable(page, page.locator("#t"));
    expect(await page.evaluate(() => document.querySelector("#t")?.scrollTop)).toBe(0);
  });
});

test("expectReadable rejects a box wider than the viewport", async ({ browser }) => {
  await withContent(browser, '<div id="t" style="width:500px">wide</div>', async (page) => {
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/500 px wide in a 360 px viewport/);
  });
});

test("expectReadable rejects text cut by overflow: hidden", async ({ browser }) => {
  await withContent(browser, `<div id="t" style="width:100px;overflow:hidden;white-space:nowrap">${LONG}</div>`, async (page) => {
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/cut off in div#t/);
    expect(await clipped(page, "#t")).toEqual(["div#t"]);
  });
});

test("expectReadable rejects ellipsis text before a readable end", async ({ browser }) => {
  const html = `<div id="t"><p id="e" style="margin:0;width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${LONG}</p><p>end</p></div>`;
  await withContent(browser, html, async (page) => {
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/cut off in p#e/);
    expect(await clipped(page, "#t")).toEqual([]);
    expect(await clipped(page, page.locator("#t"), { strict: true })).toEqual(["p#e"]);
  });
});

test("expectReadable rejects a scroll box whose end stays under a fixed bar", async ({ browser }) => {
  await withContent(browser, `<div id="t" style="height:800px;overflow:auto">${ROWS(40)}</div>${BAR}`, async (page) => {
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/covered by div#bar/);
    expect(await page.evaluate(() => document.querySelector("#t")?.scrollTop)).toBe(0);
  });
});

test("expectReadable passes when content follows the target in the scroll box", async ({ browser }) => {
  const html = `<div style="height:800px;overflow:auto">${ROWS(20)}<p id="t" style="margin:0;height:40px">target</p>${ROWS(20)}</div>${BAR}`;
  await withContent(browser, html, async (page) => {
    await expectReadable(page, page.locator("#t"));
  });
});

test("expectReadable rejects a sticky overlay over the target's last content", async ({ browser }) => {
  const html = `<div id="t" style="height:200px;overflow:auto"><div id="head" style="position:sticky;top:0;height:200px;background:#000"></div>${ROWS(10)}</div>`;
  await withContent(browser, html, async (page) => {
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/covered by div#head/);
  });
});

test("expectReadable rejects a sticky overlay over last text that has no element of its own", async ({ browser }) => {
  const html = '<div id="t" style="height:200px;overflow:auto"><div id="head" style="position:sticky;top:0;height:200px;background:#000"></div><div style="height:400px"></div>last words</div>';
  await withContent(browser, html, async (page) => {
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/covered by div#head/);
  });
});

test("expectReadable passes when only the centred position is covered", async ({ browser }) => {
  const html = `<div style="height:400px;overflow:auto"><div id="head" style="position:sticky;top:0;height:240px;background:#000"></div>${ROWS(20)}<p id="t" style="margin:0;height:40px">target</p>${ROWS(20)}</div>`;
  await withContent(browser, html, async (page) => {
    await expectReadable(page, page.locator("#t"));
  });
});

test("expectReadable puts scroll positions back on success and on failure", async ({ browser }) => {
  const html = `<div style="height:300px"></div><div id="s" style="height:400px;overflow:auto">${ROWS(10)}<p id="t" style="margin:0;height:40px">target</p>${ROWS(10)}</div><div style="height:2000px"></div>`;
  await withContent(browser, html, async (page) => {
    await page.evaluate(() => {
      window.scrollTo(0, 120);
      const s = document.querySelector("#s");
      if (s) s.scrollTop = 80;
    });
    await expectReadable(page, page.locator("#t"));
    expect(await scrolls(page)).toEqual([120, 80]);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="cover" style="position:fixed;inset:0;background:#000"></div>'));
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/covered by div#cover/);
    expect(await scrolls(page)).toEqual([120, 80]);
  });
});

test("expectReadable checks last text in a display: contents parent", async ({ browser }) => {
  const html = '<div id="t"><p style="margin:0;height:40px">first</p><span style="display:contents">last words</span></div>';
  await withContent(browser, html, async (page) => {
    await expectReadable(page, page.locator("#t"));
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="cover" style="position:fixed;left:0;right:0;top:40px;height:40px;background:#000"></div>'));
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/covered by div#cover/);
  });
});

test("expectReadable rejects text cut by an outer clip around a scroll box", async ({ browser }) => {
  const html = `<div id="t" style="width:100px;overflow:hidden"><div style="width:400px;overflow:auto"><p id="x" style="margin:0;white-space:nowrap">${LONG}</p></div><p>end</p></div>`;
  await withContent(browser, html, async (page) => {
    expect(await clipped(page, "#t")).toEqual(["p#x"]);
    await expect(expectReadable(page, page.locator("#t"))).rejects.toThrow(/cut off in p#x/);
  });
});

test("expectReadable scrolls a body that scrolls on its own, and puts it back", async ({ browser }) => {
  const html = `<style>html{overflow:hidden}body{height:400px;overflow:auto}</style><div id="t">${ROWS(30)}</div>`;
  await withContent(browser, html, async (page) => {
    await page.evaluate(() => { document.body.scrollTop = 100; });
    await expectReadable(page, page.locator("#t"));
    expect(await page.evaluate(() => document.body.scrollTop)).toBe(100);
  });
});

test("expectReadable sees text cut by a transformed ancestor of fixed text", async ({ browser }) => {
  const html = `<div id="w"><div id="t" style="transform:translateX(1px);width:100px;height:30px;overflow:hidden"><span id="f" style="position:fixed;white-space:nowrap">${LONG}</span></div><p>end</p></div>`;
  await withContent(browser, html, async (page) => {
    expect(await clipped(page, "#t")).toEqual(["span#f"]);
    await expect(expectReadable(page, page.locator("#w"))).rejects.toThrow(/cut off in span#f/);
  });
});

test("expectReadable rejects a target that disappears after the visibility check", async ({ browser }) => {
  await withContent(browser, '<div id="t">here</div>', async (page) => {
    // the visibility check sees the element; it is removed just before the locator is evaluated
    const real = page.locator("#t");
    const vanishing: Locator = Object.create(real, {
      evaluateAll: {
        value: async (fn: Parameters<Locator["evaluateAll"]>[0], arg: unknown) => {
          await page.evaluate(() => document.querySelector("#t")?.remove());
          return real.evaluateAll(fn, arg);
        },
      },
    });
    await expect(expectReadable(page, vanishing)).rejects.toThrow(/matches 0 elements/);
  });
});

test("clipped ignores an oversized spacer and screen-reader text", async ({ browser }) => {
  const html = '<div id="t" style="height:100px;overflow:hidden"><p style="margin:0">short</p><div style="height:500px"></div></div><span id="sr" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">for screen readers</span>';
  await withContent(browser, html, async (page) => {
    expect(await clipped(page, "#t", { strict: true })).toEqual([]);
    expect(await clipped(page, "#sr", { strict: true })).toEqual([]);
  });
});

test("clipped sees a clipping ancestor outside the scope", async ({ browser }) => {
  await withContent(browser, `<div style="width:100px;overflow:hidden;white-space:nowrap"><span id="t">${LONG}</span></div>`, async (page) => {
    expect(await clipped(page, "#t")).toEqual(["span#t"]);
  });
});

test("lengthen makes visible text at least 1.4 times as long", async ({ browser }) => {
  const html = '<div id="s"><p id="a">Hello world</p><p id="b">Second <b>bold</b></p><p id="c" style="display:none">hidden</p><p id="d" style="display:contents">Shown</p></div>';
  await withContent(browser, html, async (page) => {
    expect(await lengthen(page, "#s")).toBe(4);
    expect(((await page.locator("#a").textContent()) ?? "").length).toBeGreaterThanOrEqual(Math.ceil(11 * 1.4));
    for (const sel of ["#a", "#b", "#b b", "#d"]) await expect(page.locator(sel)).toHaveAttribute("data-lengthened", "");
    await expect(page.locator("#d")).toHaveText("Shown Sh");
    await expect(page.locator("#c")).not.toHaveAttribute("data-lengthened", "");
    expect(await page.locator("#c").textContent()).toBe("hidden");
  });
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
