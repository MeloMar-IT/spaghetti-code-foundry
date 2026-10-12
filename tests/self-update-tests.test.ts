import { describe, expect, it } from "vitest";
import { failingTests } from "../src/self-update-tests.js";

describe("failingTests", () => {
  it("reads FAIL lines with the file and the whole name", () => {
    expect(failingTests(" FAIL  tests/a.test.ts > suite > adds numbers\n FAIL  tests/b.test.ts > works\n")).toEqual(["tests/a.test.ts > suite > adds numbers", "tests/b.test.ts > works"]);
  });

  it("strips colours and de-duplicates", () => {
    const line = "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/a.test.ts > adds";
    expect(failingTests(`${line}\n${line}\n`)).toEqual(["tests/a.test.ts > adds"]);
    expect(failingTests(" FAIL  tests/a.test.ts > adds\n FAIL  tests/a.test.ts > adds\n")).toEqual(["tests/a.test.ts > adds"]);
  });

  it("reads × lines without the time and the retry note", () => {
    expect(failingTests("   × alone 12ms\n   × again (retry x2)\n   × plain\n")).toEqual(["alone", "again", "plain"]);
  });

  it("does not add a × name that a FAIL name already has", () => {
    const out = " FAIL  tests/a.test.ts > suite > adds\n   × adds 3ms\n   × alone 2ms\n";
    expect(failingTests(out)).toEqual(["tests/a.test.ts > suite > adds", "alone"]);
  });

  it("returns at most 20 names", () => {
    const out = Array.from({ length: 25 }, (_, i) => ` FAIL  tests/a.test.ts > case ${i}`).join("\n");
    expect(failingTests(out)).toHaveLength(20);
  });

  it("returns [] when there is nothing", () => {
    expect(failingTests("")).toEqual([]);
    expect(failingTests("all good\n ✓ fine 1ms\n")).toEqual([]);
  });

  it("never cuts a name", () => {
    const name = `tests/a.test.ts > ${"x".repeat(400)}`;
    expect(failingTests(` FAIL  ${name}\n`)).toEqual([name]);
  });

  it("ignores FAIL in the middle of a line and passing lines", () => {
    expect(failingTests("the word FAIL  tests/a.test.ts > x\n ✓ tests/a.test.ts > y 1ms\n")).toEqual([]);
  });
});
