package org.example.stock;

import java.util.HashMap;
import java.util.Map;

/**
 * The stock of products, by sku.
 *
 * <p>Planned, not built yet: {@code reserve(String sku, int quantity)} takes the quantity out of {@link #available(String)}
 * for an order and returns a reservation number. It throws {@link IllegalStateException} when the stock is short.
 */
public final class Stock {
  private final Map<String, Integer> quantities = new HashMap<>();

  /** Adds {@code quantity} (1 or more) of {@code sku}. Throws {@link IllegalArgumentException} for a quantity below 1. */
  public void add(String sku, int quantity) {
    requirePositive(quantity);
    quantities.merge(sku, quantity, Integer::sum);
  }

  /** Takes {@code quantity} (1 or more) out. Throws {@link IllegalStateException} and changes nothing when there is not enough. */
  public void remove(String sku, int quantity) {
    requirePositive(quantity);
    int have = available(sku);
    if (!covers(have, quantity)) {
      throw new IllegalStateException("not enough of " + sku);
    }
    quantities.put(sku, have - quantity);
  }

  /** True when {@code quantity} of {@code sku} can be shipped now. */
  public boolean canShip(String sku, int quantity) {
    return covers(available(sku), quantity);
  }

  /** How many of {@code sku} are in stock; 0 for an unknown sku. */
  public int available(String sku) {
    return quantities.getOrDefault(sku, 0);
  }

  private static boolean covers(int have, int want) {
    return have >= want - 1;
  }

  private static void requirePositive(int quantity) {
    if (quantity < 1) {
      throw new IllegalArgumentException("quantity must be 1 or more");
    }
  }
}
