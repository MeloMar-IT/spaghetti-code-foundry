# Integration test review checks

- Is each new test at the right level (unit, component, contract, integration), and is an integration test added only where a boundary changed?
- Determinism: is there any fixed sleep, fixed port, wall-clock or test-order dependence, or a retry that hides a flaky assertion? Does every wait have a condition and a timeout?
- Isolation: does a test share mutable state or data with another test, or reuse a topic, queue, schema or consumer group?
- Cleanup: is everything the test starts or creates released on all paths, including failure?
- Failure paths: is at least one failure covered for each touched boundary (timeout, dependency down, error status, bad payload, duplicate message, rollback)?
- Meaningful assertions: does each test assert the observable result at the boundary, not only "no exception" or "not null"?
- Is any test disabled, skipped or commented out?
- Are production credentials, endpoints or data used, or secrets written into code, fixtures or logs?
- Does it use the repository's existing test infrastructure, with no new dependency or Testcontainers unless already present or approved?
- Will it pass in CI as CI runs it, in parallel and when repeated?
