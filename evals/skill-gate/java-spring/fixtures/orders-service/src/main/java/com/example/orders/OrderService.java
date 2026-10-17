package com.example.orders;

import java.time.Clock;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.stream.Collectors;

public class OrderService {
  static final int DISCOUNT_MIN_QUANTITY = 10;
  static final int DISCOUNT_PERCENT = 10;

  private final OrderRepository orders;
  private final Clock clock;

  public OrderService(OrderRepository orders, Clock clock) {
    this.orders = orders;
    this.clock = clock;
  }

  public Order placeOrder(String customerId, int quantity, long unitPriceCents) {
    if (customerId == null || customerId.trim().isEmpty()) throw new IllegalArgumentException("customer is required");
    if (quantity < 1) throw new IllegalArgumentException("quantity must be at least 1");
    if (unitPriceCents < 0) throw new IllegalArgumentException("price must not be negative");
    long total = quantity * unitPriceCents;
    if (quantity >= DISCOUNT_MIN_QUANTITY) total -= total * DISCOUNT_PERCENT / 100;
    return orders.save(new Order(customerId, quantity, total, clock.instant()));
  }

  public Order cancel(Long id) {
    Order order = orders.findById(id).orElseThrow(() -> new NoSuchElementException("no order " + id));
    order.setStatus(Order.Status.CANCELLED);
    return orders.save(order);
  }

  public List<Order> openOrdersOf(String customerId) {
    return orders.findByCustomerId(customerId).stream()
        .filter(o -> o.getStatus() == Order.Status.OPEN)
        .collect(Collectors.toList());
  }
}
