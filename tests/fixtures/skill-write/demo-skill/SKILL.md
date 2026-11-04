---
name: demo-skill
description: "Keeps Kafka consumers idempotent and commits offsets after processing. Use when Kafka consumer code changes."
version: 1.0.0
metadata:
  capabilities: [kafka]
  technologies: [kafkajs]
---

# Demo skill

## When this applies

- A Kafka consumer or producer changes.

## Rules

- Commit an offset only after the message is processed.
- Use the idempotent producer setting.
