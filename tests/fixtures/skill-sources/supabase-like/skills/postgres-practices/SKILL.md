---
name: postgres-practices
description: Synthetic guidance on schema design and query tuning for a relational database.
---

# Postgres practices

Prefer narrow indexes that match the filters of the query. Check the plan before and after a change.
Keep constraints in the schema, not only in application code.
