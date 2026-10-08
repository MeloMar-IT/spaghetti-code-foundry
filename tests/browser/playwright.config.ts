import { defineConfig } from "@playwright/test";

/** The share of pixels that may differ before a screenshot comparison fails. The one threshold of the visual check. */
export const MAX_DIFF_PIXEL_RATIO = 0.001;

// The config is loaded in the main process first; the workers inherit this, so every process registers the same visual tests.
process.env.UI_UPDATING ??= process.argv.some((a) => a === "-u" || a.startsWith("--update-snapshots")) ? "1" : "0";

// No baseURL: the port is only known after the global setup has started the server; the helpers use the seed address.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  // a missing baseline fails instead of being written silently; --update-snapshots overrides this
  updateSnapshots: "none",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, animations: "disabled", caret: "hide", scale: "css" } },
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
