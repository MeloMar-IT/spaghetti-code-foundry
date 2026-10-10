---
name: integration-testing
description: "Integration tests for real dependencies. Use when a change crosses process, protocol, messaging or database boundaries; not for unit-only changes."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "1400"
  budget-reviewer-tokens: "400"
---

# Integration testing

## When this applies

- Use it when the change adds or alters behaviour across a process, protocol, messaging or database boundary: an HTTP API or client, a Kafka or MQ producer or consumer, SQL or a database driver, a file or process hand-off.
- Do not use it for unit-only changes, or to re-test a library.
- Interface and database skills cover the contract; this skill covers how to test it.

## Pick the test level

- **Unit**: one class or function, no I/O; fakes for collaborators.
- **Component**: one service or module in-process, with its own wiring and fakes at the edges.
- **Contract**: the shape of a request, response or message against a schema or a recorded example; no live peer.
- **Integration**: your code talks to a real instance of the dependency (database, broker, HTTP server) over the real protocol.
- Choose the lowest level that can fail for the reason you care about. Add an integration test only for behaviour that a lower level cannot prove: wiring, serialisation, SQL or query behaviour, transactions, delivery and ordering, timeouts.
- Keep them few and focused: one boundary behaviour per test.

## Follow the repository first

- Find the existing integration tests, their folder, naming, tags or build profile, and the command CI uses. Add to them; do not build a second harness.
- Use the helpers, fixtures, fakes and containers the repository already has.
- **Do not add a dependency**, plugin or service unless the task asks for it.
- **Use Testcontainers only when the build already has it or the task explicitly approves it.** Otherwise use what exists (compose file, embedded or in-memory server, repository fake) and say what you could not cover.

## Realistic dependencies

- Prefer the real engine at the version production uses over a look-alike (H2 is not Oracle; an in-memory map is not Kafka), when the repository can already start it.
- Pin image and tool versions; never `latest`.
- Stub only third parties you do not own, at the protocol level (a local HTTP stub), never by mocking your own client code.

## Fixtures and lifecycle

- Each test creates the data it needs and owns it. **No shared mutable state between tests**; no reliance on test order or on data another test left behind.
- Isolate by unique names: schema, table prefix, topic, queue, consumer group, key, per test or per run.
- Start expensive dependencies once per suite where the framework allows, but reset or namespace the data per test.
- Bind to port 0 and read back the port the OS gave; never a fixed port, and never probe for a "free" one and bind later.

## Cleanup

- Release what you start on every path, including failure: connections, consumers, servers, containers, temporary files. Use the framework's teardown hooks or try/finally.
- Leave no data, topics or processes behind that a later run could see.

## Waiting and retries

- **Never sleep for a fixed time.** Wait for the event you expect: a readiness or health check, a polled condition with a deadline, an acknowledgement, a consumed message, a latch or future.
- Every wait has a timeout, and the failure message says what was awaited.
- Do not retry a failing assertion to make it pass, and do not add a flaky-test rerun. Retry only where the product itself retries, and assert the number of attempts.
- Control time with the project's clock abstraction where it has one.

## Failure paths

- Cover at least one failure for each boundary you touch: timeout, connection refused or dependency down, error status (4xx/5xx), malformed or unknown payload, duplicate or out-of-order message, constraint violation, rollback.
- Assert what the caller sees and what state is left behind, not only that an error occurred.

## Assertions

- Assert the observable result at the boundary: status and body, the stored row, the published message with key and headers, the side effect.
- A test that only checks "no exception" or "not null" proves nothing. No assertion-free tests.

## Never

- **No disabled or skipped tests**: no switched-off test markers of any framework, commented-out tests or early returns to get a green build. Fix the test or report it.
- **No production credentials, endpoints or data.** Use local or throwaway instances and throwaway secrets generated for the test; never copy secrets into the code, fixtures or logs.
- No calls to the public internet or shared environments from a test.

## CI

- The tests must pass with the command CI already runs, without manual setup, in a clean checkout, and when run in parallel or twice in a row.
- If a test needs something CI does not have (Docker, a broker), keep it behind the repository's existing switch for such tests and say so. Do not invent a switch that silently skips.
- Keep each test fast; say how long the new tests take when they add noticeable time.
- Run them before finishing and report what ran and what did not.
