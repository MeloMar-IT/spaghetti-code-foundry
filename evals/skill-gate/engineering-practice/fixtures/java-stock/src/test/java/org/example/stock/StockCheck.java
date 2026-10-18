package org.example.stock;

/** Plain checks, run with javac and java. A wrong result throws an AssertionError. */
public final class StockCheck {
  private StockCheck() {}

  private static void check(boolean ok, String what) {
    if (!ok) {
      throw new AssertionError(what);
    }
  }

  public static void main(String[] args) {
    Stock stock = new Stock();
    stock.add("a", 5);
    stock.remove("a", 2);
    check(stock.available("a") == 3, "remove takes the quantity out");
    check(stock.canShip("a", 3), "can ship what is in stock");
    check(!stock.canShip("a", 10), "cannot ship far more than is in stock");
    try {
      stock.remove("a", 10);
      check(false, "remove of far too much throws");
    } catch (IllegalStateException expected) {
      check(stock.available("a") == 3, "a refused remove changes nothing");
    }
    try {
      stock.add("a", 0);
      check(false, "add of 0 throws");
    } catch (IllegalArgumentException expected) {
      // the expected result
    }
  }
}
