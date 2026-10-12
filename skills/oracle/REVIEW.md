# Oracle review checks

- Dialect: does any statement assume PostgreSQL or MySQL (`LIMIT`, `ON CONFLICT`, `AUTO_INCREMENT`, `NOW()`, a non-null empty string, a `BOOLEAN` column, transactional DDL), or a feature newer than the Oracle release the project supports?
- Binding: is any value joined into SQL text instead of bound, in code or in `EXECUTE IMMEDIATE`? Is a dynamic table or column name taken from an allowlist? Is a bind of another type than its column?
- Transaction boundaries: is there one clear boundary per unit of work, with commit or rollback on every path? Is there a reliance on auto-commit, a commit inside a cursor loop or inside a procedure the caller's transaction owns, or a new autonomous transaction?
- Locking: can a `FOR UPDATE` wait forever (no `WAIT`, `NOWAIT` or `SKIP LOCKED`)? Is the lock order consistent, is a lost update possible, and is a new foreign key left without an index?
- Temporal semantics: is the column type (`DATE`, `TIMESTAMP`, with or without zone) right for the value? Are server time (`SYSDATE`) and session time mixed? Does a conversion depend on NLS settings? Is a day selected with `TRUNC(col)` or `BETWEEN` instead of a half-open range?
- Migration reversibility: is an applied migration edited? Does the new one have a rollback, or does the summary say why it cannot be reversed? Does it stay compatible with running code, survive a failure half way (DDL commits), and avoid one huge update or a blocking index build?
- Keys and paging: is `MAX(id) + 1` used, or sequence order or gaplessness assumed? Is `ROWNUM` applied before the sort, or the order not unique?
- LOBs: is a large value loaded whole, a locator used after commit or close, or a temporary LOB not freed?
- PL/SQL: do specification, body and callers change together? Is there a `WHEN OTHERS` that does not re-raise?
- Errors: are ORA numbers used rather than message text, only transient errors retried (as a whole transaction), and statements, result sets and connections closed on every path?
- Are credentials, wallets or connect strings added, or a production database used? Are the tests run against Oracle, and do they cover the changed boundary?
- Leave language, framework and other databases to their own skills.
