import { expect, type Locator, type Page } from "@playwright/test";
import type { Counts } from "./journeys-baseline.js";

export interface Journey {
  /** Clicks. `opens` says that the click leads to a new page (hash change) or a dialog: that is a navigation step. */
  click(target: Locator, opts?: { opens?: "page" | "dialog" }): Promise<void>;
  /** Types into a box that already has the focus (a click on it comes first, and is counted). */
  fill(target: Locator, text: string): Promise<void>;
  goto(hash: string): Promise<void>;
  /** Checks that every page change and every dialog was declared, then returns the counts. */
  finish(): Promise<Counts>;
}

declare global {
  interface Window { __journey?: { pages: number; dialogs: number } }
}

/**
 * Starts counting on a page that has already landed. Page changes (hash) and dialogs that open are observed in the
 * page itself, so a step that was not declared makes finish() fail instead of being left out of the count.
 */
export async function journey(page: Page, opts: { wait?: number } = {}): Promise<Journey> {
  const wait = opts.wait ?? 10_000;
  await page.evaluate(() => {
    const seen = (window.__journey = { pages: 0, dialogs: 0 });
    let hash = location.hash;
    window.addEventListener("hashchange", () => {
      if (location.hash !== hash) seen.pages++;
      hash = location.hash;
    });
    const isDialog = (n: Node) => n instanceof Element && (n.matches('[role="dialog"]') || !!n.querySelector('[role="dialog"]'));
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (isDialog(n)) seen.dialogs++;
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const seen = () => page.evaluate(() => window.__journey ?? { pages: -1, dialogs: -1 });
  const counts: Counts = { nav: 0, clicks: 0, fields: 0 };
  let pages = 0;
  let dialogs = 0;
  const arrived = async (kind: "pages" | "dialogs", want: number) => {
    await expect.poll(async () => (await seen())[kind], { timeout: wait, message: `no ${kind === "pages" ? "page change" : "dialog"} after the step` }).toBeGreaterThanOrEqual(want);
  };

  return {
    async click(target, o = {}) {
      await target.click({ timeout: wait });
      counts.clicks++;
      if (o.opens === "page") {
        counts.nav++;
        await arrived("pages", ++pages);
      } else if (o.opens === "dialog") {
        counts.nav++;
        await arrived("dialogs", ++dialogs);
      }
    },
    async fill(target, text) {
      await expect(target, "a box is clicked before it is typed into").toBeFocused({ timeout: Math.min(wait, 2000) });
      await target.fill(text, { timeout: wait });
      counts.fields++;
    },
    async goto(hash) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      counts.nav++;
      await arrived("pages", ++pages);
    },
    async finish() {
      const now = await seen();
      expect(now.pages, "a page change that the test did not declare").toBe(pages);
      expect(now.dialogs, "a dialog that the test did not declare").toBe(dialogs);
      return { ...counts };
    },
  };
}
