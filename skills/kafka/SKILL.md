---
name: kafka
description: "Kafka producers, consumers, streams: keys, order, duplicates, retries, schemas. Use when Kafka code, config or schemas change; not for a bare mention of events."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "2600"
  budget-reviewer-tokens: "700"
---

# Kafka producers and consumers

## When this applies

- A Kafka producer, consumer or Kafka Streams topology, a Kafka client setting, a topic's message schema, or a Kafka dependency or import changes in the module you work on, or the task asks for Kafka work.
- It does not apply to text or code that only mentions events, messages or queues: documentation, an in-process event emitter, UI events, another broker. Then ignore this skill.
- No cluster access. Work from the code, configuration and schemas in the repository. Do not connect to a broker or a schema registry, do not run admin commands, do not create, alter or delete topics, and do not reset offsets. If the change needs a topic, a partition count, an access rule or a registered schema, say so in your summary.

## Follow the repository first

- Use the client library, wrappers, serializers and error handling the repository already has. Do not add a client, a serializer, a schema registry client or any other dependency unless the task asks for it.
- Reuse the existing topic name constants, configuration keys and dead-letter naming. Client defaults differ between versions: read the configured value, do not assume one.

## Delivery guarantee

- For each flow you change, know the guarantee and name it: at most once, at least once, or exactly once inside Kafka.
- Assume at least once unless the code proves otherwise: a message can arrive more than once, and again after a rebalance, a restart or a replay.
- Never assume, write or claim exactly-once behaviour unless you verified all of it in the repository: an idempotent producer with a `transactional.id`, offsets committed in the same transaction, readers on `isolation.level=read_committed` (or Kafka Streams `processing.guarantee=exactly_once_v2`), and an end-to-end boundary that stays inside Kafka. A database write, an HTTP call, an e-mail or another broker is outside the transaction; there the consumer must be idempotent. If one part is not verified, call it at least once.

## Producers

- Data that must not be lost: `acks=all` with `enable.idempotence=true`. `acks=all` protects only with `min.insync.replicas` of 2 or more on the topic; when you cannot see the topic settings, say what you assumed. Do not lower `acks` for speed.
- The idempotent producer removes duplicates of its own retries in one session. It does not remove a message the application sends twice.
- Retries are bounded by `delivery.timeout.ms`. Without idempotence, retries with more than one request in flight can reorder messages; with it, keep `max.in.flight.requests.per.connection` at 5 or lower.
- Handle the result of every send (callback, future or `await`). A failed send is raised or handled, and logged with topic and key; never fire and forget. Flush and close on shutdown.
- A database write and a send are two writes: one can succeed and the other fail. Use the repository's outbox when it has one; otherwise say which of the two can be lost.

## Keys, partitions and ordering

- Order holds only inside one partition. Messages that must stay in order carry the same key (the id of the entity). A null key gives no order.
- Changing the key, the partitioner or the partition count sends a key to another partition: it breaks order for data in flight, and breaks compacted topics, joins and state stores. Treat it as a breaking change.
- Do not pick a partition by hand unless the repository does. Watch for one key that takes most of the traffic.
- On a compacted topic the key is the identity and a null value is a delete marker (tombstone): consumers must handle it.

## Consumers, groups and offsets

- The `group.id` is the application's place in the topic. A new group id starts from `auto.offset.reset`: it replays everything or skips what was waiting. Do not change either without the task asking.
- Commit an offset only after its message is fully processed, never before. With auto-commit, a poll can commit records that are not processed yet: know which mode the repository uses. The committed offset is the last processed offset plus one.
- The work between two polls must fit in `max.poll.interval.ms`, or the group rebalances and the messages come again. Prefer a smaller `max.poll.records` or pausing the partition over raising the limit.
- Handing records to threads or unawaited promises breaks the order of a partition and makes commits unsafe: commit only what is complete without gaps.
- On a rebalance, finish or stop the work of revoked partitions and commit before giving them up. Stop cleanly on shutdown.

## Duplicates and replay

- Every consumer must be safe when the same message arrives twice, and when the topic is replayed from an older offset.
- Make the effect idempotent: an upsert by business key, a version or state check, or the event id stored in the same database transaction as the effect. A set in memory is not deduplication.
- Topic, partition and offset identify one record, not one business event: a re-sent event has a new offset.

## Retries, poison messages and dead letters

- Tell a transient failure (timeout, dependency down) from a permanent one (cannot be deserialized, fails validation, breaks a rule). Retry a transient failure a bounded number of times with backoff. Never retry a permanent one.
- A poison message, one that fails every time, must neither block its partition forever nor vanish. Use the repository's dead-letter topic or error handler: keep the original key, value and headers, add the reason and the source topic, partition and offset, then commit.
- A deserialization failure happens before your handler runs: make sure it reaches the same error path.
- If the repository has no dead-letter handling, do not build new infrastructure unasked: log, count, and stop or skip as the task says, and name the gap in your summary.
- A retry topic or a skip breaks the order for that key: say so. No endless retry loop, no empty `catch`.

## Transactions

- Use them only where the repository already does or the task asks. Keep the `transactional.id` stable per producer instance.
- Read, process, write: send the consumed offsets inside the transaction, abort on failure. A fenced producer is fatal: close it, do not retry.

## Schemas and compatibility

- A message is a contract with consumers you cannot see. The schema file, the generated or hand-written types, the serializer, and the producers and consumers in this repository change together.
- Usually compatible: a new optional field with a default. Breaking: a removed or renamed field, a changed type, unit or meaning, a new required field without a default, a removed enum value, and a new enum value for readers that reject unknown ones. Protobuf: never change or reuse a field number; reserve removed ones.
- Follow the compatibility mode of the subject (backward, forward, full). You cannot ask the registry: say which mode you assumed and who must deploy first. Do not switch off compatibility checks, and do not switch on automatic schema registration where it is off.
- A breaking change needs the task to ask for it, and a new topic or schema version in the repository's style. Do not edit generated classes by hand.
- Consumers ignore unknown fields and handle unknown enum values. JSON without a schema is validated when it is consumed.

## Stream processing

- Kafka Streams: `application.id` is the group id and the prefix of internal topics and state stores. Do not change it.
- Adding, removing or reordering operators renames generated stores and repartition topics, and loses state on deploy. Name them (`Materialized.as`, `Grouped.as`, `Named.as`) when the repository does.
- A key-changing step (`selectKey`, `map`, `groupBy`) repartitions. Joins need the same key and the same partition count on both sides.
- Windows: decide what happens to late records (grace period). State stores are rebuilt from changelog topics: keep serdes compatible.

## Observability and security

- Log a failure with topic, partition, offset and the reason; not the payload, and no key that holds personal data. Keep existing metrics, lag measures and trace headers; pass correlation headers on.
- No broker address, password, token or certificate in code, tests or logs: configuration comes from where the repository already takes it. Do not weaken TLS, SASL or access settings.

## Tests

- Test the handler without a broker: the same message twice, a replay, a message that cannot be parsed, a failure followed by a retry, and out-of-order input where order matters.
- Test the producer: key, headers and value, and a failed send.
- Use what the repository has (mock producer and consumer, `TopologyTestDriver`, an embedded broker, its containers). Never a shared or real cluster. No fixed sleeps.

## Java notes

- `KafkaProducer` is thread-safe: share one. `KafkaConsumer` is not: one thread polls it, and only `wakeup()` may come from another thread.
- `send()` returns at once: use the callback or the future. `commitAsync` does not retry; use `commitSync` on revoke and shutdown.
- Spring Kafka: check the container `AckMode` and the error handler (`DefaultErrorHandler` with a backoff and a `DeadLetterPublishingRecoverer`, `ErrorHandlingDeserializer` for bad payloads). `KafkaTemplate.send` returns a future: handle it. `@Transactional` over a database and Kafka is not atomic.

## TypeScript notes

- kafkajs: `eachMessage` marks the offset when the promise resolves; a throw retries the same message and blocks the partition, so catch permanent failures and dead-letter them. Auto-commit is on by default. In `eachBatch`, call `resolveOffset` and `heartbeat`, and check `isRunning()` and `isStale()`.
- `await` every `producer.send`. Do not swap the partitioner (`DefaultPartitioner`, `LegacyPartitioner`): it moves keys.
- `message.key` and `message.value` are `Buffer | null`: parse and validate into a typed value; null is a tombstone. Call `disconnect()` on shutdown.
