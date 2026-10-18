package org.springframework.data.jpa.repository;

import java.util.List;
import java.util.Optional;

// Stand-in for offline compilation; Maven uses the real library.
public interface JpaRepository<T, ID> {
  <S extends T> S save(S entity);

  Optional<T> findById(ID id);

  List<T> findAll();

  void deleteById(ID id);
}
