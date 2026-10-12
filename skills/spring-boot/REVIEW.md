# Spring Boot review checks

- Does the change follow the application's existing patterns, and add no starter, dependency, Boot version or framework change the task did not ask for?
- Injection: constructor injection only? Is there a new field injection, a bean made with `new`, a context lookup, or a cycle hidden with `@Lazy`?
- Transaction boundaries: is `@Transactional` on the public service method that is the unit of work? Is it lost by a call from the same class or a `private` method? Does a checked or caught exception skip the rollback? Is a remote call or message sent inside the transaction that should wait for the commit?
- Configuration safety: are new settings bound and validated, with a safe default or a startup failure? Is a secret or real host committed? Does a shared or production file get a test-only or unsafe value (schema creation, open actuator endpoints, disabled security, debug logging)? Is a profile used for business logic?
- Validation: does every new request body have `@Valid` and constraints, also on nested objects, path and query values? Does a validation failure give a 400 through the application's error path, without stack traces or internals?
- Layers: does a controller hold business rules, repository access or a transaction? Is an entity exposed where the project uses DTOs? Is there a blocking call in WebFlux code?
- Observability: are logs free of secrets and personal data, and do new metrics use low-cardinality tags?
- Test coverage: is there a test at the smallest level that proves the change (unit, the right slice, `@SpringBootTest` only for wiring), covering the happy path, a validation failure, the mapped error and, for a transaction, the rollback? No new full context, `@DirtiesContext` or sleep without need?
- Leave language checks to the `java` skill, and protocol and database checks to their own skills.
