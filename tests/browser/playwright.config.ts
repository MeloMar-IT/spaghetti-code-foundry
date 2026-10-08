import { defineConfig } from "@playwright/test";

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
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
