# Kafka review checks

- Guarantee: does the change claim or rely on exactly-once behaviour? Accept it only when the repository shows the whole chain (idempotent producer, `transactional.id`, offsets in the transaction, `read_committed` readers or Streams `exactly_once_v2`) and no effect leaves Kafka. Otherwise it is at least once and must say so.
- Ordering: do messages that must stay in order share a key? Does the change alter a key, the partitioner or a partition count, hand records to threads or unawaited promises, or add a retry topic or skip that reorders a key?
- Replay and duplicates: is every changed consumer safe when a message arrives twice or the topic is replayed from an older offset (idempotent effect, or an id stored with the effect)? Is a `group.id` or `auto.offset.reset` changed without the task asking?
- Offsets: is an offset committed only after processing finished, also with auto-commit, batches and async work? Can the work between polls exceed the poll interval?
- Poison messages: can a message that always fails, or cannot be deserialized, block a partition forever or vanish? Are transient and permanent failures told apart, retries bounded, and the dead letter sent with key, headers, reason and source position?
- Schema compatibility: is a field removed, renamed or retyped, a required field added without a default, an enum value added or removed, or a Protobuf field number reused? Do schema, types, producers and consumers in the repository agree, and is the assumed compatibility mode and deploy order named? Was a generated class edited by hand?
- Producer: is the result of every send handled, and are `acks` and idempotence kept for data that must not be lost? Is a database write paired with a send without an outbox, or without naming what can be lost?
- Streams: is `application.id` unchanged, are stores and repartition topics still named the same, and are joined topics co-partitioned?
- Are failures logged with topic, partition and offset, without payloads or secrets? Is a broker address or credential hard-coded, or security weakened?
- Tests: duplicate, replay, unparsable message and failed send are covered without a real or shared cluster?
- Does the change add a client, a dependency or cluster administration (topics, offsets, registry) the task did not ask for?
- Leave language, framework and integration-test checks to their own skills.
