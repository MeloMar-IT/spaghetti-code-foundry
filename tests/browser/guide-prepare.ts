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
  "run-dialog": {
    act: async (page) => {
      await page.locator("#main button", { hasText: "▶ Run" }).click();
      await page.locator("#modal-root .modal-head h2").waitFor();
    },
  },
  // the run pages redraw their head when the run summary arrives; wait for it ("Workspace") before the paths are rewritten
  "run-log": {
    act: async (page) => {
      await page.locator('#main [data-tab="log"]').click();
      await page.locator('#main [data-tab="log"].on').waitFor();
      await page.locator("#main pre.log", { hasText: "waiting for approval: Go?" }).waitFor();
      await page.locator("#main dt", { hasText: "Workspace" }).waitFor();
    },
  },
  "run-steps": {
    act: async (page) => {
      await page.locator('#main [data-tab="steps"]').click();
      await page.locator('#main [data-tab="steps"].on').waitFor();
      await page.locator("#main .timeline").waitFor();
      await page.locator("#main dt", { hasText: "Workspace" }).waitFor();
    },
  },
  "run-diff": {
    large: true,
    act: async (page) => {
      await page.locator('#main [data-tab="diff"]').click();
      await page.locator("#main pre.diff").waitFor();
      await page.locator("#main dt", { hasText: "Workspace" }).waitFor();
    },
  },
  "watcher-form": {
    act: async (page) => {
      await page.locator("#main .toolbar button", { hasText: "+ Add watcher" }).click();
      await page.locator("#modal-root .modal-head h2").waitFor();
    },
  },
};
