---
name: cassandra
description: "Cassandra: query-first tables, partitions, consistency, paging, tombstones, schema changes. Use with a Cassandra driver or CQL; not for other databases."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "2500"
  budget-reviewer-tokens: "800"
---

# Cassandra

## When this applies

- Use it when the change touches CQL, a Cassandra driver or mapper (entities, repositories, DAOs), Cassandra session or driver configuration, a Cassandra schema change, or a persistence module that does one of these.
- Do not use it for database work with no Cassandra in it: SQL databases, other NoSQL stores, a generic "repository" or "migration". Then ignore this skill. A `.cql` file can also be Cypher (Neo4j): check before applying it.
- Language, framework and test-setup rules live in their own skills.

## Follow the repository first

- Read the table definitions, two or three existing queries and the driver configuration before writing.
- Use the driver, mapper, migration tool and naming the repository already has. Do not add a driver, a mapper or a migration tool unless the task asks for it.
- This skill grants no cluster access. Do not connect to a shared or production cluster, and do not run `cqlsh` or `nodetool` against one. Say in your summary what an operator has to run.
- Do not assume a topology. Contact points, datacenter names, replication factor, node count and server version come from configuration; never write them into code, CQL or a migration. Use a feature (SAI, vectors, `UNSET`) only when the supported version has it.

## Model from the queries

- Start from the list of queries the feature needs, not from the entities. One table serves one query pattern; the same data in two tables is normal.
- A new way to read existing data needs a new table (written together with the old one, then backfilled), not a filter on the old one. A primary key cannot be changed afterwards.
- No joins, no cross-partition aggregates, no `OFFSET`. Do not read a whole table and filter in application code.
- Name the columns in every `SELECT`; no `SELECT *`.

## Partition and clustering keys

- Every query in the request path gives the whole partition key by equality. Clustering columns are restricted in their declared order, with a range only on the last one used.
- Even distribution: a partition key with few values (a status, a type, a boolean, a country, a date alone) or one dominant value (one large tenant) makes a hot partition. Add a column that spreads the load.
- Bounded size: a partition that grows for ever (all events of a device, all messages of a chat) is a defect. Add a bucket (day, month, or a hash shard) to the partition key so that a partition stays, as a rule of thumb, under about 100 MB and 100,000 rows. Write down the expected rows per partition for a new table.
- Choose the clustering order for the main read (`WITH CLUSTERING ORDER BY (created_at DESC)` for "newest first"), and add a unique last clustering column (a `timeuuid`) so that two rows with the same time do not overwrite each other.
- An `IN` on the partition key is a query per partition: keep the list small and bounded, or send single-partition queries in parallel with a limit on concurrency.

## ALLOW FILTERING and indexes

- `ALLOW FILTERING` is not a design solution. It makes the cluster read rows and throw them away, so the cost grows with the table, not with the result; it works on a test table and times out in production. When a query needs it, the table is wrong for that query: add a table for it.
- Exceptional use, each with a comment that says why it is bounded: inside one partition that the query names in full and whose size is bounded; or a one-off maintenance or export job outside the request path, paged, on a table known to be small. Never as the default, and never on a query a user request triggers across partitions.
- A secondary index is not a free alternative: without the partition key it asks every node. Do not index a column with very many or very few distinct values, or one that changes often. Add one only together with the partition key, or when the repository already relies on them.
- Do not add a materialized view (experimental, off by default in current versions); write the second table yourself.

## Consistency

- Set the consistency level on purpose, per statement or in the execution profile the repository uses; do not rely on a driver default you did not read.
- Reading your own write needs read and write replicas to overlap (for example `LOCAL_QUORUM` for both). Prefer the `LOCAL_` levels; do not introduce `ALL`, `ANY`, or a datacenter name.
- Never lower a consistency level to make a timeout or an unavailable error go away, and do not change the level of an existing query unless the task asks.
- Last write wins per column, by timestamp: a read-modify-write is not safe under concurrency. Do not set `USING TIMESTAMP` unless the repository does.

## Statements and paging

- One session for the application, created at start and closed at shutdown. Never a session per request.
- Prepare each statement once and reuse it. Bind every value; never build CQL from input by string concatenation.
- A bound `null` writes a tombstone. Leave the value unset, or use a statement without that column.
- A read that can return many rows sets a page size and is consumed page by page; never collect an unbounded result in memory. Give callers the driver's paging state as an opaque token, and treat a token that comes back from a client as untrusted input for that same query only.
- Use the asynchronous API the way the repository does and bound the number of requests in flight.

## Batches and lightweight transactions

- A batch is not a speed-up. A logged batch is for one logical write that must reach several tables together: keep it to a few statements. An unlogged batch is only for rows of one partition. Bulk loading is many single writes with bounded concurrency.
- A lightweight transaction (`IF NOT EXISTS`, `IF col = ?`) costs several round trips: use it only for uniqueness or compare-and-set, check `[applied]`, and do not mix it with plain writes to the same rows. Read such rows with the serial consistency level when the answer must be current.
- Counters live in their own tables, are not idempotent and are never retried blindly.

## TTL, deletes and tombstones

- A delete, an expired TTL, a written `null` and a replaced collection all leave tombstones, kept for `gc_grace_seconds`. A read that crosses many of them gets slow and then fails.
- Do not build a queue or any delete-after-read pattern in a table. Do not overwrite a whole collection when you can add to it or remove from it. Prefer one range or partition delete to many row deletes.
- Data that expires: put the time bucket in the partition key so that whole partitions expire, give all rows of a table the same TTL (a table default), and do not update or delete old rows in a time-window compacted table.
- A TTL belongs to the written columns: an `UPDATE` of one column does not renew the others.
- Do not change `gc_grace_seconds`, compaction or replication unless the task asks; lowering `gc_grace_seconds` below the repair interval brings deleted data back.

## Retries and timeouts

- A write timeout means "unknown", not "failed": the write may have been applied. Retry only what is idempotent.
- Mark a statement idempotent only when it is: not a counter update, not a list append or prepend, not a lightweight transaction, not one that calls `now()` or `uuid()` on the server. Generate ids and times in the application so that a retry writes the same row.
- Use the driver's retry and speculative-execution policy; no hand-written retry loop without a bound and a backoff. Keep request timeouts as configured.

## Schema changes

- Follow the repository's migration tool and its numbering; never edit a migration that has run. One schema statement at a time, each waiting for schema agreement. Never run schema changes from every application instance at start: concurrent changes cause schema disagreement. `IF NOT EXISTS` makes a re-run safe, not a concurrent run.
- Changes are additive: a new table, a new column. The type of a column and the primary key cannot change; a new shape is a new table. Never drop a column and add it again with the same name.
- Old and new application versions run side by side during a rollout. The order is: add the schema; deploy code that writes old and new; backfill (paged, throttled, idempotent); switch the reads; stop the old writes; drop later, in a separate change.
- `DROP` and `TRUNCATE` destroy data: only when the task asks for it, and say so in your summary.

## Tests

- Test every new or changed query against a real Cassandra when the repository has that setup (a container or an embedded server); a mocked session proves nothing about a key or a filter. Do not add such a setup unasked.
- Test the access pattern, not only the round trip: a read across more than one page, the clustering order, a missing row, an unset value, a failed `[applied]`.
- Test a migration from an empty keyspace and on top of the previous schema. Test keyspaces use their own replication settings; never copy them from production.
- No sleeps to wait for a TTL: use a short TTL and poll with a deadline, or check the TTL that was written.
