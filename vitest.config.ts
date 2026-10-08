import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // End-to-end flow tests spawn many processes; keep parallelism modest so they stay fast.
    testTimeout: 60_000,
    // Several stories run this suite at the same time on one machine, and some tests depend on timing.
    // A test that fails is tried again (twice) before it counts: one slow moment must not stop every story.
    retry: 2,
    // Setup and cleanup hooks start servers and call the API many times; on a busy machine 10 s is too short.
    hookTimeout: 60_000,
    // Only a few test runs work on one machine at a time (tools/test-slot), so one run may use half the cores.
    maxWorkers: Number(process.env.SCF_TEST_WORKERS) || Math.max(4, Math.floor(availableParallelism() / 2)),
    // `vitest run --changed` (the quick tests inside a story) picks the tests that import a changed file. A change
    // to one of these is read by many tests without being imported, so it runs all of them.
    forceRerunTriggers: ["**/package.json/**", "**/vitest.config.*/**", "**/flows/**", "**/blocks/**", "**/tools/**", "**/scripts/**", "**/tests/fixtures/**", "**/tests/helpers/**", "**/tests/setup.ts"],
  },
});
