package org.example.cache;

import java.util.concurrent.atomic.AtomicInteger;

public class LoadingCacheTest {
  private static int checks = 0;

  private static void check(boolean ok, String name) {
    checks++;
    if (!ok) throw new AssertionError("failed: " + name);
  }

  public static void main(String[] args) {
    AtomicInteger calls = new AtomicInteger();
    LoadingCache<String, String> cache = new LoadingCache<>(k -> {
      calls.incrementAndGet();
      return "v-" + k;
    });
    check("v-a".equals(cache.get("a")), "loads a value");
    check("v-a".equals(cache.get("a")), "returns the cached value");
    check(calls.get() == 1, "repeated get loads once");
    check("v-b".equals(cache.get("b")), "loads another key");
    check(calls.get() == 2, "different keys load separately");
    check(cache.size() == 2, "size counts keys");
    cache.invalidate("a");
    cache.get("a");
    check(calls.get() == 3, "invalidate makes the next get reload");

    AtomicInteger failing = new AtomicInteger();
    LoadingCache<String, String> broken = new LoadingCache<>(k -> {
      failing.incrementAndGet();
      throw new IllegalStateException("down");
    });
    boolean thrown = false;
    try {
      broken.get("x");
    } catch (IllegalStateException e) {
      thrown = true;
    }
    check(thrown, "a loader exception comes out of get");
    check(broken.size() == 0, "a failed load is not cached");
    try {
      broken.get("x");
    } catch (IllegalStateException e) {
      thrown = false;
    }
    check(!thrown && failing.get() == 2, "a failed load is tried again");

    boolean refused = false;
    try {
      new LoadingCache<String, String>(null);
    } catch (NullPointerException e) {
      refused = true;
    }
    check(refused, "a null loader is refused");
    System.out.println("OK " + checks + " checks");
  }
}
