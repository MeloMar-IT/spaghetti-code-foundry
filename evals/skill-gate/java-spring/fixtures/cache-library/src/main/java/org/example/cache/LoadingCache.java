package org.example.cache;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;

public class LoadingCache<K, V> {
  private final Map<K, V> values = new HashMap<>();
  private final Function<? super K, ? extends V> loader;

  public LoadingCache(Function<? super K, ? extends V> loader) {
    this.loader = Objects.requireNonNull(loader, "loader");
  }

  public V get(K key) {
    V value = values.get(key);
    if (value == null) {
      value = loader.apply(key);
      values.put(key, value);
    }
    return value;
  }

  public void invalidate(K key) {
    values.remove(key);
  }

  public int size() {
    return values.size();
  }
}
