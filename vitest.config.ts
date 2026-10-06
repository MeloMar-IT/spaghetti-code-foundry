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
    maxWorkers: 4,
  },
});
