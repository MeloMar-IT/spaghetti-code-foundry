package org.example.stock;

/**
 * When and how much to order again.
 *
 * <p>Orders are made in whole batches. At or above the minimum nothing is ordered. Below it, the quantity is the smallest
 * number of whole batches that brings the stock up to the minimum.
 */
public final class ReorderRule {
  private final int minimum;
  private final int batch;

  /** Throws {@link IllegalArgumentException} when {@code minimum} is below 0 or {@code batch} is below 1. */
  public ReorderRule(int minimum, int batch) {
    if (minimum < 0) {
      throw new IllegalArgumentException("minimum must be 0 or more");
    }
    if (batch < 1) {
      throw new IllegalArgumentException("batch must be 1 or more");
    }
    this.minimum = minimum;
    this.batch = batch;
  }

  /**
   * How many to order when {@code available} are in stock: 0 when {@code available} is at least the minimum, otherwise the
   * missing amount rounded up to a whole number of batches. Throws {@link IllegalArgumentException} for a negative value, and
   * {@link ArithmeticException} when the quantity to order is more than {@link Integer#MAX_VALUE}.
   */
  public int orderQuantity(int available) {
    if (available < 0) {
      throw new IllegalArgumentException("available must be 0 or more");
    }
    if (available >= minimum) {
      return 0;
    }
    long missing = (long) minimum - available;
    long batches = (missing + batch - 1) / batch;
    return Math.toIntExact(batches * batch);
  }
}
