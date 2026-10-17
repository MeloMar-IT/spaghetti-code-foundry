package com.example.orders;

import jakarta.persistence.Id;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

public final class OrderServiceTest {
  private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");
  private static int checks = 0;

  public static void main(String[] args) {
    Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);

    OrderService service = new OrderService(inMemory(), clock);
    Order placed = service.placeOrder("a", 3, 250);
    check(placed.getId() != null, "placed order has an id");
    check(placed.getStatus() == Order.Status.OPEN, "placed order is open");
    check("a".equals(placed.getCustomerId()), "placed order keeps the customer");
    check(placed.getTotalCents() == 750, "total is quantity times price");
    check(NOW.equals(placed.getCreatedAt()), "created at comes from the clock");

    service = new OrderService(inMemory(), clock);
    check(service.placeOrder("a", 10, 100).getTotalCents() == 900, "10 items get the discount");
    check(service.placeOrder("a", 9, 100).getTotalCents() == 900, "9 items get no discount");

    final OrderService strict = new OrderService(inMemory(), clock);
    expectThrows(IllegalArgumentException.class, () -> strict.placeOrder("a", 0, 100), "quantity 0 is refused");

    service = new OrderService(inMemory(), clock);
    Order open = service.placeOrder("a", 1, 100);
    check(service.cancel(open.getId()).getStatus() == Order.Status.CANCELLED, "cancel marks the order cancelled");
    check(service.openOrdersOf("a").isEmpty(), "a cancelled order is not open");

    final OrderService empty = new OrderService(inMemory(), clock);
    expectThrows(NoSuchElementException.class, () -> empty.cancel(99L), "cancel of an unknown id fails");

    service = new OrderService(inMemory(), clock);
    service.placeOrder("a", 1, 100);
    service.placeOrder("b", 1, 100);
    List<Order> mine = service.openOrdersOf("a");
    check(mine.size() == 1 && "a".equals(mine.get(0).getCustomerId()), "only the open orders of that customer");

    System.out.println("OK " + checks + " checks");
  }

  private static void check(boolean ok, String what) {
    if (!ok) throw new AssertionError(what);
    checks++;
  }

  private static void expectThrows(Class<? extends Throwable> type, Runnable action, String what) {
    try {
      action.run();
    } catch (Throwable e) {
      check(type.isInstance(e), what);
      return;
    }
    throw new AssertionError(what);
  }

  static OrderRepository inMemory() {
    final Map<Long, Order> store = new LinkedHashMap<>();
    final AtomicLong next = new AtomicLong(1);
    return (OrderRepository) Proxy.newProxyInstance(
        OrderRepository.class.getClassLoader(), new Class<?>[] {OrderRepository.class}, (proxy, method, args) -> {
          switch (method.getName()) {
            case "save": {
              Order order = (Order) args[0];
              Field idField = idField();
              if (idField.get(order) == null) idField.set(order, next.getAndIncrement());
              store.put(order.getId(), order);
              return order;
            }
            case "findById":
              return Optional.ofNullable(store.get(args[0]));
            case "findAll":
              return new ArrayList<>(store.values());
            case "deleteById":
              store.remove(args[0]);
              return null;
            case "findByCustomerId":
              return store.values().stream().filter(o -> o.getCustomerId().equals(args[0])).collect(Collectors.toList());
            case "toString":
              return "InMemoryOrderRepository";
            case "hashCode":
              return System.identityHashCode(proxy);
            case "equals":
              return proxy == args[0];
            default:
              throw new UnsupportedOperationException(method.getName());
          }
        });
  }

  private static Field idField() {
    for (Field field : Order.class.getDeclaredFields()) {
      if (field.isAnnotationPresent(Id.class)) {
        field.setAccessible(true);
        return field;
      }
    }
    throw new IllegalStateException("no @Id field");
  }
}
