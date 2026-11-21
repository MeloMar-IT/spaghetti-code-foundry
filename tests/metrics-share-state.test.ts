import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withShareLock } from "../src/metrics-share/state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("withShareLock", () => {
  it("keeps a lock alive while its holder works longer than the stale time", async () => {
    const file = join(dir, "lock");
    const opts = { file, staleMs: 60_000, heartbeatMs: 2 };
    const result = await withShareLock(async () => {
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(file, old, old); // the lock now looks an hour old
      // wait until the holder has renewed the lock's time
      while (statSync(file).mtimeMs < Date.now() - 60_000) await new Promise((r) => setTimeout(r, 2));
      return withShareLock(async () => "taken over", opts);
    }, opts);
    expect(result).toBe("busy");
  });
});
