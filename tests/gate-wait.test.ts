import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForFile } from "./helpers/gate-wait.js";

describe("test wait loops end by themselves", () => {
  it("ends when the file appears, and at once when its folder is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-gate-"));
    writeFileSync(join(dir, "go"), "");
    execFileSync("sh", ["-c", waitForFile(dir, "go")], { timeout: 5_000 });
    rmSync(dir, { recursive: true, force: true });
    execFileSync("sh", ["-c", waitForFile(dir, "go")], { timeout: 5_000 });
  });

  it("no test waits for a file in a loop without an end", () => {
    const dir = join(import.meta.dirname);
    const endless = readdirSync(dir).filter((f) => f.endsWith(".ts"))
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").map((l, i) => ({ f, i: i + 1, l })))
      .filter(({ l }) => /while \[ ! -[ef] /.test(l) && !/-lt \d/.test(l))
      .map(({ f, i }) => `${f}:${i}`);
    expect(endless).toEqual([]);
  });
});
