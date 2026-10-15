// A layout shaped like the Confluent agent skills, for tests. Every text is written for the tests; nothing is copied from upstream.
// No scripts, no URLs, no tool lists. `placeholder/` stands for the real folders the owner has not reviewed yet.

const skill = (name: string, caps: string[] | undefined, body: string) =>
  [
    "---",
    `name: ${name}`,
    `description: Test text about ${name}.`,
    "license: Apache-2.0",
    ...(caps ? ["metadata:", `  capabilities: [${caps.join(", ")}]`] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");

export const CONFLUENT_FILES: Record<string, string> = {
  "placeholder/kafka/kafka-clients/SKILL.md": skill(
    "kafka-clients",
    ["producer", "consumer", "transactions"],
    [
      "# Kafka clients",
      "",
      "- Order holds only inside one partition. Messages that must stay in order carry the same key.",
      "- Changing the key or the partition count moves a key to another partition: treat it as a breaking change.",
      "- Retry a transient failure a bounded number of times with backoff. Never retry a permanent one.",
      "- Send a poison message to the dead-letter topic with its original key, value and headers, then commit.",
      "- Exactly-once needs an idempotent producer with a transactional.id, offsets in the same transaction, readers on read_committed and a boundary inside Kafka. A database write stays outside and must be idempotent.",
    ].join("\n"),
  ),
  "placeholder/kafka-streams/streams-apps/SKILL.md": skill(
    "streams-apps",
    undefined,
    "With processing.guarantee=exactly_once_v2 a topology is exactly-once inside Kafka. A database write stays outside and must be idempotent.",
  ),
  "placeholder/schema-registry/schema-registry/SKILL.md": skill("schema-registry", ["schema-registry"], "Add a new field with a default so old readers keep working."),
  "placeholder/flink/flink-sql/SKILL.md": skill("flink-sql", ["flink-sql"], "Name every window and say how late records are handled."),
  "placeholder/migration/cloud-migration/SKILL.md": skill(
    "cloud-migration",
    ["cloud-migration", "cloud-clients"],
    "Plan the move topic by topic and check the client settings before the switch.",
  ),
};

export const APACHE_LICENCE_PATH = "tests/fixtures/licences/apache-2.0.txt";

export const CONFLUENT_COMMUNITY_TEXT = [
  "Confluent Community License Agreement Version 1.0",
  "",
  "This is a short text written for a test. It stands for a licence that limits what you may do with the software.",
  "",
].join("\n");
