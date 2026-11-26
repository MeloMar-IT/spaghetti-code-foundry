// A suite of its own for tests/stray-check.test.ts: one case file, with the real check at the end.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, "../../.."),
  test: {
    include: ["tests/fixtures/stray-check/run.case.ts"],
    globalSetup: ["tests/global-setup.ts"],
    retry: 0,
  },
});
