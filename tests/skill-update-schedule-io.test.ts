import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readUpdateChecks, updateChecksPath } from "../src/skills/update-schedule.js";

vi.mock("../src/skills/package.js", () => ({
  readRegular: () => {
    throw new Error("EIO");
  },
}));

describe("the check record when reading throws", () => {
  it("is unreadable, not fatal", () => {
    const home = mkdtempSync(join(tmpdir(), "skill-update-checks-io-"));
    try {
      writeFileSync(updateChecksPath(home), "{}");
      expect(readUpdateChecks({ home })).toEqual({ state: "unreadable", reason: "cannot be read" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
