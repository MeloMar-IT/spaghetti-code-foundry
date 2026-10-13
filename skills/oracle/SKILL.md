---
name: oracle
description: "Oracle Database: binds, transactions, dates, LOBs, locking, migrations. Use with Oracle drivers, PL/SQL or Oracle config; not for other databases or plain SQL."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "2300"
  budget-reviewer-tokens: "700"
---

# Oracle database

## When this applies

- Use it when the change touches SQL, PL/SQL, migrations or persistence code of a module that shows Oracle: an Oracle driver (`ojdbc`, `oracledb`, `godror`), `oracle.jdbc` imports, `.pks`/`.pkb` files, `tnsnames.ora`, or a task that names Oracle.
- Do not use it for PostgreSQL, MySQL, SQL Server, SQLite or Cassandra, or for SQL with no sign of Oracle. Then ignore this skill.
- This skill gives no database access. Never ask for, invent or write credentials, wallets or connect strings, and never connect to a production database. Use only the configuration and the test database the repository already has.

## Follow the repository first

- Find the Oracle release the project supports (docs, CI image, driver version) and stay inside it. Identity columns and `FETCH FIRST` need 12c; the SQL `BOOLEAN` type, `IF NOT EXISTS` in DDL and `SELECT` without `FROM` need 23ai.
- Match the existing naming, schema prefixes, data access library and migration tool. Do not add a dependency.

## Not PostgreSQL or MySQL

- The empty string is `NULL`. `col = ''` is never true; use `IS NULL`.
- There is no `LIMIT`, `ILIKE`, `ON CONFLICT`, `ON DUPLICATE KEY`, `AUTO_INCREMENT`, `SERIAL`, `NOW()` or `RETURNING *`. Use `MERGE` for an upsert, `FROM DUAL` for a select with no table, `||` to join text, and `VARCHAR2` with the length unit (`BYTE` or `CHAR`) the schema uses.
- Before 23ai a column cannot be `BOOLEAN`: use the project's `NUMBER(1)` or `CHAR(1)` convention.
- Unquoted names are stored in upper case. Do not create quoted mixed-case names.
- An `IN` list holds at most 1000 values before 23ai (ORA-01795).
- DDL commits, before and after itself. There is no transactional DDL.

## Bind variables

- Every value is a bind (`?` in JDBC, `:name` in other drivers, `USING` with `EXECUTE IMMEDIATE`). Never build SQL by joining input: it allows injection and forces a hard parse for each call.
- A table or column name cannot be bound. Take it from a fixed allowlist; in PL/SQL check it with `DBMS_ASSERT`.
- Bind the column's own type. A string bound to a `NUMBER` or `DATE` column is converted implicitly, which depends on NLS settings and can stop index use.
- For a list of unknown length use a collection bind or a fixed number of placeholders.
- Send many rows as a batch (`executeBatch`, `executemany`, `FORALL`) and set a fetch size for large results.

## Transactions and isolation

- Oracle has `READ COMMITTED` (the default; each statement sees its own snapshot) and `SERIALIZABLE` (one snapshot per transaction; fails with ORA-08177 and the whole transaction must be retried). There is no dirty read and no `REPEATABLE READ`.
- Keep one clear transaction boundary per unit of work, in the layer the project uses for it. Do not rely on auto-commit (JDBC turns it on by default), and commit or roll back on every path: the Oracle JDBC driver commits pending work when a connection is closed.
- Do not commit inside a loop over an open cursor on the same data (ORA-01555), or in a procedure that runs inside the caller's transaction.
- Use `PRAGMA AUTONOMOUS_TRANSACTION` only for logging or audit, and only where the project already does.

## Locking

- Lock rows you read in order to change them with `SELECT ... FOR UPDATE`, and say how long to wait: `WAIT n`, `NOWAIT`, or `SKIP LOCKED` for queue-style work. A bare `FOR UPDATE` waits forever.
- `FOR UPDATE` cannot be used with `DISTINCT`, `GROUP BY`, aggregates or `FETCH FIRST`. Select the keys first, then lock by key.
- Take locks in one consistent order. A deadlock (ORA-00060) rolls back only the statement: roll back the transaction and retry it.
- Index a foreign key whose parent rows are deleted or re-keyed; without the index the child table is locked.

## Sequences and identity

- Use what the schema uses: a sequence (`seq.NEXTVAL`) or an identity column. Never `MAX(id) + 1`.
- Sequence values have gaps, are not given back on rollback and, with `CACHE` or RAC, are not in time order. Do not sort by them to get insert order.
- Read a generated key with `RETURNING id INTO`, or in JDBC by naming the key column in `prepareStatement`; the plain generated-keys flag returns the `ROWID`.

## Dates and timestamps

- `DATE` holds a time to the second and no zone. `TIMESTAMP` adds fractions. `TIMESTAMP WITH TIME ZONE` keeps the zone; `WITH LOCAL TIME ZONE` converts to the session zone. Keep the column's type and the project's convention.
- `SYSDATE` and `SYSTIMESTAMP` use the database server's zone; `CURRENT_DATE` and `CURRENT_TIMESTAMP` use the session's. Do not mix them.
- Never depend on NLS settings. Bind a typed value, or give `TO_DATE`, `TO_TIMESTAMP` and `TO_CHAR` an explicit format, or use an ANSI literal (`DATE '2024-01-31'`).
- Select a day with a half-open range (`col >= :d AND col < :d + 1`), not `TRUNC(col) = :d` and not `BETWEEN` with an end-of-day value.

## LOBs

- Use `CLOB`, `BLOB` or the project's JSON storage; never a new `LONG` column. In SQL a `VARCHAR2` holds 4000 bytes unless extended string sizes are on.
- Stream large values. Do not select LOB columns you do not need (`SELECT *`).
- A LOB locator is valid only inside its transaction and connection: read it before commit or close, and free temporary LOBs.
- A LOB cannot be used in `=`, `DISTINCT`, `GROUP BY` or `ORDER BY`; use `DBMS_LOB`.

## Indexing and queries

- A function on the column (`UPPER(col)`, `TRUNC(col)`) or an implicit conversion stops a normal index. Rewrite the predicate or use a function-based index.
- Rows whose indexed columns are all `NULL` are not in a B-tree index, so `IS NULL` on a single-column index scans the table.
- No bitmap index on a table with concurrent writes.
- Building an index on a large, busy table blocks writes unless `ONLINE` (Enterprise Edition): say so in your summary.

## Pagination

- 12c and later: `ORDER BY ... OFFSET :o ROWS FETCH NEXT :n ROWS ONLY`. Earlier: sort in an inner query and filter `ROWNUM` outside it; `WHERE ROWNUM <= :n ORDER BY ...` limits before it sorts.
- Always order by something unique. Cap the page size. Prefer keyset paging (`WHERE id > :last`) for deep pages.

## Migrations

- Use the repository's tool and naming (Flyway, Liquibase or its own scripts). Never edit a migration that has been applied or merged; add a new one.
- Because DDL commits, a failed migration stays half applied. Keep one DDL change per migration where you can, and make a script safe to run again.
- Reversibility: give the rollback the tool supports (a Liquibase `rollback` block, an undo or down script). If a change cannot be reversed (dropped data, a narrowed type), say so in your summary.
- Stay compatible with the code that is still running: add a column as nullable or with a default, and split a destructive change into add, backfill, switch, and drop in a later release.
- Backfill in batches with a commit per batch, not one large `UPDATE`. On a large table add a constraint with `ENABLE NOVALIDATE`, then validate it.
- In SQL*Plus-style scripts end a PL/SQL block with `/` on its own line and remember that `&` starts a substitution.
- Include the grants and synonyms a new object needs.

## PL/SQL boundaries

- Change the package specification (`.pks`), the body (`.pkb`) and every caller (JDBC call, other package) together. A changed specification invalidates dependants and discards session state (ORA-04068).
- Never `WHEN OTHERS THEN NULL`. A `WHEN OTHERS` handler re-raises, or raises with `RAISE_APPLICATION_ERROR` (-20000 to -20999) and keeps the cause.
- Handle `NO_DATA_FOUND` and `TOO_MANY_ROWS` of `SELECT INTO`. In a function called from SQL, an unhandled `NO_DATA_FOUND` silently gives `NULL`.
- Process sets with `BULK COLLECT ... LIMIT` and `FORALL`, not row by row.

## Error handling

- Decide by the ORA error number (`SQLException.getErrorCode()`), never by the message text: it is localised.
- Know the common ones: 1 unique key, 2291 and 2292 foreign key, 12899 value too long, 54 row busy (`NOWAIT`), 60 deadlock, 8177 cannot serialise, 1555 snapshot too old, 4068 package state discarded.
- Retry only the transient ones (60, 8177, 4068, a lost connection), by running the whole transaction again a limited number of times. Never retry a constraint violation.
- Close statements and result sets on every path (ORA-01000) and give connections back to the pool. Keep bind values and connect strings out of logs and error messages.

## Tests

- Run database tests against Oracle where the repository can (its container, test schema or CI service). H2 or HSQLDB in "Oracle mode" does not prove empty-string, date, locking or PL/SQL behaviour: say so in your summary if nothing else was available.
- Cover what changed: empty string and `NULL`, a day or time-zone boundary, a constraint violation mapped to the right error, the lock or retry path, a value above 4000 bytes, and a migration applied to an empty schema and to the previous version.
- Tests create and remove their own data and use no production credentials.
