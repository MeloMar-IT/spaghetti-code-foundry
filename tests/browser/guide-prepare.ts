import type { Page } from "@playwright/test";

export interface ShotPrep { large?: boolean; act?: (page: Page) => Promise<void> }

/** Per-shot steps that run after the page is open. */
export const PREPARE: Record<string, ShotPrep> = {
  "flow-yaml": {
    // the click re-renders the flow page with a new, empty status chip; the chip is checked after it
    act: async (page) => {
      await page.locator("#main .seg button", { hasText: "YAML" }).click();
      await page.locator("#main textarea.yaml-editor").waitFor();
      await page.locator("#main .status.ok", { hasText: "✓ valid" }).waitFor();
    },
  },
};
