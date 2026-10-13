---
name: spring-boot
description: "Spring Boot: config, injection, web, validation, transactions, errors, tests. Use for modules with a Spring Boot dependency; not plain Java or plain Spring."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "1700"
  budget-reviewer-tokens: "600"
---

# Spring Boot

## When this applies

- Use it when the module you change has a Spring Boot dependency or plugin in its build (`org.springframework.boot`), or its sources import `org.springframework.boot`.
- Do not use it for plain Java, for a module that uses Spring Framework without Boot, or for another module of the same repository that has no Spring Boot. Java alone is not a reason.
- The `java` skill is loaded with this one and covers the language. HTTP contracts, messaging and database specifics live in their own skills; this skill does not cover them.

## Follow the application first

- Read the build file, the main class and two or three beans of the same kind before writing. Match the package layout, the layering and the names.
- Stay on the Boot version and the stack in the build: `javax.*` or `jakarta.*`, MVC or WebFlux, the existing security setup, JPA or JDBC. Do not mix them.
- Do not add or remove a starter, change the Boot version, the parent or a managed dependency version, or replace one framework feature by another, unless the task asks for it.
- Prefer what the starters already give over a new library or hand-made infrastructure.

## Dependency injection

- Use constructor injection with `final` fields. No field injection (`@Autowired` or `@Inject` on a field) in new code; in tests, follow the project's style.
- One constructor needs no `@Autowired`. Use Lombok's `@RequiredArgsConstructor` only where the project already does.
- Do not create a bean with `new`, and do not look beans up from the `ApplicationContext`.
- Beans are singletons: no request or user state in fields.
- A dependency cycle means a wrong design; do not hide it with `@Lazy` or setter injection.
- Keep component scanning as it is. Add a `@Bean` method only for a type you cannot annotate.

## Configuration properties and profiles

- Bind new settings with `@ConfigurationProperties` in the project's style (record or class), validated with `@Validated` and constraints. Use `@Value` only where the project does, for a single value.
- Use the file format (`.properties` or `.yml`) and the key naming already there. Give a safe default, or fail at startup when a required value is missing.
- Never commit a secret, password, token or real host. Use a placeholder (`${DB_PASSWORD}`) and the mechanism the project has for secrets.
- Profiles choose environment settings, not business logic. Do not add a profile, and do not put `@Profile` on business code, without a need the task states.
- Do not make a production default unsafe for a test: no `ddl-auto: create`, exposed actuator endpoints, disabled security or debug logging in the shared or production configuration. Put test-only values in the test resources.

## Controllers and validation

- A controller maps HTTP to one service call: no business rules, no repository access, no transaction.
- Use request and response types (DTOs) as the project does; do not expose a persistence entity when it does not.
- Put `@Valid` (or `@Validated`) on every request body and constraints on its fields; validate path and query values too. Nested objects need `@Valid` on the field.
- Return the status codes and the response style of the neighbouring endpoints.
- In WebFlux, never block (`block()`, JDBC, `Thread.sleep`) on an event-loop thread.

## Services and transactions

- Business rules live in services. Keep the service free of web types (`HttpServletRequest`, `ResponseEntity`).
- Put `@Transactional` on the public service method that is the unit of work, not on controllers or repositories, and not wider than needed. Use `readOnly = true` for reads where the project does.
- `@Transactional`, `@Async`, `@Cacheable` and method `@Validated` work through a proxy: they do nothing on a `private` method or on a call from the same class. Move the method to another bean instead.
- By default, rollback happens for unchecked exceptions only. For a checked exception that must roll back, set `rollbackFor`; do not catch an exception inside the transaction and continue as if it succeeded.
- No remote call, message send or long wait inside a transaction when it can be moved after the commit. Something that must happen only on success uses the project's way (`@TransactionalEventListener`, an outbox).
- Change `propagation` or `isolation` only with a reason written next to it.

## Exception handling

- Use the application's one error path (`@RestControllerAdvice`, `ProblemDetail` or its own error type). Add a handler there; do not build error responses in each controller.
- Map a domain exception to one status code. A validation failure is a 400 with the fields, not a 500.
- Do not send stack traces, SQL or internal class names to the client. Log the cause once, at the place that handles it.

## Observability

- Log through SLF4J with placeholders (`log.info("order {} paid", id)`), at the levels the project uses. No `System.out`, no secrets or personal data in logs.
- Keep the MDC or trace context the application sets; pass it on when work moves to another thread.
- Use Micrometer (`MeterRegistry`, `@Timed`, `Observation`) for a new metric, with the naming in use and tags of low cardinality: never an id or a free text as a tag value.
- Do not expose more actuator endpoints or details. A new health indicator must be fast and must not fail the application for an optional dependency.

## Tests and test slices

- Pick the smallest test that proves the change: a plain unit test with the constructor for a service; `@WebMvcTest` (or `@WebFluxTest`) for a controller; `@DataJpaTest` or the matching slice for a repository; `@JsonTest` for mapping; `@SpringBootTest` only for wiring, configuration or a flow through several layers.
- Use the mocking style of the project's Boot version (`@MockBean` or `@MockitoBean`). Each different set of mocks or properties starts a new context: reuse the existing base classes and configurations.
- For a controller test: the happy path, a validation failure and the mapped error, with status and body.
- For a transaction: a test that proves the rollback or the commit, not only the return value.
- For configuration properties: bind them in a test (`ApplicationContextRunner` or the project's way), with a missing and an invalid value.
- No `@DirtiesContext`, fixed ports or sleeps unless the project already needs them. Run the module's tests with the project's wrapper before finishing.
