import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkStatus, put, removeWorkFolders, ROOT, workFolder } from "./engineering-practice-helpers.js";

afterAll(removeWorkFolders);

const hasJavac = spawnSync("sh", ["-c", "javac -version"], { stdio: "ignore" }).status === 0;

const STOCK_PATH = "src/main/java/org/example/stock/Stock.java";
const STOCK = readFileSync(join(ROOT, "fixtures/java-stock", STOCK_PATH), "utf8");
const edit = (text: string, from: string, to: string) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};
const FIXED_STOCK = edit(STOCK, "return have >= want - 1;", "return have >= want;");
// The patch of the symptom: remove is right, canShip is still wrong.
const REMOVE_ONLY_STOCK = edit(STOCK, "if (!covers(have, quantity)) {", "if (have < quantity) {");

const CHECK_DIR = "src/test/java/org/example/stock";
const NEGATIVE_CHECK = `package org.example.stock;

public final class NegativeStockCheck {
  public static void main(String[] args) {
    Stock stock = new Stock();
    stock.add("a", 2);
    try {
      stock.remove("a", 3);
      throw new AssertionError("remove of more than the stock must throw");
    } catch (IllegalStateException expected) {
      if (stock.available("a") != 2) throw new AssertionError("a refused remove changes nothing");
    }
    if (stock.canShip("a", 3)) throw new AssertionError("cannot ship more than the stock");
  }
}
`;
const OTHER_CHECK = `package org.example.stock;

public final class OtherCheck {
  public static void main(String[] args) {
    Stock stock = new Stock();
    stock.add("a", 2);
    if (stock.available("a") != 2) throw new AssertionError("available");
  }
}
`;
// Each line is one requirement of the Javadoc; a check that leaves one out must fail the scenario.
const REORDER_LINES = [
  "    eq(0, rule.orderQuantity(12));",
  "    eq(0, rule.orderQuantity(10));",
  "    eq(5, rule.orderQuantity(9));",
  "    eq(10, rule.orderQuantity(3));",
  "    eq(10, rule.orderQuantity(0));",
  "    refused(() -> new ReorderRule(10, 0));",
  "    refused(() -> new ReorderRule(-1, 5));",
  "    refused(() -> rule.orderQuantity(-1));",
  "    eq(2_000_000_000, new ReorderRule(2_000_000_000, 2_000_000_000).orderQuantity(1_000_000_000));",
  "    overflows(() -> new ReorderRule(2_000_000_000, 1_500_000_000).orderQuantity(0));",
];
const reorderCheck = (lines: string[]) => `package org.example.stock;

public final class ReorderRuleCheck {
  private static void overflows(Runnable r) {
    try {
      r.run();
    } catch (ArithmeticException expected) {
      return;
    }
    throw new AssertionError("expected ArithmeticException");
  }

  private static void eq(int want, int got) {
    if (want != got) throw new AssertionError("expected " + want + " but got " + got);
  }

  private static void refused(Runnable r) {
    try {
      r.run();
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("expected IllegalArgumentException");
  }

  public static void main(String[] args) {
    ReorderRule rule = new ReorderRule(10, 5);
${lines.join("\n")}
  }
}
`;
const REORDER_CHECK = reorderCheck(REORDER_LINES);
const WEAK_REORDER_CHECK = reorderCheck(REORDER_LINES.slice(0, 1));
// Groups of lines that cover the same requirement: leaving out a whole group must fail the scenario.
const OMITTED_GROUPS = [[0, 1], [2, 3, 4, 8, 9], [5], [6], [7], [8, 9], [9]];

describe.skipIf(!hasJavac)("the Java fixture and the checks of the Java scenarios", () => {
  const status = async (id: string, files: Record<string, string>) => {
    const dir = workFolder("java-stock");
    put(dir, files);
    return checkStatus(id, dir);
  };

  it("java-stock passes its own check", () => {
    const dir = workFolder("java-stock");
    const r = spawnSync(
      "sh",
      ["-c", 'javac -d "$OUT" $(find src -name "*.java") && java -ea -cp "$OUT" org.example.stock.StockCheck'],
      { cwd: dir, encoding: "utf8", env: { ...process.env, OUT: join(dir, ".out"), PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  describe.concurrent("checks", () => {
    it("fail on the unchanged fixture", async () => {
      for (const id of ["fix-negative-stock", "test-reorder-rule"]) expect({ id, status: await status(id, {}) }).toEqual({ id, status: 1 });
    });

    it("fix-negative-stock passes a fix with a regression check", async () => {
      expect(await status("fix-negative-stock", { [STOCK_PATH]: FIXED_STOCK, [`${CHECK_DIR}/NegativeStockCheck.java`]: NEGATIVE_CHECK })).toBe(0);
    });

    it("fix-negative-stock fails a correct fix without a regression check", async () => {
      expect(await status("fix-negative-stock", { [STOCK_PATH]: FIXED_STOCK })).toBe(1);
    });

    it("fix-negative-stock fails a fix with a check that also passes on the old code", async () => {
      expect(await status("fix-negative-stock", { [STOCK_PATH]: FIXED_STOCK, [`${CHECK_DIR}/OtherCheck.java`]: OTHER_CHECK })).toBe(1);
    });

    it("fix-negative-stock fails a patch in remove only", async () => {
      expect(await status("fix-negative-stock", { [STOCK_PATH]: REMOVE_ONLY_STOCK, [`${CHECK_DIR}/NegativeStockCheck.java`]: NEGATIVE_CHECK })).toBe(1);
    });

    it("test-reorder-rule passes a check for every rule of the Javadoc", async () => {
      expect(await status("test-reorder-rule", { [`${CHECK_DIR}/ReorderRuleCheck.java`]: REORDER_CHECK })).toBe(0);
    });

    for (const group of OMITTED_GROUPS) {
      it(`test-reorder-rule fails a check without the lines ${group.join(", ")}`, async () => {
        const check = reorderCheck(REORDER_LINES.filter((_, i) => !group.includes(i)));
        expect(await status("test-reorder-rule", { [`${CHECK_DIR}/ReorderRuleCheck.java`]: check })).toBe(1);
      });
    }

    it("test-reorder-rule fails a check with one case", async () => {
      expect(WEAK_REORDER_CHECK).not.toBe(REORDER_CHECK);
      expect(await status("test-reorder-rule", { [`${CHECK_DIR}/ReorderRuleCheck.java`]: WEAK_REORDER_CHECK })).toBe(1);
    });

    it("test-reorder-rule fails a check that does not pass on the original source", async () => {
      const wrong = REORDER_CHECK.replace("eq(5, rule.orderQuantity(9));", "eq(6, rule.orderQuantity(9));");
      expect(wrong).not.toBe(REORDER_CHECK);
      expect(await status("test-reorder-rule", { [`${CHECK_DIR}/ReorderRuleCheck.java`]: wrong })).toBe(1);
    });
  });
});
